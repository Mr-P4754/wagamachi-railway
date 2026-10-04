import * as THREE from 'three';
import { GameMaterials } from './materials';
import { GridLayer } from '../core/types';

/**
 * InstancedMeshManager
 * 大量オブジェクト（直線レール、高架レール、橋脚、架線柱、街路樹等）を
 * THREE.InstancedMesh に集約してドローコール（Draw Calls）を劇的に削減する。
 * スワップ＆ポップ方式（Swap & Pop）による O(1) の高速追加・削除および厳格なメモリ解放を実装。
 *
 * 【大規模発展時のパフォーマンス防壁】
 * InstancedMesh を「種類 × 階層(GridLayer) × 空間リージョン(64×64マス)」単位に分割して保持する。
 * - 階層スライサーで非表示にした階層の InstancedMesh を丸ごと描画対象外にできる
 * - リージョンごとに静的な包囲球を設定し、カメラ外のリージョンを視錐台カリングで除外できる
 */

/** インスタンス種別ごとの共有ジオメトリ・マテリアル定義 */
interface InstanceArchetype {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  ghostMaterial: THREE.Material;
}

/** 種別×階層×リージョン単位の InstancedMesh バケット */
interface ManagedInstancedLayer {
  mesh: THREE.InstancedMesh;
  layerName: string;
  keyToIndex: Map<string, number>;
  indexToKey: Map<number, string>;
  count: number;
  maxCount: number;
  floor: number;
}

export class InstancedMeshManager {
  /** 空間リージョン1辺のマス数（大きすぎるとカリング効率低下、小さすぎるとドローコール増加） */
  private static readonly REGION_TILES = 64;
  /** マス1辺のワールド長 */
  private static readonly TILE_SIZE = 2.0;
  /** リージョン新規生成時の初期容量（不足時は倍々に拡張） */
  private static readonly INITIAL_CAPACITY = 128;
  /** 包囲球の高さ方向の範囲（5F高架〜地上までの橋脚を含む） */
  private static readonly MIN_Y = -10;
  private static readonly MAX_Y = 20;

  private scene: THREE.Scene;
  private container: THREE.Group = new THREE.Group();

  // 種別定義（共有ジオメトリ・マテリアル）
  private archetypes: Map<string, InstanceArchetype> = new Map();

  // バケット管理: キー = `${種別}|${階層}|${リージョンX},${リージョンZ}`
  private layers: Map<string, ManagedInstancedLayer> = new Map();

  // ジオメトリキャッシュ（共有してdispose時に一括解放）
  private sharedGeometries: THREE.BufferGeometry[] = [];

  // 階層スライサーによる表示設定（'all' または各階層）
  private currentDisplayLayer: GridLayer | 'all' = 'all';

  // 一時計算用（GC削減）
  private readonly tempMatrix = new THREE.Matrix4();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.container.name = 'InstancedMeshContainer';
    this.container.matrixAutoUpdate = false;
    this.scene.add(this.container);

    this.initGeometriesAndLayers();
  }

  /**
   * ジオメトリ構築およびInstancedMeshレイヤーの初期化
   */
  private initGeometriesAndLayers(): void {
    // 1. 直線地上レール (Ballast, Sleepers, Rails)
    // 1-a. バラスト
    const ballastGeo = new THREE.BoxGeometry(1.6, 0.16, 2.0);
    ballastGeo.translate(0, 0.08, 0);
    this.createLayer('rail_ground_ballast', ballastGeo, GameMaterials.ballastMat);

    // 1-b. 枕木 (5本を単一ジオメトリにマージ)
    const sleeperGeo = this.createMergedSleepersGeometry(1.4, 0.08, 0.16, 0.18, 5);
    this.createLayer('rail_ground_sleepers', sleeperGeo, GameMaterials.sleeperMat);

    // 1-c. レール (左右2本マージ)
    const railGeo = this.createMergedRailsGeometry(0.06, 0.1, 2.0, 0.24, 0.45);
    this.createLayer('rail_ground_rails', railGeo, GameMaterials.railMat);

    // 2. 直線高架レール (Deck & Walls, Sleepers, Rails)
    // 2-a. 高架デッキと左右側壁
    const elevatedStructureGeo = this.createElevatedStructureGeometry();
    this.createLayer('rail_elevated_structure', elevatedStructureGeo, GameMaterials.concreteMat);

    // 2-b. 高架枕木
    const elevatedSleeperGeo = this.createMergedSleepersGeometry(1.3, 0.06, 0.16, 0.38, 5);
    this.createLayer('rail_elevated_sleepers', elevatedSleeperGeo, GameMaterials.sleeperMat);

    // 2-c. 高架レール
    const elevatedRailGeo = this.createMergedRailsGeometry(0.06, 0.1, 2.0, 0.44, 0.45);
    this.createLayer('rail_elevated_rails', elevatedRailGeo, GameMaterials.railMat);

    // 3. 標準橋脚 (Pier)
    const pierGeo = new THREE.BoxGeometry(0.8, 3.0, 0.8);
    pierGeo.translate(0, -1.5, 0);
    this.createLayer('standard_pier', pierGeo, GameMaterials.concreteMat);

    // 4. 架線柱 (Catenary Pole)
    const poleGeo = this.createCatenaryPoleGeometry();
    this.createLayer('catenary_pole', poleGeo, GameMaterials.poleMat);

    // 5. 街路樹 (Tree - Trunk & Foliage)
    const trunkGeo = new THREE.CylinderGeometry(0.08, 0.12, 0.8, 6);
    trunkGeo.translate(0, 0.4, 0);
    this.createLayer('tree_trunk', trunkGeo, GameMaterials.woodTrunkMat);

    const foliageGeo = this.createTreeFoliageGeometry();
    this.createLayer('tree_foliage', foliageGeo, GameMaterials.foliageMats[0]);
  }

  /**
   * インスタンス種別（共有ジオメトリ・マテリアル・ゴーストマテリアル）の登録
   * 実際の InstancedMesh は、インスタンスが配置された階層×リージョンごとに遅延生成する
   */
  private createLayer(
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material
  ): void {
    const ghostMaterial = material.clone();
    ghostMaterial.transparent = true;
    ghostMaterial.opacity = 0.28;
    ghostMaterial.depthWrite = false;
    this.sharedGeometries.push(geometry);
    this.archetypes.set(name, { geometry, material, ghostMaterial });
  }

  /**
   * タイルキー（"x,z,layer"）から所属する階層・リージョンを算出
   */
  private static parseTileKey(tileKey: string): { floor: number; rx: number; rz: number } {
    const parts = tileKey.split(',');
    const x = parseInt(parts[0], 10) || 0;
    const z = parseInt(parts[1], 10) || 0;
    const floor = parts.length > 2 ? (parseInt(parts[2], 10) || 1) : 1;
    const n = InstancedMeshManager.REGION_TILES;
    return { floor, rx: Math.floor(x / n), rz: Math.floor(z / n) };
  }

  /**
   * バケットキーの生成
   */
  private static bucketKey(name: string, tileKey: string): string {
    const { floor, rx, rz } = InstancedMeshManager.parseTileKey(tileKey);
    return `${name}|${floor}|${rx},${rz}`;
  }

  /**
   * リージョン全体を包む静的な包囲球（インスタンス追加・削除のたびに再計算しないための固定値）
   */
  private static createRegionBoundingSphere(rx: number, rz: number): THREE.Sphere {
    const n = InstancedMeshManager.REGION_TILES;
    const ts = InstancedMeshManager.TILE_SIZE;
    const box = new THREE.Box3(
      new THREE.Vector3(rx * n * ts - ts, InstancedMeshManager.MIN_Y, rz * n * ts - ts),
      new THREE.Vector3((rx + 1) * n * ts + ts, InstancedMeshManager.MAX_Y, (rz + 1) * n * ts + ts)
    );
    return box.getBoundingSphere(new THREE.Sphere());
  }

  /**
   * InstancedMesh の生成（共通設定）
   */
  private createInstancedMesh(archetype: InstanceArchetype, capacity: number, boundingSphere: THREE.Sphere): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(archetype.geometry, archetype.material, capacity);
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    // リージョン単位の静的包囲球を与え、カメラ外のリージョンを視錐台カリングで除外する
    mesh.boundingSphere = boundingSphere;
    mesh.frustumCulled = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return mesh;
  }

  /**
   * バケットの取得（存在しなければ create=true の場合のみ生成）
   */
  private getBucket(name: string, tileKey: string, create: boolean): ManagedInstancedLayer | undefined {
    const key = InstancedMeshManager.bucketKey(name, tileKey);
    let layer = this.layers.get(key);
    if (layer || !create) return layer;

    const archetype = this.archetypes.get(name);
    if (!archetype) return undefined;

    const { floor, rx, rz } = InstancedMeshManager.parseTileKey(tileKey);
    const capacity = InstancedMeshManager.INITIAL_CAPACITY;
    const mesh = this.createInstancedMesh(archetype, capacity, InstancedMeshManager.createRegionBoundingSphere(rx, rz));
    mesh.name = `Instanced_${key}`;
    mesh.visible = false; // インスタンス0件の間は描画対象外
    this.container.add(mesh);

    layer = {
      mesh,
      layerName: name,
      keyToIndex: new Map(),
      indexToKey: new Map(),
      count: 0,
      maxCount: capacity,
      floor
    };
    this.layers.set(key, layer);
    return layer;
  }

  /**
   * インスタンス数・階層スライス状態に応じたバケットの表示状態および通常/ゴーストマテリアルを更新
   */
  private refreshBucketVisibility(layer: ManagedInstancedLayer): void {
    if (layer.count === 0) {
      layer.mesh.visible = false;
      return;
    }

    const archetype = this.archetypes.get(layer.layerName);
    if (!archetype) return;

    if (this.currentDisplayLayer === 'all') {
      // All 表示: 地上階層（1F以上）を通常表示
      const isVisible = layer.floor >= 1;
      layer.mesh.visible = isVisible;
      if (isVisible) {
        layer.mesh.material = archetype.material;
      }
    } else {
      const targetFloor = this.currentDisplayLayer;
      const isUnderground = targetFloor < 0;
      const isTarget = layer.floor === targetFloor;
      // 地上スライス時: 地上全階層（1F以上）を表示（選択階層は通常、他階層は半透明ゴースト）
      // 地下スライス時: 地下全階層および地上階層を表示
      const isVisible = isUnderground ? true : layer.floor >= 1;
      layer.mesh.visible = isVisible;
      if (isVisible) {
        layer.mesh.material = isTarget ? archetype.material : archetype.ghostMaterial;
      }
    }
  }

  /**
   * 枕木5本の複合ジオメトリ生成
   */
  private createMergedSleepersGeometry(
    width: number,
    height: number,
    depth: number,
    yPos: number,
    count: number
  ): THREE.BufferGeometry {
    const singleGeo = new THREE.BoxGeometry(width, height, depth);
    const geos: THREE.BufferGeometry[] = [];
    for (let i = 0; i < count; i++) {
      const g = singleGeo.clone();
      const zOffset = (i / (count - 1) - 0.5) * 1.5;
      g.translate(0, yPos, zOffset);
      geos.push(g);
    }
    singleGeo.dispose();
    return this.mergeBufferGeometries(geos);
  }

  /**
   * 左右2本レールの複合ジオメトリ生成
   */
  private createMergedRailsGeometry(
    width: number,
    height: number,
    length: number,
    yPos: number,
    xOffset: number
  ): THREE.BufferGeometry {
    const singleGeo = new THREE.BoxGeometry(width, height, length);
    const gLeft = singleGeo.clone();
    gLeft.translate(-xOffset, yPos, 0);
    const gRight = singleGeo.clone();
    gRight.translate(xOffset, yPos, 0);
    singleGeo.dispose();
    return this.mergeBufferGeometries([gLeft, gRight]);
  }

  /**
   * 高架デッキと左右側壁の複合コンクリートジオメトリ生成
   */
  private createElevatedStructureGeometry(): THREE.BufferGeometry {
    const deck = new THREE.BoxGeometry(2.0, 0.35, 2.0);
    deck.translate(0, 0.175, 0);

    const wallL = new THREE.BoxGeometry(0.12, 0.65, 2.0);
    wallL.translate(-0.94, 0.45, 0);

    const wallR = new THREE.BoxGeometry(0.12, 0.65, 2.0);
    wallR.translate(0.94, 0.45, 0);

    return this.mergeBufferGeometries([deck, wallL, wallR]);
  }

  /**
   * 架線柱（両側ポール＋横梁）の複合ジオメトリ生成
   */
  private createCatenaryPoleGeometry(): THREE.BufferGeometry {
    const p1 = new THREE.CylinderGeometry(0.04, 0.04, 1.6, 6);
    p1.translate(-0.95, 0.95, 0);

    const p2 = new THREE.CylinderGeometry(0.04, 0.04, 1.6, 6);
    p2.translate(0.95, 0.95, 0);

    const beam = new THREE.BoxGeometry(2.0, 0.06, 0.06);
    beam.translate(0, 1.75, 0);

    return this.mergeBufferGeometries([p1, p2, beam]);
  }

  /**
   * 樹木の葉（2つの十二面体）の複合ジオメトリ生成
   */
  private createTreeFoliageGeometry(): THREE.BufferGeometry {
    const l1 = new THREE.DodecahedronGeometry(0.65, 1);
    l1.translate(0, 1.0, 0);

    const l2 = new THREE.DodecahedronGeometry(0.48, 1);
    l2.translate(0.2, 1.4, -0.1);

    return this.mergeBufferGeometries([l1, l2]);
  }

  /**
   * 複数の BufferGeometry を単一ジオメトリに結合
   */
  private mergeBufferGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
    let totalPositions = 0;
    let totalNormals = 0;
    let totalIndices = 0;

    for (const g of geos) {
      totalPositions += g.attributes.position.array.length;
      if (g.attributes.normal) totalNormals += g.attributes.normal.array.length;
      if (g.index) totalIndices += g.index.array.length;
    }

    const mergedPositions = new Float32Array(totalPositions);
    const mergedNormals = new Float32Array(totalNormals);
    const mergedIndices = new Uint32Array(totalIndices);

    let posOffset = 0;
    let normOffset = 0;
    let indexOffset = 0;
    let vertexBase = 0;

    for (const g of geos) {
      const pos = g.attributes.position.array as Float32Array;
      mergedPositions.set(pos, posOffset);
      posOffset += pos.length;

      if (g.attributes.normal) {
        const norm = g.attributes.normal.array as Float32Array;
        mergedNormals.set(norm, normOffset);
        normOffset += norm.length;
      }

      if (g.index) {
        const idx = g.index.array;
        for (let i = 0; i < idx.length; i++) {
          mergedIndices[indexOffset + i] = idx[i] + vertexBase;
        }
        indexOffset += idx.length;
      }
      vertexBase += g.attributes.position.count;
      g.dispose();
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(mergedPositions, 3));
    if (totalNormals > 0) {
      merged.setAttribute('normal', new THREE.BufferAttribute(mergedNormals, 3));
    }
    if (totalIndices > 0) {
      merged.setIndex(new THREE.BufferAttribute(mergedIndices, 1));
    }
    return merged;
  }

  /**
   * 単一レイヤーへのインスタンス配置 / 更新（内部用）
   */
  private setLayerInstance(layerName: string, key: string, matrix: THREE.Matrix4, tileKey: string = key): void {
    const layer = this.getBucket(layerName, tileKey, true);
    if (!layer) return;

    let index = layer.keyToIndex.get(key);
    if (index === undefined) {
      if (layer.count >= layer.maxCount) {
        this.expandLayerCapacity(layer);
      }
      index = layer.count;
      layer.count++;
      layer.keyToIndex.set(key, index);
      layer.indexToKey.set(index, key);
      layer.mesh.count = layer.count;
      this.refreshBucketVisibility(layer);
    }

    layer.mesh.setMatrixAt(index, matrix);
    layer.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * 単一レイヤーからのインスタンス削除（O(1) スワップ＆ポップ）
   */
  private removeLayerInstance(layerName: string, key: string, tileKey: string = key): void {
    // 削除時はバケットを新規生成しない（未配置キーへの削除要求が頻繁に発生するため）
    const layer = this.getBucket(layerName, tileKey, false);
    if (!layer) return;

    const index = layer.keyToIndex.get(key);
    if (index === undefined) return;

    const lastIndex = layer.count - 1;
    if (index !== lastIndex) {
      // 末尾の matrix を削除対象位置にコピー
      layer.mesh.getMatrixAt(lastIndex, this.tempMatrix);
      layer.mesh.setMatrixAt(index, this.tempMatrix);

      // マッピングを更新
      const lastKey = layer.indexToKey.get(lastIndex)!;
      layer.keyToIndex.set(lastKey, index);
      layer.indexToKey.set(index, lastKey);
    }

    layer.keyToIndex.delete(key);
    layer.indexToKey.delete(lastIndex);
    layer.count--;
    layer.mesh.count = layer.count;
    layer.mesh.instanceMatrix.needsUpdate = true;
    this.refreshBucketVisibility(layer);
  }

  /**
   * 容量不足時の動的拡張
   */
  private expandLayerCapacity(layer: ManagedInstancedLayer): void {
    const newCapacity = layer.maxCount * 2;
    const oldMesh = layer.mesh;
    const archetype = this.archetypes.get(layer.layerName);
    if (!archetype) return;

    const isTarget = this.currentDisplayLayer === 'all'
      ? layer.floor >= 1
      : layer.floor === this.currentDisplayLayer;
    const activeMaterial = isTarget ? archetype.material : archetype.ghostMaterial;

    const newMesh = this.createInstancedMesh(
      { geometry: archetype.geometry, material: activeMaterial, ghostMaterial: archetype.ghostMaterial },
      newCapacity,
      oldMesh.boundingSphere ?? new THREE.Sphere()
    );
    newMesh.name = oldMesh.name;
    newMesh.count = layer.count;
    newMesh.visible = oldMesh.visible;

    // 既存の行列配列を一括コピー
    (newMesh.instanceMatrix.array as Float32Array).set(
      (oldMesh.instanceMatrix.array as Float32Array).subarray(0, layer.count * 16)
    );
    newMesh.instanceMatrix.needsUpdate = true;

    this.container.remove(oldMesh);
    this.container.add(newMesh);
    // 旧 InstancedMesh の instanceMatrix GPU バッファを解放（共有ジオメトリ・マテリアルは解放しない）
    oldMesh.dispose();

    layer.mesh = newMesh;
    layer.maxCount = newCapacity;
  }

  // ==========================================
  // 高レベルAPI（タイルの配置・撤去と直結）
  // ==========================================

  /**
   * 直線地上レール (rail_ground) の配置
   */
  public setGroundTrack(key: string, matrix: THREE.Matrix4, hasPole: boolean = false): void {
    this.setLayerInstance('rail_ground_ballast', key, matrix);
    this.setLayerInstance('rail_ground_sleepers', key, matrix);
    this.setLayerInstance('rail_ground_rails', key, matrix);
    if (hasPole) {
      this.setLayerInstance('catenary_pole', `pole_${key}`, matrix, key);
    } else {
      this.removeLayerInstance('catenary_pole', `pole_${key}`, key);
    }
  }

  /**
   * 直線地上レールの撤去
   */
  public removeGroundTrack(key: string): void {
    this.removeLayerInstance('rail_ground_ballast', key);
    this.removeLayerInstance('rail_ground_sleepers', key);
    this.removeLayerInstance('rail_ground_rails', key);
    this.removeLayerInstance('catenary_pole', `pole_${key}`, key);
  }

  /**
   * 直線高架レール (rail_elevated) の配置
   * pierMatrices に各階層（上層から地上まで）の橋脚マトリクス配列を受け取り、完全な支柱を描画する
   */
  public setElevatedTrack(key: string, matrix: THREE.Matrix4, pierMatrices: THREE.Matrix4[] | boolean = true): void {
    this.setLayerInstance('rail_elevated_structure', key, matrix);
    this.setLayerInstance('rail_elevated_sleepers', key, matrix);
    this.setLayerInstance('rail_elevated_rails', key, matrix);

    this.removeElevatedPiers(key);

    // 橋脚は所属する高架線路と同じ階層バケットに入れ、スライサーで線路と一緒に表示切替する
    if (Array.isArray(pierMatrices)) {
      for (let i = 0; i < pierMatrices.length; i++) {
        this.setLayerInstance('standard_pier', `pier_${key}_${i}`, pierMatrices[i], key);
      }
    } else if (pierMatrices === true) {
      this.setLayerInstance('standard_pier', `pier_${key}_0`, matrix, key);
    }
  }

  /**
   * 直線高架レールの撤去
   */
  public removeElevatedTrack(key: string): void {
    this.removeLayerInstance('rail_elevated_structure', key);
    this.removeLayerInstance('rail_elevated_sleepers', key);
    this.removeLayerInstance('rail_elevated_rails', key);
    this.removeElevatedPiers(key);
  }

  /**
   * 特定高架レールに紐づく全階層分の橋脚インスタンスを削除
   */
  private removeElevatedPiers(key: string): void {
    for (let i = 0; i < 6; i++) {
      this.removeLayerInstance('standard_pier', `pier_${key}_${i}`, key);
    }
    this.removeLayerInstance('standard_pier', `pier_${key}`, key);
  }

  /**
   * 街路樹 (nature) の配置
   */
  public setTree(key: string, matrix: THREE.Matrix4): void {
    this.setLayerInstance('tree_trunk', key, matrix);
    this.setLayerInstance('tree_foliage', key, matrix);
  }

  /**
   * 街路樹の撤去
   */
  public removeTree(key: string): void {
    this.removeLayerInstance('tree_trunk', key);
    this.removeLayerInstance('tree_foliage', key);
  }

  /**
   * 全インスタンスのクリア
   */
  public clearAll(): void {
    // バケット単位の InstancedMesh を破棄（共有ジオメトリ・マテリアルは保持）
    for (const layer of this.layers.values()) {
      this.container.remove(layer.mesh);
      layer.mesh.dispose();
    }
    this.layers.clear();
  }

  /**
   * コンテナ表示/非表示の切り替え（地下階層作業時の非表示化など）
   */
  public setVisible(visible: boolean): void {
    this.container.visible = visible;
  }

  /**
   * 階層スライサーの表示設定を行い、全バケットへ即時反映する
   */
  public setDisplayLayer(displayLayer: GridLayer | 'all'): void {
    this.currentDisplayLayer = displayLayer;
    for (const layer of this.layers.values()) {
      this.refreshBucketVisibility(layer);
    }
  }

  /**
   * 厳格なメモリ解放（全ジオメトリ・InstancedMeshのGPU破棄）
   */
  public dispose(): void {
    for (const layer of this.layers.values()) {
      this.container.remove(layer.mesh);
      layer.mesh.dispose();
      // マテリアルは GameMaterials の共有マテリアルのためここでは dispose しない
    }
    for (const geo of this.sharedGeometries) {
      geo.dispose();
    }
    this.sharedGeometries = [];
    this.archetypes.clear();
    this.layers.clear();
    this.scene.remove(this.container);
  }
}
