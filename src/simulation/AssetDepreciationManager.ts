/**
 * 固定資産および減価償却台帳マネージャー
 * 日本の鉄道会計基準に準拠した耐用年数ベースの定額法減価償却を管理する
 */

export type AssetCategory = 'vehicle' | 'infrastructure';

export interface AssetEntry {
  id: string;
  name: string;
  category: AssetCategory;
  acquisitionYear: number;
  initialCost: number;       // 取得原価
  bookValue: number;         // 現在の固定資産簿価
  usefulLifeYears: number;   // 耐用年数（車両: 5年, インフラ: 10年）
  annualDepreciation: number;// 年間減価償却額
  isFullyDepreciated: boolean;// 償却完了フラグ
}

export interface DepreciationLedgerSnapshot {
  assets: AssetEntry[];
  totalHistoricalCost: number;
  totalBookValue: number;
  accumulatedDepreciation: number;
}

export class AssetDepreciationManager {
  // 耐用年数設定（ゲーム内年数）
  public static readonly VEHICLE_USEFUL_LIFE = 5;       // 車両: 5年 (毎年20%償却)
  public static readonly INFRASTRUCTURE_USEFUL_LIFE = 10;// 線路・駅・橋梁: 10年 (毎年10%償却)

  private assets: AssetEntry[] = [];
  private nextAssetId: number = 1;

  constructor() {}

  /**
   * 新規資産（車両またはインフラ設備）を減価償却台帳に登録する
   */
  public registerAsset(
    category: AssetCategory,
    initialCost: number,
    name: string,
    acquisitionYear: number
  ): AssetEntry {
    const usefulLife = category === 'vehicle'
      ? AssetDepreciationManager.VEHICLE_USEFUL_LIFE
      : AssetDepreciationManager.INFRASTRUCTURE_USEFUL_LIFE;

    const annualDepreciation = Math.floor(initialCost / usefulLife);

    const asset: AssetEntry = {
      id: `asset_${this.nextAssetId++}`,
      name,
      category,
      acquisitionYear,
      initialCost,
      bookValue: initialCost,
      usefulLifeYears: usefulLife,
      annualDepreciation,
      isFullyDepreciated: false
    };

    this.assets.push(asset);
    return asset;
  }

  /**
   * 直近登録された資産から指定金額分を取り消し・減額する（Undoや返金、一部設置失敗時用）
   * @param amount 減額する金額
   * @param category 対象資産カテゴリ（省略時は指定なしで直近から減額）
   * @returns 実際に減額できた金額
   */
  public removeLatestAsset(amount: number, category?: AssetCategory): number {
    if (amount <= 0 || this.assets.length === 0) return 0;
    let remaining = amount;

    for (let i = this.assets.length - 1; i >= 0 && remaining > 0; i--) {
      const asset = this.assets[i];
      if (category && asset.category !== category) continue;

      if (asset.initialCost <= remaining) {
        remaining -= asset.initialCost;
        this.assets.splice(i, 1);
      } else {
        asset.initialCost -= remaining;
        asset.bookValue = Math.min(asset.bookValue, asset.initialCost);
        asset.annualDepreciation = Math.floor(asset.initialCost / asset.usefulLifeYears);
        remaining = 0;
      }
    }

    return amount - remaining;
  }

  /**
   * 毎年3月31日の年度末決算時に呼び出され、全資産の減価償却費を算定・計上する
   * @returns 当年度に計上された減価償却費の合計
   */
  public processAnnualDepreciation(): {
    totalDepreciation: number;
    vehicleDepreciation: number;
    infrastructureDepreciation: number;
    totalBookValue: number;
  } {
    let vehicleDepreciation = 0;
    let infrastructureDepreciation = 0;

    for (const asset of this.assets) {
      if (asset.isFullyDepreciated || asset.bookValue <= 0) {
        asset.isFullyDepreciated = true;
        asset.bookValue = 0;
        continue;
      }

      // 定額法により当期償却額を決定（残存簿価を超えない）
      const depreciationAmount = Math.min(asset.annualDepreciation, asset.bookValue);

      asset.bookValue -= depreciationAmount;

      if (asset.bookValue <= 0) {
        asset.bookValue = 0;
        asset.isFullyDepreciated = true;
      }

      if (asset.category === 'vehicle') {
        vehicleDepreciation += depreciationAmount;
      } else {
        infrastructureDepreciation += depreciationAmount;
      }
    }

    const totalDepreciation = vehicleDepreciation + infrastructureDepreciation;
    const totalBookValue = this.getTotalBookValue();

    return {
      totalDepreciation,
      vehicleDepreciation,
      infrastructureDepreciation,
      totalBookValue
    };
  }

  /**
   * 全固定資産の現在簿価合計を算出
   */
  public getTotalBookValue(): number {
    return this.assets.reduce((sum, a) => sum + a.bookValue, 0);
  }

  /**
   * 全固定資産の取得原価合計を算出
   */
  public getTotalInitialCost(): number {
    return this.assets.reduce((sum, a) => sum + a.initialCost, 0);
  }

  /**
   * 車両資産の現在簿価合計
   */
  public getVehicleBookValue(): number {
    return this.assets
      .filter(a => a.category === 'vehicle')
      .reduce((sum, a) => sum + a.bookValue, 0);
  }

  /**
   * インフラ資産の現在簿価合計
   */
  public getInfrastructureBookValue(): number {
    return this.assets
      .filter(a => a.category === 'infrastructure')
      .reduce((sum, a) => sum + a.bookValue, 0);
  }

  /**
   * 全登録資産リストの取得
   */
  public getAssets(): readonly AssetEntry[] {
    return this.assets;
  }

  /**
   * 台帳データのスナップショット出力（セーブ用）
   */
  public toSnapshot(): DepreciationLedgerSnapshot {
    return {
      assets: JSON.parse(JSON.stringify(this.assets)),
      totalHistoricalCost: this.getTotalInitialCost(),
      totalBookValue: this.getTotalBookValue(),
      accumulatedDepreciation: this.getTotalInitialCost() - this.getTotalBookValue()
    };
  }

  /**
   * スナップショットから台帳データを復元（ロード用）
   */
  public loadFromSnapshot(snapshot: Partial<DepreciationLedgerSnapshot>): void {
    if (snapshot && Array.isArray(snapshot.assets)) {
      this.assets = JSON.parse(JSON.stringify(snapshot.assets));
      let maxId = 0;
      for (const a of this.assets) {
        const num = parseInt(a.id.replace('asset_', ''), 10);
        if (!isNaN(num) && num > maxId) maxId = num;
      }
      this.nextAssetId = maxId + 1;
    }
  }

  /**
   * 台帳のリセット（新規ゲーム・都市初期化用）
   */
  public clear(): void {
    this.assets = [];
    this.nextAssetId = 1;
  }
}
