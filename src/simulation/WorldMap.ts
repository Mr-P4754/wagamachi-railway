import * as THREE from 'three';
import { ModelFactory } from '../models/ModelFactory';
import { GridLayer } from '../core/types';
import { Grid3D, layerToHeight } from '../core/Grid3D';
import { StationManager } from '../core/StationManager';
import { disposeHierarchy } from '../graphics/materials';
import { InstancedMeshManager } from '../graphics/InstancedMeshManager';
import { RenderBucketRegistry } from '../graphics/RenderBucketRegistry';
import {
  CurveDirection,
  SwitchState,
  CrossingState,
  TileData,
  TileType,
  TileDataSnapshot,
  TileExit,
  DirVec,
  LEVEL_GROUND,
  LEVEL_ELEVATED,
  SLOPE_PARTS,
  cloneStationSchedule,
  cloneSwitchSchedule,
  cloneTileSnapshot,
  createDefaultStationSchedule,
  createDefaultCargoStationSchedule,
  createDefaultSwitchSchedule
} from './world/types';
import { TrackTopology } from './world/TrackTopology';
import { WorldMapSerializer } from './world/WorldMapSerializer';

export * from './world/types';
export { TrackTopology } from './world/TrackTopology';
export { WorldMapSerializer } from './world/WorldMapSerializer';

export class WorldMap {
  public static GRID_SIZE = 64;
  public static readonly TILE_SIZE = 2.0;

  public static readonly DIRS: DirVec[] = TrackTopology.DIRS;

  public static opposite(idx: number): number {
    return TrackTopology.opposite(idx);
  }

  public static rotateCW(idx: number): number {
    return TrackTopology.rotateCW(idx);
  }

  public static rotateCCW(idx: number): number {
    return TrackTopology.rotateCCW(idx);
  }

  public static curveDirToIndices(cd: CurveDirection): [number, number] {
    return TrackTopology.curveDirToIndices(cd);
  }

  public static indicesToCurveDir(a: number, b: number): CurveDirection {
    return TrackTopology.indicesToCurveDir(a, b);
  }

  public static shouldShowPier(x: number, z: number, rotation: number): boolean {
    return TrackTopology.shouldShowPier(x, z, rotation);
  }

  /**
   * 直線高架レール用橋脚マトリクス配列の算出（地上または直下構造物デッキまで）
   */
  public getElevatedPierMatrices(x: number, z: number, layer: GridLayer, rotation: number): THREE.Matrix4[] {
    const pierMatrices: THREE.Matrix4[] = [];
    if (!WorldMap.shouldShowPier(x, z, rotation)) return pierMatrices;

    const groundH = this.getElevationOffset(x, z);
    for (let l = layer; l >= 2; l--) {
      const pierTopH = layerToHeight(l as GridLayer);
      const pierBottomH = pierTopH - 3.0;
      if (pierBottomH < groundH - 0.01) {
        break;
      }

      const pierDummy = new THREE.Object3D();
      pierDummy.position.set(x * WorldMap.TILE_SIZE, pierTopH, z * WorldMap.TILE_SIZE);
      pierDummy.updateMatrix();
      pierMatrices.push(pierDummy.matrix.clone());

      // 直下の階層に高架線路や駅等がある場合、その上面デッキに着地するためそれより下は生成しない
      if (l - 1 >= 2) {
        const lowerTile = this.getTile(x, z, (l - 1) as GridLayer);
        if (lowerTile && (lowerTile.type.startsWith('rail_') || lowerTile.type.startsWith('station_') || lowerTile.type.startsWith('cargo_station_') || lowerTile.type === 'signal_yard')) {
          break;
        }
      }
    }
    return pierMatrices;
  }

  /**
   * 直上の高架線路の橋脚を再計算・更新する（下層に構造物が設置/撤去された際）
   */
  public updateUpperElevatedPiers(x: number, z: number, startLayer: GridLayer): void {
    for (let l = (startLayer + 1) as GridLayer; l <= 5; l++) {
      const upperTile = this.getTile(x, z, l as GridLayer);
      if (upperTile && upperTile.type === 'rail_elevated') {
        const upperTileKey = `${x},${z},${l}`;
        const upperBaseH = layerToHeight(l as GridLayer);
        const dummy = new THREE.Object3D();
        dummy.position.set(x * WorldMap.TILE_SIZE, upperBaseH, z * WorldMap.TILE_SIZE);
        if (upperTile.rotation === 1) dummy.rotation.y = Math.PI / 2;
        dummy.updateMatrix();
        const pierMatrices = this.getElevatedPierMatrices(x, z, l as GridLayer, upperTile.rotation);
        this.instancedMeshManager.setElevatedTrack(upperTileKey, dummy.matrix, pierMatrices);
      }
    }
  }

  public static getRoadExits(tile: TileData): TileExit[] {
    return TrackTopology.getRoadExits(tile);
  }

  public static getTileExits(tile: TileData): TileExit[] {
    return TrackTopology.getTileExits(tile);
  }

  public gridSize: number = 64;
  private tiles: Map<string, TileData> = new Map();
  public grid3D: Grid3D<TileData> = new Grid3D();
  public activeLayer: GridLayer = 1; // 現在編集・フォーカス中の階層 (-2..5)
  public stationManager: StationManager = new StationManager();
  public instancedMeshManager: InstancedMeshManager;
  /** 静的タイルメッシュの「チャンク×階層」バケット管理（視錐台・階層スライスカリング） */
  public renderBuckets: RenderBucketRegistry;
  private elevationProvider: ((x: number, z: number) => number) | null = null;
  public gridManagerRef: { isWaterAtGroundLevel: (x: number, z: number) => boolean; getCell: (x: number, y: GridLayer, z: number) => any } | null = null;

  /** マップ変更検知ダーティフラグとシリアライズキャッシュ */
  public isDirty: boolean = true;
  public structureVersion: number = 0;
  private cachedSerializedData: string | null = null;
  private cachedAllTiles: TileData[] | null = null;
  private cachedLayerTiles: Map<GridLayer, TileData[]> = new Map();
  private cachedBuildingTiles: TileData[] | null = null;
  private cachedCargoTiles: TileData[] | null = null;

  public markDirty(): void {
    this.isDirty = true;
    this.structureVersion++;
    this.cachedSerializedData = null;
    this.cachedAllTiles = null;
    this.cachedLayerTiles.clear();
    this.cachedBuildingTiles = null;
    this.cachedCargoTiles = null;
  }
  public groundHoleHandler: {
    add: (x: number, z: number, rotation: number) => void;
    remove: (x: number, z: number) => void;
    clear: () => void;
  } | null = null;

  constructor(scene: THREE.Scene, gridSize: number = 64) {
    // タイルメッシュは RenderBucketRegistry / InstancedMeshManager 経由でシーンへ登録する
    this.instancedMeshManager = new InstancedMeshManager(scene);
    this.renderBuckets = new RenderBucketRegistry(scene);
    this.gridSize = gridSize;
    WorldMap.GRID_SIZE = gridSize;
    this.initializeGrid();
  }

  public setGridSize(size: number): void {
    this.gridSize = size;
    WorldMap.GRID_SIZE = size;
    this.clearAll();
  }

  public setActiveLayer(layer: GridLayer): void {
    this.activeLayer = layer;
  }

  /**
   * 現在の表示モードにおいて、指定階層のタイルメッシュが表示対象かどうかを判定
   * 地下モード時は全層可視、地上モード時は 1F 以上を可視とする（スライサーでの半透明・カリングは main 側で制御）
   */
  public isLayerVisibleInCurrentMode(layer: GridLayer): boolean {
    return this.activeLayer < 0 ? true : layer >= 1;
  }

  public setElevationProvider(provider: (x: number, z: number) => number): void {
    this.elevationProvider = provider;
  }

  public getElevationOffset(x: number, z: number): number {
    return this.elevationProvider ? this.elevationProvider(x, z) : 0;
  }

  private getKey(x: number, z: number): string {
    return `${x},${z}`;
  }

  /**
   * タイルメッシュを「チャンク×階層」バケットへ登録し、タイルに紐付ける
   * （シーン直下に数万個を並べると、カリング判定・行列更新が毎フレーム全件走査されるため）
   */
  private attachTileMesh(tile: TileData, mesh: THREE.Group): void {
    this.renderBuckets.add(mesh, tile.x, tile.z, (tile.layer ?? 1) as GridLayer);
    tile.mesh = mesh;
  }

  /**
   * 外部（main.ts 等）で再生成したタイルメッシュを登録するための公開ラッパー
   */
  public attachExternalTileMesh(tile: TileData, mesh: THREE.Group): void {
    this.attachTileMesh(tile, mesh);
  }

  /**
   * 疎（Sparse）マップ構造の初期化
   * 大マップ（512x512, 1024x1024）でのヒープメモリ枯渇を防ぐため、
   * 空タイルオブジェクトを事前生成せず、マップコレクションをクリアして境界サイズのみを定義する
   */
  private initializeGrid() {
    this.tiles.clear();
    this.grid3D.clear();
  }

  /**
   * 指定座標がマップの境界内にあるかを判定する
   */
  public isInBounds(x: number, z: number): boolean {
    const half = Math.floor(this.gridSize / 2);
    // 南端(z = half)・東端(x = half)も北端・西端(-half)と同様に境界線上タイルとして許可
    return x >= -half && x <= half && z >= -half && z <= half;
  }

  /**
   * 指定した階層のタイルを取得する（デフォルトは現在のアクティブ階層）
   * 完全な読み取り専用であり、タイルが存在しない場合は undefined を返却する（メモリリーク防止）
   */
  public getTile(x: number, z: number, layer: GridLayer = this.activeLayer): TileData | undefined {
    // まず指定階層の3Dグリッドを検索
    const tile3D = this.grid3D.get(x, layer, z);
    if (tile3D) return tile3D;

    // 地上1Fの場合、互換性用Mapから取得
    if (layer === 1) {
      const tile1F = this.tiles.get(this.getKey(x, z));
      if (tile1F) return tile1F;
    }

    return undefined;
  }

  /**
   * タイルを取得する。指定座標にタイルが存在しない場合は、マップ境界内であれば
   * 空タイル（TileData）を新規生成・登録して返却する。
   * ※ 建築・敷設など、実際にマップデータを変更する処理でのみ呼び出すこと。
   */
  public getOrCreateTile(x: number, z: number, layer: GridLayer = this.activeLayer): TileData | undefined {
    const existing = this.getTile(x, z, layer);
    if (existing) return existing;

    if (this.isInBounds(x, z)) {
      const newTile: TileData = {
        x,
        z,
        layer,
        type: 'empty',
        rotation: 0,
        level: layer >= 1 ? layer : 0,
        stationPassengers: 0,
        landValue: 100,
        switchState: 'straight'
      };
      this.grid3D.set(x, layer, z, newTile);
      if (layer === 1) {
        this.tiles.set(this.getKey(x, z), newTile);
      }
      return newTile;
    }

    return undefined;
  }

  /**
   * 指定した (x, z) の全階層のタイル一覧を取得
   */
  public getTilesAtColumn(x: number, z: number): Array<{ layer: GridLayer; tile: TileData }> {
    const list = this.grid3D.getColumn(x, z);
    return list.map(item => ({ layer: item.layer, tile: item.value }));
  }

  /**
   * 全階層の有効なタイルを取得する（構造変更時までキャッシュ）
   */
  public getAllTiles(filterLayer?: GridLayer): TileData[] {
    if (this.cachedAllTiles === null) {
      const all: TileData[] = [];
      const seenTiles = new Set<TileData>(); // スロープ跨がり登録による同一インスタンス重複を防止
      const seenGroundKeys = new Set<string>();
      for (const tile of this.grid3D.values()) {
        if (tile.type !== 'empty' && !seenTiles.has(tile)) {
          seenTiles.add(tile);
          all.push(tile);
          if ((tile.layer ?? 1) === 1) {
            seenGroundKeys.add(this.getKey(tile.x, tile.z));
          }
        }
      }
      // 互換性のため地上1Fのタイルもマージ
      for (const tile of this.tiles.values()) {
        if (tile.type !== 'empty' && !seenTiles.has(tile) && !seenGroundKeys.has(this.getKey(tile.x, tile.z))) {
          seenTiles.add(tile);
          all.push(tile);
        }
      }
      this.cachedAllTiles = all;
    }

    if (filterLayer === undefined) {
      return this.cachedAllTiles;
    }

    let layerList = this.cachedLayerTiles.get(filterLayer);
    if (!layerList) {
      layerList = this.cachedAllTiles.filter(
        tile => tile.layer === filterLayer || (filterLayer === 1 && tile.layer === undefined)
      );
      this.cachedLayerTiles.set(filterLayer, layerList);
    }
    return layerList;
  }

  /**
   * LOD対象となる建物タイル一覧を取得（キャッシュ付き）
   */
  public getBuildingTiles(): TileData[] {
    if (this.cachedBuildingTiles === null) {
      this.cachedBuildingTiles = this.getAllTiles().filter(
        t => t.type === 'residence' || t.type === 'commercial' || t.type === 'industrial' || !!t.mesh?.userData?.buildingLod
      );
    }
    return this.cachedBuildingTiles;
  }

  /**
   * 貨物ヤード・貨物駅タイル一覧を取得（キャッシュ付き）
   */
  public getCargoTiles(): TileData[] {
    if (this.cachedCargoTiles === null) {
      this.cachedCargoTiles = this.getAllTiles().filter(
        t => t.isCargoYard || t.type === 'cargo_station_ground' || t.type === 'cargo_station_elevated'
      );
    }
    return this.cachedCargoTiles;
  }

  /**
   * 水辺（海・河川）敷設制約の判定
   * - 地上1F: 水面のため敷設不可
   * - 地上2F以上: 高架橋梁・鉄橋として敷設可能
   * - 地下B1F〜B2F: 海底・河底トンネルとして敷設可能
   */
  public canPlaceAtWater(x: number, z: number, layer: GridLayer): { allowed: boolean; reason?: string } {
    if (!this.gridManagerRef) return { allowed: true };
    const isWater = this.gridManagerRef.isWaterAtGroundLevel(x, z);
    if (!isWater) return { allowed: true };

    if (layer === 1) {
      return {
        allowed: false,
        reason: '水上（地上1F）には敷設できません。地上2F以上の高架橋梁、または地下トンネルをご利用ください。'
      };
    }
    return { allowed: true };
  }

  /**
   * 指定タイルが山岳地表より下を貫く「トンネル区間」かどうかを判定
   */
  public isTunnelSection(x: number, z: number, layer: GridLayer): boolean {
    if (!this.gridManagerRef) return layer < 0;
    const cell = this.gridManagerRef.getCell(x, 1, z);
    const surfaceElevation = cell ? cell.elevation : 1;
    // 地下階層はすべてトンネル
    if (layer < 0) return true;
    // 地上階層でも、地表の標高より低い位置にあればトンネル区間
    return layer < surfaceElevation;
  }

  /**
   * 【Hotfix】地上1Fの線路用の高さオフセットを算出する。
   * 山岳マス（地表標高 > 1F）を貫くトンネル区間では、線路は山の中腹を這い上がるのではなく
   * 常に基準の地表高さ（0）を保ったまま山を貫通させる。トンネルでない通常の平地・丘陵地では
   * 従来通り地表標高に応じたオフセット（丘の上に乗る通常の地上線路）を適用する。
   */
  public getTrackElevationOffset(x: number, z: number, layer: GridLayer): number {
    if (layer !== 1) return 0;
    if (this.isTunnelSection(x, z, layer)) return 0;
    return this.getElevationOffset(x, z);
  }

  /**
   * ② ③ 曲線レール（1マス・斜め接続）の敷設。地上/高架どちらも設置可能。
   */
  public placeCurve(x: number, z: number, curveDir: CurveDirection, isElevated: boolean = false, layer: GridLayer = this.activeLayer): boolean {
    const tile = this.getOrCreateTile(x, z, layer);
    if (!tile) return false;

    const cell = this.gridManagerRef?.getCell(x, 1, z);
    const surfaceElevation = cell ? cell.elevation : 1;
    const effectiveElevated = isElevated && (layer > surfaceElevation);

    const tileType: TileType = effectiveElevated ? 'rail_curve_elevated' : 'rail_curve_ground';

    this.removeTileMesh(tile);

    tile.type = tileType;
    tile.layer = layer;
    tile.curveDir = curveDir;
    tile.rotation = 0;
    const baseH = layerToHeight(layer);
    const elevY = this.getTrackElevationOffset(x, z, layer);
    tile.elevationOffset = elevY;

    const isTunnel = this.isTunnelSection(x, z, layer);
    const mesh = ModelFactory.createCurveTrackSegment(curveDir, effectiveElevated, baseH, isTunnel);
    mesh.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
    mesh.visible = this.isLayerVisibleInCurrentMode(layer);
    this.attachTileMesh(tile, mesh);

    this.markDirty();
    return true;
  }

  /**
   * ① 勾配レール（4マス直線）の敷設。origin を地上側の端として、rotation・reversed で決まる
   * 上り方向へ4マス連続で配置し、各マスが1/4ずつ高さを分担する（地上⇔高架を緩やかに接続）。
   */
  public placeSlope(originX: number, originZ: number, rotation: number, reversed: boolean, layer: GridLayer = 1): boolean {
    if (layer >= 5) return false; // 最上階（5F）からは上りスロープを敷設不可
    const axis: [number, number] = rotation === 1 ? [1, 3] : [0, 2];
    const [, highIdx] = reversed ? [axis[1], axis[0]] : [axis[0], axis[1]];
    const stepDir = WorldMap.DIRS[highIdx];

    const positions = Array.from({ length: SLOPE_PARTS }, (_, i) => ({
      x: originX + stepDir.x * i,
      z: originZ + stepDir.z * i
    }));
    const upperLayer: GridLayer = (layer + 1) as GridLayer;
    for (const p of positions) {
      if (!this.isInBounds(p.x, p.z)) return false;
      if (this.isPermanentTrackOrStation(p.x, p.z, layer)) return false;
      // 上位階層(upperLayer)にも既に線路や駅・建物が存在しないかチェック
      const upperTile = this.getTile(p.x, p.z, upperLayer);
      if (upperTile && upperTile.type !== 'empty') return false;
      const waterCheck = this.canPlaceAtWater(p.x, p.z, layer);
      if (!waterCheck.allowed) return false;
    }

    // トンネル区間内では 0m、地上地表では標高オフセットをベース高さ基準とする
    const originElevOffset = this.getTrackElevationOffset(originX, originZ, layer);

    positions.forEach((p, i) => {
      const tile = this.getOrCreateTile(p.x, p.z, layer)!;
      this.applySlopeTile(tile, rotation, reversed, i, layer, originElevOffset);
      // 上位階層接続端（part 3）を上位レイヤーのGrid3Dにも登録
      if (i === SLOPE_PARTS - 1) {
        this.grid3D.set(p.x, upperLayer, p.z, tile);
      }
    });

    this.markDirty();
    return true;
  }

  /**
   * 勾配レール1マス分のデータ・メッシュを反映する（新規敷設・個別復元の両方で使用）
   */
  private applySlopeTile(tile: TileData, rotation: number, reversed: boolean, part: number, layer: GridLayer = 1, originElevOffset?: number) {
    this.removeTileMesh(tile);
    tile.type = 'rail_slope';
    tile.layer = layer;
    tile.rotation = rotation;
    tile.slopeReversed = reversed;
    tile.slopePart = part;
    tile.switchState = 'straight';
    tile.groupOrigin = undefined;
    const elevY = originElevOffset !== undefined ? originElevOffset : this.getElevationOffset(tile.x, tile.z);
    tile.elevationOffset = elevY;

    const baseH = layerToHeight(layer, elevY);
    const mesh = ModelFactory.createSlopeTrackPart(rotation, reversed, part);
    mesh.position.set(tile.x * WorldMap.TILE_SIZE, baseH, tile.z * WorldMap.TILE_SIZE);
    const upperLayer: GridLayer = (layer + 1) as GridLayer;
    mesh.visible = (this.isLayerVisibleInCurrentMode(layer) || this.isLayerVisibleInCurrentMode(upperLayer));
    this.attachTileMesh(tile, mesh);
  }

  /**
   * ② 地下勾配レール（4マス直線）の敷設。origin を地上側の端として、下り方向へ4マス連続で配置する（地上⇔地下を接続）。
   */
  public placeUndergroundSlope(originX: number, originZ: number, rotation: number, reversed: boolean, layer: GridLayer = 1): boolean {
    const axis: [number, number] = rotation === 1 ? [1, 3] : [0, 2];
    const [, downIdx] = reversed ? [axis[1], axis[0]] : [axis[0], axis[1]];
    const stepDir = WorldMap.DIRS[downIdx];

    const positions = Array.from({ length: SLOPE_PARTS }, (_, i) => ({
      x: originX + stepDir.x * i,
      z: originZ + stepDir.z * i
    }));
    for (const p of positions) {
      if (!this.isInBounds(p.x, p.z)) return false;
      if (this.isPermanentTrackOrStation(p.x, p.z, layer)) return false;
      // 地下B1F(-1)に既に線路や地下駅が存在しないかチェック
      const lowerTile = this.getTile(p.x, p.z, -1);
      if (lowerTile && lowerTile.type !== 'empty') return false;
      const waterCheck = this.canPlaceAtWater(p.x, p.z, layer);
      if (!waterCheck.allowed) return false;

      // 【バグ修正】山岳・丘陵地（標高が平地より高い場所）からの地下スロープ建設を禁止
      if (layer === 1 && this.getElevationOffset(p.x, p.z) > 0) return false;
    }

    positions.forEach((p, i) => {
      const tile = this.getOrCreateTile(p.x, p.z, layer)!;
      this.applyUndergroundSlopeTile(tile, rotation, reversed, i, layer);
      // 地下側接続端（part 3）を地下レイヤー(layer -1)のGrid3Dにも登録
      if (i === SLOPE_PARTS - 1) {
        const lowerLayer: GridLayer = -1;
        this.grid3D.set(p.x, lowerLayer, p.z, tile);
      }
      // 地上側掘割区間（part 0, 1）の地表面をステンシル穴あけ
      if (i === 0 || i === 1) {
        this.groundHoleHandler?.add(p.x, p.z, rotation);
      }
    });

    this.markDirty();
    return true;
  }

  /**
   * 地下勾配レール1マス分のデータ・メッシュを反映する
   */
  private applyUndergroundSlopeTile(tile: TileData, rotation: number, reversed: boolean, part: number, layer: GridLayer = 1) {
    this.removeTileMesh(tile);
    tile.type = 'rail_slope_underground';
    tile.layer = layer;
    tile.rotation = rotation;
    tile.slopeReversed = reversed;
    tile.slopePart = part;
    tile.switchState = 'straight';
    tile.groupOrigin = undefined;
    const elevY = this.getElevationOffset(tile.x, tile.z);
    tile.elevationOffset = elevY;

    const mesh = ModelFactory.createUndergroundSlopeTrackPart(rotation, reversed, part);
    mesh.position.set(tile.x * WorldMap.TILE_SIZE, elevY, tile.z * WorldMap.TILE_SIZE);
    this.attachTileMesh(tile, mesh);
  }

  /**
   * 分岐器やシーサスクロッシングによって上書き設置可能な線路タイルかどうかを判定する
   * （直線・曲線・分岐器・シーサス等の通常線路は上書き可能。駅や信号場、建物、道路、踏切等は上書き不可）
   */
  public isOverwritableTrack(x: number, z: number, layer: GridLayer = this.activeLayer): boolean {
    const tile = this.getTile(x, z, layer);
    if (!tile || tile.type === 'empty') return true;
    return (
      tile.type === 'rail_ground' ||
      tile.type === 'rail_elevated' ||
      tile.type === 'rail_curve_ground' ||
      tile.type === 'rail_curve_elevated' ||
      tile.type === 'point_switch_ground' ||
      tile.type === 'point_switch_elevated'
    );
  }

  /**
   * ② 分岐器（ポイント）の敷設。曲線レールと同じ1マスで完結する
   * （進入側＋直進側＋分岐側の曲線レールを1タイル内に収める）。
   * rotation: 0-3 = 通過方向（進入→直進方向）のインデックス（0=北,1=東,2=南,3=西）。
   * branchSide: 'right'(右分岐) または 'left'(左分岐)。
   */
  public placeSwitch(x: number, z: number, rotation: number, isElevated: boolean = false, branchSide: 'left' | 'right' = 'right', layer: GridLayer = this.activeLayer): boolean {
    if (!this.isInBounds(x, z)) return false;
    if (!this.isOverwritableTrack(x, z, layer)) return false;
    const tile = this.getOrCreateTile(x, z, layer);
    if (!tile) return false;

    const cell = this.gridManagerRef?.getCell(x, 1, z);
    const surfaceElevation = cell ? cell.elevation : 1;
    const effectiveElevated = isElevated && (layer > surfaceElevation);

    const forward = ((rotation % 4) + 4) % 4;
    const switchType: TileType = effectiveElevated ? 'point_switch_elevated' : 'point_switch_ground';

    this.removeTileMesh(tile);

    tile.type = switchType;
    tile.layer = layer;
    tile.rotation = forward;
    tile.switchState = 'straight';
    tile.switchBranchSide = branchSide;
    tile.curveDir = undefined;
    tile.slopeReversed = undefined;
    tile.groupOrigin = undefined;
    const baseH = layerToHeight(layer);
    const elevY = this.getTrackElevationOffset(x, z, layer);
    tile.elevationOffset = elevY;

    const isTunnel = this.isTunnelSection(x, z, layer);
    const mesh = ModelFactory.createSwitchHub(forward, false, effectiveElevated, branchSide, baseH, isTunnel);
    mesh.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
    mesh.visible = this.isLayerVisibleInCurrentMode(layer);
    this.attachTileMesh(tile, mesh);

    this.markDirty();
    return true;
  }

  /**
   * ③ シーサスクロッシング（複線用の交差分岐）の敷設。2×2マスを使用する。
   * origin=A（左上/北西または北東側の角）。rotation: 0=南北方向に並走(横に2本), 1=東西方向に並走(縦に2本)。
   * A-B が1本目の線路、C-D が2本目の線路（Aから見て右手側=acrossDir に1マスずれた位置）。
   */
  public placeScissorsCrossing(originX: number, originZ: number, rotation: number, isElevated: boolean = false, layer: GridLayer = this.activeLayer): boolean {
    const along = (rotation % 2 === 1) ? 1 : 2;
    const across = WorldMap.rotateCW(along);
    const alongVec = WorldMap.DIRS[along];
    const acrossVec = WorldMap.DIRS[across];

    const posA = { x: originX, z: originZ };
    const posB = { x: originX + alongVec.x, z: originZ + alongVec.z };
    const posC = { x: originX + acrossVec.x, z: originZ + acrossVec.z };
    const posD = { x: originX + alongVec.x + acrossVec.x, z: originZ + alongVec.z + acrossVec.z };
    const positions = [posA, posB, posC, posD];

    for (const p of positions) {
      if (!this.isInBounds(p.x, p.z)) return false;
      if (!this.isOverwritableTrack(p.x, p.z, layer)) return false;
      const waterCheck = this.canPlaceAtWater(p.x, p.z, layer);
      if (!waterCheck.allowed) return false;
    }

    const sharedSchedule = createDefaultSwitchSchedule();

    positions.forEach((p, role) => {
      const cell = this.gridManagerRef?.getCell(p.x, 1, p.z);
      const surfaceElevation = cell ? cell.elevation : 1;
      const effectiveElevated = isElevated && (layer > surfaceElevation);
      const crossingType: TileType = effectiveElevated ? 'scissors_crossing_elevated' : 'scissors_crossing_ground';

      const t = this.getOrCreateTile(p.x, p.z, layer)!;
      this.removeTileMesh(t);
      t.type = crossingType;
      t.layer = layer;
      t.rotation = (rotation % 2 === 1) ? 1 : 0;
      t.curveDir = undefined;
      t.slopeReversed = undefined;
      t.switchState = 'straight';
      t.groupOrigin = { x: originX, z: originZ };
      t.crossingRole = role as 0 | 1 | 2 | 3;
      const baseH = layerToHeight(layer);
      const elevY = this.getTrackElevationOffset(p.x, p.z, layer);
      t.elevationOffset = elevY;

      const isTunnel = this.isTunnelSection(p.x, p.z, layer);
      const mesh = ModelFactory.createScissorsCrossingTile(along, role as 0 | 1 | 2 | 3, effectiveElevated, 'straight', baseH, isTunnel);
      mesh.position.set(p.x * WorldMap.TILE_SIZE, baseH + elevY, p.z * WorldMap.TILE_SIZE);
      mesh.visible = this.isLayerVisibleInCurrentMode(layer);
      this.attachTileMesh(t, mesh);
      t.switchSchedule = t.switchSchedule || sharedSchedule;
    });

    this.markDirty();
    return true;
  }

  /**
   * ③ シーサスクロッシングの開通状態を straight → cross-a → cross-b → straight … と切り替える。
   * グループ内のどのマスをクリックしても起点(A)を切り替え、4マス全てのメッシュを再構築する。
   */
  public cycleCrossingState(x: number, z: number, layer?: GridLayer): CrossingState | null {
    const checkLayer = (layer ?? this.activeLayer) as GridLayer;
    const clicked = this.getTile(x, z, checkLayer);
    if (!clicked || !clicked.groupOrigin) return null;
    const origin = this.getTile(clicked.groupOrigin.x, clicked.groupOrigin.z, (clicked.layer ?? checkLayer) as GridLayer);
    if (!origin || origin.crossingRole !== 0) return null;

    const order: CrossingState[] = ['straight', 'cross-a', 'cross-b'];
    const nextState = order[(order.indexOf(origin.crossingState ?? 'straight') + 1) % order.length];
    const success = this.setCrossingState(x, z, nextState, checkLayer, false);
    return success ? nextState : null;
  }

  /**
   * シーサスクロッシングの開通状態を指定の状態（'straight' | 'cross-a' | 'cross-b'）に設定する
   */
  public setCrossingState(x: number, z: number, targetState: CrossingState, layer?: GridLayer, isTransient: boolean = false): boolean {
    const checkLayer = (layer ?? this.activeLayer) as GridLayer;
    const clicked = this.getTile(x, z, checkLayer);
    if (!clicked || !clicked.groupOrigin) return false;
    const origin = this.getTile(clicked.groupOrigin.x, clicked.groupOrigin.z, (clicked.layer ?? checkLayer) as GridLayer);
    if (!origin || origin.crossingRole !== 0) return false;

    // 手動明示的切替（!isTransient）の時はモードを manual に設定し、
    // 列車通過時や時刻同期処理で勝手に straight へ戻されないようにする
    if (!isTransient) {
      if (!origin.switchSchedule) {
        origin.switchSchedule = createDefaultSwitchSchedule();
      }
      origin.switchSchedule.mode = 'manual';
    }

    // 既に同一状態なら再生成をスキップ
    if (origin.crossingState === targetState) return true;

    const along = (origin.rotation % 2 === 1) ? 1 : 2;
    const across = WorldMap.rotateCW(along);
    const alongVec = WorldMap.DIRS[along];
    const acrossVec = WorldMap.DIRS[across];
    const isElevated = origin.type.includes('elevated');

    const positions = [
      { x: origin.x, z: origin.z },
      { x: origin.x + alongVec.x, z: origin.z + alongVec.z },
      { x: origin.x + acrossVec.x, z: origin.z + acrossVec.z },
      { x: origin.x + alongVec.x + acrossVec.x, z: origin.z + alongVec.z + acrossVec.z }
    ];

    positions.forEach((p, role) => {
      const t = this.getTile(p.x, p.z, (origin.layer ?? checkLayer) as GridLayer);
      if (!t) return;
      t.crossingState = targetState;
      if (origin.switchSchedule) {
        t.switchSchedule = origin.switchSchedule;
      }
      const typedRole = role as 0 | 1 | 2 | 3;
      if (t.mesh && ModelFactory.updateScissorsCrossingTileState(t.mesh, typedRole, targetState)) {
        return;
      }
      this.removeTileMesh(t);
      const tileLayer = (t.layer ?? checkLayer) as GridLayer;
      const baseH = layerToHeight(tileLayer);
      const elevY = this.getTrackElevationOffset(p.x, p.z, tileLayer);
      t.elevationOffset = elevY;
      const isTunnel = this.isTunnelSection(p.x, p.z, tileLayer);
      const mesh = ModelFactory.createScissorsCrossingTile(along, typedRole, isElevated, targetState, baseH, isTunnel);
      mesh.position.set(p.x * WorldMap.TILE_SIZE, baseH + elevY, p.z * WorldMap.TILE_SIZE);
      mesh.visible = this.isLayerVisibleInCurrentMode(tileLayer);
      this.attachTileMesh(t, mesh);
    });

    if (!isTransient) {
      this.markDirty();
    }
    return true;
  }

  /**
   * シーサスクロッシンググループの代表(A)タイルを取得する
   */
  public resolveCrossingOrigin(x: number, z: number, layer?: GridLayer): TileData | undefined {
    const checkLayer = (layer ?? this.activeLayer) as GridLayer;
    const tile = this.getTile(x, z, checkLayer);
    if (!tile || !tile.groupOrigin) return undefined;
    return this.getTile(tile.groupOrigin.x, tile.groupOrigin.z, (tile.layer ?? checkLayer) as GridLayer);
  }

  /**
   * ② ポイント切り替え（直進 ⇄ 分岐）。分岐器は1マスなのでそのまま切り替える。
   */
  public togglePointSwitch(x: number, z: number, layer?: GridLayer): SwitchState | null {
    const checkLayer = (layer ?? this.activeLayer) as GridLayer;
    const tile = this.getTile(x, z, checkLayer);
    if (!tile || !tile.type.startsWith('point_switch')) return null;

    tile.switchState = (tile.switchState === 'straight') ? 'diverge' : 'straight';

    this.removeTileMesh(tile);

    const tileLayer = (tile.layer ?? checkLayer) as GridLayer;
    const isElevated = tile.type.includes('elevated');
    const branchSide = tile.switchBranchSide ?? 'right';
    const baseH = layerToHeight(tileLayer);
    const elevY = this.getTrackElevationOffset(tile.x, tile.z, tileLayer);
    tile.elevationOffset = elevY;
    const isTunnel = this.isTunnelSection(tile.x, tile.z, tileLayer);
    const mesh = ModelFactory.createSwitchHub(tile.rotation, tile.switchState === 'diverge', isElevated, branchSide, baseH, isTunnel);
    mesh.position.set(tile.x * WorldMap.TILE_SIZE, baseH + elevY, tile.z * WorldMap.TILE_SIZE);
    mesh.visible = this.isLayerVisibleInCurrentMode(tileLayer);
    this.attachTileMesh(tile, mesh);

    this.markDirty();
    return tile.switchState;
  }

  /**
   * ① 本設置済みの線路・駅等のインフラが存在するかを判定（仮置きによる誤上書き防止用）
   */
  public isPermanentTrackOrStation(x: number, z: number, layer: GridLayer = this.activeLayer): boolean {
    const tile = this.getTile(x, z, layer);
    if (!tile) return false;
    return (
      tile.type.startsWith('rail') ||
      tile.type.includes('station') ||
      tile.type === 'signal_yard' ||
      tile.type.startsWith('point_switch') ||
      tile.type.startsWith('scissors_crossing') ||
      tile.type === 'level_crossing' ||
      tile.type === 'external_connection'
    );
  }

  /**
   * 分岐器タイルそのものを取得する（インスペクター表示等で使用。1マスなので自分自身を返すだけ）
   */
  public resolveSwitchHub(x: number, z: number, layer?: GridLayer): TileData | undefined {
    const checkLayer = (layer ?? this.activeLayer) as GridLayer;
    const tile = this.getTile(x, z, checkLayer);
    if (!tile || !tile.type.startsWith('point_switch')) return undefined;
    return tile;
  }

  /**
   * 駅・信号場・貨物駅・隣町接続ゲートウェイのいずれかであるかを判定
   */
  public static isStationTileType(type: string): boolean {
    return (
      type.startsWith('station') ||
      type.startsWith('cargo_station') ||
      type === 'signal_yard'
    );
  }

  /**
   * ⑤ 踏切の自動検出: 直進レールと道路が直交して同じマスに置かれた場合、上書きするのではなく
   * 両方を兼ねる踏切タイルにする。軸が同じ（平行）場合は従来通り単純に上書きする。
   */
  private tryCreateLevelCrossing(x: number, z: number, type: TileType, rotation: number, level: number): boolean | null {
    const tile = this.getTile(x, z, 1);
    if (!tile) return null;
    const axis = ((rotation % 2) + 2) % 2;
    const tileAxis = (((tile.rotation ?? 0) % 2) + 2) % 2;

    if (type === 'road' && tile.type === 'rail_ground' && tileAxis !== axis) {
      return this.applyLevelCrossing(x, z, tileAxis, axis, level, 1);
    }
    if (type === 'rail_ground' && tile.type === 'road' && tileAxis !== axis) {
      return this.applyLevelCrossing(x, z, axis, tileAxis, level, 1);
    }
    return null;
  }

  private applyLevelCrossing(x: number, z: number, railAxis: number, roadAxis: number, level: number, layer: GridLayer = 1): boolean {
    const tile = this.getOrCreateTile(x, z, layer);
    if (!tile) return false;
    this.removeTileMesh(tile);
    tile.type = 'level_crossing';
    tile.layer = layer;
    tile.rotation = railAxis;
    tile.crossingRoadAxis = roadAxis;
    tile.level = level;
    tile.switchState = 'straight';
    tile.groupOrigin = undefined;
    tile.curveDir = undefined;
    tile.slopeReversed = undefined;
    tile.slopePart = undefined;
    tile.crossingRole = undefined;
    tile.crossingState = undefined;

    const elevY = this.getElevationOffset(x, z);
    tile.elevationOffset = elevY;

    const mesh = ModelFactory.createLevelCrossing(railAxis);
    mesh.position.set(x * WorldMap.TILE_SIZE, elevY, z * WorldMap.TILE_SIZE);
    this.attachTileMesh(tile, mesh);
    this.markDirty();
    return true;
  }

  /**
   * 踏切の明示的配置
   */
  public placeLevelCrossing(x: number, z: number, railAxis: number = 0, layer: GridLayer = 1): boolean {
    if (layer !== 1) return false;
    const normRailAxis = ((railAxis % 2) + 2) % 2;
    const normRoadAxis = 1 - normRailAxis;
    return this.applyLevelCrossing(x, z, normRailAxis, normRoadAxis, 1, layer);
  }

  /**
   * Set single tile
   */
  public setTile(x: number, z: number, type: TileType, rotation: number = 0, level: number = 1, platformSide: 'left' | 'right' = 'right', layer: GridLayer = this.activeLayer): boolean {
    // 疎マップ構造対応: 更地化の場合はオブジェクトを新規生成せず、既存タイルがあれば完全削除する
    if (type === 'empty') {
      const existing = this.getTile(x, z, layer);
      if (existing) {
        this.resetTileData(existing);
      }
      return true;
    }

    const tile = this.getOrCreateTile(x, z, layer);
    if (!tile) return false;

    // 踏切の直接指定配置（地上1F）
    if (type === 'level_crossing') {
      const railAxis = ((rotation % 2) + 2) % 2;
      const roadAxis = 1 - railAxis;
      return this.applyLevelCrossing(x, z, railAxis, roadAxis, level, layer);
    }

    // ⑤ 道路とレールが直交して重なる場合は踏切にする（地上1F限定）
    if (layer === 1) {
      const crossingResult = this.tryCreateLevelCrossing(x, z, type, rotation, level);
      if (crossingResult !== null) return crossingResult;
    }

    this.removeTileMesh(tile);

    tile.type = type;
    tile.layer = layer;
    tile.rotation = rotation;
    tile.level = level;
    tile.switchState = 'straight';
    tile.groupOrigin = undefined;
    tile.crossingRole = undefined;
    tile.crossingState = undefined;
    tile.crossingRoadAxis = undefined;
    if (!WorldMap.isStationTileType(type)) {
      tile.stationGroupId = undefined;
      tile.stationPlatformId = undefined;
      tile.stationPart = undefined;
      tile.stationPlatformSide = undefined;
      tile.isCargoYard = undefined;
    }


    // ⑧ 複数マス駅ホームの自動パーツ判定 (single / start / mid / end)
    let stationPart: 'single' | 'start' | 'mid' | 'end' = 'single';
    if (WorldMap.isStationTileType(type)) {
      tile.stationPlatformSide = platformSide;
      tile.stationSchedule = tile.stationSchedule || (type.startsWith('cargo_station') ? createDefaultCargoStationSchedule() : createDefaultStationSchedule());
      if (type.startsWith('station')) {
        stationPart = this.detectStationPart(x, z, tile.rotation, type, layer);
      }
      tile.stationPart = stationPart;
    }
    if (type.startsWith('point_switch')) {
      tile.switchSchedule = tile.switchSchedule || createDefaultSwitchSchedule();
    }

    let mesh: THREE.Group | undefined;
    const hasPole = Math.abs(x + z) % 3 === 0;
    const isTunnel = this.isTunnelSection(x, z, layer);
    const baseH = layerToHeight(layer);

    const cell = this.gridManagerRef?.getCell(x, 1, z);
    const surfaceElevation = cell ? cell.elevation : 1;

    // 山岳区間（isTunnel）では高架線路指定であっても山を貫くトンネル線路として扱い、
    // 山岳地表面（layer === surfaceElevation）では高架ではなく地表線路として扱う
    if (type === 'rail_elevated' && (isTunnel || layer === surfaceElevation)) {
      type = 'rail_ground';
      tile.type = 'rail_ground';
    }

    // ★修正: 駅や分岐器なども線路と同じく getTrackElevationOffset を使用し、山岳トンネル内の線路と高さを一致させる
    const isSurfaceStructure = type === 'road' || type === 'residence' || type === 'commercial' || type === 'industrial' || type === 'nature' || type === 'farmland';
    const elevY = isSurfaceStructure
      ? ((layer === 1) ? this.getElevationOffset(x, z) : 0)
      : this.getTrackElevationOffset(x, z, layer);
    tile.elevationOffset = elevY;
    const tileKey = `${x},${z},${layer}`;

    const isGroundStraight = (type === 'rail_ground' && !isTunnel && layer >= 0);
    const isElevatedStraight = (type === 'rail_elevated');
    const isNatureTree = (type === 'nature');

    if (isGroundStraight) {
      const dummy = new THREE.Object3D();
      dummy.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
      if (tile.rotation === 1) dummy.rotation.y = Math.PI / 2;
      dummy.updateMatrix();
      this.instancedMeshManager.setGroundTrack(tileKey, dummy.matrix, hasPole);
    } else if (isElevatedStraight) {
      const dummy = new THREE.Object3D();
      dummy.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
      if (tile.rotation === 1) dummy.rotation.y = Math.PI / 2;
      dummy.updateMatrix();
      const pierMatrices = this.getElevatedPierMatrices(x, z, layer, tile.rotation);
      this.instancedMeshManager.setElevatedTrack(tileKey, dummy.matrix, pierMatrices);
    } else if (isNatureTree) {
      const dummy = new THREE.Object3D();
      dummy.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
      dummy.updateMatrix();
      this.instancedMeshManager.setTree(tileKey, dummy.matrix);
    } else {
      switch (type) {
        case 'rail_ground': {
          let portalEnds: { start?: boolean; end?: boolean } | undefined;
          if (isTunnel) {
            const isEW = (tile.rotation === 1);
            const dirA = isEW ? { x: -1, z: 0 } : { x: 0, z: -1 };
            const dirB = isEW ? { x: 1, z: 0 } : { x: 0, z: 1 };
            const isTunnelA = this.isTunnelSection(x + dirA.x, z + dirA.z, layer);
            const isTunnelB = this.isTunnelSection(x + dirB.x, z + dirB.z, layer);
            portalEnds = {
              start: !isTunnelA,
              end: !isTunnelB
            };
          }
          mesh = ModelFactory.createTunnelTrack(tile.rotation, portalEnds);
          break;
        }
        case 'station_ground':
          mesh = ModelFactory.createStation(tile.rotation, false, stationPart, tile.stationPlatformSide ?? 'right', tile.stationName ?? '駅');
          break;
        case 'station_elevated':
          mesh = ModelFactory.createStation(tile.rotation, true, stationPart, tile.stationPlatformSide ?? 'right', tile.stationName ?? '駅', baseH);
          break;
        case 'signal_yard':
          mesh = ModelFactory.createSignalYard(tile.rotation, layer >= 2, tile.stationPlatformSide ?? 'right', baseH);
          break;
        case 'cargo_station_ground':
          mesh = ModelFactory.createCargoStation(tile.rotation, false, tile.stationPlatformSide ?? 'right');
          break;
        case 'cargo_station_elevated':
          mesh = ModelFactory.createCargoStation(tile.rotation, true, tile.stationPlatformSide ?? 'right', baseH);
          break;
        case 'road':
          mesh = ModelFactory.createRoad(tile.rotation);
          break;
        case 'residence':
          mesh = ModelFactory.createHouse(Math.abs(x * 7 + z * 13) % 4, level);
          break;
        case 'commercial':
          mesh = ModelFactory.createCommercialBuilding(level);
          break;
        case 'industrial':
          mesh = ModelFactory.createIndustrialBuilding(level);
          break;
        case 'farmland':
          mesh = ModelFactory.createFarmland(Math.abs(x * 11 + z * 17) % 3);
          break;
        case 'external_connection': {
          tile.isExternalConnection = true;
          if (isTunnel) {
            const isEW = (tile.rotation === 1);
            const dirA = isEW ? { x: -1, z: 0 } : { x: 0, z: -1 };
            const dirB = isEW ? { x: 1, z: 0 } : { x: 0, z: 1 };
            const isTunnelA = this.isTunnelSection(x + dirA.x, z + dirA.z, layer);
            const isTunnelB = this.isTunnelSection(x + dirB.x, z + dirB.z, layer);
            mesh = ModelFactory.createTunnelTrack(tile.rotation, {
              start: !isTunnelA,
              end: !isTunnelB
            });
          } else {
            mesh = ModelFactory.createGroundTrack(tile.rotation, false);
          }
          break;
        }
        default:
          mesh = undefined;
          break;
      }

      if (mesh) {
        mesh.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
        mesh.visible = this.isLayerVisibleInCurrentMode(layer);
        this.attachTileMesh(tile, mesh);
      }
    }

    // Update neighboring stations if this is a station
    if (WorldMap.isStationTileType(type)) {
      if (!tile.stationName) {
        tile.stationName = (type === 'external_connection')
          ? '隣町ゲートウェイ'
          : (type.startsWith('cargo_station')
            ? `第${this.getStationCount() + 1}貨物駅`
            : (type === 'signal_yard' ? `第${this.getStationCount() + 1}信号場` : `第${this.getStationCount() + 1}駅`));
      }

      if (type.startsWith('station')) {
        // ★修正: 第5引数に layer を渡す
        this.updateNeighborStations(x, z, tile.rotation, type, layer);
      }
    }

    // トンネル敷設時、隣接するトンネルタイルの坑口ポータル開閉を更新
    if ((type === 'rail_ground' || type === 'external_connection') && isTunnel) {
      const isEW = (rotation === 1);
      const dirA = isEW ? { x: -1, z: 0 } : { x: 0, z: -1 };
      const dirB = isEW ? { x: 1, z: 0 } : { x: 0, z: 1 };
      this.updateTunnelTilePortal(x + dirA.x, z + dirA.z, layer);
      this.updateTunnelTilePortal(x + dirB.x, z + dirB.z, layer);
    }

    // 直上階層の高架線路の橋脚を着地状況に合わせて更新
    this.updateUpperElevatedPiers(x, z, layer);

    this.markDirty();
    return true;
  }

  /**
   * トンネルタイルの坑口ポータル（アーチ額縁と庇）メッシュを隣接状況に合わせて更新
   */
  public updateTunnelTilePortal(x: number, z: number, layer: GridLayer = this.activeLayer): void {
    const tile = this.getTile(x, z, layer);
    if (!tile || tile.type !== 'rail_ground' || !this.isTunnelSection(x, z, layer)) return;

    const isEW = (tile.rotation === 1);
    const dirA = isEW ? { x: -1, z: 0 } : { x: 0, z: -1 };
    const dirB = isEW ? { x: 1, z: 0 } : { x: 0, z: 1 };
    const isTunnelA = this.isTunnelSection(x + dirA.x, z + dirA.z, layer);
    const isTunnelB = this.isTunnelSection(x + dirB.x, z + dirB.z, layer);
    const portalEnds = {
      start: !isTunnelA,
      end: !isTunnelB
    };

    if (tile.mesh) {
      tile.mesh.removeFromParent();
      disposeHierarchy(tile.mesh);
    }
    const baseH = layerToHeight(layer);
    const elevY = this.getTrackElevationOffset(x, z, layer);
    const newMesh = ModelFactory.createTunnelTrack(tile.rotation, portalEnds);
    newMesh.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
    newMesh.visible = this.isLayerVisibleInCurrentMode(layer);
    this.attachTileMesh(tile, newMesh);
  }

  /**
   * ⑧ 複数マス駅パーツの自動検出
   */
  private detectStationPart(x: number, z: number, rot: number, type: TileType, layer: GridLayer = this.activeLayer): 'single' | 'start' | 'mid' | 'end' {
    const prev = rot === 1 ? this.getTile(x - 1, z, layer) : this.getTile(x, z - 1, layer);
    const next = rot === 1 ? this.getTile(x + 1, z, layer) : this.getTile(x, z + 1, layer);

    const hasPrev = prev && prev.type === type && prev.rotation === rot;
    const hasNext = next && next.type === type && next.rotation === rot;

    if (hasPrev && hasNext) return 'mid';
    if (!hasPrev && hasNext) return 'start';
    if (hasPrev && !hasNext) return 'end';
    return 'single';
  }

  /**
   * ⑨ 駅の有効長（連続する同一駅タイル数 = 列車の最大両数）を取得
   */
  public getStationRunLength(x: number, z: number, layer: GridLayer = this.activeLayer): number {
    const tile = this.getTile(x, z, layer);
    if (!tile || !WorldMap.isStationTileType(tile.type)) return 0;

    const targetLayer = (tile.layer ?? layer) as GridLayer;
    // StationManager からホーム有効長を直接参照（正本優先）
    const platInfo = this.stationManager.getPlatformByTile(x, z, targetLayer);
    if (platInfo && platInfo.platform.length > 0) {
      return platInfo.platform.length;
    }

    // 未登録の場合のみ従来のタイル探索にフォールバック
    const rot = tile.rotation;
    const stepX = (rot % 2 === 1) ? 1 : 0;
    const stepZ = (rot % 2 === 1) ? 0 : 1;

    const isSameStation = (t: TileData | undefined): boolean => {
      if (!t) return false;
      if (((t.layer ?? layer) as GridLayer) !== targetLayer) return false;
      if (!WorldMap.isStationTileType(t.type)) return false;
      if (tile.stationPlatformId) {
        return t.stationPlatformId === tile.stationPlatformId;
      }
      if (tile.stationGroupId) {
        return t.stationGroupId === tile.stationGroupId;
      }
      return t.type === tile.type && (t.rotation % 2 === rot % 2);
    };

    let count = 1;
    let cx = x - stepX, cz = z - stepZ;
    while (true) {
      const t = this.getTile(cx, cz, targetLayer);
      if (isSameStation(t)) {
        count++;
        cx -= stepX;
        cz -= stepZ;
      } else break;
    }
    cx = x + stepX; cz = z + stepZ;
    while (true) {
      const t = this.getTile(cx, cz, targetLayer);
      if (isSameStation(t)) {
        count++;
        cx += stepX;
        cz += stepZ;
      } else break;
    }
    return count;
  }

  /**
   * ② マップ境界端に隣町接続ゲートウェイ（外部接続都市タイル）を配置
   */
  public placeExternalConnection(
    x: number,
    z: number,
    rotation: number,
    cityId: string,
    cityName: string,
    layer: GridLayer = 1
  ): TileData | undefined {
    const success = this.setTile(x, z, 'external_connection', rotation, 1, 'right', layer);
    if (!success) return undefined;
    const tile = this.getTile(x, z, layer);
    if (tile) {
      tile.externalCityId = cityId;
      tile.isExternalConnection = true;
      tile.stationName = cityName;
      if (tile.mesh) {
        ModelFactory.updateGatewaySign(tile.mesh, cityName, false);
      }
    }
    return tile;
  }

  public getStationCount(): number {
    return Array.from(this.tiles.values()).filter(t => WorldMap.isStationTileType(t.type)).length;
  }

  /**
   * ④ 駅グループの先頭タイル（最小座標側のタイル）を取得
   */
  public getStationStartTile(x: number, z: number, layer: GridLayer = this.activeLayer): TileData | null {
    const tile = this.getTile(x, z, layer);
    if (!tile || !WorldMap.isStationTileType(tile.type)) return null;

    const targetLayer = (tile.layer ?? layer) as GridLayer;
    const platInfo = this.stationManager.getPlatformByTile(x, z, targetLayer);
    if (platInfo && platInfo.platform && platInfo.platform.tiles.length > 0) {
      // 座標最小のタイルを先頭とする（X優先、同値ならZ優先）
      const sorted = [...platInfo.platform.tiles].sort((a, b) => (a.x - b.x) || (a.z - b.z));
      const first = sorted[0];
      const found = this.getTile(first.x, first.z, first.layer);
      if (found) return found;
    }

    const rot = tile.rotation;
    const stepX = (rot % 2 === 1) ? 1 : 0;
    const stepZ = (rot % 2 === 1) ? 0 : 1;

    const isSameStation = (t: TileData | undefined): boolean => {
      if (!t) return false;
      if (((t.layer ?? layer) as GridLayer) !== targetLayer) return false;
      if (!WorldMap.isStationTileType(t.type)) return false;
      if (tile.stationPlatformId) {
        return t.stationPlatformId === tile.stationPlatformId;
      }
      if (tile.stationGroupId) {
        return t.stationGroupId === tile.stationGroupId;
      }
      return t.type === tile.type && (t.rotation % 2 === rot % 2);
    };

    let cur = tile;
    while (true) {
      const t = this.getTile(cur.x - stepX, cur.z - stepZ, targetLayer);
      if (isSameStation(t)) {
        cur = t!;
      } else break;
    }
    return cur;
  }

  /**
   * ④ 駅グループを構成する全タイルを取得
   */
  public getStationTiles(x: number, z: number, layer: GridLayer = this.activeLayer): TileData[] {
    const tile = this.getTile(x, z, layer);
    if (!tile || !WorldMap.isStationTileType(tile.type)) return [];

    const targetLayer = (tile.layer ?? layer) as GridLayer;
    const platInfo = this.stationManager.getPlatformByTile(x, z, targetLayer);
    if (platInfo && platInfo.platform && platInfo.platform.tiles.length > 0) {
      const result: TileData[] = [];
      const sorted = [...platInfo.platform.tiles].sort((a, b) => (a.x - b.x) || (a.z - b.z));
      for (const pt of sorted) {
        const t = this.getTile(pt.x, pt.z, pt.layer);
        if (t && WorldMap.isStationTileType(t.type)) {
          result.push(t);
        }
      }
      if (result.length > 0) return result;
    }

    const startTile = this.getStationStartTile(x, z, layer);
    if (!startTile) return [];

    const rot = startTile.rotation;
    const stepX = (rot % 2 === 1) ? 1 : 0;
    const stepZ = (rot % 2 === 1) ? 0 : 1;

    const isSameStation = (t: TileData | undefined): boolean => {
      if (!t) return false;
      if (((t.layer ?? layer) as GridLayer) !== targetLayer) return false;
      if (!WorldMap.isStationTileType(t.type)) return false;
      if (startTile.stationPlatformId) {
        return t.stationPlatformId === startTile.stationPlatformId;
      }
      if (startTile.stationGroupId) {
        return t.stationGroupId === startTile.stationGroupId;
      }
      return t.type === startTile.type && (t.rotation % 2 === rot % 2);
    };

    const tiles: TileData[] = [];
    let curX = startTile.x, curZ = startTile.z;
    while (true) {
      const t = this.getTile(curX, curZ, targetLayer);
      if (isSameStation(t)) {
        tiles.push(t!);
        curX += stepX;
        curZ += stepZ;
      } else break;
    }
    return tiles;
  }

  /**
   * Phase3 ①: 近接する平行ホーム（同一駅の別番線）を「番線タブ」として束ねるための
   * 全駅・信号場グループの開始タイル一覧を取得する。同一駅名が設定されている場合はそれを優先し、
   * 未設定の場合は軌道軸が同じで近接（8マス以内）するグループを自動的に同一駅としてまとめる。
   */
  public getSiblingPlatformStartTiles(x: number, z: number, layer: GridLayer = this.activeLayer): TileData[] {
    const origin = this.getStationStartTile(x, z, layer);
    if (!origin) return [];

    const groupStarts = new Map<string, TileData>();
    // 全階層のタイルから駅・信号場・貨物駅グループの開始タイルを収集
    const allTiles = this.getAllTiles();
    for (const t of allTiles) {
      if (!WorldMap.isStationTileType(t.type)) continue;
      if (t.stationPart !== 'start' && t.stationPart !== 'single') continue;
      const key = t.stationGroupId || `${t.x}_${t.z}_${t.layer ?? 1}`;
      if (!groupStarts.has(key)) groupStarts.set(key, t);
    }

    // StationManager に所属する駅の兄弟ホーム開始タイルも追加
    const originLayer = (origin.layer ?? 1) as GridLayer;
    const originPlatInfo = this.stationManager.getPlatformByTile(origin.x, origin.z, originLayer);
    if (originPlatInfo) {
      for (const plat of originPlatInfo.station.platforms) {
        if (plat.tiles.length > 0) {
          const firstCoord = plat.tiles[0];
          const st = this.getTile(firstCoord.x, firstCoord.z, firstCoord.layer);
          if (st) {
            const key = st.stationGroupId || `${st.x}_${st.z}_${st.layer ?? 1}`;
            groupStarts.set(key, st);
          }
        }
      }
    }

    const originAxis = origin.rotation % 2;
    const named = origin.stationName;

    const getStationKind = (t: TileData) => {
      if (t.type.startsWith('cargo_station')) return 'cargo';
      if (t.type === 'signal_yard') return 'yard';
      if (t.type.startsWith('station')) return 'station';
      return 'other';
    };

    const siblings = Array.from(groupStarts.values()).filter(t => {
      if (t.x === origin.x && t.z === origin.z && (t.layer ?? 1) === originLayer) return true;
      if (getStationKind(t) !== getStationKind(origin)) return false; // 旅客駅・貨物駅・信号場は相互に別グループ
      
      // StationManagerで同一駅として紐付いている場合は無条件で兄弟番線
      if (originPlatInfo) {
        const plat = this.stationManager.getPlatformByTile(t.x, t.z, (t.layer ?? 1) as GridLayer);
        if (plat && plat.station.id === originPlatInfo.station.id) return true;
      }

      if ((t.rotation % 2) !== originAxis) return false;
      if (named && t.stationName === named) return true;
      const dist = Math.max(Math.abs(t.x - origin.x), Math.abs(t.z - origin.z));
      return dist <= 8;
    });

    // 番線番号は座標順（北西→南東）で安定させる
    siblings.sort((a, b) => (a.x - b.x) || (a.z - b.z));
    return siblings;
  }

  /**
   * ④ 既存の駅のホーム有効長（1〜10両）を設定・変更する
   * 始点タイルを基準に、指定した長さ分になるよう駅タイルを延伸または短縮する。
   */
  public setStationLength(
    x: number,
    z: number,
    targetLength: number,
    layer?: GridLayer,
    isTileOccupied?: (x: number, z: number, layer: GridLayer) => boolean
  ): boolean {
    if (targetLength < 1 || targetLength > 10) return false;
    const checkLayer = (layer ?? this.activeLayer) as GridLayer;
    const tile = this.getTile(x, z, checkLayer) || this.getTile(x, z);
    if (!tile || !WorldMap.isStationTileType(tile.type)) return false;

    const rot = tile.rotation;
    const stationType = tile.type;
    const stLayer = (tile.layer ?? checkLayer) as GridLayer;
    const startTile = this.getStationStartTile(x, z, stLayer);
    if (!startTile) return false;

    const stepX = (rot % 2 === 1) ? 1 : 0;
    const stepZ = (rot % 2 === 1) ? 0 : 1;
    const isYard = stationType === 'signal_yard';
    const isCargo = stationType.startsWith('cargo_station');
    const defaultName = isYard
      ? `信号場 (${startTile.x}, ${startTile.z})`
      : (isCargo
        ? `貨物駅 (${startTile.x}, ${startTile.z})`
        : `駅 (${startTile.x}, ${startTile.z})`);
    const stationName = startTile.stationName || defaultName;

    // 現在の駅タイル列を取得
    const currentTiles: TileData[] = [];
    let curX = startTile.x, curZ = startTile.z;
    while (true) {
      const t = this.getTile(curX, curZ, stLayer);
      if (t && t.type === stationType && (t.rotation % 2 === rot % 2)) {
        currentTiles.push(t);
        curX += stepX;
        curZ += stepZ;
      } else break;
    }

    const currentLen = currentTiles.length;
    if (currentLen === targetLength) return true;

    if (targetLength > currentLen) {
      // 延伸：末尾から追加
      for (let i = currentLen; i < targetLength; i++) {
        const nx = startTile.x + stepX * i;
        const nz = startTile.z + stepZ * i;
        if (!this.isInBounds(nx, nz)) return false;
        if (isTileOccupied && isTileOccupied(nx, nz, stLayer)) {
          return false;
        }
        const waterCheck = this.canPlaceAtWater(nx, nz, stLayer);
        if (!waterCheck.allowed) return false;

        const targetTile = this.getTile(nx, nz, stLayer);
        // ★修正: 更地、または同じ向き(rot)の直線レールのみ駅に置換可能とする（曲線や勾配・直交レールの上書き破壊を防止）
        const isCompatibleStraightRail =
          targetTile &&
          (targetTile.type === 'rail_ground' || targetTile.type === 'rail_elevated') &&
          (targetTile.rotation % 2) === (rot % 2);
        if (targetTile && targetTile.type !== 'empty' && !isCompatibleStraightRail) {
          return false; // スペース不足・障害物あり
        }
      }
      for (let i = currentLen; i < targetLength; i++) {
        const nx = startTile.x + stepX * i;
        const nz = startTile.z + stepZ * i;
        this.setTile(nx, nz, stationType, rot, 1, startTile.stationPlatformSide ?? 'right', stLayer);
        const t = this.getTile(nx, nz, stLayer);
        if (t) {
          t.stationName = stationName;
          t.stationSchedule = startTile.stationSchedule;
          t.stationGroupId = startTile.stationGroupId;
          t.stationPlatformId = startTile.stationPlatformId;
          t.stationPlatformSide = startTile.stationPlatformSide ?? 'right';
          if (isCargo) {
            t.isCargoYard = true;
          }
        }
      }
    } else {
      // 【列車安全ガード】短縮対象タイルおよび駅ホーム上に列車が停車・通過中の場合は短縮を禁止
      if (isTileOccupied) {
        for (let i = 0; i < currentLen; i++) {
          const nx = startTile.x + stepX * i;
          const nz = startTile.z + stepZ * i;
          if (isTileOccupied(nx, nz, stLayer)) {
            return false;
          }
        }
      }

      // 短縮：余剰タイルを撤去（または地上/高架線路へ戻す）
      const isElevatedTrack = stationType.includes('elevated') || stLayer >= 2;
      const normalTrack: TileType = isElevatedTrack ? 'rail_elevated' : 'rail_ground';
      for (let i = targetLength; i < currentLen; i++) {
        const nx = startTile.x + stepX * i;
        const nz = startTile.z + stepZ * i;
        this.setTile(nx, nz, normalTrack, rot, 1, 'right', stLayer);
        const t = this.getTile(nx, nz, stLayer);
        if (t) {
          t.stationGroupId = undefined;
          t.stationPlatformId = undefined;
          t.stationPart = undefined;
          t.stationPlatformSide = undefined;
          t.isCargoYard = undefined;
        }
      }
    }

    // 更新後の全駅タイルのパーツ（start, mid, end, single）とメッシュを再構築
    for (let i = 0; i < targetLength; i++) {
      const nx = startTile.x + stepX * i;
      const nz = startTile.z + stepZ * i;
      const t = this.getTile(nx, nz, stLayer);
      if (t && t.type === stationType) {
        t.stationSchedule = startTile.stationSchedule;
        t.stationGroupId = startTile.stationGroupId;
        t.stationPlatformId = startTile.stationPlatformId;
        if (isCargo) {
          t.isCargoYard = true;
        }
        const part = (targetLength === 1)
          ? 'single'
          : (i === 0 ? 'start' : (i === targetLength - 1 ? 'end' : 'mid'));
        t.stationPart = part; // ★追加: stationPart プロパティを同期更新

        this.removeTileMesh(t); // 古いメッシュの完全解放
        const isElevated = stationType.includes('elevated') || stLayer >= 2;
        const platformSide = startTile.stationPlatformSide ?? 'right';
        t.stationPlatformSide = platformSide;
        const tileLayer = (t.layer ?? this.activeLayer) as GridLayer;
        const baseH = layerToHeight(tileLayer);
        const elevY = this.getTrackElevationOffset(nx, nz, tileLayer);
        t.elevationOffset = elevY;
        const mesh = isYard
          ? ModelFactory.createSignalYard(rot, isElevated, platformSide, baseH)
          : (isCargo
            ? ModelFactory.createCargoStation(rot, isElevated, platformSide, baseH)
            : ModelFactory.createStation(rot, isElevated, part, platformSide, t.stationName ?? '駅', baseH));
        mesh.position.set(nx * WorldMap.TILE_SIZE, baseH + elevY, nz * WorldMap.TILE_SIZE);
        mesh.visible = this.isLayerVisibleInCurrentMode(tileLayer);
        this.attachTileMesh(t, mesh);
      }
    }

    // StationManager にホーム有効長（および更新されたタイル）を同期通知
    const platInfo = this.stationManager.getPlatformByTile(startTile.x, startTile.z, stLayer);
    const newTiles: Array<{ x: number; z: number; layer: GridLayer }> = [];
    for (let i = 0; i < targetLength; i++) {
      newTiles.push({
        x: startTile.x + stepX * i,
        z: startTile.z + stepZ * i,
        layer: stLayer
      });
    }

    if (platInfo) {
      this.stationManager.updatePlatformLength(
        platInfo.station.id,
        platInfo.platform.id,
        targetLength,
        newTiles
      );
      for (const tCoord of newTiles) {
        const t = this.getTile(tCoord.x, tCoord.z, tCoord.layer);
        if (t) {
          t.stationGroupId = platInfo.station.id;
          t.stationPlatformId = platInfo.platform.id;
        }
      }
    } else {
      // 未登録の場合はホームとして新規登録
      const isSignalYard = stationType === 'signal_yard';
      const reg = this.stationManager.registerPlatform({
        tiles: newTiles,
        length: targetLength,
        trackAxis: rot,
        isSignalYard,
        isCargoStation: isCargo,
        customName: stationName
      });
      for (const tCoord of newTiles) {
        const t = this.getTile(tCoord.x, tCoord.z, tCoord.layer);
        if (t) {
          t.stationGroupId = reg.station.id;
          t.stationPlatformId = reg.platform.id;
        }
      }
    }

    this.markDirty();
    return true;
  }

  /**
   * ⑤ 駅グループ全体の集計情報（合計乗降客数、合計運賃収入、維持費、純利益）を取得
   */
  public getStationAggregateData(x: number, z: number, layer: GridLayer = this.activeLayer): {
    id?: string;
    name: string;
    platformNumber?: number;
    platformCount?: number;
    length: number;
    dailyPassengers: number;
    previousDayPassengers: number;
    twoDaysAgoPassengers: number;
    dailyLoadedCargo?: number;
    dailyUnloadedCargo?: number;
    previousDayLoadedCargo?: number;
    previousDayUnloadedCargo?: number;
    totalPassengers: number;
    totalRevenue: number;
    maintenance: number;
    netProfit: number;
    isSignalYard?: boolean;
    isCargoYard?: boolean;
    cargoContainers?: number;
  } | null {
    const tile = this.getTile(x, z, layer);
    if (!tile || !WorldMap.isStationTileType(tile.type)) return null;

    const stLayer = (tile.layer ?? layer) as GridLayer;
    const isYard = tile.type === 'signal_yard';
    const isCargo = tile.type.startsWith('cargo_station') || !!tile.isCargoYard;

    // StationManager から所属駅とホームの正本データを直接取得（Single Source of Truth）
    const platInfo = this.stationManager.getPlatformByTile(x, z, stLayer);
    if (platInfo) {
      const { station, platform } = platInfo;
      return {
        id: station.id,
        name: station.name,
        platformNumber: platform.platformNumber,
        platformCount: station.platforms.length,
        length: platform.length,
        dailyPassengers: (isYard || isCargo) ? 0 : station.dailyPassengers,
        previousDayPassengers: (isYard || isCargo) ? 0 : (station.previousDayPassengers ?? 0),
        twoDaysAgoPassengers: (isYard || isCargo) ? 0 : (station.twoDaysAgoPassengers ?? 0),
        dailyLoadedCargo: isCargo ? (station.dailyLoadedCargo ?? 0) : 0,
        dailyUnloadedCargo: isCargo ? (station.dailyUnloadedCargo ?? 0) : 0,
        previousDayLoadedCargo: isCargo ? (station.previousDayLoadedCargo ?? 0) : 0,
        previousDayUnloadedCargo: isCargo ? (station.previousDayUnloadedCargo ?? 0) : 0,
        totalPassengers: (isYard || isCargo) ? 0 : station.totalPassengers,
        totalRevenue: station.totalRevenue,
        maintenance: station.maintenance,
        netProfit: station.netProfit,
        isSignalYard: station.isSignalYard,
        isCargoYard: isCargo,
        cargoContainers: tile.cargoContainers ?? 0
      };
    }

    // 未登録時のフォールバック（初期化時等）
    const length = this.getStationRunLength(x, z, stLayer) || 1;
    const defaultMaint = isYard ? 20000 : (isCargo ? 50000 : 200000);
    const defaultName = isYard
      ? `第1信号場`
      : (isCargo ? `第1貨物駅` : `第1駅`);

    return {
      id: tile.stationGroupId,
      name: tile.stationName || defaultName,
      platformNumber: 1,
      platformCount: 1,
      length,
      dailyPassengers: 0,
      previousDayPassengers: 0,
      twoDaysAgoPassengers: 0,
      dailyLoadedCargo: 0,
      dailyUnloadedCargo: 0,
      previousDayLoadedCargo: 0,
      previousDayUnloadedCargo: 0,
      totalPassengers: 0,
      totalRevenue: 0,
      maintenance: defaultMaint,
      netProfit: -defaultMaint,
      isSignalYard: isYard,
      isCargoYard: isCargo,
      cargoContainers: tile.cargoContainers ?? 0
    };
  }

  /**
   * 貨物駅グループの蓄積コンテナ数を取得する
   */
  public getStationCargoContainers(x: number, z: number, layer: GridLayer = this.activeLayer): number {
    const startTile = this.getStationStartTile(x, z, layer);
    if (!startTile) return 0;
    return startTile.cargoContainers ?? 0;
  }

  /**
   * 貨物駅グループの蓄積コンテナ数を設定・同期する
   */
  public setStationCargoContainers(x: number, z: number, count: number, layer: GridLayer = this.activeLayer): void {
    const startTile = this.getStationStartTile(x, z, layer);
    if (!startTile) return;
    const val = Math.max(0, count);
    const platInfo = this.stationManager.getPlatformByTile(startTile.x, startTile.z, (startTile.layer ?? layer) as GridLayer);
    if (platInfo) {
      for (const plat of platInfo.station.platforms) {
        for (const pt of plat.tiles) {
          const t = this.getTile(pt.x, pt.z, pt.layer);
          if (t) t.cargoContainers = val;
        }
      }
    } else {
      const tiles = this.getStationTiles(startTile.x, startTile.z, layer);
      for (const t of tiles) {
        t.cargoContainers = val;
      }
    }
    this.markDirty();
  }

  /**
   * 貨物駅グループの蓄積コンテナ数を増減加算する
   */
  public addStationCargoContainers(x: number, z: number, delta: number, layer: GridLayer = this.activeLayer): number {
    const cur = this.getStationCargoContainers(x, z, layer);
    const next = Math.max(0, cur + delta);
    this.setStationCargoContainers(x, z, next, layer);
    return next;
  }

  /**
   * 駅名・信号場名のリネーム
   * プレイヤーが自由に変更した名前を駅グループ全体および StationManager に反映する
   */
  public renameStation(x: number, z: number, newName: string, layer: GridLayer = this.activeLayer): boolean {
    const trimmed = newName.trim();
    if (!trimmed) return false;

    const startTile = this.getStationStartTile(x, z, layer);
    if (!startTile) return false;

    const stLayer = (startTile.layer ?? layer) as GridLayer;

    // StationManager の駅名をリネーム
    const platInfo = this.stationManager.getPlatformByTile(startTile.x, startTile.z, stLayer);
    if (platInfo) {
      this.stationManager.renameStation(platInfo.station.id, trimmed);
    }

    // 兄弟番線（全ホーム）の開始タイルを取得し、すべての番線の stationName と3D看板を一括更新
    const siblingStarts = this.getSiblingPlatformStartTiles(startTile.x, startTile.z, stLayer);
    const allStarts = siblingStarts.length > 0 ? siblingStarts : [startTile];

    for (const sibStart of allStarts) {
      const sibLayer = (sibStart.layer ?? stLayer) as GridLayer;
      const tiles = this.getStationTiles(sibStart.x, sibStart.z, sibLayer);
      for (const t of tiles) {
        t.stationName = trimmed;
        if (t.mesh) {
          ModelFactory.updateStationSign(t.mesh, trimmed);
        }
      }
    }

    // StationManager に所属する同一駅の全ホーム・全タイルも網羅して確実に同期
    if (platInfo) {
      for (const platform of platInfo.station.platforms) {
        for (const pt of platform.tiles) {
          const t = this.getTile(pt.x, pt.z, pt.layer);
          if (t) {
            t.stationName = trimmed;
            if (t.mesh) {
              ModelFactory.updateStationSign(t.mesh, trimmed);
            }
          }
        }
      }
    }

    this.markDirty();
    return true;
  }

  private updateNeighborStations(x: number, z: number, rot: number, type: TileType, layer: GridLayer = this.activeLayer) {
    const neighbors = rot === 1
      ? [this.getTile(x - 1, z, layer), this.getTile(x + 1, z, layer)]
      : [this.getTile(x, z - 1, layer), this.getTile(x, z + 1, layer)];

    neighbors.forEach(n => {
      if (n && n.type === type && n.mesh) {
        const tileLayer = (n.layer ?? layer) as GridLayer;
        const part = this.detectStationPart(n.x, n.z, n.rotation, n.type, tileLayer);
        n.stationPart = part;
        n.mesh.removeFromParent();
        disposeHierarchy(n.mesh); // 旧メッシュのGPUリソース解放（VRAMリーク防止）
        const isElevated = n.type.includes('elevated');
        const baseH = layerToHeight(tileLayer);
        const elevY = this.getTrackElevationOffset(n.x, n.z, tileLayer);
        n.elevationOffset = elevY;
        const newMesh = ModelFactory.createStation(n.rotation, isElevated, part, n.stationPlatformSide ?? 'right', n.stationName ?? '駅', baseH);
        newMesh.position.set(n.x * WorldMap.TILE_SIZE, baseH + elevY, n.z * WorldMap.TILE_SIZE);
        newMesh.visible = this.isLayerVisibleInCurrentMode(tileLayer);
        this.attachTileMesh(n, newMesh);
      }
    });
  }

  /**
   * ② 分岐器の開通状態を明示的に指定して切り替える
   */
  public setSwitchState(x: number, z: number, state: SwitchState, layer: GridLayer = this.activeLayer, isTransient: boolean = false): void {
    const tile = this.getTile(x, z, layer);
    if (!tile || !tile.type.startsWith('point_switch')) return;
    if (tile.switchState === state) return;

    tile.switchState = state;
    if (tile.mesh && ModelFactory.updateSwitchHubState(tile.mesh, tile.switchState === 'diverge')) {
      if (!isTransient) {
        this.markDirty();
      }
      return;
    }

    if (tile.mesh) {
      tile.mesh.removeFromParent();
      disposeHierarchy(tile.mesh); // 旧メッシュのGPUリソース解放（VRAMリーク防止）
      tile.mesh = undefined;
    }
    const tileLayer = (tile.layer ?? layer) as GridLayer;
    const isElevated = tile.type.includes('elevated');
    const branchSide = tile.switchBranchSide ?? 'right';
    const baseH = layerToHeight(tileLayer);
    const elevY = this.getTrackElevationOffset(tile.x, tile.z, tileLayer);
    tile.elevationOffset = elevY;
    const isTunnel = this.isTunnelSection(tile.x, tile.z, tileLayer);
    const mesh = ModelFactory.createSwitchHub(tile.rotation, tile.switchState === 'diverge', isElevated, branchSide, baseH, isTunnel);
    mesh.position.set(tile.x * WorldMap.TILE_SIZE, baseH + elevY, tile.z * WorldMap.TILE_SIZE);
    mesh.visible = this.isLayerVisibleInCurrentMode(tileLayer);
    this.attachTileMesh(tile, mesh);
    if (!isTransient) {
      this.markDirty();
    }
  }

  /**
   * ⑤ 指定された有効長（1〜4マス）の駅ホームを一括敷設する。
   * 全マスに共通の stationGroupId を割り当て、先頭・中間・末尾のパーツを正確に適用する。
   */
  public placeStationGroup(
    originX: number,
    originZ: number,
    length: number,
    rotation: number,
    isElevated: boolean = false,
    name?: string,
    platformSide: 'left' | 'right' = 'right',
    layer: GridLayer = this.activeLayer,
    isSignalYard: boolean = false,
    isCargoStation: boolean = false
  ): boolean {
    const rot = rotation % 2;
    const stepX = rot === 1 ? 1 : 0;
    const stepZ = rot === 1 ? 0 : 1;
    let stationType: TileType = isElevated ? 'station_elevated' : 'station_ground';
    if (isSignalYard) stationType = 'signal_yard';
    else if (isCargoStation) stationType = isElevated ? 'cargo_station_elevated' : 'cargo_station_ground';

    // 敷設可能チェック
    for (let i = 0; i < length; i++) {
      const tx = originX + stepX * i;
      const tz = originZ + stepZ * i;
      if (!this.isInBounds(tx, tz)) return false;
      const t = this.getTile(tx, tz, layer);
      if (t && t.type !== 'empty') {
        // 直線線路（地上・高架）かつ向きが一致していればアタッチ設置可能
        const isCompatibleTrack = (t.type === 'rail_ground' || t.type === 'rail_elevated') && t.rotation === rot;
        if (!isCompatibleTrack) return false;
      }
      const waterCheck = this.canPlaceAtWater(tx, tz, layer);
      if (!waterCheck.allowed) return false;
    }

    const groupId = isSignalYard
      ? `yard_${Date.now()}_${originX}_${originZ}`
      : (isCargoStation
        ? `cargo_${Date.now()}_${originX}_${originZ}`
        : `st_${Date.now()}_${originX}_${originZ}`);
    const stationName = name || (isSignalYard
      ? `第${this.getStationCount() + 1}信号場`
      : (isCargoStation
        ? `第${this.getStationCount() + 1}貨物駅`
        : `第${this.getStationCount() + 1}駅`));
    const baseH = layerToHeight(layer);

    const tiles: Array<{ x: number; z: number; layer: GridLayer }> = [];
    for (let i = 0; i < length; i++) {
      const tx = originX + stepX * i;
      const tz = originZ + stepZ * i;
      tiles.push({ x: tx, z: tz, layer });
      const part: 'single' | 'start' | 'mid' | 'end' =
        length === 1 ? 'single' : (i === 0 ? 'start' : (i === length - 1 ? 'end' : 'mid'));

      const tile = this.getOrCreateTile(tx, tz, layer)!;
      this.removeTileMesh(tile);

      tile.type = stationType;
      tile.layer = layer;
      tile.rotation = rot;
      tile.level = isElevated ? LEVEL_ELEVATED : LEVEL_GROUND;
      tile.stationGroupId = groupId;
      tile.stationPart = part;
      tile.stationPlatformSide = platformSide;
      tile.stationName = stationName;
      tile.stationSchedule = isCargoStation ? createDefaultCargoStationSchedule() : createDefaultStationSchedule();
      if (isCargoStation) {
        tile.isCargoYard = true;
      }

      const elevY = this.getTrackElevationOffset(tx, tz, layer);
      tile.elevationOffset = elevY;
      const mesh = isSignalYard
        ? ModelFactory.createSignalYard(rot, isElevated, platformSide, baseH)
        : (isCargoStation
          ? ModelFactory.createCargoStation(rot, isElevated, platformSide, baseH)
          : ModelFactory.createStation(rot, isElevated, part, platformSide, stationName, baseH));
      mesh.position.set(tx * WorldMap.TILE_SIZE, baseH + elevY, tz * WorldMap.TILE_SIZE);
      mesh.visible = this.isLayerVisibleInCurrentMode(layer);
      this.attachTileMesh(tile, mesh);
    }

    // StationManager にホーム（番線）として登録
    const reg = this.stationManager.registerPlatform({
      tiles,
      length,
      trackAxis: rot,
      isSignalYard,
      isCargoStation,
      customName: stationName
    });

    // 発番された stationId と platformId を構成タイルの stationGroupId と stationPlatformId に確実に書き込む
    for (const tCoord of tiles) {
      const t = this.getTile(tCoord.x, tCoord.z, tCoord.layer);
      if (t) {
        t.stationGroupId = reg.station.id;
        t.stationPlatformId = reg.platform.id;
        t.stationName = reg.station.name;
        if (t.mesh && !isSignalYard) {
          ModelFactory.updateStationSign(t.mesh, reg.station.name);
        }
      }
    }

    this.markDirty();
    return true;
  }

  /**
   * ① タイルメッシュの安全な破棄とGPUリソース完全解放（VRAMリーク防止）
   */
  private removeTileMesh(tile: TileData): void {
    const tileKey = `${tile.x},${tile.z},${tile.layer ?? 1}`;
    this.instancedMeshManager.removeGroundTrack(tileKey);
    this.instancedMeshManager.removeElevatedTrack(tileKey);
    this.instancedMeshManager.removeTree(tileKey);

    if (tile.mesh) {
      tile.mesh.removeFromParent();
      disposeHierarchy(tile.mesh);
      tile.mesh = undefined;
    }
  }

  private resetTileData(tile: TileData) {
    this.removeTileMesh(tile);
    const wasRailGround = tile.type === 'rail_ground';
    const prevRotation = tile.rotation;
    // スロープの跨がり登録（高架・地下）を解除
    if (tile.type === 'rail_slope') {
      const baseLayer = (tile.layer ?? 1) as GridLayer;
      const upperLayer = (baseLayer + 1) as GridLayer;
      const upperTile = this.grid3D.get(tile.x, upperLayer, tile.z);
      if (upperTile === tile) {
        this.grid3D.delete(tile.x, upperLayer, tile.z);
      }
    } else if (tile.type === 'rail_slope_underground') {
      const lowerTile = this.grid3D.get(tile.x, -1, tile.z);
      if (lowerTile === tile) {
        this.grid3D.delete(tile.x, -1, tile.z);
      }
      this.groundHoleHandler?.remove(tile.x, tile.z);
    }

    tile.type = 'empty';
    tile.rotation = 0;
    tile.level = 1;
    tile.stationPassengers = 0;
    tile.curveDir = undefined;
    tile.switchState = 'straight';
    tile.groupOrigin = undefined;
    tile.crossingRole = undefined;
    tile.crossingState = undefined;
    tile.crossingRoadAxis = undefined;
    tile.slopeReversed = undefined;
    tile.slopePart = undefined;
    tile.stationGroupId = undefined;
    tile.stationPlatformId = undefined;
    tile.stationPart = undefined;
    tile.stationPlatformSide = undefined;
    tile.stationSchedule = undefined;
    tile.switchSchedule = undefined;
    tile.stationName = undefined;
    tile.cargoContainers = undefined;
    tile.isCargoYard = undefined;

    // 疎マップ構造化: 地上1Fを含め、全階層で empty オブジェクトを Map に残さず完全削除する
    const layer = (tile.layer ?? 1) as GridLayer;
    const tx = tile.x;
    const tz = tile.z;
    this.grid3D.delete(tx, layer, tz);
    if (layer === 1) {
      this.tiles.delete(this.getKey(tx, tz));
    }

    // マップから削除された直後に同期的に隣接トンネルタイルの坑口ポータルを更新（非同期 setTimeout による競合を排除）
    if (wasRailGround) {
      const isEW = (prevRotation === 1);
      const dirA = isEW ? { x: -1, z: 0 } : { x: 0, z: -1 };
      const dirB = isEW ? { x: 1, z: 0 } : { x: 0, z: 1 };
      this.updateTunnelTilePortal(tx + dirA.x, tz + dirA.z, layer);
      this.updateTunnelTilePortal(tx + dirB.x, tz + dirB.z, layer);
    }

    // 直上階層の高架線路の橋脚を再計算（下層が撤去されたため地上まで延長）
    this.updateUpperElevatedPiers(tx, tz, layer);
    this.markDirty();
  }

  /**
   * ⑤ 撤去処理。駅タイルの場合は同一駅グループ（有効長分の全マス）を一括撤去する。
   * シーサスクロッシンググループの一員を撤去した場合は残りを単体線路化する。
   */
  public demolishTile(
    x: number,
    z: number,
    layer: GridLayer = this.activeLayer,
    demolishMode: 'track' | 'city' | 'all' = 'all'
  ): boolean {
    const tile = this.getTile(x, z, layer);
    if (!tile || tile.type === 'empty') return false;

    // 踏切の部分撤去: 線路撤去なら道路に戻し、街づくり撤去なら地上線路に戻す
    if (tile.type === 'level_crossing' && demolishMode !== 'all') {
      const railAxis = ((tile.rotation ?? 0) % 2 + 2) % 2;
      const roadAxis = tile.crossingRoadAxis ?? (1 - railAxis);
      if (demolishMode === 'track') {
        return this.setTile(x, z, 'road', roadAxis, 1, 'right', layer);
      } else if (demolishMode === 'city') {
        return this.setTile(x, z, 'rail_ground', railAxis, 1, 'right', layer);
      }
    }

    // ⑤ 駅・信号場タイルの場合: 同一番線グループ全体を一括撤去する
    if (tile.type.includes('station') || tile.type === 'signal_yard') {
      const tilesToDemolish = this.getDemolitionAffectedTiles(x, z, layer);

      for (const st of tilesToDemolish) {
        const prevType = st.type;
        const rot = st.rotation;
        const sx = st.x;
        const sz = st.z;
        const stLayer = (st.layer ?? layer) as GridLayer;
        this.stationManager.removeTileFromPlatform(sx, sz, stLayer);

        // 駅舎・ホーム・コンテナ等は線路に付随するオプションパーツとして扱うため、
        // 駅撤去時は線路を残して元の直線線路（地上線路または高架線路）に復元する
        const isElevated = prevType.includes('elevated') || stLayer >= 2;
        const restoreTrackType: TileType = isElevated ? 'rail_elevated' : 'rail_ground';

        // 駅固有のプロパティをクリアしてから setTile で正規の直線線路（InstancedMesh対応）として再構築
        st.stationPassengers = 0;
        st.stationGroupId = undefined;
        st.stationPlatformId = undefined;
        st.stationPart = undefined;
        st.stationPlatformSide = undefined;
        st.stationSchedule = undefined;
        st.stationName = undefined;
        st.cargoContainers = undefined;
        st.isCargoYard = undefined;

        this.setTile(sx, sz, restoreTrackType, rot, 1, 'right', stLayer);

        if (prevType.startsWith('station')) {
          this.updateNeighborStations(sx, sz, rot, prevType, stLayer);
        }
      }
      return true;
    }

    // シーサスクロッシングの独立化処理
    if (tile.groupOrigin) {
      const origin = this.getTile(tile.groupOrigin.x, tile.groupOrigin.z, layer);
      if (origin && origin.crossingRole === 0) {
        const isElevated = origin.type.includes('elevated');
        const normalRailType: TileType = isElevated ? 'rail_elevated' : 'rail_ground';
        const mainAxisRot = origin.rotation === 1 ? 1 : 0;
        const groupTiles = this.getDemolitionAffectedTiles(x, z, layer);

        for (const t of groupTiles) {
          if (t.x === x && t.z === z) continue;
          if (t.type.startsWith('scissors_crossing')) {
            // 残ったマスを主線の向きに沿った通常の直線レールに安全に退行させる
            this.setTile(t.x, t.z, normalRailType, mainAxisRot, 1, 'right', layer);
          }
        }
      }
    }

    // 勾配線路（地上・地下ともに4マス構成）の一括撤去
    if (tile.type === 'rail_slope' || tile.type === 'rail_slope_underground') {
      const slopeTiles = this.getDemolitionAffectedTiles(x, z, layer);
      for (const st of slopeTiles) {
        this.resetTileData(st);
      }
      return true;
    }

    this.resetTileData(tile);
    return true;
  }

  /**
   * 指定座標のタイルのスナップショットを生成する
   */
  public createTileSnapshot(x: number, z: number, layer: GridLayer = this.activeLayer): TileDataSnapshot | null {
    const tile = this.getTile(x, z, layer);
    return cloneTileSnapshot(tile);
  }

  /**
   * 撤去時に影響を受けるすべてのタイル一覧（駅ホーム全体、シーサス4マス、勾配4マス等）を取得する
   */
  public getDemolitionAffectedTiles(x: number, z: number, layer: GridLayer = this.activeLayer): TileData[] {
    const tile = this.getTile(x, z, layer);
    if (!tile || tile.type === 'empty') return [];

    // 1. 駅・信号場・貨物駅（同一グループ全体）
    if (tile.type.includes('station') || tile.type === 'signal_yard') {
      const tiles: TileData[] = [];
      if (tile.stationPlatformId) {
        // ★修正: 駅全体(stationGroupId)ではなく、クリックした番線(stationPlatformId)のみを撤去対象にする
        const targetPlatId = tile.stationPlatformId;
        this.getAllTiles().forEach(t => {
          if (t.stationPlatformId === targetPlatId) {
            tiles.push(t);
          }
        });
      } else if (tile.stationGroupId) {
        // stationPlatformId が未設定の場合でも、同一線路上の連続タイルのみを取得
        tiles.push(...this.getStationTiles(x, z, layer));
      } else {
        const startTile = this.getStationStartTile(x, z, layer);
        if (startTile) {
          const rot = startTile.rotation;
          const stType = startTile.type;
          const stepX = (rot % 2 === 1) ? 1 : 0;
          const stepZ = (rot % 2 === 1) ? 0 : 1;
          let curX = startTile.x, curZ = startTile.z;
          while (true) {
            const t = this.getTile(curX, curZ, layer);
            if (t && t.type === stType && (t.rotation % 2 === rot % 2)) {
              tiles.push(t);
              curX += stepX;
              curZ += stepZ;
            } else break;
          }
        } else {
          tiles.push(tile);
        }
      }
      return tiles.length > 0 ? tiles : [tile];
    }

    // 2. シーサスクロッシング（2×2グループの4マス）
    if (tile.groupOrigin) {
      const origin = this.getTile(tile.groupOrigin.x, tile.groupOrigin.z, layer);
      if (origin && origin.crossingRole === 0) {
        const along = origin.rotation === 1 ? 1 : 2;
        const across = WorldMap.rotateCW(along);
        const alongVec = WorldMap.DIRS[along];
        const acrossVec = WorldMap.DIRS[across];
        const coords = [
          { x: origin.x, z: origin.z },
          { x: origin.x + alongVec.x, z: origin.z + alongVec.z },
          { x: origin.x + acrossVec.x, z: origin.z + acrossVec.z },
          { x: origin.x + alongVec.x + acrossVec.x, z: origin.z + alongVec.z + acrossVec.z }
        ];
        const tiles: TileData[] = [];
        for (const c of coords) {
          const t = this.getTile(c.x, c.z, layer);
          if (t) tiles.push(t);
        }
        return tiles.length > 0 ? tiles : [tile];
      }
    }

    // 3. 勾配線路（4マス）
    if (tile.type === 'rail_slope' || tile.type === 'rail_slope_underground') {
      const rot = tile.rotation;
      const rev = !!tile.slopeReversed;
      const part = tile.slopePart ?? 0;
      const axis: [number, number] = rot === 1 ? [1, 3] : [0, 2];
      const [, stepIdx] = rev ? [axis[1], axis[0]] : [axis[0], axis[1]];
      const stepDir = WorldMap.DIRS[stepIdx];
      const originX = tile.x - stepDir.x * part;
      const originZ = tile.z - stepDir.z * part;
      const baseLayer = (tile.layer ?? 1) as GridLayer;
      const tiles: TileData[] = [];
      for (let i = 0; i < SLOPE_PARTS; i++) {
        const sx = originX + stepDir.x * i;
        const sz = originZ + stepDir.z * i;
        const st = this.getTile(sx, sz, baseLayer);
        if (st && st.type === tile.type) {
          tiles.push(st);
        }
      }
      return tiles.length > 0 ? tiles : [tile];
    }

    // 4. 通常タイル（1マス）
    return [tile];
  }

  /**
   * スナップショットからタイルを完全復元する
   */
  public restoreTileFromSnapshot(snap: TileDataSnapshot | null, x: number, z: number, layer: GridLayer = this.activeLayer): void {
    if (!snap || snap.type === 'empty') {
      this.setTile(x, z, 'empty', 0, 1, 'right', layer);
      return;
    }

    const lyr = snap.layer ?? layer;
    const isElevated = snap.type.includes('elevated') || lyr >= 2;

    if (snap.type.startsWith('point_switch')) {
      this.placeSwitch(snap.x, snap.z, snap.rotation, isElevated, snap.switchBranchSide || 'right', lyr);
      if (snap.switchState === 'diverge') {
        this.togglePointSwitch(snap.x, snap.z, lyr);
      }
      const swTile = this.getTile(snap.x, snap.z, lyr);
      if (swTile && snap.switchSchedule) {
        swTile.switchSchedule = cloneSwitchSchedule(snap.switchSchedule);
      }
    } else if (snap.type.startsWith('scissors_crossing')) {
      if (snap.crossingRole === 0 && snap.groupOrigin && snap.groupOrigin.x === snap.x && snap.groupOrigin.z === snap.z) {
        this.placeScissorsCrossing(snap.x, snap.z, snap.rotation, isElevated, lyr);
        if (snap.switchSchedule) {
          const crTile = this.getTile(snap.x, snap.z, lyr);
          if (crTile) crTile.switchSchedule = cloneSwitchSchedule(snap.switchSchedule);
        }
        if (snap.crossingState) {
          this.setCrossingState(snap.x, snap.z, snap.crossingState, lyr, true); // ★第5引数 true
        }
      } else if (!snap.groupOrigin) {
        this.setTile(snap.x, snap.z, snap.type, snap.rotation, snap.level, 'right', lyr);
      }
    } else if (snap.type.startsWith('rail_curve') && snap.curveDir !== undefined) {
      this.placeCurve(snap.x, snap.z, snap.curveDir, isElevated, lyr);
    } else if (snap.type === 'rail_slope') {
      const tile = this.getOrCreateTile(snap.x, snap.z, lyr);
      if (tile) {
        this.applySlopeTile(tile, snap.rotation, !!snap.slopeReversed, snap.slopePart || 0, lyr, snap.elevationOffset);
        if ((snap.slopePart || 0) === 3) {
          const upperLayer: GridLayer = lyr === 1 ? 2 : ((lyr + 1) as GridLayer);
          this.grid3D.set(snap.x, upperLayer, snap.z, tile);
        }
      }
    } else if (snap.type === 'rail_slope_underground') {
      const tile = this.getOrCreateTile(snap.x, snap.z, lyr);
      if (tile) {
        this.applyUndergroundSlopeTile(tile, snap.rotation, !!snap.slopeReversed, snap.slopePart || 0, lyr);
        if ((snap.slopePart || 0) === 3) {
          this.grid3D.set(snap.x, -1, snap.z, tile);
        }
        if ((snap.slopePart || 0) === 0 || (snap.slopePart || 0) === 1) {
          this.groundHoleHandler?.add(snap.x, snap.z, snap.rotation);
        }
      }
    } else if (snap.type === 'level_crossing') {
      this.applyLevelCrossing(snap.x, snap.z, snap.rotation, snap.crossingRoadAxis ?? (1 - snap.rotation), snap.level, lyr);
    } else if (snap.type.includes('station') || snap.type === 'signal_yard') {
      this.setTile(snap.x, snap.z, snap.type, snap.rotation, snap.level, snap.stationPlatformSide || 'right', lyr);
      const restored = this.getTile(snap.x, snap.z, lyr);
      if (restored) {
        if (snap.stationName) restored.stationName = snap.stationName;
        if (snap.stationGroupId) restored.stationGroupId = snap.stationGroupId;
        if (snap.stationPlatformId) restored.stationPlatformId = snap.stationPlatformId;
        if (snap.stationPart) restored.stationPart = snap.stationPart;
        if (snap.stationPlatformSide) restored.stationPlatformSide = snap.stationPlatformSide;
        if (snap.stationSchedule) restored.stationSchedule = cloneStationSchedule(snap.stationSchedule);
        if (snap.stationPassengers !== undefined) restored.stationPassengers = snap.stationPassengers;
        if (snap.isCargoYard !== undefined) restored.isCargoYard = snap.isCargoYard;
        if (snap.cargoContainers !== undefined) restored.cargoContainers = snap.cargoContainers;
        if (restored.mesh && snap.stationName) {
          ModelFactory.updateStationSign(restored.mesh, snap.stationName);
        }
      }
    } else {
      this.setTile(snap.x, snap.z, snap.type, snap.rotation, snap.level, 'right', lyr);
    }

    const finalTile = this.getTile(snap.x, snap.z, lyr);
    if (finalTile) {
      if (snap.externalCityId !== undefined) finalTile.externalCityId = snap.externalCityId;
      if (snap.isExternalConnection !== undefined) finalTile.isExternalConnection = snap.isExternalConnection;
      if (snap.stationName && !finalTile.stationName) finalTile.stationName = snap.stationName;
    }

    this.updateUpperElevatedPiers(snap.x, snap.z, lyr);
    this.markDirty();
  }

  public clearAll() {
    // 全階層のタイルメッシュを破棄
    const all = this.getAllTiles();
    for (const tile of all) {
      this.resetTileData(tile);
      tile.landValue = 100;
    }
    this.instancedMeshManager.clearAll();
    this.renderBuckets.clear(); // 空になったチャンク×階層バケットも破棄
    this.groundHoleHandler?.clear();
    this.stationManager.clear();
    this.tiles.clear();
    this.grid3D.clear();
    this.initializeGrid();
    this.markDirty();
  }

  public dispose() {
    this.clearAll();
    this.instancedMeshManager.dispose();
  }

  /**
   * 日次（日付変更時）の全駅・ホーム・タイルの本日乗降客数カウンタをリセット
   */
  public resetDailyStationPassengers(): void {
    this.stationManager.resetDailyPassengers();
  }

  public serialize(): string {
    if (!this.isDirty && this.cachedSerializedData !== null) {
      return this.cachedSerializedData;
    }

    const nonEmpties = WorldMapSerializer.extractSavedTileRecords(this.getAllTiles());

    // 【駅の記憶喪失解消】v2 フォーマット: タイル一覧に加えて stationManager の全状態をシリアライズ
    const serialized = JSON.stringify({
      version: 2,
      tiles: nonEmpties,
      stations: this.stationManager.serialize()
    });

    this.cachedSerializedData = serialized;
    this.isDirty = false;
    return serialized;
  }

  public deserialize(jsonOrData: string | { tiles: any[]; stations?: any } | any[]) {
    try {
      const parsed = WorldMapSerializer.parseSavePayload(jsonOrData);
      if (!parsed) return;
      const { data, stationData } = parsed;

      this.clearAll();

      for (const item of data) {
        const lyr: GridLayer = (item.layer ?? 1) as GridLayer;
        const isElevated = item.type.includes('elevated') || lyr >= 2;
        const rot = item.rotation ?? item.rot ?? 0;
        const lvl = item.level ?? item.lvl ?? 1;
        const slopeRev = !!(item.slopeReversed ?? item.slopeRev);

        if (item.type.startsWith('point_switch')) {
          const branchSide = item.switchBranchSide ?? item.branchSide ?? 'right';
          const swState = item.switchState ?? item.sw ?? 'straight';
          this.placeSwitch(item.x, item.z, rot, isElevated, branchSide, lyr);
          if (swState === 'diverge') {
            this.togglePointSwitch(item.x, item.z, lyr);
          }
          const schedule = item.switchSchedule;
          if (schedule) {
            const swTile = this.getTile(item.x, item.z, lyr);
            if (swTile) swTile.switchSchedule = schedule;
          }
        } else if (item.type.startsWith('scissors_crossing')) {
          this.placeScissorsCrossing(item.x, item.z, rot, isElevated, lyr);
          const schedule = item.switchSchedule;
          if (schedule) {
            const crTile = this.getTile(item.x, item.z, lyr);
            if (crTile) crTile.switchSchedule = schedule;
          }
          const target: CrossingState = item.crossingState ?? item.crossState ?? 'straight';
          this.setCrossingState(item.x, item.z, target, lyr, true); // ★第5引数 true
        } else if (item.type.startsWith('rail_curve')) {
          const curveDir = item.curveDir ?? 'N_E';
          this.placeCurve(item.x, item.z, curveDir, isElevated, lyr);
        } else if (item.type === 'rail_slope') {
          const tile = this.getOrCreateTile(item.x, item.z, lyr);
          if (tile) {
            this.applySlopeTile(tile, rot, slopeRev, item.slopePart || 0, lyr, item.elevationOffset);
            // 【バグ修正】スロープ最上段(part 3)の場合、接続先の上の階層にもタイルを登録して断線を防ぐ
            if ((item.slopePart || 0) === 3) {
              const upperLayer: GridLayer = lyr === 1 ? 2 : ((lyr + 1) as GridLayer);
              this.grid3D.set(item.x, upperLayer, item.z, tile);
            }
          }
        } else if (item.type === 'rail_slope_underground') {
          const tile = this.getOrCreateTile(item.x, item.z, lyr);
          if (tile) {
            this.applyUndergroundSlopeTile(tile, rot, slopeRev, item.slopePart || 0, lyr);
            // 【バグ修正】地下スロープ最下段(part 3)の場合、地下1F(layer -1)にもタイルを登録
            if ((item.slopePart || 0) === 3) {
              this.grid3D.set(item.x, -1, item.z, tile);
            }
            if ((item.slopePart || 0) === 0 || (item.slopePart || 0) === 1) {
              this.groundHoleHandler?.add(item.x, item.z, rot);
            }
          }
        } else if (item.type === 'level_crossing') {
          this.applyLevelCrossing(item.x, item.z, rot, item.crossingRoadAxis ?? item.roadAxis ?? (1 - rot), lvl, lyr);
        } else if (item.type.includes('station') || item.type === 'signal_yard') {
          this.setTile(item.x, item.z, item.type, rot, lvl, item.stationPlatformSide || 'right', lyr);
          const restored = this.getTile(item.x, item.z, lyr);
          if (restored) {
            if (item.stationName) restored.stationName = item.stationName;
            if (item.stationGroupId) restored.stationGroupId = item.stationGroupId;
            if (item.stationPlatformId) restored.stationPlatformId = item.stationPlatformId;
            if (item.stationPart) restored.stationPart = item.stationPart;
            if (item.stationPlatformSide) restored.stationPlatformSide = item.stationPlatformSide;
            if (item.stationSchedule) restored.stationSchedule = item.stationSchedule;
            if (item.stationPassengers !== undefined) restored.stationPassengers = item.stationPassengers;
            if (restored.mesh && item.stationName) {
              ModelFactory.updateStationSign(restored.mesh, item.stationName);
            }
          }
        } else {
          this.setTile(item.x, item.z, item.type, rot, lvl, 'right', lyr);
        }

        if (item.isCargoYard || item.cargoYard) {
          const restored = this.getTile(item.x, item.z, lyr);
          if (restored) restored.isCargoYard = true;
        }
        if (item.cargoContainers !== undefined) {
          const restored = this.getTile(item.x, item.z, lyr);
          if (restored) restored.cargoContainers = item.cargoContainers;
        }
        if (item.externalCityId || item.isExternalConnection || item.type === 'external_connection') {
          const restored = this.getTile(item.x, item.z, lyr);
          if (restored) {
            restored.externalCityId = item.externalCityId;
            restored.isExternalConnection = true;
            if (item.stationPassengers !== undefined) restored.stationPassengers = item.stationPassengers;
            if (restored.mesh && item.stationName) {
              ModelFactory.updateGatewaySign(restored.mesh, item.stationName, false);
            }
          }
        }
      }

      // 【駅の記憶喪失解消】駅マネージャーの復元
      if (stationData) {
        // v2 保存データから駅・番線構成・財務・乗降客数・固有ID・タイルマッピングを完全復元
        this.stationManager.deserialize(stationData);

        // 各タイルの stationName, stationGroupId, stationPlatformId および看板メッシュを正本から同期
        for (const st of this.stationManager.getStations()) {
          for (const plat of st.platforms) {
            for (const pt of plat.tiles) {
              const t = this.getTile(pt.x, pt.z, pt.layer);
              if (t) {
                t.stationName = st.name;
                t.stationGroupId = st.id;
                t.stationPlatformId = plat.id;
                if (t.mesh && !plat.isSignalYard) {
                  ModelFactory.updateStationSign(t.mesh, st.name);
                }
              }
            }
          }
        }
      } else {
        // 旧フォーマット保存データ用のフォールバック再構築処理
        const processedGroups = new Set<string>();
        for (const item of data) {
          const lyr = (item.layer ?? 1) as GridLayer;
          const t = this.getTile(item.x, item.z, lyr);
          if (!t || (!t.type.includes('station') && t.type !== 'signal_yard')) continue;
          const groupId = t.stationGroupId || `${t.x},${lyr},${t.z}`;
          if (processedGroups.has(groupId)) continue;
          processedGroups.add(groupId);

          // 同一グループの全タイルを収集
          const groupTiles = this.getAllTiles().filter(tile => {
            if (t.stationGroupId) {
              return tile.stationGroupId === groupId &&
                (tile.type.includes('station') || tile.type === 'signal_yard');
            } else {
              return tile.x === t.x && tile.z === t.z && (tile.layer ?? 1) === lyr &&
                (tile.type.includes('station') || tile.type === 'signal_yard');
            }
          });
          if (groupTiles.length === 0) continue;

          const first = groupTiles[0];
          const isSignalYard = first.type === 'signal_yard';
          const isCargo = first.type.startsWith('cargo_station') || !!first.isCargoYard;
          const trackAxis = first.rotation === 1 ? 1 : 0;
          const reg = this.stationManager.registerPlatform({
            tiles: groupTiles.map(gt => ({ x: gt.x, z: gt.z, layer: (gt.layer ?? 1) as GridLayer })),
            length: groupTiles.length,
            trackAxis,
            isSignalYard,
            isCargoStation: isCargo,
            customName: first.stationName
          });
          for (const gt of groupTiles) {
            gt.stationGroupId = reg.station.id;
            gt.stationPlatformId = reg.platform.id;
          }
        }
      }
      this.markDirty();
    } catch (e) {
      console.error('Failed to load save data', e);
    }
  }
}
