// RCI（住宅・商業・工業）ゾーニング管理
// プレイヤーがブラシで指定した区画を保持し、都市発展(CityGrowth)・貨物システム(CargoSystem)・
// 需要エンジン(DemandEngine)がこのデータを参照して有機的な経済循環を成立させる。

import { GridLayer } from './types';

export type ZoneType = 'residential' | 'commercial' | 'industrial';

export interface ZoneCell {
  x: number;
  z: number;
  type: ZoneType;
  developmentLevel: number; // 0-3 (住宅密度 / 商業ビル階数 / 工場規模)
  // 工業ゾーン: 蓄積されたコンテナ在庫数（貨物駅から積み出し可能）
  industrialStock: number;
  // 商業ゾーン: 商品搬入による魅力度 0-100（旅客需要・ビル発展に影響）
  commercialAttractiveness: number;
}

const INDUSTRIAL_STOCK_CAP = 60;

export class ZoneManager {
  private zones = new Map<string, ZoneCell>();

  // 【需要計算の重圧解消】空間インデックス（グリッドバケット）
  // 巨大都市（数万セル）でも全走査O(N)を回避し、近隣バケットのみを高速にO(R^2)で走査する
  private static readonly BUCKET_SIZE = 8;
  private buckets = new Map<string, ZoneCell[]>();

  /** 変更検知ダーティフラグとシリアライズキャッシュ */
  public isDirty: boolean = true;
  private cachedSerialized: string | null = null;

  public markDirty(): void {
    this.isDirty = true;
    this.cachedSerialized = null;
  }

  private key(x: number, z: number): string {
    return `${x},${z}`;
  }

  private bucketKey(bx: number, bz: number): string {
    return `${bx},${bz}`;
  }

  private getBucketCoord(val: number): number {
    return Math.floor(val / ZoneManager.BUCKET_SIZE);
  }

  private addToBucket(cell: ZoneCell): void {
    const bk = this.bucketKey(this.getBucketCoord(cell.x), this.getBucketCoord(cell.z));
    let list = this.buckets.get(bk);
    if (!list) {
      list = [];
      this.buckets.set(bk, list);
    }
    list.push(cell);
  }

  private removeFromBucket(cell: ZoneCell): void {
    const bk = this.bucketKey(this.getBucketCoord(cell.x), this.getBucketCoord(cell.z));
    const list = this.buckets.get(bk);
    if (list) {
      const idx = list.indexOf(cell);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
      if (list.length === 0) {
        this.buckets.delete(bk);
      }
    }
  }

  /**
   * 指定座標の半径 radius 内に含まれるセルのみを走査する
   */
  public forEachCellInRadius(cx: number, cz: number, radius: number, callback: (cell: ZoneCell, dist: number) => void): void {
    const minBx = this.getBucketCoord(cx - radius);
    const maxBx = this.getBucketCoord(cx + radius);
    const minBz = this.getBucketCoord(cz - radius);
    const maxBz = this.getBucketCoord(cz + radius);

    const radiusSq = radius * radius;

    for (let bx = minBx; bx <= maxBx; bx++) {
      for (let bz = minBz; bz <= maxBz; bz++) {
        const list = this.buckets.get(this.bucketKey(bx, bz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const cell = list[i];
          const dx = cell.x - cx;
          const dz = cell.z - cz;
          const distSq = dx * dx + dz * dz;
          if (distSq <= radiusSq) {
            callback(cell, Math.sqrt(distSq));
          }
        }
      }
    }
  }

  public paintZone(x: number, z: number, type: ZoneType, radius: number = 2): ZoneCell[] {
    const painted: ZoneCell[] = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.hypot(dx, dz) > radius + 0.4) continue;
        const tx = x + dx;
        const tz = z + dz;
        const k = this.key(tx, tz);
        let cell = this.zones.get(k);
        if (cell && cell.type === type) {
          // 既に同じタイプのゾーンが塗られているマスは、既存の発展レベルや魅力度を保護してスキップ
          painted.push(cell);
          continue;
        }
        if (cell) {
          this.removeFromBucket(cell);
        }
        cell = { x: tx, z: tz, type, developmentLevel: 0, industrialStock: 0, commercialAttractiveness: 0 };
        this.zones.set(k, cell);
        this.addToBucket(cell);
        painted.push(cell);
      }
    }
    if (painted.length > 0) {
      this.markDirty();
    }
    return painted;
  }

  public clearZone(x: number, z: number, radius: number = 2): void {
    let clearedCount = 0;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.hypot(dx, dz) > radius + 0.4) continue;
        const k = this.key(x + dx, z + dz);
        const cell = this.zones.get(k);
        if (cell) {
          this.removeFromBucket(cell);
          this.zones.delete(k);
          clearedCount++;
        }
      }
    }
    if (clearedCount > 0) {
      this.markDirty();
    }
  }

  public getZone(x: number, z: number): ZoneCell | undefined {
    return this.zones.get(this.key(x, z));
  }

  public getAllZones(): ZoneCell[] {
    return Array.from(this.zones.values());
  }

  public hasAnyZoneOfType(type: ZoneType): boolean {
    for (const z of this.zones.values()) {
      if (z.type === type) return true;
    }
    return false;
  }

  /** 指定座標を中心とした半径内で最も優勢なゾーン種別を判定（駅の役割判定などに使用） */
  public getDominantZoneType(x: number, z: number, radius: number = 10): ZoneType | null {
    const counts: Record<ZoneType, number> = { residential: 0, commercial: 0, industrial: 0 };
    let found = false;

    this.forEachCellInRadius(x, z, radius, (cell) => {
      counts[cell.type]++;
      found = true;
    });

    if (!found) return null;
    let best: ZoneType = 'residential';
    let bestCount = -1;
    (Object.keys(counts) as ZoneType[]).forEach(t => {
      if (counts[t] > bestCount) {
        bestCount = counts[t];
        best = t;
      }
    });
    return bestCount > 0 ? best : null;
  }

  /** 指定座標に最も近い、在庫のある工業ゾーンを探索（貨物積み込み用。高架・地下駅からもエレベーター等を通じてアクセス可能） */
  public findNearestIndustrialWithStock(x: number, z: number, maxRadius: number = 30, _layer: GridLayer = 1): ZoneCell | null {
    let best: ZoneCell | null = null;
    let bestDist = Infinity;

    this.forEachCellInRadius(x, z, maxRadius, (cell, dist) => {
      if (cell.type === 'industrial' && cell.industrialStock > 0 && dist < bestDist) {
        bestDist = dist;
        best = cell;
      }
    });

    return best;
  }

  /** 指定座標に最も近い商業ゾーンを探索（貨物荷降ろし用。高架・地下駅からもエレベーター等を通じてアクセス可能） */
  public findNearestCommercial(x: number, z: number, maxRadius: number = 30, _layer: GridLayer = 1): ZoneCell | null {
    let best: ZoneCell | null = null;
    let bestDist = Infinity;

    this.forEachCellInRadius(x, z, maxRadius, (cell, dist) => {
      if (cell.type === 'commercial' && dist < bestDist) {
        bestDist = dist;
        best = cell;
      }
    });

    return best;
  }

  /** 指定座標周辺で、魅力度上限（100）未満の需要がある商業ゾーンを優先探索（高架・地下駅からもエレベーター等を通じてアクセス可能） */
  public findNearestCommercialWithDemand(x: number, z: number, maxRadius: number = 30, _layer: GridLayer = 1): ZoneCell | null {
    let best: ZoneCell | null = null;
    let bestDist = Infinity;

    this.forEachCellInRadius(x, z, maxRadius, (cell, dist) => {
      if (cell.type === 'commercial' && cell.commercialAttractiveness < 100 && dist < bestDist) {
        bestDist = dist;
        best = cell;
      }
    });

    return best;
  }

  /** 全商業ゾーンの総魅力度 (単純合計値) */
  public getTotalCommercialAttractiveness(): number {
    let sum = 0;
    for (const cell of this.zones.values()) {
      if (cell.type === 'commercial') {
        sum += cell.commercialAttractiveness;
      }
    }
    return sum;
  }

  /** 全商業ゾーンの魅力度スコア (0-1) ※平均値の罠を防ぐため全体合計に基づく飽和スコア */
  public getAverageCommercialAttractiveness(): number {
    const total = this.getTotalCommercialAttractiveness();
    // 魅力度100のセルが複数発展するにつれて1.0へ近づく飽和関数（新規区画追加で下落しない）
    return 1 - Math.exp(-total / 400);
  }

  /** 指定座標周辺（半径 radius マス圏内）の商業ゾーン魅力度合計に基づくローカル発展度 (0-1) */
  public getCommercialAttractivenessAround(cx: number, cz: number, radius: number = 20): number {
    let sum = 0;

    this.forEachCellInRadius(cx, cz, radius, (cell) => {
      if (cell.type === 'commercial') {
        sum += cell.commercialAttractiveness;
      }
    });

    if (sum <= 0) return 0;
    // 平均値（sum / count）ではなく周辺の商業魅力度合計値に基づくローカル集積評価
    // 魅力度0の新規区画を追加しても既存の合計値は一切減少しないため、需要急落の罠を恒久的に防止
    return Math.min(1.0, sum / 200);
  }

  public consumeIndustrialStock(cell: ZoneCell, amount: number): number {
    const taken = Math.min(cell.industrialStock, amount);
    cell.industrialStock -= taken;
    return taken;
  }

  public addIndustrialStock(cell: ZoneCell, amount: number): void {
    cell.industrialStock = Math.min(INDUSTRIAL_STOCK_CAP, cell.industrialStock + amount);
  }

  /**
   * 商業ゾーンへコンテナを納品。
   * 魅力度の上限100までの受入余力に応じたコンテナ数のみを受け入れ、実際に納品されたコンテナ数を返す。
   */
  public deliverToCommercial(cell: ZoneCell, containers: number): number {
    const headroom = Math.max(0, 100 - cell.commercialAttractiveness);
    if (headroom <= 0 || containers <= 0) return 0;

    // 1コンテナあたり魅力度+6
    const maxAcceptable = Math.max(1, Math.ceil(headroom / 6));
    const accepted = Math.min(containers, maxAcceptable);

    cell.commercialAttractiveness = Math.min(100, cell.commercialAttractiveness + accepted * 6);
    const newLevel = cell.commercialAttractiveness >= 70 ? 3 : cell.commercialAttractiveness >= 35 ? 2 : cell.commercialAttractiveness >= 10 ? 1 : 0;
    cell.developmentLevel = Math.max(cell.developmentLevel, newLevel);
    return accepted;
  }

  public serialize(): string {
    if (!this.isDirty && this.cachedSerialized !== null) {
      return this.cachedSerialized;
    }
    this.cachedSerialized = JSON.stringify(Array.from(this.zones.values()));
    this.isDirty = false;
    return this.cachedSerialized;
  }

  public deserialize(json: string): void {
    this.clearAll();
    try {
      const arr: ZoneCell[] = JSON.parse(json);
      for (const cell of arr) {
        this.zones.set(this.key(cell.x, cell.z), cell);
        this.addToBucket(cell);
      }
    } catch {
      // ignore malformed save data
    }
    this.markDirty();
  }

  public clearAll(): void {
    this.zones.clear();
    this.buckets.clear();
    this.markDirty();
  }
}
