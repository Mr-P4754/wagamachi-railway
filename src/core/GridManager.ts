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
 * 山脈の尾根を構成する線分セグメント
 */
export interface RidgeSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  radius: number; // 裾野の広がり半径
  height: number; // 尾根の基準隆起量 (0.5 〜 1.6)
}

/**
 * 河川を構成する線分セグメント
 */
export interface RiverSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  width: number; // 基本川幅
}

/**
 * 地形生成パラメータ・骨格データの完全スナップショット定義
 */
export interface TerrainSnapshot {
  mapSize: MapSize;
  terrainType: TerrainType;
  effectiveTerrain: 'flat' | 'balanced' | 'mountain' | 'coastal';
  seed: number;
  ridgeSegments: RidgeSegment[];
  riverSegments: RiverSegment[];
  coastCos: number;
  coastSin: number;
  coastOffset: number;
  islandCenters: Array<{ x: number; z: number; radius: number; height: number }>;
  noiseOffsetsX: number[];
  noiseOffsetsZ: number[];
}

/**
 * 3次元全7階層グリッド＆チャンク管理マネージャー
 */
export class GridManager {
  public mapSize: MapSize;
  public terrainType: TerrainType;
  public effectiveTerrain: 'flat' | 'balanced' | 'mountain' | 'coastal';
  public seed: number;
  public chunks: Map<string, MapChunk> = new Map();

  // シードから生成される非周期の地形骨格データ
  private ridgeSegments: RidgeSegment[] = [];
  private riverSegments: RiverSegment[] = [];
  private coastCos: number = 1;
  private coastSin: number = 0;
  private coastOffset: number = 16;
  private islandCenters: Array<{ x: number; z: number; radius: number; height: number }> = [];
  private noiseOffsetsX: number[] = [];
  private noiseOffsetsZ: number[] = [];

  // 2Dグラディエントベクトル（12方向）
  private static readonly GRADS_2D: ReadonlyArray<readonly [number, number]> = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [0.70710678, 0.70710678], [-0.70710678, 0.70710678],
    [0.70710678, -0.70710678], [-0.70710678, -0.70710678],
    [0.8660254, 0.5], [-0.8660254, 0.5],
    [0.5, 0.8660254], [-0.5, -0.8660254]
  ];

  constructor(mapSize: MapSize = 256, terrainType: TerrainType = 'balanced', seed?: number) {
    this.mapSize = mapSize;
    this.terrainType = terrainType;
    this.seed = (seed !== undefined && Number.isFinite(seed))
      ? (Math.floor(seed) >>> 0)
      : Math.floor(Math.random() * 0x7fffffff);

    // 'random' テンプレート時はシード値から決定論的に実効テンプレートを選定
    if (terrainType === 'random') {
      const types: Array<'balanced' | 'mountain' | 'coastal'> = ['balanced', 'mountain', 'coastal'];
      this.effectiveTerrain = types[this.seed % types.length];
    } else {
      this.effectiveTerrain = terrainType;
    }

    this.buildRandomFeatures();
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
   * シード値に基づき、ランダムな山脈の尾根群・河川経路・海岸線・島々を構築
   */
  private buildRandomFeatures(): void {
    let s = (this.seed ^ 0x9e3779b9) >>> 0;
    const rand = (): number => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const randRange = (min: number, max: number): number => min + rand() * (max - min);

    this.noiseOffsetsX = [];
    this.noiseOffsetsZ = [];
    for (let i = 0; i < 16; i++) {
      this.noiseOffsetsX.push(randRange(-5000, 5000));
      this.noiseOffsetsZ.push(randRange(-5000, 5000));
    }

    this.ridgeSegments = [];
    this.riverSegments = [];
    this.islandCenters = [];

    const half = this.mapSize / 2;

    // 1. ランダムな河川ポリライン（本流＋支流）の生成
    const buildRiverChain = (
      startAngle: number,
      passOffset: number,
      baseWidth: number,
      steps: number,
      span: number
    ): Array<{ x: number; z: number }> => {
      const dirX = Math.cos(startAngle);
      const dirZ = Math.sin(startAngle);
      const perpX = -dirZ;
      const perpZ = dirX;

      const pts: Array<{ x: number; z: number }> = [];
      let lateral = passOffset;
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps - 0.5) * 2.0; // -1.0 〜 +1.0
        const along = t * span;
        lateral += randRange(-span * 0.14, span * 0.14);

        let px = dirX * along + perpX * lateral;
        let pz = dirZ * along + perpZ * lateral;

        // 初期都市エリア（原点付近施設）に重なりそうな頂点はマージン外側へ逃がす
        if (Math.abs(px) < 10 && pz > -8 && pz < 5) {
          px = Math.sign(px || 1) * Math.max(12, Math.abs(px));
          pz = Math.sign(pz || 1) * Math.max(7, Math.abs(pz));
        }
        pts.push({ x: px, z: pz });
      }

      for (let i = 0; i < pts.length - 1; i++) {
        this.riverSegments.push({
          ax: pts[i].x,
          az: pts[i].z,
          bx: pts[i + 1].x,
          bz: pts[i + 1].z,
          width: baseWidth * randRange(0.85, 1.2)
        });
      }
      return pts;
    };

    const mainRiverAngle = rand() * Math.PI * 2;
    const mainRiverSign = rand() < 0.5 ? 1 : -1;
    const minOffset = Math.min(10, Math.max(6, half * 0.18));
    const maxOffset = Math.max(minOffset + 3, Math.min(30, half * 0.45));
    const mainRiverOffset = mainRiverSign * randRange(minOffset, maxOffset);
    const mainPts = buildRiverChain(mainRiverAngle, mainRiverOffset, 1.5, 8, half * 1.35);

    // 75%の確率で本流の途中から分岐する支流を生成
    if (rand() < 0.75 && mainPts.length >= 4) {
      const joinIdx = 2 + Math.floor(rand() * (mainPts.length - 4));
      const joinPt = mainPts[joinIdx];
      const branchAngle = mainRiverAngle + (rand() < 0.5 ? 1 : -1) * randRange(0.6, 1.4);
      let curX = joinPt.x;
      let curZ = joinPt.z;
      let curAngle = branchAngle;
      const segLen = Math.max(12, half * 0.22);

      for (let i = 0; i < 4; i++) {
        curAngle += randRange(-0.45, 0.45);
        const nx = curX + Math.cos(curAngle) * segLen;
        const nz = curZ + Math.sin(curAngle) * segLen;
        if (!(Math.abs(nx) < 10 && nz > -8 && nz < 5)) {
          this.riverSegments.push({
            ax: curX,
            az: curZ,
            bx: nx,
            bz: nz,
            width: 1.15
          });
          curX = nx;
          curZ = nz;
        }
      }
    }

    // 2. ランダムな山脈スパイン（尾根の骨格）の生成
    const areaFactor = Math.max(1, this.mapSize / 128);
    const numMountainChains = this.effectiveTerrain === 'mountain'
      ? Math.round(7 * areaFactor)
      : this.effectiveTerrain === 'balanced'
      ? Math.round(4 * areaFactor)
      : Math.round(3 * areaFactor);

    for (let c = 0; c < numMountainChains; c++) {
      // 初期都市を避けた位置に山脈の起点を決定（中心から14マス先から生成可能にして近景にも山並みを配置）
      let cx = randRange(-half * 0.82, half * 0.82);
      let cz = randRange(-half * 0.82, half * 0.82);
      if (Math.hypot(cx, cz) < 14) {
        const a = rand() * Math.PI * 2;
        const r = randRange(15, Math.min(half * 0.8, Math.max(20, half * 0.6)));
        cx = Math.cos(a) * r;
        cz = Math.sin(a) * r;
      }

      let angle = rand() * Math.PI * 2;
      const segCount = this.effectiveTerrain === 'mountain'
        ? Math.floor(randRange(3, 6))
        : Math.floor(randRange(2, 5));

      for (let sIdx = 0; sIdx < segCount; sIdx++) {
        angle += randRange(-0.7, 0.7);
        const len = randRange(16, Math.min(40, half * 0.4));
        const nx = cx + Math.cos(angle) * len;
        const nz = cz + Math.sin(angle) * len;

        const baseRadius = this.effectiveTerrain === 'mountain'
          ? randRange(16, 36)
          : randRange(12, 28);
        const baseHeight = this.effectiveTerrain === 'mountain'
          ? randRange(0.85, 1.55)
          : randRange(0.55, 1.15);

        this.ridgeSegments.push({
          ax: cx,
          az: cz,
          bx: nx,
          bz: nz,
          radius: baseRadius,
          height: baseHeight
        });

        // 40%の確率で尾根から支脈（フォーク）を派生させる
        if (rand() < 0.4) {
          const branchAngle = angle + (rand() < 0.5 ? 1 : -1) * randRange(0.7, 1.3);
          const branchLen = len * randRange(0.5, 0.85);
          this.ridgeSegments.push({
            ax: cx,
            az: cz,
            bx: cx + Math.cos(branchAngle) * branchLen,
            bz: cz + Math.sin(branchAngle) * branchLen,
            radius: baseRadius * 0.75,
            height: baseHeight * 0.8
          });
        }

        cx = nx;
        cz = nz;
      }
    }

    // 3. 海・臨海テンプレート（coastal）用のランダム方向・沖合の島々
    const coastAngle = rand() * Math.PI * 2;
    this.coastCos = Math.cos(coastAngle);
    this.coastSin = Math.sin(coastAngle);
    this.coastOffset = randRange(14, Math.min(24, half * 0.4));

    const numIslands = Math.max(3, Math.round(4 * areaFactor));
    for (let i = 0; i < numIslands; i++) {
      // 海側（cx < -coastOffset）のランダムな沖合座標に島を配置
      const seaDepth = -this.coastOffset - randRange(16, Math.max(28, half * 0.7));
      const seaLateral = randRange(-half * 0.8, half * 0.8);
      const ix = seaDepth * this.coastCos + seaLateral * this.coastSin;
      const iz = -seaDepth * this.coastSin + seaLateral * this.coastCos;
      this.islandCenters.push({
        x: ix,
        z: iz,
        radius: randRange(10, 26),
        height: randRange(0.45, 1.1)
      });
    }
  }


  /**
   * 格子座標 (ix, iz) とチャンネルから決定論的ハッシュ値を算出
   */
  private hash2D(ix: number, iz: number, channel: number): number {
    let h = (this.seed + Math.imul(channel, 374761393)) | 0;
    h = (h + Math.imul(ix, 3266489917)) | 0;
    h = (h + Math.imul(iz, 668265263)) | 0;
    h ^= h >>> 15;
    h = Math.imul(h, 2246822519);
    h ^= h >>> 13;
    h = Math.imul(h, 3266489917);
    h ^= h >>> 16;
    return h >>> 0;
  }

  /**
   * 2D グラディエントノイズ（値域はおおよそ [-1, 1]）
   */
  private noise2D(x: number, z: number, channel: number = 0): number {
    const ox = x + (this.noiseOffsetsX[channel & 15] || 0);
    const oz = z + (this.noiseOffsetsZ[channel & 15] || 0);

    const x0 = Math.floor(ox);
    const z0 = Math.floor(oz);
    const x1 = x0 + 1;
    const z1 = z0 + 1;

    const fx = ox - x0;
    const fz = oz - z0;

    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);

    const g00 = GridManager.GRADS_2D[this.hash2D(x0, z0, channel) % 12];
    const g10 = GridManager.GRADS_2D[this.hash2D(x1, z0, channel) % 12];
    const g01 = GridManager.GRADS_2D[this.hash2D(x0, z1, channel) % 12];
    const g11 = GridManager.GRADS_2D[this.hash2D(x1, z1, channel) % 12];

    const n00 = g00[0] * fx + g00[1] * fz;
    const n10 = g10[0] * (fx - 1) + g10[1] * fz;
    const n01 = g01[0] * fx + g01[1] * (fz - 1);
    const n11 = g11[0] * (fx - 1) + g11[1] * (fz - 1);

    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);

    return (nx0 + v * (nx1 - nx0)) * 1.4142;
  }

  /**
   * 軸回転付きマルチオクターブ fBm（オクターブごとに約37度回転して縦横の格子感を完全に消去）
   */
  private rotatedFbm(
    x: number,
    z: number,
    octaves: number = 4,
    lacunarity: number = 2.03,
    gain: number = 0.5,
    baseChannel: number = 0
  ): number {
    let sum = 0;
    let amp = 1.0;
    let norm = 0;
    let rx = x;
    let rz = z;

    for (let i = 0; i < octaves; i++) {
      sum += this.noise2D(rx, rz, baseChannel + i) * amp;
      norm += amp;
      amp *= gain;
      // 3-4-5 直角三角形の回転行列 (cos=0.8, sin=0.6) × lacunarity
      const nx = (0.8 * rx - 0.6 * rz) * lacunarity;
      const nz = (0.6 * rx + 0.8 * rz) * lacunarity;
      rx = nx;
      rz = nz;
    }
    return sum / norm;
  }

  /**
   * 点 (px, pz) から線分 (ax, az)-(bx, bz) への最短距離
   */
  private distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
    const dx = bx - ax;
    const dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    if (lenSq < 1e-6) return Math.hypot(px - ax, pz - az);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
    return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
  }

  /**
   * エルミート補間 (Smoothstep)
   */
  private smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  /**
   * マップサイズとテンプレートに応じた3次元地形の初期化
   */
  public initializeTerrain(): void {
    this.chunks.clear();
  }

  /**
   * 現在の地形骨格データとシード値をスナップショットとして出力（セーブ用）
   */
  public toSnapshot(): TerrainSnapshot {
    return {
      mapSize: this.mapSize,
      terrainType: this.terrainType,
      effectiveTerrain: this.effectiveTerrain,
      seed: this.seed,
      ridgeSegments: this.ridgeSegments.map(r => ({ ...r })),
      riverSegments: this.riverSegments.map(r => ({ ...r })),
      coastCos: this.coastCos,
      coastSin: this.coastSin,
      coastOffset: this.coastOffset,
      islandCenters: this.islandCenters.map(i => ({ ...i })),
      noiseOffsetsX: [...this.noiseOffsetsX],
      noiseOffsetsZ: [...this.noiseOffsetsZ]
    };
  }

  /**
   * 保存されたスナップショットから地形骨格データを完全復元（ロード用）
   */
  public loadFromSnapshot(snap: Partial<TerrainSnapshot>): void {
    if (snap.mapSize) this.mapSize = snap.mapSize;
    if (snap.terrainType) this.terrainType = snap.terrainType;
    if (snap.effectiveTerrain) this.effectiveTerrain = snap.effectiveTerrain;
    if (typeof snap.seed === 'number' && Number.isFinite(snap.seed)) {
      this.seed = snap.seed >>> 0;
    }

    if (
      Array.isArray(snap.ridgeSegments) &&
      Array.isArray(snap.riverSegments) &&
      Array.isArray(snap.noiseOffsetsX) &&
      Array.isArray(snap.noiseOffsetsZ) &&
      snap.noiseOffsetsX.length === 16
    ) {
      this.ridgeSegments = snap.ridgeSegments.map(r => ({ ...r }));
      this.riverSegments = snap.riverSegments.map(r => ({ ...r }));
      this.coastCos = typeof snap.coastCos === 'number' ? snap.coastCos : 1;
      this.coastSin = typeof snap.coastSin === 'number' ? snap.coastSin : 0;
      this.coastOffset = typeof snap.coastOffset === 'number' ? snap.coastOffset : 16;
      this.islandCenters = Array.isArray(snap.islandCenters) ? snap.islandCenters.map(i => ({ ...i })) : [];
      this.noiseOffsetsX = [...snap.noiseOffsetsX];
      this.noiseOffsetsZ = [...snap.noiseOffsetsZ];
    } else {
      // 旧セーブデータ等で骨格配列がない場合はシード値から再構築
      this.buildRandomFeatures();
    }

    this.initializeTerrain();
  }

  /**
   * 指定チャンクが未生成なら生成する（遅延生成・オンデマンド方式）。
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

        const { elevation, isWater } = this.calculateTerrainPoint(worldX, worldZ);

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
   */
  public sampleTerrain(x: number, z: number): { elevation: number; isWater: boolean } {
    return this.calculateTerrainPoint(x, z);
  }

  /**
   * ランダム山脈スパイン群からの隆起度と、河川ポリラインからの距離を計算
   */
  private evaluateSkeleton(x: number, z: number): {
    ridgeHeight: number;
    minRiverNormalizedDist: number;
    rawRiverDist: number;
  } {
    // 1. 座標を非周期ノイズで大きく歪ませる（ドメインワーピング）
    const warpX = this.rotatedFbm(x * 0.022, z * 0.022, 3, 2.0, 0.5, 0) * 14.0;
    const warpZ = this.rotatedFbm(x * 0.022 + 37.1, z * 0.022 + 91.7, 3, 2.0, 0.5, 4) * 14.0;
    const wx = x + warpX;
    const wz = z + warpZ;

    // 2. 山脈スパインからの隆起量を合算（滑らかな減衰カーブ＋尾根の凹凸）
    let ridgeHeight = 0;
    const ridgeDetail = this.rotatedFbm(x * 0.045, z * 0.045, 3, 2.05, 0.5, 8);

    for (let i = 0; i < this.ridgeSegments.length; i++) {
      const seg = this.ridgeSegments[i];
      const d = this.distToSegment(wx, wz, seg.ax, seg.az, seg.bx, seg.bz);
      // 裾野の半径にノイズで不規則な出入りをつける
      const effectiveRadius = seg.radius * (1.0 + ridgeDetail * 0.35);
      if (d < effectiveRadius) {
        const t = 1.0 - d / effectiveRadius;
        const contrib = t * t * (3 - 2 * t) * seg.height;
        // 複数の尾根が交差する場所は滑らかに最大値＋少しの重なりを持たせる
        ridgeHeight = Math.max(ridgeHeight, contrib) + Math.min(ridgeHeight, contrib) * 0.25;
      }
    }

    // 3. 河川ポリラインからの距離計算（川用の細かい蛇行ワープを加える）
    const rWarpX = warpX * 0.65 + this.noise2D(x * 0.06, z * 0.06, 11) * 4.5;
    const rWarpZ = warpZ * 0.65 + this.noise2D(x * 0.06 + 19.3, z * 0.06 + 41.2, 12) * 4.5;
    const rwx = x + rWarpX;
    const rwz = z + rWarpZ;

    let minRiverNormalizedDist = Infinity;
    let rawRiverDist = Infinity;
    const widthMod = 1.0 + this.noise2D(x * 0.04, z * 0.04, 13) * 0.35;

    for (let i = 0; i < this.riverSegments.length; i++) {
      const rSeg = this.riverSegments[i];
      const d = this.distToSegment(rwx, rwz, rSeg.ax, rSeg.az, rSeg.bx, rSeg.bz);
      const effectiveWidth = Math.max(0.9, rSeg.width * widthMod);
      const normDist = d / effectiveWidth;
      if (normDist < minRiverNormalizedDist) {
        minRiverNormalizedDist = normDist;
        rawRiverDist = d - effectiveWidth;
      }
    }

    return { ridgeHeight, minRiverNormalizedDist, rawRiverDist };
  }

  /**
   * 地形テンプレートに応じた標高および水域判定
   */
  private calculateTerrainPoint(x: number, z: number): { elevation: number; isWater: boolean } {
    if (this.effectiveTerrain === 'flat') {
      return { elevation: 1, isWater: false };
    }

    // 初期都市施設エリア（駅・線路・道路・初期施設群）を確実に平地（標高1・陸地）として保護
    // 西駅: x=-6..-5, 東駅: x=5..6, 道路: x=-7..7, z=2, 施設: z=3, 工業: x=-6, z=-6
    if (x >= -8 && x <= 8 && z >= -7 && z <= 4) {
      return { elevation: 1, isWater: false };
    }

    // 初期都市周辺の平野遷移マスク（都市周辺は平坦にしつつ、10〜15マス先から自然に山や川が現れるように調整）
    const borderNoise = this.noise2D(x * 0.08, z * 0.08, 15) * 2.5;
    const cityDist = Math.hypot(Math.max(0, Math.abs(x) - 7), Math.max(0, Math.abs(z) - 3)) + borderNoise;
    const cityMask = this.smoothstep(2.0, 10.0, cityDist);

    const { ridgeHeight, minRiverNormalizedDist, rawRiverDist } = this.evaluateSkeleton(x, z);

    // 大域的なうねり（平野と丘陵の非周期バリエーション）
    const macroContinent = this.rotatedFbm(x * 0.012, z * 0.012, 4, 2.07, 0.5, 2);
    const localHill = this.rotatedFbm(x * 0.035, z * 0.035, 3, 2.03, 0.5, 6);

    switch (this.effectiveTerrain) {
      case 'balanced': {
        // 河川または低地の自然湖沼の判定
        const isRiver = cityMask > 0.2 && minRiverNormalizedDist < 1.0;
        const isLake = cityMask > 0.55 && ridgeHeight < 0.05 && macroContinent < -0.52;
        if (isRiver || isLake) {
          return { elevation: 0, isWater: true };
        }

        // 川岸から5マスはなだらかな平地（氾濫原）にする
        const bankMask = this.smoothstep(0.0, 5.5, rawRiverDist);

        // 山脈スパインの隆起 ＋ 大域の丘陵ノイズを合成
        const ambientHill = Math.max(0, macroContinent + localHill * 0.4 - 0.15) * 0.55;
        const h = (ridgeHeight + ambientHill) * cityMask * bankMask;

        let elev = 1;
        if (h > 0.95) elev = 4;
        else if (h > 0.60) elev = 3;
        else if (h > 0.28) elev = 2;

        return { elevation: elev, isWater: false };
      }

      case 'mountain': {
        // 山間を縫う渓流の判定
        if (cityMask > 0.3 && minRiverNormalizedDist < 0.85) {
          return { elevation: 0, isWater: true };
        }

        // 渓流沿いは深い谷（渓谷）として標高を下げる
        const gorgeMask = this.smoothstep(0.0, 7.5, rawRiverDist);

        // ランダム山脈スパイン ＋ 急峻な尾根ノイズ
        const ambientMountain = Math.max(0, (macroContinent + 0.25) * 0.7 + localHill * 0.45);
        const h = (ridgeHeight * 1.15 + ambientMountain) * cityMask * gorgeMask;

        let elev = 1;
        if (h > 1.25) elev = 5;
        else if (h > 0.90) elev = 4;
        else if (h > 0.55) elev = 3;
        else if (h > 0.24) elev = 2;

        return { elevation: elev, isWater: false };
      }

      case 'coastal': {
        // ランダムな海方向への回転座標
        const cx = x * this.coastCos - z * this.coastSin;
        const cz = x * this.coastSin + z * this.coastCos;

        // 大きく入り組んだ湾・半島を作る非周期ワープ
        const coastWarp =
          this.rotatedFbm(cz * 0.011, cx * 0.011, 4, 2.05, 0.55, 1) * 32.0 +
          this.rotatedFbm(cz * 0.038, cx * 0.038, 3, 2.0, 0.5, 5) * 9.0;

        let signedLandDist = (cx + this.coastOffset) + coastWarp;

        // 沖合に配置されたランダムな島々の隆起
        let islandElevBoost = 0;
        if (signedLandDist < 4.0) {
          const iWarpX = x + this.rotatedFbm(x * 0.04, z * 0.04, 2, 2.0, 0.5, 9) * 7.0;
          const iWarpZ = z + this.rotatedFbm(x * 0.04 + 23, z * 0.04 + 51, 2, 2.0, 0.5, 11) * 7.0;
          for (let i = 0; i < this.islandCenters.length; i++) {
            const isl = this.islandCenters[i];
            const d = Math.hypot(iWarpX - isl.x, iWarpZ - isl.z);
            if (d < isl.radius) {
              const t = 1.0 - d / isl.radius;
              signedLandDist = Math.max(signedLandDist, t * 14.0);
              islandElevBoost = Math.max(islandElevBoost, this.smoothstep(0.25, 0.85, t) * isl.height);
            }
          }
        }

        // 初期都市周辺の陸地保護
        const finalLandDist = signedLandDist + (1.0 - cityMask) * 35.0;
        if (finalLandDist < 0) {
          return { elevation: 0, isWater: true };
        }

        // 海へ注ぐ河口（海に近いほど川幅が広がる）
        const estuaryFactor = 1.0 + Math.max(0, (16.0 - finalLandDist) * 0.08);
        if (cityMask > 0.25 && minRiverNormalizedDist < estuaryFactor) {
          return { elevation: 0, isWater: true };
        }

        const shoreMask = this.smoothstep(0.0, 8.0, finalLandDist);
        const bankMask = this.smoothstep(0.0, 5.0, rawRiverDist);
        const ambientHill = Math.max(0, macroContinent + localHill * 0.35 - 0.1) * 0.5;
        const h = (ridgeHeight * 0.85 + ambientHill + islandElevBoost) * cityMask * shoreMask * bankMask;

        let elev = 1;
        if (h > 0.70) elev = 3;
        else if (h > 0.30) elev = 2;

        return { elevation: elev, isWater: false };
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
