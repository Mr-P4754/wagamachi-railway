import * as THREE from 'three';
import { GridLayer } from './types';
import { WorldMap, TileDataSnapshot } from '../simulation/WorldMap';
import { TrainManager } from '../simulation/TrainManager';
import { Economy } from '../simulation/Economy';
import { AudioManager } from '../engine/AudioManager';
import { UIManager } from '../ui/UIManager';
import { MiniMap } from '../ui/MiniMap';
import { TerrainRenderer } from '../graphics/TerrainRenderer';
import { GridManager } from './GridManager';
import { ModelFactory } from '../models/ModelFactory';

/**
 * 操作前後のタイルスナップショット
 */
export interface TileSnapshot {
  x: number;
  z: number;
  layer: GridLayer;
  before: TileDataSnapshot | null;
  after: TileDataSnapshot | null;
}

/**
 * Undo対象のアクション単位
 */
export interface UndoAction {
  type: 'placement' | 'demolition';
  tiles: TileSnapshot[];
  cost: number;
  description?: string;
}

export interface UndoManagerDependencies {
  worldMap: WorldMap;
  trainManager: TrainManager;
  economy: Economy;
  audioManager: AudioManager;
  uiManager: UIManager;
  miniMap: MiniMap;
  terrainRenderer: TerrainRenderer;
  getGridManager: () => GridManager;
  scene: THREE.Scene;
  onCargoYardVisualUpdate?: (x: number, z: number, layer: GridLayer) => void;
  removeCargoYardVisual?: (x: number, z: number, layer: GridLayer) => void;
  onAfterUndo?: () => void;
}

/**
 * 敷設・撤去操作のUndo（元に戻す）を管理するマネージャー
 */
export class UndoManager {
  private static readonly MAX_HISTORY = 20;
  private undoStack: UndoAction[] = [];
  private deps: UndoManagerDependencies;

  constructor(deps: UndoManagerDependencies) {
    this.deps = deps;
  }

  /**
   * 操作をスタックに記録する（最大20件保持、超過分は古い順に破棄）
   */
  public pushAction(action: UndoAction): void {
    if (!action || action.tiles.length === 0) return;

    // 上限件数（20件）を超えたら最も古い履歴を破棄
    while (this.undoStack.length >= UndoManager.MAX_HISTORY) {
      this.undoStack.shift();
    }

    this.undoStack.push(action);
    this.notifyStackChanged();
  }

  /**
   * Undo可能かどうかを返す
   */
  public canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /**
   * 履歴スタック件数を取得
   */
  public getHistoryCount(): number {
    return this.undoStack.length;
  }

  /**
   * 履歴スタックを完全にクリア（新規ゲーム開始・リセット時）
   */
  public clear(): void {
    this.undoStack = [];
    this.notifyStackChanged();
  }

  /**
   * タイル種別・レベルに応じた基礎人口を取得
   */
  public static getTilePopulation(type: string | undefined, level: number = 1): number {
    if (!type) return 0;
    if (type === 'residence') {
      const popMap = [0, 30, 60, 120, 220];
      return popMap[Math.min(4, Math.max(1, level))] ?? 30;
    }
    if (type === 'commercial') {
      const popMap = [0, 40, 80, 150, 270];
      return popMap[Math.min(4, Math.max(1, level))] ?? 100;
    }
    if (type === 'industrial') {
      const popMap = [0, 50, 70, 90];
      return popMap[Math.min(3, Math.max(1, level))] ?? 50;
    }
    return 0;
  }

  /**
   * 直前の操作を1手元に戻す（安全ガード付き・原子的実行）
   */
  public undo(): boolean {
    if (this.undoStack.length === 0) return false;

    const action = this.undoStack.pop()!;
    const { worldMap, trainManager, economy, audioManager, uiManager, miniMap, terrainRenderer, scene } = this.deps;

    // 1. 安全ガード: 設置の取り消し（線路を更地または元の状態に戻す）時、
    // 現在そのタイル上に列車が走行・在線中の場合は取り消しを拒否してスタックを保持する
    if (action.type === 'placement') {
      trainManager.updateOccupancyNow();
      for (const t of action.tiles) {
        // 変更後に線路・駅などの軌道系タイルだったマスをチェック
        if (t.after && t.after.type !== 'empty') {
          if (trainManager.isTileOccupiedByTrain(t.x, t.z, t.layer)) {
            // スタックを巻き戻して保持
            this.undoStack.push(action);
            uiManager.showToast('Undo不可', '列車が走行・在線中のため、この操作は取り消せません', 'warning');
            return false;
          }
        }
      }
    }

    // 2. 巻き戻し処理の実行
    if (action.type === 'placement') {
      // 設置された駅・信号場・貨物駅、およびスロープの跨がり参照を解除
      for (const t of action.tiles) {
        const curTile = worldMap.getTile(t.x, t.z, t.layer);
        if (curTile) {
          if (curTile.type.includes('station') || curTile.type === 'signal_yard') {
            worldMap.stationManager.removeTileFromPlatform(t.x, t.z, t.layer);
            if (this.deps.removeCargoYardVisual) {
              this.deps.removeCargoYardVisual(t.x, t.z, t.layer);
            }
          } else if (curTile.type === 'rail_slope') {
            const baseLayer = (curTile.layer ?? 1) as GridLayer;
            const upperLayer = (baseLayer + 1) as GridLayer;
            if (worldMap.grid3D.get(curTile.x, upperLayer, curTile.z) === curTile) {
              worldMap.grid3D.delete(curTile.x, upperLayer, curTile.z);
            }
          } else if (curTile.type === 'rail_slope_underground') {
            if (worldMap.grid3D.get(curTile.x, -1 as GridLayer, curTile.z) === curTile) {
              worldMap.grid3D.delete(curTile.x, -1 as GridLayer, curTile.z);
            }
            worldMap.groundHoleHandler?.remove(curTile.x, curTile.z);
          }
        }
      }

      // 設置前の状態 (before) に復元し、人口差分を巻き戻す
      let popDelta = 0;
      for (const t of action.tiles) {
        popDelta += UndoManager.getTilePopulation(t.before?.type, t.before?.level) - UndoManager.getTilePopulation(t.after?.type, t.after?.level);
        worldMap.restoreTileFromSnapshot(t.before, t.x, t.z, t.layer);
      }
      if (popDelta !== 0) {
        economy.addPopulation(popDelta);
      }

      // 消費した建設費用を全額返金し、固定資産台帳からも資産を取り消し
      if (action.cost > 0) {
        economy.refundFunds(action.cost, true);
      }
    } else if (action.type === 'demolition') {
      // 【撤去の取り消し】
      let popDelta = 0;
      for (const t of action.tiles) {
        popDelta += UndoManager.getTilePopulation(t.before?.type, t.before?.level) - UndoManager.getTilePopulation(t.after?.type, t.after?.level);
      }
      if (popDelta !== 0) {
        economy.addPopulation(popDelta);
      }
      // シーサスクロッシング起点があれば先に構築
      const scissorsOrigins = action.tiles.filter(t => t.before?.type.startsWith('scissors_crossing') && t.before.crossingRole === 0);
      for (const st of scissorsOrigins) {
        const b = st.before!;
        worldMap.restoreTileFromSnapshot(b, b.x, b.z, b.layer);
      }

      // 全タイルのスナップショット復元
      for (const t of action.tiles) {
        if (t.before?.type.startsWith('scissors_crossing') && t.before.crossingRole !== 0) {
          // シーサスの非起点は placeScissorsCrossing で生成済みのため、追加プロパティのみ復元
          const tile = worldMap.getTile(t.x, t.z, t.layer);
          if (tile && t.before.switchSchedule) {
            tile.switchSchedule = { ...t.before.switchSchedule, rules: t.before.switchSchedule.rules.map(r => ({ ...r })) };
          }
          continue;
        }
        worldMap.restoreTileFromSnapshot(t.before, t.x, t.z, t.layer);
      }

      // 駅・信号場・貨物駅ホームを StationManager に再登録
      const stationGroups = new Map<string, {
        tool: string;
        rotation: number;
        stationName?: string;
        isSignalYard: boolean;
        isCargoStation: boolean;
        tiles: Array<{ x: number; z: number; layer: GridLayer }>;
      }>();

      for (const t of action.tiles) {
        const b = t.before;
        if (!b) continue;
        if (b.type.includes('station') || b.type === 'signal_yard') {
          const groupId = b.stationGroupId || `st_${b.x}_${b.z}`;
          if (!stationGroups.has(groupId)) {
            stationGroups.set(groupId, {
              tool: b.type,
              rotation: b.rotation,
              stationName: b.stationName,
              isSignalYard: b.type === 'signal_yard',
              isCargoStation: b.type.startsWith('cargo_station'),
              tiles: []
            });
          }
          stationGroups.get(groupId)!.tiles.push({ x: b.x, z: b.z, layer: b.layer });
        }
      }

      for (const [groupId, gData] of stationGroups) {
        if (gData.tiles.length > 0) {
          const axis = gData.rotation % 2;
          const reg = worldMap.stationManager.registerPlatform({
            tiles: gData.tiles,
            length: gData.tiles.length,
            trackAxis: axis,
            isSignalYard: gData.isSignalYard,
            isCargoStation: gData.isCargoStation,
            existingStationId: groupId,
            customName: gData.stationName
          });
          for (const pt of gData.tiles) {
            const tile = worldMap.getTile(pt.x, pt.z, pt.layer);
            if (tile) {
              tile.stationGroupId = reg.station.id;
              tile.stationPlatformId = reg.platform.id;
              tile.stationName = reg.station.name;
              if (tile.mesh && !gData.isSignalYard) {
                ModelFactory.updateStationSign(tile.mesh, reg.station.name);
              }
              if (gData.isCargoStation && this.deps.onCargoYardVisualUpdate) {
                this.deps.onCargoYardVisualUpdate(pt.x, pt.z, pt.layer);
              }
            }
          }
        }
      }

      // 撤去にかかった費用を全額返金
      if (action.cost > 0) {
        economy.refundFunds(action.cost);
      }
    }

    // 3. 後処理・描画更新
    terrainRenderer.rebuildAll(this.deps.getGridManager(), scene);
    miniMap.requestStaticUpdate();
    trainManager.updateOccupancyNow();

    // 効果音再生とトーストフィードバック
    audioManager.playSelectSound();
    uiManager.showToast('元に戻す', '操作を取り消しました', 'info');

    if (this.deps.onAfterUndo) {
      this.deps.onAfterUndo();
    }

    this.notifyStackChanged();
    return true;
  }

  /**
   * UIボタンの有効/無効状態を同期
   */
  private notifyStackChanged(): void {
    this.deps.uiManager.updateUndoButton(this.canUndo());
  }
}
