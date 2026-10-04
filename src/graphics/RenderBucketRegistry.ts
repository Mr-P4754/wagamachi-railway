import * as THREE from 'three';
import { GridLayer } from '../core/types';

/**
 * RenderBucketRegistry
 * 静的タイルメッシュ（建物・駅・曲線/分岐線路など）を「空間チャンク × 階層」単位の Group（バケット）に集約し、
 * 以下の 2 種類のカリングを Group 単位で一括適用する。
 *
 * 1. 視錐台カリング: カメラ視錐台と交差しないバケットを丸ごと非表示にする
 *    （子孫数万個に対する個別の包囲球判定・描画リスト登録を省略）
 * 2. 階層スライスカリング: スライサーで表示対象外となった階層のバケットを丸ごと非表示にする
 *
 * 非表示バケットは matrixWorldAutoUpdate=false とし、毎フレームの行列更新（updateMatrixWorld）の
 * サブツリー走査も完全にスキップする。
 *
 * ※ 個々のタイル単位の細かな表示規則（勾配線路の上下階層跨ぎ表示など）は従来通り tile.mesh.visible で行い、
 *   バケットはその「上位集合」となるよう判定する。
 */
export class RenderBucketRegistry {
  /** バケット1辺のマス数（地形チャンクと同等の粒度） */
  public static readonly BUCKET_TILES = 16;

  /** マス1辺のワールド長 */
  private static readonly TILE_SIZE = 2.0;

  /** バケットの高さ方向の包囲範囲（高層ビル・橋脚・地下構造物を十分に含む余裕値） */
  private static readonly MIN_Y = -10;
  private static readonly MAX_Y = 30;

  /** 影の投影元が画面外にあっても影が欠けないよう、包囲ボックスを水平方向に拡張する余白 */
  private static readonly SHADOW_MARGIN = 8;

  private readonly root = new THREE.Group();
  private readonly buckets = new Map<string, { group: THREE.Group; box: THREE.Box3; layer: GridLayer }>();

  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly lastProjScreen = new THREE.Matrix4();
  private hasLastProj = false;

  private layerFilter: (layer: GridLayer) => boolean = () => true;
  private layerFilterDirty = true;

  constructor(scene: THREE.Scene) {
    this.root.name = 'RenderBucketRoot';
    this.root.matrixAutoUpdate = false;
    scene.add(this.root);
  }

  /**
   * タイル座標からバケットキーを算出
   */
  private static bucketCoords(tileX: number, tileZ: number): { bx: number; bz: number } {
    const n = RenderBucketRegistry.BUCKET_TILES;
    return { bx: Math.floor(tileX / n), bz: Math.floor(tileZ / n) };
  }

  /**
   * 指定タイルの所属バケットを取得（未生成なら生成）
   */
  private getBucket(tileX: number, tileZ: number, layer: GridLayer) {
    const { bx, bz } = RenderBucketRegistry.bucketCoords(tileX, tileZ);
    const key = `${bx},${bz},${layer}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      const n = RenderBucketRegistry.BUCKET_TILES;
      const ts = RenderBucketRegistry.TILE_SIZE;
      const m = RenderBucketRegistry.SHADOW_MARGIN;
      // マス中心は (x * 2.0)、マスは中心から ±1.0 の範囲を占める
      const minX = bx * n * ts - ts / 2 - m;
      const minZ = bz * n * ts - ts / 2 - m;
      const maxX = (bx + 1) * n * ts - ts / 2 + m;
      const maxZ = (bz + 1) * n * ts - ts / 2 + m;
      const box = new THREE.Box3(
        new THREE.Vector3(minX, RenderBucketRegistry.MIN_Y, minZ),
        new THREE.Vector3(maxX, RenderBucketRegistry.MAX_Y, maxZ)
      );

      const group = new THREE.Group();
      group.name = `RenderBucket_${key}`;
      group.matrixAutoUpdate = false; // 原点固定のため自身の行列再計算は不要
      group.visible = false;
      group.matrixWorldAutoUpdate = false;
      this.root.add(group);

      bucket = { group, box, layer };
      this.buckets.set(key, bucket);
      // 新規バケットは次回 update で必ず可視判定させる
      this.hasLastProj = false;
    }
    return bucket;
  }

  /**
   * タイルメッシュをバケットへ登録する（既存の親からは自動的に外れる）
   */
  public add(obj: THREE.Object3D, tileX: number, tileZ: number, layer: GridLayer): void {
    const bucket = this.getBucket(tileX, tileZ, layer);
    bucket.group.add(obj);
    // 非表示バケットに追加された場合でも、表示に切り替わった時点で行列は自動更新される
  }

  /**
   * 階層スライサーの表示階層を設定する
   * @param displayLayer 'all' は地上階（1F以上）すべて
   */
  public setDisplayLayer(displayLayer: GridLayer | 'all'): void {
    if (displayLayer === 'all') {
      this.layerFilter = (layer) => layer >= 1;
    } else if (displayLayer < 0) {
      // 地下スライサー時: 地下全階層および地上も表示対象とする（最終判定はタイル単位）
      this.layerFilter = () => true;
    } else {
      // 地上スライサー時: 他階層のオブジェクトも半透明ゴースト表示するため地上全階層を対象とする
      this.layerFilter = (layer) => layer >= 1;
    }
    this.layerFilterDirty = true;
  }

  /**
   * 毎フレーム呼び出し: カメラが動いた時・階層が変わった時のみ全バケットの可視判定を行う
   */
  public update(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    const cameraMoved = !this.hasLastProj || !this.projScreen.equals(this.lastProjScreen);
    if (!cameraMoved && !this.layerFilterDirty) return;

    this.lastProjScreen.copy(this.projScreen);
    this.hasLastProj = true;
    this.layerFilterDirty = false;
    this.frustum.setFromProjectionMatrix(this.projScreen);

    for (const bucket of this.buckets.values()) {
      // 空バケットは描画コストを持たないため判定対象に含めても問題ない
      const visible = this.layerFilter(bucket.layer) && this.frustum.intersectsBox(bucket.box);
      bucket.group.visible = visible;
      bucket.group.matrixWorldAutoUpdate = visible;
    }
  }

  /**
   * 次回 update で可視判定を強制再計算させる（カメラ切替時など）
   */
  public invalidate(): void {
    this.hasLastProj = false;
  }

  /**
   * 全バケットの破棄（子メッシュの GPU 解放は呼び出し側の disposeHierarchy に委ねる）
   */
  public clear(): void {
    for (const bucket of this.buckets.values()) {
      this.root.remove(bucket.group);
    }
    this.buckets.clear();
    this.hasLastProj = false;
  }
}
