import { WorldMap, TileData, SwitchSchedule, SwitchTimeZoneRule, createDefaultSwitchSchedule } from '../simulation/WorldMap';
import { GridLayer } from '../core/types';

export type DeviceMode = 'desktop' | 'mobile';

export class SwitchScheduleUI {
  private container: HTMLDivElement;
  private currentTile: TileData | null = null;
  public onScheduleChanged: (tile: TileData) => void = () => {};


  constructor(private worldMap: WorldMap) {
    this.container = document.createElement('div');
    this.container.id = 'switch-schedule-ui';
    this.container.className = 'switch-schedule-ui hidden mode-desktop';
    document.body.appendChild(this.container);

    this.injectStyle();

    // ESCキーで閉じる
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) {
        this.close();
      }
    });
  }

  private injectStyle(): void {
    if (document.getElementById('switch-schedule-ui-style')) return;
    const style = document.createElement('style');
    style.id = 'switch-schedule-ui-style';
    style.textContent = `
      .switch-schedule-ui {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 820px;
        max-width: 94vw;
        max-height: 88vh;
        max-height: 88dvh;
        z-index: 1500;
        background: var(--bg-panel, rgba(15,23,42,0.96));
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(245, 158, 11, 0.4);
        border-radius: 12px;
        box-shadow: 0 20px 48px rgba(0, 0, 0, 0.8), 0 0 30px rgba(245, 158, 11, 0.15);
        color: var(--text-primary, #e2e8f0);
        display: flex;
        flex-direction: column;
        font-size: 13px;
        overflow: hidden;
      }
      .switch-schedule-ui.hidden { display: none !important; }
      
      .sw-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 16px; flex-shrink: 0; border-bottom: 1px solid var(--border-panel, rgba(255,255,255,0.1));
      }
      .sw-header-title { font-size: 16px; font-weight: bold; color: #f59e0b; display: flex; align-items: center; gap: 8px; }
      .sw-close-btn { background: none; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; }
      .sw-close-btn:hover { color: #fff; }
      .sw-body { flex: 1; overflow-y: auto; padding: 12px 16px 24px; }

      .sw-mode-selector {
        display: flex; align-items: center; gap: 10px; margin-bottom: 14px;
        background: rgba(0,0,0,0.3); padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1);
      }
      .sw-mode-btn-group { display: flex; gap: 6px; }
      .sw-mode-btn {
        background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.2);
        color: #94a3b8; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold;
        transition: all 0.2s;
      }
      .sw-mode-btn:hover { background: rgba(245, 158, 11, 0.15); color: #fff; }
      .sw-mode-btn.active {
        background: rgba(245, 158, 11, 0.25); border-color: #f59e0b; color: #fbbf24;
        box-shadow: 0 0 8px rgba(245, 158, 11, 0.3);
      }
      
      .sw-timeline-container {
        width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.55);
        border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 12px 14px 14px 14px; margin-bottom: 16px;
        user-select: none;
      }
      .sw-tl-time-header {
        position: relative; width: 100%; height: 18px; margin-bottom: 6px;
      }
      .sw-tl-time-label {
        position: absolute; top: 0; transform: translateX(-50%);
        font-size: 11px; font-weight: 700; color: #cbd5e1;
        pointer-events: none; line-height: 1; text-align: center;
      }
      .sw-timeline-ruler {
        position: relative; width: 100%; box-sizing: border-box; height: 42px; background: rgba(100, 116, 139, 0.2);
        border: 1px solid rgba(255,255,255,0.25); border-radius: 4px;
        overflow: hidden;
      }
      .sw-tl-grid-line {
        position: absolute; top: 0; height: 100%; pointer-events: none;
      }
      .sw-tl-grid-line.major {
        border-left: 1px solid rgba(255,255,255,0.35);
      }
      .sw-tl-grid-line.minor {
        border-left: 1px dashed rgba(255,255,255,0.12);
      }
      
      .sw-default-label {
        position: absolute; top: 50%; left: 12px; transform: translateY(-50%);
        font-size: 11px; color: rgba(148, 163, 184, 0.6); font-weight: bold; letter-spacing: 2px;
        pointer-events: none; user-select: none;
      }

      /* 分岐ゾーン（帯） */
      .sw-tl-zone {
        position: absolute; top: 0; height: 100%; display: flex; align-items: center; justify-content: center;
        font-size: 10px; font-weight: bold; color: white; z-index: 5;
        border-left: 2px solid rgba(255,255,255,0.8); border-right: 2px solid rgba(255,255,255,0.8);
        pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        box-sizing: border-box;
      }
      .sw-tl-zone-diverge {
        background: rgba(245, 158, 11, 0.65);
        box-shadow: inset 0 0 8px rgba(251, 191, 36, 0.5);
      }
      .sw-tl-zone-cross-a {
        background: rgba(56, 189, 248, 0.65);
        box-shadow: inset 0 0 8px rgba(56, 189, 248, 0.5);
      }
      .sw-tl-zone-cross-b {
        background: rgba(236, 72, 153, 0.65);
        box-shadow: inset 0 0 8px rgba(236, 72, 153, 0.5);
      }

      .sw-cards-container { display: flex; flex-direction: column; gap: 10px; }
      .sw-detail-card {
        background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(245, 158, 11, 0.3);
        border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 10px;
        transition: border-color 0.2s;
      }
      .sw-detail-card:hover { border-color: rgba(245, 158, 11, 0.7); }
      .sw-card-header {
        display: flex; justify-content: space-between; align-items: center;
        border-bottom: 1px dashed rgba(255, 255, 255, 0.15); padding-bottom: 8px;
        flex-wrap: wrap; gap: 8px;
      }
      .sw-type-sel, .sw-target-sel {
        background: rgba(15, 23, 42, 0.9); border: 1px solid #d97706; color: #fff;
        padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 13px; outline: none;
        cursor: pointer;
      }
      .sw-type-sel:focus, .sw-target-sel:focus {
        border-color: #fbbf24; box-shadow: 0 0 6px rgba(251, 191, 36, 0.4);
      }
      .sw-card-actions { display: flex; align-items: center; gap: 6px; }
      .sw-btn-copy, .sw-btn-del {
        background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.2);
        color: #e2e8f0; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px;
      }
      .sw-btn-copy:hover { background: rgba(245, 158, 11, 0.25); border-color: #f59e0b; color: #fff; }
      .sw-btn-del:hover { background: rgba(244, 63, 94, 0.25); border-color: #f43f5e; color: #fff; }

      .sw-inputs-row { display: flex; align-items: center; gap: 10px; font-size: 13px; flex-wrap: wrap; }
      .sw-inputs-row input[type="time"], .sw-inputs-row input[type="number"] {
        background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.3);
        color: #fff; padding: 4px 6px; border-radius: 4px; font-size: 14px; font-family: monospace;
      }
      .sw-inputs-row input[type="time"]:focus, .sw-inputs-row input[type="number"]:focus {
        border-color: #f59e0b; outline: none; background: rgba(245, 158, 11, 0.1);
      }

      .btn-add-sw-card {
        background: rgba(245, 158, 11, 0.15); border: 1px dashed rgba(245, 158, 11, 0.5);
        color: #fbbf24; padding: 12px; border-radius: 8px; text-align: center;
        cursor: pointer; font-weight: bold; transition: background 0.2s; margin-top: 6px;
      }
      .btn-add-sw-card:hover { background: rgba(245, 158, 11, 0.3); }

      .sw-legend {
        display: flex; align-items: center; gap: 16px; font-size: 11px; color: #94a3b8; margin-top: 4px; margin-bottom: 12px;
      }
      .sw-legend-item { display: flex; align-items: center; gap: 6px; }
      .sw-legend-box { width: 14px; height: 14px; border-radius: 3px; }
    `;
    document.head.appendChild(style);
  }

  public isOpen(): boolean {
    return !this.container.classList.contains('hidden');
  }

  public close(): void {
    this.container.classList.add('hidden');
    this.currentTile = null;
  }

  public open(tile: TileData): void {
    if (!tile.switchSchedule) {
      tile.switchSchedule = createDefaultSwitchSchedule();
    }
    const sched = tile.switchSchedule;
    if (!sched.rules) sched.rules = [];
    if (!sched.mode) sched.mode = 'timeline';
    if (!sched.defaultState) sched.defaultState = 'straight';

    this.currentTile = tile;
    this.container.classList.remove('hidden');
    this.render();
  }

  public refreshOrClose(): void {
    if (!this.currentTile) return;
    const lyr = (this.currentTile.layer ?? 1) as GridLayer;
    const still = this.worldMap.getTile(this.currentTile.x, this.currentTile.z, lyr);
    if (!still) this.close();
    else {
      this.currentTile = still;
      this.render();
    }
  }

  private notifyChanged(): void {
    if (this.currentTile) {
      this.onScheduleChanged(this.currentTile);
    }
    this.render();
  }

  private formatTime(minutes: number): string {
    const norm = ((minutes % 1440) + 1440) % 1440;
    const h = Math.floor(norm / 60).toString().padStart(2, '0');
    const m = (norm % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
  }

  private parseTime(timeStr: string): number {
    const parts = timeStr.split(':');
    if (parts.length !== 2) return 0;
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }

  private isScissorsCrossing(): boolean {
    return !!this.currentTile && this.currentTile.type.startsWith('scissors_crossing');
  }

  private render(): void {
    if (!this.currentTile || !this.currentTile.switchSchedule) return;
    const sched = this.currentTile.switchSchedule;
    sched.rules = sched.rules || [];

    const isScissors = this.isScissorsCrossing();
    const titleText = isScissors
      ? `シーサスクロッシング ダイヤ設定 (${this.currentTile.x}, ${this.currentTile.z})`
      : `分岐器ダイヤ設定 (${this.currentTile.x}, ${this.currentTile.z})`;

    this.container.innerHTML = `
      <div class="sw-header">
        <div class="sw-header-title">
          <span>🔀</span>
          <span>${titleText}</span>
        </div>
        <button class="sw-close-btn" title="閉じる (Esc)">✕</button>
      </div>
      <div class="sw-body">
        <!-- 動作モード切替 -->
        <div class="sw-mode-selector">
          <span style="font-weight:bold; color:#cbd5e1;">動作モード:</span>
          <div class="sw-mode-btn-group">
            <button class="sw-mode-btn ${sched.mode === 'timeline' ? 'active' : ''}" data-mode="timeline">
              ⏱ タイムライン方式
            </button>
            <button class="sw-mode-btn ${sched.mode === 'alternate' ? 'active' : ''}" data-mode="alternate">
              🔁 列車毎に交互切替
            </button>
            <button class="sw-mode-btn ${sched.mode === 'manual' ? 'active' : ''}" data-mode="manual">
              ✋ 手動切替のみ
            </button>
          </div>
        </div>

        <div style="font-size:12px; color:#94a3b8; margin-bottom:8px; line-height:1.5;">
          💡 <b>基本は「直進方向」です。</b><br>
          下のカードから <b>「時間帯指定で分岐」</b> または <b>「パターンで分岐（毎時〇分～〇分）」</b> を追加すると、指定時間帯のみ自動で分岐側へ開通します。
        </div>

        <!-- 凡例 -->
        <div class="sw-legend">
          <div class="sw-legend-item">
            <div class="sw-legend-box" style="background: rgba(100, 116, 139, 0.4); border: 1px solid #64748b;"></div>
            <span>直進 (デフォルト)</span>
          </div>
          ${isScissors ? `
            <div class="sw-legend-item">
              <div class="sw-legend-box" style="background: rgba(56, 189, 248, 0.7); border: 1px solid #38bdf8;"></div>
              <span>交差A開通</span>
            </div>
            <div class="sw-legend-item">
              <div class="sw-legend-box" style="background: rgba(236, 72, 153, 0.7); border: 1px solid #ec4899;"></div>
              <span>交差B開通</span>
            </div>
          ` : `
            <div class="sw-legend-item">
              <div class="sw-legend-box" style="background: rgba(245, 158, 11, 0.7); border: 1px solid #f59e0b;"></div>
              <span>分岐開通</span>
            </div>
          `}
        </div>

        <!-- 24時間タイムラインルーラー -->
        <div class="sw-timeline-container">
          <div class="sw-tl-time-header">
            ${this.generateTimeHeader()}
          </div>
          <div class="sw-timeline-ruler" id="sw-tl-ruler">
            <div class="sw-default-label">DEFAULT: 直進 (STRAIGHT)</div>
            ${this.generateGridLines()}
            ${sched.mode === 'timeline' ? this.generateRuleZones(sched.rules, isScissors) : ''}
          </div>
        </div>

        <div style="font-size:14px; font-weight:bold; color:#e2e8f0; margin:16px 0 8px; display:flex; justify-content:space-between; align-items:center;">
          <span>分岐ダイヤ詳細設定カード</span>
          <span style="font-size:11px; font-weight:normal; color:#94a3b8;">${sched.rules.length} 件の設定</span>
        </div>

        <div class="sw-cards-container">
          ${this.renderCards(sched, isScissors)}
        </div>
        
        <div class="btn-add-sw-card" id="btn-add-sw-rule">＋ 新しい分岐設定を追加</div>
      </div>
    `;

    this.container.querySelector('.sw-close-btn')!.addEventListener('click', () => this.close());
    this.attachEvents(sched, isScissors);
  }

  /** タイムライン上部の2時間とび時刻ラベルヘッダー (0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24) */
  private generateTimeHeader(): string {
    let html = '';
    for (let h = 0; h <= 24; h += 2) {
      const leftPct = (h / 24) * 100;
      html += `<div class="sw-tl-time-label" style="left:${leftPct}%;"><span>${h}</span></div>`;
    }
    return html;
  }

  /** ルーラー内部の1時間ごと縦目盛り線（偶数時: 実線 / 奇数時: 破線補助線） */
  private generateGridLines(): string {
    let html = '';
    for (let h = 0; h < 24; h++) {
      const leftPct = (h / 24) * 100;
      const isMajor = h % 2 === 0;
      const cls = isMajor ? 'sw-tl-grid-line major' : 'sw-tl-grid-line minor';
      html += `<div class="${cls}" style="left:${leftPct}%;"></div>`;
    }
    // 終端 24:00 目盛り線
    html += `<div class="sw-tl-grid-line major" style="left:100%;"></div>`;
    return html;
  }

  /**
   * タイムライン上に各ルールの分岐開通時間帯をゾーンとして描画する
   */
  private generateRuleZones(rules: SwitchTimeZoneRule[], isScissors: boolean): string {
    let html = '';

    for (const rule of rules) {
      let zoneClass = 'sw-tl-zone-diverge';
      let label = '分岐';

      if (isScissors) {
        if (rule.targetState === 'cross-b') {
          zoneClass = 'sw-tl-zone-cross-b';
          label = '交差B';
        } else {
          zoneClass = 'sw-tl-zone-cross-a';
          label = '交差A';
        }
      }

      if (rule.type === 'time_range') {
        // 時間帯指定で分岐
        if (rule.startMin <= rule.endMin) {
          const leftPct = (rule.startMin / 1440) * 100;
          const widthPct = Math.max(0.4, ((rule.endMin - rule.startMin) / 1440) * 100);
          html += `<div class="sw-tl-zone ${zoneClass}" style="left:${leftPct}%; width:${widthPct}%;" title="${this.formatTime(rule.startMin)}～${this.formatTime(rule.endMin)}: ${label}"><span>${label}</span></div>`;
        } else {
          // 日またぎ
          const leftPct1 = (rule.startMin / 1440) * 100;
          const widthPct1 = ((1440 - rule.startMin) / 1440) * 100;
          const leftPct2 = 0;
          const widthPct2 = (rule.endMin / 1440) * 100;
          html += `<div class="sw-tl-zone ${zoneClass}" style="left:${leftPct1}%; width:${widthPct1}%;" title="${this.formatTime(rule.startMin)}～${this.formatTime(rule.endMin)}: ${label}"><span>${label}</span></div>`;
          html += `<div class="sw-tl-zone ${zoneClass}" style="left:${leftPct2}%; width:${widthPct2}%;" title="${this.formatTime(rule.startMin)}～${this.formatTime(rule.endMin)}: ${label}"><span>${label}</span></div>`;
        }
      } else if (rule.type === 'pattern') {
        // パターンで分岐（適用時間帯内で毎時指定分を開通）
        const patStart = Math.min(rule.startPatternMin ?? 0, 59);
        const patEnd = Math.min(rule.endPatternMin ?? 10, 59);
        const span = patStart <= patEnd ? (patEnd - patStart) : (60 - patStart + patEnd);

        // 24時間各時をチェック
        for (let h = 0; h < 24; h++) {
          const hourBase = h * 60;
          const zoneStartMin = hourBase + patStart;

          // 適用時間帯に入っているか確認（簡易判定: 開始点または終了点が含まれるか）
          const isStartInSpan = this.isMinuteInZone(hourBase + patStart, rule.startMin, rule.endMin);
          const isEndInSpan = this.isMinuteInZone(hourBase + ((patEnd === 0 ? 59 : patEnd)), rule.startMin, rule.endMin);

          if (isStartInSpan || isEndInSpan) {
            const leftPct = ((zoneStartMin % 1440) / 1440) * 100;
            const widthPct = Math.max(0.4, (span / 1440) * 100);
            html += `<div class="sw-tl-zone ${zoneClass}" style="left:${leftPct}%; width:${widthPct}%;" title="${this.formatTime(rule.startMin)}～${this.formatTime(rule.endMin)} (毎時${patStart}～${patEnd}分): ${label}"><span>${label}</span></div>`;
          }
        }
      }
    }

    return html;
  }

  private isMinuteInZone(minute: number, startMin: number, endMin: number): boolean {
    const m = ((minute % 1440) + 1440) % 1440;
    if (startMin <= endMin) {
      return m >= startMin && m <= endMin;
    } else {
      return m >= startMin || m <= endMin;
    }
  }

  private renderCards(sched: SwitchSchedule, isScissors: boolean): string {
    if (!sched.rules || sched.rules.length === 0) {
      return `
        <div style="background:rgba(255,255,255,0.03); border:1px dashed rgba(255,255,255,0.2); border-radius:8px; padding:20px; text-align:center; color:#94a3b8;">
          現在設定されている分岐ルールはありません（常時直進）。<br>
          下の「＋ 新しい分岐設定を追加」ボタンからルールを追加してください。
        </div>
      `;
    }

    return sched.rules.map((rule, idx) => {
      const isPattern = rule.type === 'pattern';
      const patStart = rule.startPatternMin ?? 0;
      const patEnd = rule.endPatternMin ?? 10;
      const targetState = rule.targetState || (isScissors ? 'cross-a' : 'diverge');

      return `
        <div class="sw-detail-card" data-idx="${idx}">
          <div class="sw-card-header">
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <select class="sw-type-sel" data-idx="${idx}">
                <option value="time_range" ${!isPattern ? 'selected' : ''}>🔀 時間帯指定で分岐</option>
                <option value="pattern" ${isPattern ? 'selected' : ''}>🔁 パターンで分岐</option>
              </select>

              ${isScissors ? `
                <select class="sw-target-sel" data-idx="${idx}">
                  <option value="cross-a" ${targetState === 'cross-a' ? 'selected' : ''}>開通: 交差A (左上↔右下)</option>
                  <option value="cross-b" ${targetState === 'cross-b' ? 'selected' : ''}>開通: 交差B (右上↔左下)</option>
                </select>
              ` : ''}
            </div>

            <div class="sw-card-actions">
              <button class="sw-btn-copy" data-idx="${idx}" title="この設定を複製">📋 複製</button>
              <button class="sw-btn-del" data-idx="${idx}" title="削除">🗑 削除</button>
            </div>
          </div>

          <!-- 入力部 -->
          <div class="sw-inputs-row">
            <span style="color:#cbd5e1; font-weight:bold;">${isPattern ? '適用時間帯:' : '分岐時間帯:'}</span>
            <input type="time" class="sw-start-time" data-idx="${idx}" value="${this.formatTime(rule.startMin)}">
            <span style="color:#94a3b8;">～</span>
            <input type="time" class="sw-end-time" data-idx="${idx}" value="${this.formatTime(rule.endMin)}">

            ${isPattern ? `
              <div style="display:inline-flex; align-items:center; gap:6px; margin-left:8px; padding-left:10px; border-left:1px solid rgba(255,255,255,0.2);">
                <span style="color:#fbbf24; font-weight:bold;">毎時:</span>
                <input type="number" class="sw-pat-start" data-idx="${idx}" min="0" max="59" value="${patStart}" style="width:50px;">
                <span style="color:#94a3b8;">分 ～</span>
                <input type="number" class="sw-pat-end" data-idx="${idx}" min="0" max="59" value="${patEnd}" style="width:50px;">
                <span style="color:#94a3b8;">分 に開通</span>
              </div>
            ` : `
              <span style="color:#94a3b8; font-size:12px; margin-left:6px;">の間は分岐側へ開通</span>
            `}
          </div>
        </div>
      `;
    }).join('');
  }

  private attachEvents(sched: SwitchSchedule, isScissors: boolean): void {
    // 動作モード切り替えボタン
    this.container.querySelectorAll<HTMLButtonElement>('.sw-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-mode') as 'timeline' | 'alternate' | 'manual';
        if (mode && sched.mode !== mode) {
          sched.mode = mode;
          this.notifyChanged();
        }
      });
    });

    // 新規カード追加ボタン
    const addBtn = this.container.querySelector('#btn-add-sw-rule');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const newRule: SwitchTimeZoneRule = {
          id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'time_range',
          startMin: 8 * 60, // 08:00
          endMin: 10 * 60,  // 10:00
          targetState: isScissors ? 'cross-a' : 'diverge'
        };
        sched.rules.push(newRule);
        this.notifyChanged();
      });
    }

    // カード内の各種イベント
    this.container.querySelectorAll<HTMLElement>('.sw-detail-card').forEach(card => {
      const idx = parseInt(card.getAttribute('data-idx') || '0', 10);
      const rule = sched.rules[idx];
      if (!rule) return;

      // 種別切替 (time_range / pattern)
      const typeSel = card.querySelector<HTMLSelectElement>('.sw-type-sel');
      if (typeSel) {
        typeSel.addEventListener('change', () => {
          rule.type = typeSel.value as 'time_range' | 'pattern';
          if (rule.type === 'pattern') {
            if (rule.startPatternMin === undefined) rule.startPatternMin = 15;
            if (rule.endPatternMin === undefined) rule.endPatternMin = 25;
          }
          this.notifyChanged();
        });
      }

      // 開通方向切替 (シーサスクロッシング用)
      const targetSel = card.querySelector<HTMLSelectElement>('.sw-target-sel');
      if (targetSel) {
        targetSel.addEventListener('change', () => {
          rule.targetState = targetSel.value as 'cross-a' | 'cross-b';
          this.notifyChanged();
        });
      }

      // 複製ボタン
      const copyBtn = card.querySelector<HTMLButtonElement>('.sw-btn-copy');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          const clone: SwitchTimeZoneRule = {
            ...rule,
            id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
          };
          sched.rules.splice(idx + 1, 0, clone);
          this.notifyChanged();
        });
      }

      // 削除ボタン
      const delBtn = card.querySelector<HTMLButtonElement>('.sw-btn-del');
      if (delBtn) {
        delBtn.addEventListener('click', () => {
          sched.rules.splice(idx, 1);
          this.notifyChanged();
        });
      }

      // 開始時刻・終了時刻
      const startInput = card.querySelector<HTMLInputElement>('.sw-start-time');
      if (startInput) {
        startInput.addEventListener('change', () => {
          rule.startMin = this.parseTime(startInput.value);
          this.notifyChanged();
        });
      }

      const endInput = card.querySelector<HTMLInputElement>('.sw-end-time');
      if (endInput) {
        endInput.addEventListener('change', () => {
          rule.endMin = this.parseTime(endInput.value);
          this.notifyChanged();
        });
      }

      // パターン開始分・終了分
      const patStartInput = card.querySelector<HTMLInputElement>('.sw-pat-start');
      if (patStartInput) {
        patStartInput.addEventListener('change', () => {
          let val = parseInt(patStartInput.value, 10);
          if (isNaN(val)) val = 0;
          val = Math.max(0, Math.min(59, val));
          rule.startPatternMin = val;
          this.notifyChanged();
        });
      }

      const patEndInput = card.querySelector<HTMLInputElement>('.sw-pat-end');
      if (patEndInput) {
        patEndInput.addEventListener('change', () => {
          let val = parseInt(patEndInput.value, 10);
          if (isNaN(val)) val = 10;
          val = Math.max(0, Math.min(59, val));
          rule.endPatternMin = val;
          this.notifyChanged();
        });
      }
    });
  }
}
