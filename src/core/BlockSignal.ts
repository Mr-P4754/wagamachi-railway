import * as THREE from 'three';
import { GridLayer, BlockSection, BlockSignalState, DeadlockEvent } from './types';

export interface SignalVisual {
  x: number;
  z: number;
  layer: GridLayer;
  directionIdx: number;
  state: BlockSignalState;
  mesh?: THREE.Group;
}

/**
 * 閉塞（信号機）および最大10両編成の全マス在線ロック・デッドロック検知マネージャー
 */
export class BlockSignalManager {
  private blockSections: Map<string, BlockSection> = new Map();
  private tileToSectionId: Map<string, string> = new Map();
  private signals: Map<string, SignalVisual> = new Map();
  private trainStuckTimers: Map<number, number> = new Map();
  private trainDeadlockNotified: Set<number> = new Set();
  public onDeadlockDetected?: (event: DeadlockEvent) => void;

  constructor() {}

  /**
   * タイル座標キーを生成
   */
  public makeTileKey(x: number, z: number, layer: GridLayer): string {
    return `${x},${layer},${z}`;
  }

  /**
   * 信号機キーを生成
   */
  public makeSignalKey(x: number, z: number, layer: GridLayer, directionIdx: number): string {
    return `${x},${layer},${z},${directionIdx}`;
  }

  /**
   * 閉塞区間の登録
   */
  public registerBlockSection(section: BlockSection): void {
    this.blockSections.set(section.id, section);
    for (const tile of section.tiles) {
      this.tileToSectionId.set(this.makeTileKey(tile.x, tile.z, tile.layer), section.id);
    }
    for (const sig of section.entrySignals) {
      const key = this.makeSignalKey(sig.x, sig.z, sig.layer, sig.directionIdx);
      if (!this.signals.has(key)) {
        this.signals.set(key, {
          x: sig.x,
          z: sig.z,
          layer: sig.layer,
          directionIdx: sig.directionIdx,
          state: 'green'
        });
      }
    }
  }

  /**
   * タイル座標から所属する閉塞区間を取得
   */
  public getSectionByTile(x: number, z: number, layer: GridLayer): BlockSection | undefined {
    const key = this.makeTileKey(x, z, layer);
    const sectionId = this.tileToSectionId.get(key);
    if (!sectionId) return undefined;
    return this.blockSections.get(sectionId);
  }

  /**
   * 指定したIDの閉塞区間を取得
   */
  public getSection(id: string): BlockSection | undefined {
    return this.blockSections.get(id);
  }

  /**
   * 登録されている全信号機データを取得
   */
  public getSignals(): SignalVisual[] {
    return Array.from(this.signals.values());
  }

  /**
   * ① 最大10両編成の全マス在線ロック更新
   * 各列車が占有している全タイル（先頭車〜最後尾車）に基づき、
   * 最後尾が閉塞境界を完全に抜けきるまで、手前の信号機を「赤（停止現示）」に維持する。
   */
  public updateOccupancy(
    trains: Array<{
      id: number;
      name: string;
      carCount: number;
      occupiedTiles: Array<{ x: number; z: number; layer: GridLayer }>;
      isStopped: boolean;
      isDeadlocked?: boolean;
      speed: number;
    }>,
    deltaTime: number,
    hasOccupancyChanged: boolean = true
  ): void {
    // 占有状態に変化があった場合のみ、閉塞区間リセット・再割当・信号機ビジュアル更新を実行
    if (hasOccupancyChanged) {
      // 1. 各閉塞区間の占有状態をリセット
      for (const section of this.blockSections.values()) {
        section.occupiedTrainId = null;
        section.signalState = 'green';
      }

      // 2. 各列車の占有タイル（最大10マス以上）をチェックし、該当閉塞区間をロック
      for (const train of trains) {
        const occupiedSections = new Set<string>();

        for (const tile of train.occupiedTiles) {
          const key = this.makeTileKey(tile.x, tile.z, tile.layer);
          const sectionId = this.tileToSectionId.get(key);
          if (sectionId) {
            occupiedSections.add(sectionId);
          }
        }

        for (const sId of occupiedSections) {
          const section = this.blockSections.get(sId);
          if (section) {
            section.occupiedTrainId = train.id;
            section.signalState = 'red';
          }
        }
      }

      // 3. 信号機ビジュアルの状態を閉塞区間に連動更新
      for (const section of this.blockSections.values()) {
        for (const sig of section.entrySignals) {
          const key = this.makeSignalKey(sig.x, sig.z, sig.layer, sig.directionIdx);
          const sigVisual = this.signals.get(key);
          if (sigVisual) {
            sigVisual.state = section.signalState;
          }
        }
      }
    }

    // 4. ③ デッドロック（立ち往生）検知
    // 赤信号やATS非常停止等で進行不能な状態がゲーム内時間10分以上（等速10秒相当）継続した場合のみ発火
    // （※正規の駅客扱い停車、夜間留置、折り返し待機中はデッドロックとみなさない）
    for (const train of trains) {
      const isStuck = train.isDeadlocked ?? false;
      if (isStuck) {
        const currentTimer = (this.trainStuckTimers.get(train.id) ?? 0) + deltaTime;
        this.trainStuckTimers.set(train.id, currentTimer);

        // 10秒（ゲーム内時間10分）以上停止していて、未通知の場合に発火
        if (currentTimer >= 10.0 && !this.trainDeadlockNotified.has(train.id)) {
          this.trainDeadlockNotified.add(train.id);
          if (this.onDeadlockDetected && train.occupiedTiles.length > 0) {
            const headTile = train.occupiedTiles[0];
            this.onDeadlockDetected({
              trainId: train.id,
              trainName: train.name,
              stuckDurationMinutes: Math.floor(currentTimer),
              position: headTile
            });
          }
        }
      } else {
        // 走行を再開した、または正規停車中になったらタイマーと通知フラグをクリア
        this.trainStuckTimers.delete(train.id);
        this.trainDeadlockNotified.delete(train.id);
      }
    }

    // 5. 運行中リストから除外された（撤去・消滅した）列車のタイマー・通知フラグを確実にパージ
    const currentTrainIds = new Set(trains.map(t => t.id));
    for (const trainId of Array.from(this.trainStuckTimers.keys())) {
      if (!currentTrainIds.has(trainId)) {
        this.trainStuckTimers.delete(trainId);
        this.trainDeadlockNotified.delete(trainId);
      }
    }
  }

  /**
   * 撤去された列車のデッドロック監視タイマーおよび通知状態を即座に解放
   */
  public unregisterTrain(trainId: number): void {
    this.trainStuckTimers.delete(trainId);
    this.trainDeadlockNotified.delete(trainId);
  }

  /**
   * ② 信号機の手前停止 ＆ 安全進入判定
   * 進入予定のタイルが属する閉塞区間が赤信号（他列車が占有中）の場合、進入を拒否して停止させる
   */
  public canEnterTile(
    trainId: number,
    targetX: number,
    targetZ: number,
    targetLayer: GridLayer
  ): boolean {
    const section = this.getSectionByTile(targetX, targetZ, targetLayer);
    if (!section) {
      // 閉塞区間に未登録の線路は単独タイルレベルで在線チェック
      return true;
    }

    // 自列車自身が既にその区間内に一部跨っている（自列車占有中）の場合は前進を許可
    if (section.occupiedTrainId === trainId) {
      return true;
    }

    // 他の列車が占有中（赤信号）の場合は進入不可（停止）
    if (section.occupiedTrainId !== null && section.occupiedTrainId !== trainId) {
      return false;
    }

    return section.signalState !== 'red';
  }

  /**
   * マップリセット時の全クリア
   */
  public clear(): void {
    this.blockSections.clear();
    this.tileToSectionId.clear();
    this.signals.clear();
    this.trainStuckTimers.clear();
    this.trainDeadlockNotified.clear();
  }
}
