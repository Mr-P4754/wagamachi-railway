// わがまちレールウェイ 時間同期タイマーシステム（マスター設計書準拠）

export type SpeedLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface TimeManagerEvents {
  onMinutePassed?: (year: number, month: number, day: number, hour: number, minute: number) => void;
  onFiveMinutesPassed?: (hour: number, minute: number) => void;
  onHourPassed?: (hour: number) => void;
  onDayPassed?: (year: number, month: number, day: number) => void;
  onMonthPassed?: (year: number, month: number) => void;
  onFiscalYearEnd?: (fiscalYear: number) => void; // 毎年 3月31日 23:59
  onTaxDueDay?: (year: number) => void; // 毎年 5月30日 00:00
}

export class TimeManager {
  // 速度定義: 0=一時停止, 1=等速(1分/秒), 2=3倍速(3分/秒), 3=10倍速(10分/秒), 4=超高速(60分/秒 = 1秒で1時間), 5=爆速(720分/秒 = 1秒で12時間進む)
  public static readonly SPEED_MULTIPLIERS = [0, 1, 3, 10, 60, 720] as const;
  public static readonly MINUTES_PER_SECOND = [0, 1, 3, 10, 60, 720] as const;

  public speedLevel: SpeedLevel = 1;

  // カレンダー日時 (初期値: 2026年4月1日 06:00)
  public year: number = 2026;
  public month: number = 4;
  public day: number = 1;
  public hour: number = 6;
  public minute: number = 0;

  // サブ分アキュムレータ（0.0 〜 1.0分）
  private minuteAccumulator: number = 0;

  // 【時間のズレ解消】カハン加算アルゴリズム用補正項（Kahan Compensation）
  // 浮動小数点数（IEEE 754 float64）の微小加算で生じる情報落ち（丸め誤差）を厳密に補正・相殺
  private minuteAccumulatorCompensation: number = 0;

  // コロン点滅用タイマー（現実時間秒）
  private colonTimer: number = 0;
  public isColonVisible: boolean = true;

  public events: TimeManagerEvents = {};

  constructor(initialYear: number = 2026, initialMonth: number = 4, initialDay: number = 1, initialHour: number = 6, initialMinute: number = 0) {
    this.year = initialYear;
    this.month = initialMonth;
    this.day = initialDay;
    this.hour = initialHour;
    this.minute = initialMinute;
  }

  public setSpeedLevel(level: SpeedLevel): void {
    this.speedLevel = level;
    if (level === 0) {
      this.isColonVisible = true;
    }
  }

  public get currentMultiplier(): number {
    return TimeManager.SPEED_MULTIPLIERS[this.speedLevel];
  }

  public get minutesPerSecond(): number {
    return TimeManager.MINUTES_PER_SECOND[this.speedLevel];
  }

  /**
   * 毎フレームの更新処理
   * @param deltaTimeSec 前フレームからの経過時間（現実秒）
   */
  public update(deltaTimeSec: number): void {
    // 【フレームドロップ耐性】高負荷・描画遅延時でも最大0.05秒（20fps相当）にクランプし、
    // 極端なワープや時間スキップによるシミュレーション破綻を防止
    const clampedDt = Math.min(Math.max(0, deltaTimeSec), 0.05);

    // 1. コロン点滅の更新（稼働時は0.5秒周期、停止時は常時点灯）
    if (this.speedLevel > 0) {
      this.colonTimer += clampedDt;
      if (this.colonTimer >= 0.5) {
        this.colonTimer -= 0.5;
        this.isColonVisible = !this.isColonVisible;
      }
    } else {
      this.isColonVisible = true;
      this.colonTimer = 0;
    }

    // 2. ゲーム内時間の進行
    const minPerSec = this.minutesPerSecond;
    if (minPerSec <= 0) return;

    // 【時間のズレ解消】カハン加算（Kahan summation algorithm）による誤差補正加算
    // 毎フレームの微小な小数加算（0.016666...）に伴う浮動小数点丸め誤差（情報落ち）を完全に相殺
    const deltaMin = clampedDt * minPerSec;
    const y = deltaMin - this.minuteAccumulatorCompensation;
    const t = this.minuteAccumulator + y;
    this.minuteAccumulatorCompensation = (t - this.minuteAccumulator) - y;
    this.minuteAccumulator = t;

    let loopCount = 0;
    while (this.minuteAccumulator >= 1.0 && loopCount < 720) {
      this.minuteAccumulator -= 1.0;
      this.advanceOneMinute();
      loopCount++;
    }
    if (this.minuteAccumulator > 720) {
      this.minuteAccumulator = 0;
    }
  }

  /**
   * ちょうど1分進める
   */
  private advanceOneMinute(): void {
    this.minute++;
    if (this.minute >= 60) {
      this.minute = 0;
      this.hour++;

      if (this.hour >= 24) {
        this.hour = 0;
        this.day++;

        const daysInMonth = this.getDaysInMonth(this.year, this.month);
        if (this.day > daysInMonth) {
          this.day = 1;
          this.month++;

          if (this.month > 12) {
            this.month = 1;
            this.year++;
          }
          this.events.onMonthPassed?.(this.year, this.month);
        }
        this.events.onDayPassed?.(this.year, this.month, this.day);

        // 5月30日 00:00 到達イベント（納税執行日）
        if (this.month === 5 && this.day === 30 && this.hour === 0 && this.minute === 0) {
          this.events.onTaxDueDay?.(this.year);
        }
      }
      this.events.onHourPassed?.(this.hour);
    }

    this.events.onMinutePassed?.(this.year, this.month, this.day, this.hour, this.minute);

    if (this.minute % 5 === 0) {
      this.events.onFiveMinutesPassed?.(this.hour, this.minute);
    }

    // 毎年 3月31日 23:59 到達イベント（前年度決算・税額確定日: 4月〜翌3月の年度末のため year - 1 年度）
    if (this.month === 3 && this.day === 31 && this.hour === 23 && this.minute === 59) {
      this.events.onFiscalYearEnd?.(this.year - 1);
    }
  }

  private getDaysInMonth(year: number, month: number): number {
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    const days = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return days[month - 1];
  }

  /**
   * カレンダー日付表示（例: 2026年04月01日）
   */
  public getFormattedDate(): string {
    const yStr = String(this.year);
    const mStr = String(this.month).padStart(2, '0');
    const dStr = String(this.day).padStart(2, '0');
    return `${yStr}年 ${mStr}月 ${dStr}日`;
  }

  /**
   * 時計時刻表示（例: 07:15 または 07 15）
   */
  public getFormattedTime(useBlink: boolean = true): string {
    const hh = String(this.hour).padStart(2, '0');
    const mm = String(this.minute).padStart(2, '0');
    const colon = (useBlink && !this.isColonVisible) ? ' ' : ':';
    return `${hh}${colon}${mm}`;
  }

  /**
   * 総合日時表示
   */
  public getFormattedDateTime(): string {
    return `${this.getFormattedDate()} ${this.getFormattedTime(false)}`;
  }

  /**
   * 状態のシリアライズ
   */
  public serialize(): { year: number; month: number; day: number; hour: number; minute: number; speedLevel: number } {
    return {
      year: this.year,
      month: this.month,
      day: this.day,
      hour: this.hour,
      minute: this.minute,
      speedLevel: this.speedLevel
    };
  }

  /**
   * 状態の復元
   */
  public deserialize(data: { year?: number; month?: number; day?: number; hour?: number; minute?: number; speedLevel?: number }): void {
    if (data.year !== undefined) this.year = data.year;
    if (data.month !== undefined) this.month = data.month;
    if (data.day !== undefined) this.day = data.day;
    if (data.hour !== undefined) this.hour = data.hour;
    if (data.minute !== undefined) this.minute = data.minute;
    if (data.speedLevel !== undefined) this.speedLevel = data.speedLevel as SpeedLevel;
    this.minuteAccumulator = 0;
    this.minuteAccumulatorCompensation = 0;
  }
}
