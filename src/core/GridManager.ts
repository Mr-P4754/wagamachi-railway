import { MapSize, TerrainType, GridLayer } from './types';
import { CHUNK_SIZE, GRID_LAYERS } from './constants';

/**
 * 3次元ボクセル／セルデータ
 */
export interface Cell3D {
  x: number;
  y: GridLayer; // -2, -1, 1, 2, 3, 4, 5
  z: number;
  isWater: boolean; // 水域かどうか（地上1Fの水域には地上線路敷設不可）
  isSolidGround: boolean; // 地形・地表本体が存在するか
  elevation: number; // 標高
}

/**
 * 32×32マス単位のチャンクデータ
 */
export interface MapChunk {
  chunkX: number;
  chunkZ: number;
  cells: Map<string, Cell3D>;
}

/**
 * 3次元全7階層グリッド＆チャンク管理マネージャー
 */
export class GridManager {
  public mapSize: MapSize;
  public terrainType: TerrainType;
  public chunks: Map<string, MapChunk> = new Map();

  constructor(mapSize: MapSize = 256, terrainType: TerrainType = 'balanced') {
    this.mapSize = mapSize;
    this.terrainType = terrainType;
    this.initializeTerrain();
  }

  /**
   * チャンクキーの生成
   */
  public static getChunkKey(chunkX: number, chunkZ: number): string {
    return `${chunkX},${chunkZ}`;
  }

  /**
   * セル座標キーの生成
   */
  public static getCellKey(x: number, y: GridLayer, z: number): string {
    return `${x},${y},${z}`;
  }

  /**
   * マップサイズとテンプレートに応じた3次元地形の初期化
   * ⚡超広大マップ対応: 全チャンクを即時生成せず、chunksを空にリセットするのみ。
   * 実際のセルデータは ensureChunk() により、カメラ可視範囲に入った時点で遅延生成される。
   */
  public initializeTerrain(): void {
    this.chunks.clear();
  }

  /**
   * 指定チャンクが未生成なら生成する（遅延生成・オンデマンド方式）。
   * 32×32マス×全7階層分のセルを1チャンク単位でのみ計算するため、
   * 512/1024といった超広大マップでも起動時に全域を計算するコストが発生しない。
   */
  public ensureChunk(cx: number, cz: number): MapChunk {
    const key = GridManager.getChunkKey(cx, cz);
    const existing = this.chunks.get(key);
    if (existing) return existing;

    const halfSize = this.mapSize / 2;
    const chunk: MapChunk = {
      chunkX: cx,
      chunkZ: cz,
      cells: new Map()
    };

    const startX = cx * CHUNK_SIZE - halfSize;
    const startZ = cz * CHUNK_SIZE - halfSize;

    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const worldX = startX + lx;
        const worldZ = startZ + lz;

        // 地形テンプレートに応じた標高・水域の計算
        const { elevation, isWater } = this.calculateTerrainPoint(worldX, worldZ);

        // 全7階層のセル初期化
        for (const layer of GRID_LAYERS) {
          const isSolid = layer > 0 && layer <= elevation;
          const cell: Cell3D = {
            x: worldX,
            y: layer,
            z: worldZ,
            isWater: layer === 1 && isWater,
            isSolidGround: isSolid,
            elevation
          };
          chunk.cells.set(GridManager.getCellKey(worldX, layer, worldZ), cell);
        }
      }
    }

    this.chunks.set(key, chunk);
    return chunk;
  }

  /** ワールド座標からチャンク座標を算出 */
  public worldToChunkCoords(x: number, z: number): { cx: number; cz: number } {
    const halfSize = this.mapSize / 2;
    return {
      cx: Math.floor((x + halfSize) / CHUNK_SIZE),
      cz: Math.floor((z + halfSize) / CHUNK_SIZE)
    };
  }

  /** マップ全域のチャンク数（1辺） */
  public get chunkCount(): number {
    return this.mapSize / CHUNK_SIZE;
  }

  /**
   * 地形テンプレートを軽量に直接サンプリング（チャンク生成不要）。
   * ミニマップの全域プレビュー描画など、粗い解像度で地形色だけ必要な場合に使用する。
   */
  public sampleTerrain(x: number, z: number): { elevation: number; isWater: boolean } {
    return this.calculateTerrainPoint(x, z);
  }

  /**
   * 地形テンプレートに応じた標高および水域判定
   */
  private calculateTerrainPoint(x: number, z: number): { elevation: number; isWater: boolean } {
    // 中央の初期都市エリア（|x| <= 9 かつ |z| <= 5）は平地（標高1・陸地）として保護
    const isCoreCityArea = Math.abs(x) <= 9 && Math.abs(z) <= 5;

    switch (this.terrainType) {
      case 'flat':
        // 完全平地（全域が標高1、水域なし）
        return { elevation: 1, isWater: false };

      case 'balanced': {
        if (isCoreCityArea) return { elevation: 1, isWater: false };
        // 山海平野バランス型: 北東・南西に丘陵（標高2〜3）、Z=8〜10付近に川
        const river = Math.abs(Math.sin(x * 0.1) * 4 + 9 - z) < 2;
        let elev = 1;
        const dist = Math.sqrt(x * x + z * z);
        if (dist > 18) {
          const noise = Math.sin(x * 0.12) + Math.cos(z * 0.12);
          if (noise > 0.4) elev = 2;
          if (noise > 1.2) elev = 3;
        }
        return { elevation: elev, isWater: river };
      }

      case 'mountain': {
        if (isCoreCityArea) return { elevation: 1, isWater: false };
        // 急峻な山岳地帯中心: 谷間の平野部を囲む雄大な山脈（標高2〜5）
        const noise = (Math.sin(x * 0.15) * 1.5 + Math.cos(z * 0.15) * 1.5 + 1.2);
        const distY = Math.abs(z);
        const distX = Math.abs(x);
        let elev = 1;

        if (distY > 5 || distX > 10) {
          const factor = Math.max(0, (Math.max(distY - 5, distX - 10)) * 0.15);
          elev = 1 + Math.floor(Math.min(4, Math.max(1, noise * 0.8 + factor)));
        }
        return { elevation: Math.min(5, Math.max(1, elev)), isWater: false };
      }

      case 'coastal': {
        // 大河川・海岸線: 西側（X < -10）が広大な海
        const coastLine = Math.sin(z * 0.08) * 4 - 10;
        const isWater = x < coastLine;
        let elev = isWater ? 0 : 1;
        if (!isWater && x > 20) {
          elev = 2;
        }
        return { elevation: elev, isWater };
      }
    }
  }

  /**
   * 指定座標のセルを取得
   */
  public getCell(x: number, y: GridLayer, z: number): Cell3D | null {
    const halfSize = this.mapSize / 2;
    if (x < -halfSize || x > halfSize || z < -halfSize || z > halfSize) return null;
    const clampedX = Math.min(x, halfSize - 1);
    const clampedZ = Math.min(z, halfSize - 1);
    const cx = Math.floor((clampedX + halfSize) / CHUNK_SIZE);
    const cz = Math.floor((clampedZ + halfSize) / CHUNK_SIZE);
    if (cx < 0 || cz < 0 || cx >= this.chunkCount || cz >= this.chunkCount) return null;

    const chunk = this.chunks.get(GridManager.getChunkKey(cx, cz)) || this.ensureChunk(cx, cz);
    return chunk.cells.get(GridManager.getCellKey(clampedX, y, clampedZ)) || null;
  }

  /**
   * 水辺制約判定: 地上1Fの水域マスかどうか
   */
  public isWaterAtGroundLevel(x: number, z: number): boolean {
    const cell = this.getCell(x, 1, z);
    return cell ? cell.isWater : false;
  }
}
