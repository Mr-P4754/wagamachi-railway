import * as THREE from 'three';
import { GridLayer } from '../core/types';
import { layerToHeight } from '../core/Grid3D';
import { WorldMap } from '../simulation/WorldMap';
import { ZoneManager } from '../core/ZoneManager';
import { CargoSystem } from '../core/CargoSystem';
import { disposeHierarchy } from './materials';

/**
 * 貨物ヤードのコンテナ描画演出およびRCIゾーニング3D半透明オーバーレイの管理クラス
 */
export class VisualEffectManager {
  private scene: THREE.Scene;
  private worldMap: WorldMap;
  private zoneManager: ZoneManager;
  private cargoSystem: CargoSystem;

  // RCIゾーニング半透明オーバーレイ
  private zoneOverlayGroup: THREE.Group = new THREE.Group();
  private zoneOverlayMeshes: Map<string, THREE.Mesh> = new Map();

  // 貨物ヤードのコンテナ段数視覚演出管理
  private cargoYardMeshes: Map<string, THREE.Group> = new Map();
  private cargoYardSignatures: Map<string, string> = new Map();

  // 貨物ヤードのコンテナ共有ジオメトリ（全コンテナで使い回し、disposeHierarchy の解放対象外）
  private readonly cargoContainerGeo: THREE.BoxGeometry = (() => {
    const geo = new THREE.BoxGeometry(0.55, 0.42, 0.85);
    geo.userData.keepAlive = true;
    return geo;
  })();

  // 貨物ヤードのコンテナ共有マテリアル（JR貨物19Dエンジ, 18D青, 通風緑, JOT黄）
  private readonly cargoContainerMats: THREE.MeshStandardMaterial[] = [0x831843, 0x1d4ed8, 0x15803d, 0xd97706].map(color => {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2 });
    mat.userData.keepAlive = true;
    return mat;
  });

  constructor(scene: THREE.Scene, worldMap: WorldMap, zoneManager: ZoneManager, cargoSystem: CargoSystem) {
    this.scene = scene;
    this.worldMap = worldMap;
    this.zoneManager = zoneManager;
    this.cargoSystem = cargoSystem;

    this.zoneOverlayGroup.name = 'ZoneOverlayGroup';
    this.scene.add(this.zoneOverlayGroup);
  }

  /**
   * ゾーンブラシで塗った区画の3D半透明マーカーを更新（追加・色変更）
   */
  public refreshZoneOverlay(cells: { x: number; z: number }[]): void {
    for (const { x, z } of cells) {
      const key = `${x},${z}`;
      const zone = this.zoneManager.getZone(x, z);
      let mesh = this.zoneOverlayMeshes.get(key);
      if (!zone) {
        if (mesh) {
          this.zoneOverlayGroup.remove(mesh);
          this.zoneOverlayMeshes.delete(key);
        }
        continue;
      }
      const color = zone.type === 'residential' ? 0x22c55e : zone.type === 'commercial' ? 0x3b82f6 : 0xeab308;
      const groundH = this.worldMap.getElevationOffset(x, z);
      if (!mesh) {
        const geo = new THREE.PlaneGeometry(WorldMap.TILE_SIZE * 0.94, WorldMap.TILE_SIZE * 0.94);
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.32, depthWrite: false });
        mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(x * WorldMap.TILE_SIZE, groundH + 0.04, z * WorldMap.TILE_SIZE);
        this.zoneOverlayGroup.add(mesh);
        this.zoneOverlayMeshes.set(key, mesh);
      } else {
        mesh.position.set(x * WorldMap.TILE_SIZE, groundH + 0.04, z * WorldMap.TILE_SIZE);
        (mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
      }
    }
  }

  /**
   * ゾーン解除ブラシの範囲内にある3Dマーカーを撤去
   */
  public refreshZoneOverlayClear(x: number, z: number, radius: number): void {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.hypot(dx, dz) > radius + 0.4) continue;
        const key = `${x + dx},${z + dz}`;
        const mesh = this.zoneOverlayMeshes.get(key);
        if (mesh) {
          this.zoneOverlayGroup.remove(mesh);
          this.zoneOverlayMeshes.delete(key);
        }
      }
    }
  }

  /**
   * すべてのゾーンオーバーレイをクリア
   */
  public clearAllZoneOverlays(): void {
    for (const mesh of this.zoneOverlayMeshes.values()) {
      this.zoneOverlayGroup.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.zoneOverlayMeshes.clear();
  }

  /**
   * 貨物駅グループのコンテナ描写（1個単位のリアルタイム増減・最大3段）視覚演出の更新
   */
  public updateCargoYardVisual(x: number, z: number, layer: GridLayer, currentDisplayLayer: GridLayer | 'all' = 1): void {
    const tile = this.worldMap.getTile(x, z, layer);
    if (!tile || (!tile.type.startsWith('cargo_station') && !tile.isCargoYard)) {
      this.removeCargoYardVisual(x, z, layer);
      return;
    }

    // 駅グループ全体のタイル群と合計コンテナ数を取得
    const stTiles = this.worldMap.getStationTiles(x, z, layer);
    const stationTiles = stTiles.length > 0 ? stTiles : [tile];

    // 商業エリアの駅はコンテナを蓄積せず即時販売するため、描写は0個
    const isCommercial = this.cargoSystem.isStationInArea(this.worldMap, x, z, 'commercial', layer);
    const totalContainers = isCommercial ? 0 : this.worldMap.getStationCargoContainers(x, z, layer);

    let remainingToPlace = totalContainers;

    // 駅グループの各タイルごとに最大6個（2列×3段）ずつコンテナを配置
    for (let tIdx = 0; tIdx < stationTiles.length; tIdx++) {
      const curT = stationTiles[tIdx];
      const tLayer = (curT.layer ?? layer) as GridLayer;
      const curKey = `${curT.x},${curT.z},${tLayer}`;
      const placeCount = Math.min(6, Math.max(0, remainingToPlace));

      // 差分判定: 個数・配置に影響する属性が前回と同一なら再構築しない
      const signature = `${placeCount}|${curT.type}|${curT.rotation}|${curT.stationPlatformSide}|${curT.elevationOffset ?? 0}`;
      const hasMesh = this.cargoYardMeshes.has(curKey);
      if (this.cargoYardSignatures.get(curKey) === signature && (hasMesh || placeCount === 0)) {
        remainingToPlace -= placeCount;
        continue;
      }

      this.removeCargoYardVisual(curT.x, curT.z, tLayer);
      this.cargoYardSignatures.set(curKey, signature);

      if (placeCount <= 0) continue;

      const group = new THREE.Group();
      const elevOffset = curT.elevationOffset ?? 0;
      const isElevated = curT.type.includes('elevated') || tLayer >= 2;
      const baseHeight = layerToHeight(tLayer, elevOffset);
      const railBaseHeight = isElevated ? 0.2 : 0;
      const sideMult = curT.stationPlatformSide === 'left' ? -1 : 1;

      group.position.set(curT.x * WorldMap.TILE_SIZE, baseHeight, curT.z * WorldMap.TILE_SIZE);
      if ((curT.rotation % 2) === 1) {
        group.rotation.y = Math.PI / 2;
      }

      // 1マスあたり最大6個のスロット: 列(z=-0.48, +0.48) × 段(0, 1, 2)
      const slotPositions: Array<{ z: number; tier: number }> = [
        { z: -0.48, tier: 0 },
        { z: 0.48, tier: 0 },
        { z: -0.48, tier: 1 },
        { z: 0.48, tier: 1 },
        { z: -0.48, tier: 2 },
        { z: 0.48, tier: 2 }
      ];

      for (let s = 0; s < placeCount; s++) {
        const slot = slotPositions[s];
        const mat = this.cargoContainerMats[(Math.abs(curT.x * 3 + curT.z * 5) + s) % this.cargoContainerMats.length];
        const container = new THREE.Mesh(this.cargoContainerGeo, mat);
        container.position.set(
          1.0 * sideMult,
          railBaseHeight + 0.31 + slot.tier * 0.44,
          slot.z
        );
        container.castShadow = true;
        container.receiveShadow = true;
        group.add(container);
      }
      remainingToPlace -= placeCount;

      group.visible = (currentDisplayLayer === 'all' ? tLayer >= 1 : tLayer === currentDisplayLayer);
      this.scene.add(group);
      this.cargoYardMeshes.set(curKey, group);
    }
  }

  public removeCargoYardVisual(x: number, z: number, layer: GridLayer): void {
    const key = `${x},${z},${layer}`;
    this.cargoYardSignatures.delete(key);
    const existing = this.cargoYardMeshes.get(key);
    if (existing) {
      this.scene.remove(existing);
      disposeHierarchy(existing);
      this.cargoYardMeshes.delete(key);
    }
  }

  public clearAllCargoYardVisuals(): void {
    for (const mesh of this.cargoYardMeshes.values()) {
      this.scene.remove(mesh);
      disposeHierarchy(mesh);
    }
    this.cargoYardMeshes.clear();
    this.cargoYardSignatures.clear();
  }

  /**
   * 階層スライス変更時にコンテナメッシュの可視性を同期
   */
  public applyLayerVisibility(currentDisplayLayer: GridLayer | 'all'): void {
    for (const [key, group] of this.cargoYardMeshes.entries()) {
      const parts = key.split(',');
      const layer = parseInt(parts[2], 10) as GridLayer;
      group.visible = (currentDisplayLayer === 'all' ? layer >= 1 : layer === currentDisplayLayer);
    }
  }

  private cargoVisualTimer: number = 0;

  /**
   * 貨物ヤードのコンテナ段数視覚演出の定期同期（1.5秒周期）
   */
  public update(deltaTime: number): void {
    this.cargoVisualTimer += deltaTime;
    if (this.cargoVisualTimer >= 1.5) {
      this.cargoVisualTimer = 0;
      for (const tile of this.worldMap.getAllTiles()) {
        if (tile.isCargoYard || tile.type.startsWith('cargo_station')) {
          this.updateCargoYardVisual(tile.x, tile.z, (tile.layer ?? 1) as GridLayer);
        }
      }
    }
  }

  /**
   * クリーンアップ
   */
  public dispose(): void {
    this.clearAllZoneOverlays();
    this.clearAllCargoYardVisuals();
    this.scene.remove(this.zoneOverlayGroup);
  }
}
