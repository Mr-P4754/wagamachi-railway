import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GameMaterials } from '../materials';

/**
 * 焼き込み済みの描画パーツ（マテリアル単位で結合した共有ジオメトリ）
 */
interface BakedPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  castShadow: boolean;
  receiveShadow: boolean;
}

/**
 * 建物アーキタイプ（種別×レベル×バリエーション）ごとの焼き込み結果
 * - detail: 近景用（全ディテール）
 * - simple: 遠景用（主要ボリューム＋窓のみ。屋上設備・手すり等の小物を省略）
 */
interface BakedArchetype {
  detail: BakedPart[];
  simple: BakedPart[];
}

/** 建物LOD段階 */
export type BuildingLodTier = 'detail' | 'simple';

/**
 * BuildingBakery
 * 建物メッシュ（窓1枚ごとに Mesh を持つ数十パーツ構成）を、マテリアル単位で 1 ジオメトリに結合して
 * アーキタイプごとにキャッシュする。これにより 1 棟あたりのドローコールを 約60 → 3〜5 に削減し、
 * ジオメトリの GPU バッファも棟数によらずアーキタイプ数ぶんのみとなる。
 *
 * また、正投影カメラでは距離ベースの THREE.LOD が機能しないため、ズーム段階に応じた
 * 独自の 2 段階 LOD（detail / simple）を提供する。
 */
export class BuildingBakery {
  private static cache = new Map<string, BakedArchetype>();
  private static currentTier: BuildingLodTier = 'detail';

  /** 子オブジェクト名（LOD切替用） */
  private static readonly DETAIL_NAME = 'building_lod_detail';
  private static readonly SIMPLE_NAME = 'building_lod_simple';

  /**
   * キャッシュ済みアーキタイプから建物 Group を生成する（未キャッシュなら factory で原型を生成して焼き込む）
   * @param key アーキタイプ識別キー（形状・マテリアルが一意に決まる組み合わせ）
   * @param factory 原型（多パーツ構成の Group）を生成する関数
   */
  public static build(key: string, factory: () => THREE.Group): THREE.Group {
    let archetype = this.cache.get(key);
    if (!archetype) {
      const source = factory();
      archetype = this.bake(source);
      this.disposeSource(source);
      this.cache.set(key, archetype);
    }

    const root = new THREE.Group();
    root.name = `Building_${key}`;
    const detail = this.createPartsGroup(archetype.detail);
    detail.name = this.DETAIL_NAME;
    const simple = this.createPartsGroup(archetype.simple);
    simple.name = this.SIMPLE_NAME;
    root.add(detail, simple);
    root.userData.buildingLod = true;
    this.applyTier(root, this.currentTier);
    return root;
  }

  /**
   * 現在の LOD 段階を取得
   */
  public static getTier(): BuildingLodTier {
    return this.currentTier;
  }

  /**
   * LOD 段階を変更する（以後生成される建物にも適用）
   * @returns 段階が変化した場合 true（呼び出し側で既存建物へ applyTier を一括適用する）
   */
  public static setTier(tier: BuildingLodTier): boolean {
    if (this.currentTier === tier) return false;
    this.currentTier = tier;
    return true;
  }

  /**
   * 建物 Group に LOD 段階を適用する（建物以外の Group は無視）
   */
  public static applyTier(root: THREE.Object3D, tier: BuildingLodTier = this.currentTier): void {
    if (!root.userData?.buildingLod) return;
    const isDetail = tier === 'detail';
    for (const child of root.children) {
      if (child.name === this.DETAIL_NAME) child.visible = isDetail;
      else if (child.name === this.SIMPLE_NAME) child.visible = !isDetail;
    }
  }

  /**
   * キャッシュされたすべての建物の結合ジオメトリを破棄し、キャッシュを完全にクリアする。
   * （マテリアルは GameMaterials の共有物であるため解放しない）
   */
  public static clearCache(): void {
    const disposedGeometries = new Set<THREE.BufferGeometry>();

    for (const archetype of this.cache.values()) {
      const allParts = [...archetype.detail, ...archetype.simple];
      for (const part of allParts) {
        if (part && part.geometry && !disposedGeometries.has(part.geometry)) {
          disposedGeometries.add(part.geometry);
          part.geometry.dispose();
        }
      }
    }

    this.cache.clear();
  }

  /**
   * 焼き込み済みパーツ群から描画用 Group を生成（ジオメトリ・マテリアルは共有）
   */
  private static createPartsGroup(parts: BakedPart[]): THREE.Group {
    const group = new THREE.Group();
    for (const part of parts) {
      const mesh = new THREE.Mesh(part.geometry, part.material);
      mesh.castShadow = part.castShadow;
      mesh.receiveShadow = part.receiveShadow;
      mesh.matrixAutoUpdate = false; // 建物内パーツは静的
      group.add(mesh);
    }
    return group;
  }

  /**
   * 原型 Group をマテリアル単位で焼き込み、detail / simple の 2 段階を生成する
   */
  private static bake(source: THREE.Group): BakedArchetype {
    source.position.set(0, 0, 0);
    source.rotation.set(0, 0, 0);
    source.updateMatrixWorld(true);

    const meshes: THREE.Mesh[] = [];
    source.traverse(obj => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && !Array.isArray(mesh.material)) meshes.push(mesh);
    });

    const detail = this.mergeByMaterial(meshes);
    // 遠景では主要ボリューム（影を落とす/受ける本体）と窓（夜間の発光演出を維持するため）のみ残す
    const simpleMeshes = meshes.filter(m =>
      m.castShadow || m.receiveShadow || m.material === GameMaterials.windowDayMat
    );
    const simple = simpleMeshes.length > 0 ? this.mergeByMaterial(simpleMeshes) : detail;
    return { detail, simple };
  }

  /**
   * Mesh 群をマテリアルごとに 1 ジオメトリへ結合する
   */
  private static mergeByMaterial(meshes: THREE.Mesh[]): BakedPart[] {
    const buckets = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; castShadow: boolean; receiveShadow: boolean }>();
    for (const mesh of meshes) {
      const material = mesh.material as THREE.Material;
      const geo = mesh.geometry.clone();
      geo.applyMatrix4(mesh.matrixWorld);
      // 結合時の属性不一致を防ぐため、位置・法線・UV のみを残す
      for (const name of Object.keys(geo.attributes)) {
        if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
      }
      const bucket = buckets.get(material) ?? { geos: [], castShadow: false, receiveShadow: false };
      bucket.geos.push(geo);
      bucket.castShadow ||= mesh.castShadow;
      bucket.receiveShadow ||= mesh.receiveShadow;
      buckets.set(material, bucket);
    }

    const parts: BakedPart[] = [];
    for (const [material, bucket] of buckets) {
      // インデックス有無が混在する場合は非インデックス形式に統一して結合
      const mixed = bucket.geos.some(g => g.index) && bucket.geos.some(g => !g.index);
      const geos = mixed
        ? bucket.geos.map(g => (g.index ? g.toNonIndexed() : g))
        : bucket.geos;
      const merged = mergeGeometries(geos, false);
      for (const g of bucket.geos) g.dispose();
      if (mixed) for (const g of geos) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      // アーキタイプ間で共有するため disposeHierarchy による解放対象から除外
      merged.userData.keepAlive = true;
      parts.push({
        geometry: merged,
        material,
        castShadow: bucket.castShadow,
        receiveShadow: bucket.receiveShadow
      });
    }
    return parts;
  }

  /**
   * 焼き込み元の原型ジオメトリを解放（マテリアルは GameMaterials の共有物のため解放しない）
   */
  private static disposeSource(source: THREE.Group): void {
    const disposed = new Set<THREE.BufferGeometry>();
    source.traverse(obj => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && !disposed.has(mesh.geometry)) {
        disposed.add(mesh.geometry);
        mesh.geometry.dispose();
      }
    });
  }
}
