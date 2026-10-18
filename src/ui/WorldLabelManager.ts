import * as THREE from 'three';
import { GridLayer, CameraViewMode } from '../core/types';
import { WorldMap } from '../simulation/WorldMap';
import { TrainManager } from '../simulation/TrainManager';
import { layerToHeight } from '../core/Grid3D';
import { getMaxCapacity } from '../simulation/VehicleCatalog';

/**
 * ラベルDOM要素および前回フレームの状態キャッシュ
 */
interface LabelState {
  element: HTMLElement;
  lastText: string;
  lastVisible: boolean;
  lastX: number;
  lastY: number;
  isFull?: boolean;
}

/**
 * 3D空間内の駅および旅客列車の真上に、現在の乗客数を数字のみで追従表示するマネージャークラス
 */
export class WorldLabelManager {
  private container: HTMLElement;
  private containerVisible: boolean = true;
  private stationLabels: Map<string, LabelState> = new Map();
  private trainLabels: Map<number, LabelState> = new Map();
  private tempVec = new THREE.Vector3();
  private lastCamera: THREE.Camera | null = null;

  constructor(containerId: string = 'world-labels-container') {
    let el = document.getElementById(containerId);
    if (!el) {
      el = document.createElement('div');
      el.id = containerId;
      el.className = 'world-labels-container';
      document.getElementById('app')?.appendChild(el);
    }
    this.container = el;
  }

  /**
   * 毎フレームの投影位置・乗客数テキストの更新
   */
  public update(
    camera: THREE.Camera,
    viewMode: CameraViewMode,
    currentDisplayLayer: GridLayer | 'all',
    worldMap: WorldMap,
    trainManager: TrainManager
  ): void {
    this.lastCamera = camera;

    // 全体視点（quarter_view）以外（車窓モード中など）はすべて非表示
    if (viewMode !== 'quarter_view') {
      if (this.containerVisible) {
        this.container.style.display = 'none';
        this.clear();
        this.containerVisible = false;
      }
      return;
    }
    if (!this.containerVisible) {
      this.container.style.display = '';
      this.containerVisible = true;
    }

    const width = window.innerWidth;
    const height = window.innerHeight;

    // 1. 駅の待機乗客数ラベル更新
    this.updateStationLabels(camera, currentDisplayLayer, worldMap, width, height);

    // 2. 旅客列車の車内乗客数ラベル更新
    this.updateTrainLabels(camera, currentDisplayLayer, trainManager, width, height);
  }

  /**
   * 各旅客駅ホームの真上に待機乗客数を数字のみで表示
   */
  private updateStationLabels(
    camera: THREE.Camera,
    currentDisplayLayer: GridLayer | 'all',
    worldMap: WorldMap,
    screenWidth: number,
    screenHeight: number
  ): void {
    const activeStationKeys = new Set<string>();
    const stations = worldMap.stationManager.getStations();

    for (const st of stations) {
      // 信号場・貨物駅は待機乗客ラベルの対象外
      if (st.isSignalYard || st.isCargoStation) continue;

      for (let pIdx = 0; pIdx < st.platforms.length; pIdx++) {
        const platform = st.platforms[pIdx];
        if (platform.isSignalYard || platform.isCargoStation || platform.tiles.length === 0) continue;

        // ホームを構成する代表タイル（中央タイル）
        const midIdx = Math.floor(platform.tiles.length / 2);
        const centerTile = platform.tiles[midIdx];
        const tileLayer = (centerTile.layer ?? 1) as GridLayer;

        // スライサー表示フィルタ
        if (!this.isLayerVisible(tileLayer, currentDisplayLayer)) {
          continue;
        }

        const pKey = `${st.id}_p${platform.platformNumber}_${centerTile.x}_${centerTile.z}`;
        activeStationKeys.add(pKey);

        // ホーム内の最大待機乗客数を算出
        let maxPassengers = 0;
        for (const t of platform.tiles) {
          const tileData = worldMap.getTile(t.x, t.z, tileLayer);
          if (tileData && tileData.stationPassengers !== undefined) {
            maxPassengers = Math.max(maxPassengers, tileData.stationPassengers);
          }
        }

        // ホーム真上のワールド座標を算出
        const baseH = layerToHeight(tileLayer);
        const elevY = (tileLayer === 1) ? worldMap.getElevationOffset(centerTile.x, centerTile.z) : 0;
        const worldX = centerTile.x * WorldMap.TILE_SIZE;
        const worldY = baseH + elevY + 2.3; // ホーム屋根より上の見やすい頭上高さ
        const worldZ = centerTile.z * WorldMap.TILE_SIZE;

        this.tempVec.set(worldX, worldY, worldZ);
        this.tempVec.project(camera);

        // 視野内判定
        let labelState = this.stationLabels.get(pKey);
        if (!labelState) {
          const labelEl = document.createElement('div');
          labelEl.className = 'world-badge station-badge';
          this.container.appendChild(labelEl);
          labelState = {
            element: labelEl,
            lastText: '',
            lastVisible: false,
            lastX: -9999,
            lastY: -9999
          };
          this.stationLabels.set(pKey, labelState);
        }

        if (this.isOutOfScreen(this.tempVec)) {
          if (labelState.lastVisible) {
            labelState.element.style.visibility = 'hidden';
            labelState.lastVisible = false;
          }
        } else {
          if (!labelState.lastVisible) {
            labelState.element.style.visibility = 'visible';
            labelState.lastVisible = true;
          }

          const screenX = Math.round((this.tempVec.x * 0.5 + 0.5) * screenWidth);
          const screenY = Math.round((-(this.tempVec.y * 0.5) + 0.5) * screenHeight);

          if (screenX !== labelState.lastX || screenY !== labelState.lastY) {
            labelState.element.style.transform = `translate3d(${screenX}px, ${screenY}px, 0) translate(-50%, -100%)`;
            labelState.lastX = screenX;
            labelState.lastY = screenY;
          }

          // 数字のみ表示（差分がある場合のみ代入）
          const text = maxPassengers.toLocaleString();
          if (labelState.lastText !== text) {
            labelState.element.textContent = text;
            labelState.lastText = text;
          }
        }
      }
    }

    // 撤去された駅ホームのラベルをDOMから除去
    for (const [key, state] of this.stationLabels.entries()) {
      if (!activeStationKeys.has(key)) {
        state.element.remove();
        this.stationLabels.delete(key);
      }
    }
  }

  /**
   * 運行中の各旅客列車の頭上に乗客数を数字のみで追従表示
   */
  private updateTrainLabels(
    camera: THREE.Camera,
    currentDisplayLayer: GridLayer | 'all',
    trainManager: TrainManager,
    screenWidth: number,
    screenHeight: number
  ): void {
    const activeTrainIds = new Set<number>();
    const trains = trainManager.getTrains();

    for (const train of trains) {
      // 貨物列車は乗客数表示の対象外
      if (train.model.category === 'freight') continue;

      const trainLayer = train.currentTile.layer;
      // スライサー表示フィルタ
      if (!this.isLayerVisible(trainLayer, currentDisplayLayer)) {
        continue;
      }

      activeTrainIds.add(train.id);

      // 先頭車の現在ワールド位置を取得し、頭上へオフセット
      const frontPos = train.frontPosition;
      const worldX = frontPos.x;
      const worldY = frontPos.y + 1.6; // 列車の屋根から少し上
      const worldZ = frontPos.z;

      this.tempVec.set(worldX, worldY, worldZ);
      this.tempVec.project(camera);

      let labelState = this.trainLabels.get(train.id);
      if (!labelState) {
        const labelEl = document.createElement('div');
        labelEl.className = 'world-badge train-badge';
        this.container.appendChild(labelEl);
        labelState = {
          element: labelEl,
          lastText: '',
          lastVisible: false,
          lastX: -9999,
          lastY: -9999,
          isFull: false
        };
        this.trainLabels.set(train.id, labelState);
      }

      if (this.isOutOfScreen(this.tempVec)) {
        if (labelState.lastVisible) {
          labelState.element.style.visibility = 'hidden';
          labelState.lastVisible = false;
        }
      } else {
        if (!labelState.lastVisible) {
          labelState.element.style.visibility = 'visible';
          labelState.lastVisible = true;
        }

        const screenX = Math.round((this.tempVec.x * 0.5 + 0.5) * screenWidth);
        const screenY = Math.round((-(this.tempVec.y * 0.5) + 0.5) * screenHeight);

        if (screenX !== labelState.lastX || screenY !== labelState.lastY) {
          labelState.element.style.transform = `translate3d(${screenX}px, ${screenY}px, 0) translate(-50%, -100%)`;
          labelState.lastX = screenX;
          labelState.lastY = screenY;
        }

        // 満車（最大乗車人数到達）時はハイライトスタイルを適用（差分がある場合のみtoggle）
        const maxCap = getMaxCapacity(train.model, train.carCount);
        const isFull = maxCap > 0 && (train.passengers ?? 0) >= maxCap;
        if (labelState.isFull !== isFull) {
          labelState.element.classList.toggle('full', isFull);
          labelState.isFull = isFull;
        }

        // 数字のみ表示（差分がある場合のみ代入）
        const text = (train.passengers ?? 0).toLocaleString();
        if (labelState.lastText !== text) {
          labelState.element.textContent = text;
          labelState.lastText = text;
        }
      }
    }

    // 撤去・回送された列車のラベルをDOMから除去
    for (const [id, state] of this.trainLabels.entries()) {
      if (!activeTrainIds.has(id)) {
        state.element.remove();
        this.trainLabels.delete(id);
      }
    }
  }

  /**
   * 現在のスライサー階層に応じた表示可否判定
   */
  private isLayerVisible(tileLayer: GridLayer, displayLayer: GridLayer | 'all'): boolean {
    if (displayLayer === 'all') {
      return tileLayer >= 1; // 地上全階層表示
    }
    return tileLayer === displayLayer;
  }

  /**
   * 正規化デバイス座標（NDC）がカメラ画面外または背後にあるか判定
   */
  private isOutOfScreen(ndc: THREE.Vector3): boolean {
    return ndc.z < -1 || ndc.z > 1 || ndc.x < -1.1 || ndc.x > 1.1 || ndc.y < -1.1 || ndc.y > 1.1;
  }

  /**
   * 全ラベルのクリア・破棄
   */
  public clear(): void {
    for (const state of this.stationLabels.values()) {
      state.element.remove();
    }
    this.stationLabels.clear();

    for (const state of this.trainLabels.values()) {
      state.element.remove();
    }
    this.trainLabels.clear();

    // フローティングバッジもすべて破棄
    const badges = this.container.querySelectorAll('.cargo-floating-toast');
    badges.forEach(b => b.remove());
  }

  /**
   * 貨物列車によるコンテナ納品・販売完了時のワールド内フローティング通知バッジ生成
   * （荷降ろし駅の3D位置からフワッと浮き上がって1.8秒でフェードアウト消去）
   */
  public spawnCargoFloatingBadge(
    worldMap: WorldMap,
    tileX: number,
    tileZ: number,
    layer: GridLayer,
    containers: number,
    revenue: number
  ): void {
    if (!this.lastCamera) return;

    // 駅・ホームの3Dワールド座標を算出
    const baseH = layerToHeight(layer);
    const elevY = (layer === 1) ? worldMap.getElevationOffset(tileX, tileZ) : 0;
    const worldX = tileX * WorldMap.TILE_SIZE;
    const worldY = baseH + elevY + 2.5; // ホーム上空
    const worldZ = tileZ * WorldMap.TILE_SIZE;

    this.tempVec.set(worldX, worldY, worldZ);
    this.tempVec.project(this.lastCamera);

    // カメラ視野外（背後）なら生成しない
    if (this.tempVec.z < -1 || this.tempVec.z > 1) return;

    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    const screenX = (this.tempVec.x * 0.5 + 0.5) * screenWidth;
    const screenY = (-(this.tempVec.y * 0.5) + 0.5) * screenHeight;

    const badge = document.createElement('div');
    badge.className = 'cargo-floating-toast';
    badge.innerHTML = `📦 ${containers}個納品 (+¥${revenue.toLocaleString()}) 魅力度UP!`;
    badge.style.left = `${Math.round(screenX)}px`;
    badge.style.top = `${Math.round(screenY)}px`;
    this.container.appendChild(badge);

    // アニメーション完了後にDOMから確実に削除
    badge.addEventListener('animationend', () => {
      badge.remove();
    });
    // フォールバックタイマー（アニメーションイベント未発火対策）
    setTimeout(() => {
      if (badge.parentNode) badge.remove();
    }, 2000);
  }
}
