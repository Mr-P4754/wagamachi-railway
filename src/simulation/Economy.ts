export interface FinancialReportData {
  fareIncome: number;
  constructionCost: number;
  maintenanceCost: number;
  netProfit: number;
  landValue: number;
  totalPopulation: number;
  trackLength: number;
  trainCount: number;
  stationCount: number;
}

export class Economy {
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
  public periodConstructionCost: number = 0;
  public periodMaintenanceCost: number = 0;

  // 年間（前年度/当年度）会計用アキュムレータ
  public fiscalYearFareIncome: number = 0;
  public fiscalYearMaintenanceCost: number = 0;
  public fiscalYearConstructionCost: number = 0;

  // 確定税額（3月31日確定、5月30日納付）
  public pendingCorporateTax: number = 0;
  public pendingPropertyTax: number = 0;
  public pendingTotalTax: number = 0;
  public lastSettledYear: number = 2025;

  // 開発テスト用: 資金無限モード
  public isInfiniteFunds: boolean = false;

  /**
   * 追加投資（新規線路敷設・車両購入等）が可能かどうかの判定フラグ
   * 資金がマイナス（赤字）の場合は追加投資のみロックされ、運行や街の成長は継続する
   */
  public get canInvest(): boolean {
    return this.isInfiniteFunds || this.funds >= 0;
  }

  constructor() {
    this.loadFromStorage();
  }

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
   * ② 営業収入（運賃売上）に計上しない、純粋な資金返金・資産売却代金
   * （車両減車売却や仮置きキャンセル等の返金に使用し、売上過剰課税から除外する）
   */
  public refundFunds(amount: number) {
    this.funds += amount;
  }

  /**
   * 当期（直近月）の収支アキュムレータをリセット
   * 月またぎ（onMonthPassed）時に呼び出され、「今期収支」レポートの無限累計インフレを防止する
   */
  public resetPeriodStats(): void {
    this.periodFareIncome = 0;
    this.periodConstructionCost = 0;
    this.periodMaintenanceCost = 0;
  }

  public spendFunds(amount: number, isConstruction: boolean = true): boolean {
    // 資金無限モード時は残高チェックをパスし、資金を減算しない
    if (this.isInfiniteFunds) {
      if (isConstruction) {
        this.periodConstructionCost += amount;
        this.fiscalYearConstructionCost += amount;
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
      return true;
    }

    // 維持費・運行費等の固定費の場合: 赤字であっても引き落としを許可し、運行を継続させる
    this.funds -= amount;
    this.periodMaintenanceCost += amount;
    this.fiscalYearMaintenanceCost += amount;
    return true;
  }

  public addPopulation(amount: number) {
    this.population += amount;
  }

  /**
   * 毎年3月31日 23:59 に呼び出される税額確定処理
   * 前年度の実績から法人税（黒字の30%）および保有資産に応じた固定資産税を算出する
   */
  public assessAnnualTax(trackTiles: number, stationTiles: number, totalCars: number, currentYear?: number): {
    fiscalYear: number;
    operatingProfit: number;
    constructionCost: number;
    taxableIncome: number;
    corporateTax: number;
    propertyTax: number;
    totalTax: number;
    trackTax: number;
    stationTax: number;
    carTax: number;
  } {
    if (currentYear !== undefined) {
      this.year = currentYear;
    }
    const fiscalYear = this.year;
    this.lastSettledYear = fiscalYear;

    // 営業黒字（運賃収入 - 維持費）
    const operatingProfit = this.fiscalYearFareIncome - this.fiscalYearMaintenanceCost;

    // 設備投資額（建設費・車両購入費等）
    const constructionCost = this.fiscalYearConstructionCost;

    // 課税所得（設備投資控除後）: 利益を街の開発に再投資した分は損金算入（全額経費控除）
    const taxableIncome = operatingProfit - constructionCost;

    // 法人税: 課税所得が黒字の場合のみ30%。設備投資で再投資した場合は0円（節税成功）
    const corporateTax = taxableIncome > 0 ? Math.floor(taxableIncome * 0.3) : 0;

    // 固定資産税: 線路1マス5万円、駅ホーム1マス20万円、車両1両50万円
    const trackTax = trackTiles * 50000;
    const stationTax = stationTiles * 200000;
    const carTax = totalCars * 500000;
    const propertyTax = trackTax + stationTax + carTax;

    const totalTax = corporateTax + propertyTax;

    this.pendingCorporateTax = corporateTax;
    this.pendingPropertyTax = propertyTax;
    this.pendingTotalTax = totalTax;

    // 新年度に向けて年間会計アキュムレータをリセット
    this.fiscalYearFareIncome = 0;
    this.fiscalYearMaintenanceCost = 0;
    this.fiscalYearConstructionCost = 0;

    return {
      fiscalYear,
      operatingProfit,
      constructionCost,
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
    const netProfit = this.periodFareIncome - (this.periodConstructionCost + this.periodMaintenanceCost);
    return {
      fareIncome: this.periodFareIncome,
      constructionCost: this.periodConstructionCost,
      maintenanceCost: this.periodMaintenanceCost,
      netProfit,
      landValue: (this.population * 25000) + (trackTiles * 1500000),
      totalPopulation: this.population,
      trackLength: Math.round(trackTiles * 0.1 * 10) / 10,
      trainCount,
      stationCount
    };
  }

  public saveToStorage() {
    try {
      const data = {
        funds: this.funds,
        population: this.population,
        year: this.year,
        month: this.month,
        day: this.day,
        periodFareIncome: this.periodFareIncome,
        periodConstructionCost: this.periodConstructionCost,
        periodMaintenanceCost: this.periodMaintenanceCost,
        fiscalYearFareIncome: this.fiscalYearFareIncome,
        fiscalYearMaintenanceCost: this.fiscalYearMaintenanceCost,
        fiscalYearConstructionCost: this.fiscalYearConstructionCost,
        pendingCorporateTax: this.pendingCorporateTax,
        pendingPropertyTax: this.pendingPropertyTax,
        pendingTotalTax: this.pendingTotalTax,
        lastSettledYear: this.lastSettledYear
      };
      localStorage.setItem('wagamachi_economy_data', JSON.stringify(data));
    } catch (e) {
      console.warn('LocalStorage save failed', e);
    }
  }

  public loadFromStorage(): boolean {
    try {
      const raw = localStorage.getItem('wagamachi_economy_data') || localStorage.getItem('stk_3d_economy');
      if (raw) {
        const data = JSON.parse(raw);
        this.funds = data.funds ?? 100000000;
        this.population = data.population ?? 0;
        this.year = data.year && data.year >= 2026 ? data.year : 2026;
        this.month = data.month ?? 4;
        this.day = data.day ?? 1;
        this.periodFareIncome = data.periodFareIncome ?? 0;
        this.periodConstructionCost = data.periodConstructionCost ?? 0;
        this.periodMaintenanceCost = data.periodMaintenanceCost ?? 0;
        this.fiscalYearFareIncome = data.fiscalYearFareIncome ?? 0;
        this.fiscalYearMaintenanceCost = data.fiscalYearMaintenanceCost ?? 0;
        this.fiscalYearConstructionCost = data.fiscalYearConstructionCost ?? 0;
        this.pendingCorporateTax = data.pendingCorporateTax ?? 0;
        this.pendingPropertyTax = data.pendingPropertyTax ?? 0;
        this.pendingTotalTax = data.pendingTotalTax ?? 0;
        this.lastSettledYear = data.lastSettledYear ?? 2025;
        return true;
      }
    } catch (e) {
      console.warn('LocalStorage load failed', e);
    }
    return false;
  }

  public resetAll() {
    this.funds = 100000000;
    this.population = 0;
    this.year = 2026;
    this.month = 4;
    this.day = 1;
    this.periodFareIncome = 0;
    this.periodConstructionCost = 0;
    this.periodMaintenanceCost = 0;
    this.fiscalYearFareIncome = 0;
    this.fiscalYearMaintenanceCost = 0;
    this.fiscalYearConstructionCost = 0;
    this.pendingCorporateTax = 0;
    this.pendingPropertyTax = 0;
    this.pendingTotalTax = 0;
    this.lastSettledYear = 2025;
    try {
      localStorage.removeItem('wagamachi_economy_data');
      localStorage.removeItem('stk_3d_economy');
    } catch (e) {}
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
