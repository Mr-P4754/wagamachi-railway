import { AssetDepreciationManager, AssetCategory } from './AssetDepreciationManager';

export interface FinancialReportData {
  fareIncome: number; // 旅客運賃収入
  cargoIncome: number; // 貨物輸送収入
  constructionCost: number;
  maintenanceCost: number;
  depreciationCost?: number; // 減価償却費
  bookValue?: number; // 固定資産簿価
  netProfit: number;
  landValue: number;
  totalPopulation: number;
  trackLength: number;
  trainCount: number;
  stationCount: number;
}

/**
 * 財務・経営データの時点スナップショット（月次・年次推移用）
 */
export interface FinancialSnapshot {
  year: number;
  month: number; // 月次: 1-12, 年次: 0 (通年)
  fareIncome: number; // 旅客運賃収入（または総運賃収入）
  cargoIncome?: number; // 貨物運賃収入
  maintenanceCost: number; // 運行・維持管理費
  constructionCost: number; // 建設・設備投資費
  depreciationCost?: number; // 当期減価償却費
  bookValue?: number; // 固定資産簿価
  netProfit: number; // 純利益
  population: number; // 総人口
  trackLength: number; // 鉄道総延長 (km)
  trainCount: number; // 運行列車数
  stationCount: number; // 駅数
  taxAmount?: number; // 確定税額（年次決算時のみ）
}

export class Economy {
  public static readonly MAX_MONTHLY_HISTORY = 24;
  public static readonly MAX_YEARLY_HISTORY = 10;

  public funds: number = 100000000; // 初期資金: ¥100,000,000
  public population: number = 0;

  // カレンダー (マスター設計書: 2026年4月開始)
  public year: number = 2026;
  public month: number = 4;
  public day: number = 1;

  // ゲーム内時刻（当日の経過分数, 0-1440）
  private dayTimerMin: number = 0;

  // 当期（直近月）の収支
  public periodFareIncome: number = 0;
  public periodCargoIncome: number = 0;
  public periodConstructionCost: number = 0;
  public periodMaintenanceCost: number = 0;

  // 年間（前年度/当年度）会計用アキュムレータ
  public fiscalYearFareIncome: number = 0;
  public fiscalYearCargoIncome: number = 0;
  public fiscalYearMaintenanceCost: number = 0;
  public fiscalYearConstructionCost: number = 0;

  // 固定資産・減価償却台帳
  public depreciationManager: AssetDepreciationManager = new AssetDepreciationManager();
  public lastDepreciationCost: number = 0;
  public lastTotalBookValue: number = 0;

  // 確定税額（3月31日確定、5月30日納付）
  public pendingCorporateTax: number = 0;
  public pendingPropertyTax: number = 0;
  public pendingTotalTax: number = 0;
  public lastSettledYear: number = 2025;

  // 月次財務履歴（直近最大24ヶ月）
  public monthlyHistory: FinancialSnapshot[] = [];
  // 年次財務履歴（直近最大10年）
  public yearlyHistory: FinancialSnapshot[] = [];

  // 開発テスト用: 資金無限モード
  public isInfiniteFunds: boolean = false;

  /**
   * 追加投資（新規線路敷設・車両購入等）が可能かどうかの判定フラグ
   * 資金がマイナス（赤字）の場合は追加投資のみロックされ、運行や街の成長は継続する
   */
  public get canInvest(): boolean {
    return this.isInfiniteFunds || this.funds >= 0;
  }

  constructor() {}

  public toggleInfiniteFunds(): boolean {
    this.isInfiniteFunds = !this.isInfiniteFunds;
    return this.isInfiniteFunds;
  }

  public addFunds(amount: number) {
    this.funds += amount;
    if (amount > 0) {
      this.periodFareIncome += amount;
      this.fiscalYearFareIncome += amount;
    }
  }

  /**
   * 貨物輸送運賃の加算（旅客運賃と分離して独立計上）
   */
  public addCargoIncome(amount: number) {
    this.funds += amount;
    if (amount > 0) {
      this.periodCargoIncome += amount;
      this.fiscalYearCargoIncome += amount;
    }
  }

  /**
   * ② 営業収入（運賃売上）に計上しない、純粋な資金返金・資産売却代金
   * （車両減車売却や仮置きキャンセル、Undo等の返金に使用し、売上過剰課税から除外する）
   * @param amount 返金・売却額
   * @param isConstruction 建設費・固定資産の取り消しを伴うか（Undoや設置キャンセル時）
   * @param category 資産カテゴリ
   */
  public refundFunds(
    amount: number,
    isConstruction: boolean = false,
    category: AssetCategory = 'infrastructure'
  ) {
    this.funds += amount;
    if (isConstruction && amount > 0) {
      this.periodConstructionCost = Math.max(0, this.periodConstructionCost - amount);
      this.fiscalYearConstructionCost = Math.max(0, this.fiscalYearConstructionCost - amount);
      this.depreciationManager.removeLatestAsset(amount, category);
    }
  }

  /**
   * 資金支出が可能かどうかの事前判定（引き落としは行わない）
   */
  public canSpend(amount: number, isConstruction: boolean = true): boolean {
    if (this.isInfiniteFunds || amount <= 0) return true;
    if (isConstruction) {
      return this.canInvest && this.funds >= amount;
    }
    return true;
  }

  /**
   * 当期（直近月）の収支アキュムレータをリセット
   * 月またぎ（onMonthPassed）時に呼び出され、「今期収支」レポートの無限累計インフレを防止する
   */
  public resetPeriodStats(): void {
    this.periodFareIncome = 0;
    this.periodCargoIncome = 0;
    this.periodConstructionCost = 0;
    this.periodMaintenanceCost = 0;
  }

  public spendFunds(
    amount: number,
    isConstruction: boolean = true,
    category: AssetCategory = 'infrastructure',
    assetName?: string
  ): boolean {
    // 資金無限モード時は残高チェックをパスし、資金を減算しない
    if (this.isInfiniteFunds) {
      if (isConstruction) {
        this.periodConstructionCost += amount;
        this.fiscalYearConstructionCost += amount;
        if (amount > 0) {
          this.depreciationManager.registerAsset(category, amount, assetName || (category === 'vehicle' ? '鉄道車両' : 'インフラ設備'), this.year);
        } else if (amount < 0) {
          this.depreciationManager.removeLatestAsset(-amount, category);
        }
      } else {
        this.periodMaintenanceCost += amount;
        this.fiscalYearMaintenanceCost += amount;
      }
      return true;
    }

    // 建設費・新規投資の場合: 資金が不足（または赤字中）なら購入不可（返金時は無条件で許可）
    if (isConstruction) {
      if (amount > 0 && (!this.canInvest || this.funds < amount)) {
        return false; // 資金不足または追加投資ロック
      }
      this.funds -= amount;
      this.periodConstructionCost += amount;
      this.fiscalYearConstructionCost += amount;
      if (amount > 0) {
        this.depreciationManager.registerAsset(category, amount, assetName || (category === 'vehicle' ? '鉄道車両' : 'インフラ設備'), this.year);
      } else if (amount < 0) {
        // 返金（マイナス支出）時: 資産台帳からも安全に減額
        this.depreciationManager.removeLatestAsset(-amount, category);
      }
      return true;
    }

    // 維持費・運行費等の固定費の場合: 赤字であっても引き落としを許可し、運行を継続させる
    this.funds -= amount;
    this.periodMaintenanceCost += amount;
    this.fiscalYearMaintenanceCost += amount;
    return true;
  }

  public addPopulation(amount: number) {
    this.population = Math.max(0, this.population + amount);
  }

  /**
   * 毎年3月31日 23:59 に呼び出される税額確定処理
   * 日本の鉄道会計基準に基づく減価償却費控除および固定資産簿価連動の固定資産税を算出する
   */
  public assessAnnualTax(trackTiles: number, stationTiles: number, totalCars: number, currentYear?: number): {
    fiscalYear: number;
    operatingProfit: number;
    constructionCost: number;
    depreciationCost: number;
    totalBookValue: number;
    taxableIncome: number;
    corporateTax: number;
    propertyTax: number;
    totalTax: number;
    trackTax: number;
    stationTax: number;
    carTax: number;
  } {
    const fiscalYear = currentYear !== undefined ? currentYear : this.year;
    this.lastSettledYear = fiscalYear;

    // 営業黒字（運賃収入[旅客+貨物] - 維持費）
    const totalOperatingRevenue = this.fiscalYearFareIncome + this.fiscalYearCargoIncome;
    const operatingProfit = totalOperatingRevenue - this.fiscalYearMaintenanceCost;

    // 設備投資額（キャッシュフロー上の支出額）
    const constructionCost = this.fiscalYearConstructionCost;

    // 当期減価償却費の計算と固定資産簿価の更新
    const depResult = this.depreciationManager.processAnnualDepreciation();
    const depreciationCost = depResult.totalDepreciation;
    const totalBookValue = depResult.totalBookValue;
    this.lastDepreciationCost = depreciationCost;
    this.lastTotalBookValue = totalBookValue;

    // 課税所得（営業利益 - 当期減価償却費）: 投資全額即時償却ではなく、耐用年数に応じた減価償却費を経費として損金算入
    const taxableIncome = operatingProfit - depreciationCost;

    // 法人税: 課税所得が黒字の場合のみ30%
    const corporateTax = taxableIncome > 0 ? Math.floor(taxableIncome * 0.3) : 0;

    // 固定資産税: 保有固定資産の現在簿価に標準税率1.4%を乗じて算出（年数が経ち簿価が減少するほど安くなる）
    // 最低限の維持インフラ基盤税（未登録資産や償却済資産の保守枠）を担保
    const minimumPropertyBase = (trackTiles * 2000) + (stationTiles * 10000) + (totalCars * 30000);
    const propertyTax = Math.floor(Math.max(totalBookValue * 0.014, minimumPropertyBase));

    const trackTax = Math.floor(trackTiles * 2000);
    const stationTax = Math.floor(stationTiles * 10000);
    const carTax = Math.floor(totalCars * 30000);

    const totalTax = corporateTax + propertyTax;

    this.pendingCorporateTax = corporateTax;
    this.pendingPropertyTax = propertyTax;
    this.pendingTotalTax = totalTax;

    // 新年度に向けて年間会計アキュムレータをリセット
    this.fiscalYearFareIncome = 0;
    this.fiscalYearCargoIncome = 0;
    this.fiscalYearMaintenanceCost = 0;
    this.fiscalYearConstructionCost = 0;

    return {
      fiscalYear,
      operatingProfit,
      constructionCost,
      depreciationCost,
      totalBookValue,
      taxableIncome,
      corporateTax,
      propertyTax,
      totalTax,
      trackTax,
      stationTax,
      carTax
    };
  }

  /**
   * 毎年5月30日 00:00 に呼び出される納税執行処理
   * 確定した税金をプレイヤー資金から自動引き落としする
   * 資金が赤字になってもゲームオーバーにせず運行を継続可能とする
   */
  public executeTaxPayment(): { paidAmount: number; remainingFunds: number; isDeficit: boolean } {
    const taxToPay = this.pendingTotalTax;

    if (!this.isInfiniteFunds) {
      this.funds -= taxToPay;
    }

    // 納税済みにリセット
    this.pendingTotalTax = 0;
    this.pendingCorporateTax = 0;
    this.pendingPropertyTax = 0;

    return {
      paidAmount: taxToPay,
      remainingFunds: this.funds,
      isDeficit: this.funds < 0
    };
  }

  /**
   * ⑤ ゲーム内カレンダーを進行させる。
   * minutesPerSecond: 現実1秒あたりに進むゲーム内分数
   *   （通常速度=10分/秒、高速=60分/秒(1時間/秒)、超高速=360分/秒(6時間/秒)）
   */
  public update(
    deltaTime: number,
    minutesPerSecond: number,
    onDayPassed: () => void,
    onMonthPassed: () => void
  ) {
    if (minutesPerSecond <= 0) return;

    this.dayTimerMin += deltaTime * minutesPerSecond;

    // 低フレームレートや超高速設定で1フレームに複数日進む場合に備えてループで消化する
    while (this.dayTimerMin >= 1440) {
      this.dayTimerMin -= 1440;
      this.day++;

      // End of month check
      const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][this.month - 1];
      if (this.day > daysInMonth) {
        this.day = 1;
        this.month++;
        if (this.month > 12) {
          this.month = 1;
          this.year++;
        }
        onMonthPassed();
        this.resetPeriodStats();
      }

      onDayPassed();
    }
  }

  public getFormattedDate(): string {
    const yStr = String(this.year).padStart(2, '0');
    const mStr = String(this.month).padStart(2, '0');
    const dStr = String(this.day).padStart(2, '0');
    return `${yStr}年 ${mStr}月 ${dStr}日`;
  }

  /**
   * ⑥ ゲーム内時刻表示 (HH:MM)
   */
  public getFormattedTime(): string {
    const totalMinutes = Math.floor(this.dayTimerMin);
    const hh = String(Math.floor(totalMinutes / 60) % 24).padStart(2, '0');
    const mm = String(totalMinutes % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  public getHour(): number {
    return Math.floor(Math.floor(this.dayTimerMin) / 60) % 24;
  }

  public getMinute(): number {
    return Math.floor(this.dayTimerMin) % 60;
  }

  public setTime(hour: number, minute: number): void {
    this.dayTimerMin = (hour * 60) + minute;
  }

  public getFormattedFunds(): string {
    if (this.isInfiniteFunds) {
      return '¥∞ (無制限)';
    }
    if (this.funds < 0) {
      return `¥ -${Math.abs(this.funds).toLocaleString('ja-JP')}`;
    }
    return '¥' + this.funds.toLocaleString('ja-JP');
  }

  public getFormattedPopulation(): string {
    return this.population.toLocaleString('ja-JP') + '人';
  }

  public getFinancialReport(trackTiles: number, trainCount: number, stationCount: number): FinancialReportData {
    const totalIncome = this.periodFareIncome + this.periodCargoIncome;
    const netProfit = totalIncome - (this.periodConstructionCost + this.periodMaintenanceCost);
    return {
      fareIncome: this.periodFareIncome,
      cargoIncome: this.periodCargoIncome,
      constructionCost: this.periodConstructionCost,
      maintenanceCost: this.periodMaintenanceCost,
      depreciationCost: this.lastDepreciationCost,
      bookValue: this.depreciationManager.getTotalBookValue(),
      netProfit,
      landValue: (this.population * 25000) + (trackTiles * 1500000),
      totalPopulation: this.population,
      trackLength: Math.round(trackTiles * 0.1 * 10) / 10,
      trainCount,
      stationCount
    };
  }

  public getTotalBookValue(): number {
    return this.depreciationManager.getTotalBookValue();
  }

  /**
   * 月次財務スナップショットを記録する（上限24件、古い順に自動破棄）
   */
  public recordMonthlySnapshot(snapshot: FinancialSnapshot): void {
    this.monthlyHistory.push(snapshot);
    while (this.monthlyHistory.length > Economy.MAX_MONTHLY_HISTORY) {
      this.monthlyHistory.shift();
    }
  }

  /**
   * 年次財務スナップショットを記録する（上限10件、古い順に自動破棄）
   */
  public recordYearlySnapshot(snapshot: FinancialSnapshot): void {
    this.yearlyHistory.push(snapshot);
    while (this.yearlyHistory.length > Economy.MAX_YEARLY_HISTORY) {
      this.yearlyHistory.shift();
    }
  }

  public getMonthlyHistory(): FinancialSnapshot[] {
    return [...this.monthlyHistory];
  }

  public getYearlyHistory(): FinancialSnapshot[] {
    return [...this.yearlyHistory];
  }

  /**
   * 経済・財務データのシリアライズ
   */
  public serialize(): any {
    return {
      funds: this.funds,
      population: this.population,
      year: this.year,
      month: this.month,
      day: this.day,
      periodFareIncome: this.periodFareIncome,
      periodCargoIncome: this.periodCargoIncome,
      periodConstructionCost: this.periodConstructionCost,
      periodMaintenanceCost: this.periodMaintenanceCost,
      fiscalYearFareIncome: this.fiscalYearFareIncome,
      fiscalYearCargoIncome: this.fiscalYearCargoIncome,
      fiscalYearMaintenanceCost: this.fiscalYearMaintenanceCost,
      fiscalYearConstructionCost: this.fiscalYearConstructionCost,
      pendingCorporateTax: this.pendingCorporateTax,
      pendingPropertyTax: this.pendingPropertyTax,
      pendingTotalTax: this.pendingTotalTax,
      lastSettledYear: this.lastSettledYear,
      monthlyHistory: this.monthlyHistory,
      yearlyHistory: this.yearlyHistory,
      lastDepreciationCost: this.lastDepreciationCost,
      lastTotalBookValue: this.lastTotalBookValue,
      isInfiniteFunds: this.isInfiniteFunds,
      depreciationLedger: this.depreciationManager.toSnapshot()
    };
  }

  /**
   * 経済・財務データのデシリアライズ
   */
  public deserialize(data: any): boolean {
    if (!data) return false;
    const safeNum = (v: any, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
    this.funds = safeNum(data.funds, 100000000);
    this.population = safeNum(data.population, 0);
    this.year = safeNum(data.year, 2026) >= 2026 ? data.year : 2026;
    this.month = safeNum(data.month, 4);
    this.day = safeNum(data.day, 1);
    this.periodFareIncome = safeNum(data.periodFareIncome, 0);
    this.periodCargoIncome = safeNum(data.periodCargoIncome, 0);
    this.periodConstructionCost = safeNum(data.periodConstructionCost, 0);
    this.periodMaintenanceCost = safeNum(data.periodMaintenanceCost, 0);
    this.fiscalYearFareIncome = safeNum(data.fiscalYearFareIncome, 0);
    this.fiscalYearCargoIncome = safeNum(data.fiscalYearCargoIncome, 0);
    this.fiscalYearMaintenanceCost = safeNum(data.fiscalYearMaintenanceCost, 0);
    this.fiscalYearConstructionCost = safeNum(data.fiscalYearConstructionCost, 0);
    this.pendingCorporateTax = safeNum(data.pendingCorporateTax, 0);
    this.pendingPropertyTax = safeNum(data.pendingPropertyTax, 0);
    this.pendingTotalTax = safeNum(data.pendingTotalTax, 0);
    this.lastSettledYear = safeNum(data.lastSettledYear, 2025);
    this.lastDepreciationCost = safeNum(data.lastDepreciationCost, 0);
    this.lastTotalBookValue = safeNum(data.lastTotalBookValue, 0);
    this.isInfiniteFunds = !!data.isInfiniteFunds;

    if (data.depreciationLedger) {
      this.depreciationManager.loadFromSnapshot(data.depreciationLedger);
    } else {
      this.depreciationManager.clear();
    }

    if (Array.isArray(data.monthlyHistory)) {
      this.monthlyHistory = data.monthlyHistory.filter((s: any) => s && typeof s.year === 'number');
    } else {
      this.monthlyHistory = [];
    }
    if (Array.isArray(data.yearlyHistory)) {
      this.yearlyHistory = data.yearlyHistory.filter((s: any) => s && typeof s.year === 'number');
    } else {
      this.yearlyHistory = [];
    }
    return true;
  }

  public resetAll() {
    this.funds = 100000000;
    this.population = 0;
    this.year = 2026;
    this.month = 4;
    this.day = 1;
    this.periodFareIncome = 0;
    this.periodCargoIncome = 0;
    this.periodConstructionCost = 0;
    this.periodMaintenanceCost = 0;
    this.fiscalYearFareIncome = 0;
    this.fiscalYearCargoIncome = 0;
    this.fiscalYearMaintenanceCost = 0;
    this.fiscalYearConstructionCost = 0;
    this.pendingCorporateTax = 0;
    this.pendingPropertyTax = 0;
    this.pendingTotalTax = 0;
    this.lastSettledYear = 2025;
    this.lastDepreciationCost = 0;
    this.lastTotalBookValue = 0;
    this.isInfiniteFunds = false;
    this.depreciationManager.clear();
    this.monthlyHistory = [];
    this.yearlyHistory = [];
  }

  /**
   * ゲーム内時間（TimeManager）と会計カレンダー（年・月・日）を同期
   */
  public syncDate(year: number, month: number, day: number): void {
    this.year = year;
    this.month = month;
    this.day = day;
  }
}
