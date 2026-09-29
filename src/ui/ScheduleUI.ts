import { WorldMap, TileData, StationSchedule, TimeZoneRule, createDefaultStationSchedule } from '../simulation/WorldMap';
import { GridLayer } from '../core/types';
import { getPatternDepartureMinutes } from '../core/ScheduleEngine';

export type DeviceMode = 'desktop' | 'mobile';

export class ScheduleUI {
  private container: HTMLDivElement;
  private currentTile: TileData | null = null;
  public onScheduleChanged: (tile: TileData) => void = () => {};


  constructor(private worldMap: WorldMap) {
    this.container = document.createElement('div');
    this.container.id = 'schedule-ui';
    this.container.className = 'schedule-ui hidden mode-desktop';
    document.body.appendChild(this.container);

    this.injectStyle();
  }

  private injectStyle(): void {
    if (document.getElementById('schedule-ui-style-v2')) return;
    const style = document.createElement('style');
    style.id = 'schedule-ui-style-v2';
    style.textContent = `
      .schedule-ui {
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
        border: 1px solid rgba(56, 189, 248, 0.4);
        border-radius: 12px;
        box-shadow: 0 20px 48px rgba(0, 0, 0, 0.8), 0 0 30px rgba(56, 189, 248, 0.15);
        color: var(--text-primary, #e2e8f0);
        display: flex;
        flex-direction: column;
        font-size: 13px;
        overflow: hidden;
      }
      .schedule-ui.hidden { display: none !important; }
      .schedule-ui.mode-desktop {
        /* 画面中央モーダル配置を維持 */
      }
      .sc-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 16px; flex-shrink: 0; border-bottom: 1px solid var(--border-panel, rgba(255,255,255,0.1));
      }
      .sc-header-title { font-size: 16px; font-weight: bold; color: #38bdf8; }
      .sc-close-btn { background: none; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; }
      .sc-close-btn:hover { color: #fff; }
      .sc-body { flex: 1; overflow-y: auto; padding: 12px 16px 24px; }
      
      .timeline-container {
        width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.55);
        border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 12px 14px 14px 14px; margin-bottom: 16px;
        user-select: none;
      }
      .tl-time-header {
        position: relative; width: 100%; height: 18px; margin-bottom: 6px;
      }
      .tl-time-label {
        position: absolute; top: 0; transform: translateX(-50%);
        font-size: 11px; font-weight: 700; color: #cbd5e1;
        pointer-events: none; line-height: 1; text-align: center;
      }
      .timeline-ruler {
        position: relative; width: 100%; box-sizing: border-box; height: 42px; background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.25); border-radius: 4px; cursor: crosshair;
      }
      .tl-grid-line {
        position: absolute; top: 0; height: 100%; pointer-events: none;
      }
      .tl-grid-line.major {
        border-left: 1px solid rgba(255,255,255,0.35);
      }
      .tl-grid-line.minor {
        border-left: 1px dashed rgba(255,255,255,0.12);
      }
      
      /* 発車ピン: 2pxのシャープな線状表示 */
      .tl-dep-pin {
        position: absolute; top: 0; transform: translateX(-50%);
        width: 2px; height: 100%; background: #facc15; z-index: 10;
        box-shadow: 0 0 4px rgba(250, 204, 21, 0.8); pointer-events: none;
      }
      .tl-dep-pin::before {
        content: ''; position: absolute; top: -4px; left: 50%; transform: translateX(-50%);
        width: 6px; height: 6px; background: #facc15; border-radius: 50%;
        box-shadow: 0 0 4px #facc15;
      }
      
      /* パターンダイヤピン: シアン色の線状表示 */
      .tl-dep-pin-pattern {
        position: absolute; top: 0; transform: translateX(-50%);
        width: 2px; height: 100%; background: #38bdf8; z-index: 9;
        box-shadow: 0 0 4px rgba(56, 189, 248, 0.8); pointer-events: none;
      }
      .tl-dep-pin-pattern::before {
        content: ''; position: absolute; top: -4px; left: 50%; transform: translateX(-50%);
        width: 6px; height: 6px; background: #38bdf8; border-radius: 1px;
        box-shadow: 0 0 4px #38bdf8;
      }

      /* 折り返し指定時のピンクハイライト */
      .tl-dep-pin-reverse {
        background: #ec4899 !important;
        box-shadow: 0 0 5px rgba(236, 72, 153, 0.9) !important;
      }
      .tl-dep-pin-reverse::before {
        background: #ec4899 !important;
        box-shadow: 0 0 4px #ec4899 !important;
      }

      .tl-zone {
        position: absolute; top: 0; height: 100%; display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: bold; color: white; z-index: 5;
        border-left: 2px solid rgba(255,255,255,0.6); border-right: 2px solid rgba(255,255,255,0.6);
        pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .tl-zone-pass { background: rgba(239, 68, 68, 0.45); }
      .tl-zone-stop { background: rgba(16, 185, 129, 0.45); }

      .sc-cards-container { display: flex; flex-direction: column; gap: 10px; }
      .sc-detail-card {
        background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(56, 189, 248, 0.3);
        border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 10px;
        transition: border-color 0.2s;
      }
      .sc-detail-card:hover { border-color: rgba(56, 189, 248, 0.6); }
      .sc-card-header {
        display: flex; justify-content: space-between; align-items: center;
        border-bottom: 1px dashed rgba(255, 255, 255, 0.15); padding-bottom: 8px;
        flex-wrap: wrap; gap: 8px;
      }
      .sc-type-sel {
        background: rgba(15, 23, 42, 0.8); border: 1px solid #0284c7; color: #fff;
        padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 13px; outline: none;
        cursor: pointer;
      }
      .sc-card-actions { display: flex; align-items: center; gap: 6px; }
      .sc-btn-reverse {
        background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.2);
        color: #94a3b8; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;
        font-weight: bold; transition: all 0.2s ease; display: inline-flex; align-items: center; gap: 4px;
      }
      .sc-btn-reverse:hover { background: rgba(56, 189, 248, 0.15); color: #fff; }
      .sc-btn-reverse.active {
        background: rgba(16, 185, 129, 0.25); border-color: #10b981; color: #34d399;
        box-shadow: 0 0 8px rgba(16, 185, 129, 0.4);
      }
      .sc-btn-split {
        background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.2);
        color: #94a3b8; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;
        font-weight: bold; transition: all 0.2s ease; display: inline-flex; align-items: center; gap: 4px;
      }
      .sc-btn-split:hover { background: rgba(245, 158, 11, 0.15); color: #fff; }
      .sc-btn-split.active {
        background: rgba(245, 158, 11, 0.25); border-color: #f59e0b; color: #fbbf24;
        box-shadow: 0 0 8px rgba(245, 158, 11, 0.4);
      }
      .sc-split-settings {
        margin-top: 8px; padding: 8px 10px; background: rgba(245, 158, 11, 0.1);
        border: 1px dashed rgba(245, 158, 11, 0.4); border-radius: 6px;
        display: flex; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap;
      }
      .sc-split-settings input[type="number"] {
        background: rgba(255, 255, 255, 0.12); border: 1px solid rgba(245, 158, 11, 0.5);
        color: #fff; padding: 3px 6px; border-radius: 4px; font-size: 13px; font-family: monospace;
        width: 48px; text-align: center;
      }
      .sc-split-settings label { color: #fbbf24; font-weight: bold; }
      .tl-dep-pin-split {
        border-right: 2px dashed #f59e0b !important;
      }
      .sc-btn-copy, .sc-btn-del {
        background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.2);
        color: #e2e8f0; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px;
      }
      .sc-btn-copy:hover { background: rgba(56, 189, 248, 0.2); border-color: #38bdf8; }
      .sc-btn-del:hover { background: rgba(244, 63, 94, 0.2); border-color: #f43f5e; color: #fff; }

      .sc-time-inputs { display: flex; align-items: center; gap: 8px; font-size: 13px; flex-wrap: wrap; }
      .sc-time-inputs input[type="time"], .sc-wait-input input[type="number"], .sc-pattern-input input[type="number"] {
        background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.3);
        color: #fff; padding: 4px 6px; border-radius: 4px; font-size: 14px; font-family: monospace;
      }
      .sc-time-inputs input[type="time"]:focus, .sc-wait-input input[type="number"]:focus, .sc-pattern-input input[type="number"]:focus {
        border-color: #38bdf8; outline: none; background: rgba(56, 189, 248, 0.1);
      }
      .sc-wait-input, .sc-pattern-input { display: flex; align-items: center; gap: 8px; font-size: 13px; }

      .btn-add-card {
        background: rgba(16, 185, 129, 0.15); border: 1px dashed rgba(16, 185, 129, 0.5);
        color: #6ee7b7; padding: 12px; border-radius: 8px; text-align: center;
        cursor: pointer; font-weight: bold; transition: background 0.2s; margin-top: 6px;
      }
      .btn-add-card:hover { background: rgba(16, 185, 129, 0.3); }
    `;
    document.head.appendChild(style);
  }

  public isOpen(): boolean { return !this.container.classList.contains('hidden'); }
  
  public close(): void {
    this.container.classList.add('hidden');
    this.currentTile = null;
  }

  public open(tile: TileData): void {
    if (!tile.stationSchedule) tile.stationSchedule = createDefaultStationSchedule();
    this.currentTile = tile;
    this.container.classList.remove('hidden');
    this.render();
  }

  public refreshOrClose(): void {
    if (!this.currentTile) return;
    const lyr = (this.currentTile.layer ?? 1) as GridLayer;
    const still = this.worldMap.getTile(this.currentTile.x, this.currentTile.z, lyr);
    if (!still) this.close();
    else { this.currentTile = still; this.render(); }
  }

  private notifyChanged(): void {
    if (this.currentTile) this.onScheduleChanged(this.currentTile);
    this.render();
  }

  private render(): void {
    if (!this.currentTile) return;
    const schedule = this.currentTile.stationSchedule!;
    schedule.departures = schedule.departures || [];
    schedule.timeZones = schedule.timeZones || [];
    schedule.reverseDepartures = schedule.reverseDepartures || [];
    schedule.splitDepartures = schedule.splitDepartures || [];

    this.container.innerHTML = `
      <div class="sc-header">
        <div class="sc-header-title">ダイヤ設定: ${this.currentTile.stationName || '駅'}</div>
        <button class="sc-close-btn">✕</button>
      </div>
      <div class="sc-body">
        <div style="font-size:12px; color:#94a3b8; margin-bottom:12px; line-height:1.5;">
          💡 <b>基本は「停車したまま（留置）」です。</b><br>
          タイムラインをクリック、または下部のカードから <b>発車(ピン)</b>、<b>パターンダイヤ(毎時〇分発車)</b>、<b>通過/停車(時間帯ゾーン)</b> を設定してください。
        </div>

        <div class="timeline-container">
          <div class="tl-time-header">
            ${this.generateTimeHeader()}
          </div>
          <div class="timeline-ruler" id="tl-ruler">
            ${this.generateGridLines()}
            ${this.generateZones(schedule.timeZones)}
            ${this.generateDepartures(schedule.departures, schedule.reverseDepartures, schedule.splitDepartures)}
          </div>
        </div>

        <div style="font-size:14px; font-weight:bold; color:#e2e8f0; margin:16px 0 8px;">ダイヤ詳細設定カード</div>
        <div class="sc-cards-container">
          ${this.renderCards(schedule)}
        </div>
        
        <div class="btn-add-card" id="btn-add-sched-card">＋ 新しいダイヤ設定を追加</div>
      </div>
    `;

    this.container.querySelector('.sc-close-btn')!.addEventListener('click', () => this.close());
    this.attachEvents(schedule);
  }

  /** タイムライン上部の2時間とび時刻ラベルヘッダー (0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24) */
  private generateTimeHeader(): string {
    let html = '';
    for (let h = 0; h <= 24; h += 2) {
      const leftPct = (h / 24) * 100;
      html += `<div class="tl-time-label" style="left:${leftPct}%;"><span>${h}</span></div>`;
    }
    return html;
  }

  /** ルーラー内部の1時間ごと縦目盛り線（偶数時: 実線 / 奇数時: 破線補助線） */
  private generateGridLines(): string {
    let html = '';
    for (let h = 0; h < 24; h++) {
      const leftPct = (h / 24) * 100;
      const isMajor = h % 2 === 0;
      const cls = isMajor ? 'tl-grid-line major' : 'tl-grid-line minor';
      html += `<div class="${cls}" style="left:${leftPct}%;"></div>`;
    }
    // 終端 24:00 目盛り線
    html += `<div class="tl-grid-line major" style="left:100%;"></div>`;
    return html;
  }

  private generateDepartures(deps: number[], reverseDeps: number[] = [], splitDeps: number[] = []): string {
    return deps.map(m => {
      const isRev = reverseDeps.includes(m);
      const isSplit = splitDeps.includes(m);
      const revClass = isRev ? ' tl-dep-pin-reverse' : '';
      const splitClass = isSplit ? ' tl-dep-pin-split' : '';
      const revTitle = isRev ? ' (折り返し)' : '';
      const splitTitle = isSplit ? ' [✂️分割]' : '';
      const leftPct = (m / 1440) * 100;
      return `
        <div class="tl-dep-pin${revClass}${splitClass}" style="left:${leftPct}%;" title="${this.formatTime(m)} 発車${revTitle}${splitTitle}"></div>
      `;
    }).join('');
  }

  private generateZones(zones: TimeZoneRule[]): string {
    let html = '';
    for (const z of zones) {
      const splitTitle = z.isSplit ? ` [✂️分割 ${z.splitFrontCars || 2}+${z.splitRearCars || 2}両]` : '';
      const splitLabel = z.isSplit ? ` [✂️${z.splitFrontCars || 2}+${z.splitRearCars || 2}]` : '';
      if (z.mode === 'pattern') {
        // パターンダイヤ: 設定された発車間隔・基準分に基づいてピンを描画
        const revClass = z.isReverse ? ' tl-dep-pin-reverse' : '';
        const revTitle = z.isReverse ? ' (折り返し)' : '';
        const interval = z.patternIntervalMinutes ?? 60;
        const intHours = Math.floor(interval / 60);
        const intMins = interval % 60;
        const intLabel = intHours > 0 && intMins > 0
          ? `${intHours}時間${intMins}分毎`
          : intHours > 0
          ? `${intHours}時間毎`
          : `${intMins}分毎`;

        const deps = getPatternDepartureMinutes(z);
        for (const m of deps) {
          const leftPct = (m / 1440) * 100;
          html += `<div class="tl-dep-pin-pattern${revClass}" style="left:${leftPct}%;" title="${this.formatTime(m)} パターン発車 (${intLabel})${revTitle}${splitTitle}"></div>`;
        }
      } else {
        // 通過 または 〇分停車: 時間帯の帯を描画
        const cls = z.mode === 'pass' ? 'tl-zone-pass' : 'tl-zone-stop';
        const label = z.mode === 'pass' ? '通過' : `${z.waitMinutes || 1}分停車`;
        const revLabel = z.isReverse ? ' [折]' : '';

        if (z.startMin <= z.endMin) {
          const leftPct = (z.startMin / 1440) * 100;
          const widthPct = Math.max(0.4, ((z.endMin - z.startMin) / 1440) * 100);
          html += `
            <div class="tl-zone ${cls}" style="left:${leftPct}%; width:${widthPct}%;" title="${this.formatTime(z.startMin)}～${this.formatTime(z.endMin)}: ${label}${revLabel}${splitTitle}">
              <span>${label}${revLabel}${splitLabel}</span>
            </div>
          `;
        } else {
          // 日またぎ (例: 22:00〜05:00)
          const leftPct1 = (z.startMin / 1440) * 100;
          const widthPct1 = ((1440 - z.startMin) / 1440) * 100;
          const leftPct2 = 0;
          const widthPct2 = (z.endMin / 1440) * 100;
          html += `
            <div class="tl-zone ${cls}" style="left:${leftPct1}%; width:${widthPct1}%;" title="${this.formatTime(z.startMin)}～${this.formatTime(z.endMin)}: ${label}${revLabel}${splitTitle}">
              <span>${label}${revLabel}${splitLabel}</span>
            </div>
            <div class="tl-zone ${cls}" style="left:${leftPct2}%; width:${widthPct2}%;" title="${this.formatTime(z.startMin)}～${this.formatTime(z.endMin)}: ${label}${revLabel}${splitTitle}">
              <span>${label}${revLabel}${splitLabel}</span>
            </div>
          `;
        }
      }
    }
    return html;
  }

  private formatTime(minutes: number): string {
    const clamped = Math.max(0, Math.min(1439, minutes));
    const h = Math.floor(clamped / 60);
    const m = clamped % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  private renderCards(schedule: StationSchedule): string {
    schedule.reverseDepartures = schedule.reverseDepartures || [];
    schedule.splitDepartures = schedule.splitDepartures || [];
    // タイムライン順（時刻順）に並べるための統合配列を作成
    const items: Array<{ type: 'dep'|'zone', min: number, origIdx: number, data: TimeZoneRule | null }> = [];
    
    schedule.departures.forEach((min, idx) => {
      items.push({ type: 'dep', min, origIdx: idx, data: null });
    });
    schedule.timeZones.forEach((z) => {
      items.push({ type: 'zone', min: z.startMin, origIdx: -1, data: z });
    });

    // 時刻順にソート
    items.sort((a, b) => a.min - b.min);

    let html = '';
    items.forEach((item, displayOrder) => {
      if (item.type === 'dep') {
        const isRev = schedule.reverseDepartures!.includes(item.min);
        const isSplit = schedule.splitDepartures!.includes(item.min);
        const fCars = schedule.splitConfig?.frontCars ?? 2;
        const rCars = schedule.splitConfig?.rearCars ?? 2;
        const rRev = !!schedule.splitConfig?.rearReverses;
        html += this.buildCardHtml('dep', item.origIdx, null, item.min, 0, 'dep', 0, 0, 60, isRev, displayOrder + 1, isSplit, fCars, rCars, rRev);
      } else if (item.data) {
        html += this.buildCardHtml(
          'zone',
          -1,
          item.data.id,
          item.data.startMin,
          item.data.endMin,
          item.data.mode,
          item.data.waitMinutes || 2,
          item.data.patternMinute ?? 0,
          item.data.patternIntervalMinutes ?? 60,
          !!item.data.isReverse,
          displayOrder + 1,
          !!item.data.isSplit,
          item.data.splitFrontCars ?? 2,
          item.data.splitRearCars ?? 2,
          !!item.data.splitRearReverses
        );
      }
    });

    if (items.length === 0) {
      html = `<div style="text-align:center; color:#94a3b8; padding:16px;">設定されたダイヤがありません。</div>`;
    }

    return html;
  }

  private buildCardHtml(
    dataType: 'dep' | 'zone',
    origIdx: number,
    id: string | null,
    startMin: number,
    endMin: number,
    mode: 'dep' | 'pass' | 'stop' | 'pattern',
    waitMinutes: number,
    patternMinute: number,
    patternIntervalMinutes: number,
    isReverse: boolean,
    order: number,
    isSplit: boolean = false,
    splitFrontCars: number = 2,
    splitRearCars: number = 2,
    splitRearReverses: boolean = false
  ): string {
    const dataAttr = dataType === 'dep' ? `data-type="dep" data-index="${origIdx}"` : `data-type="zone" data-id="${id}"`;
    const intervalHours = Math.floor((patternIntervalMinutes || 60) / 60);
    const intervalMins = (patternIntervalMinutes || 60) % 60;

    return `
      <div class="sc-detail-card" ${dataAttr}>
        <div class="sc-card-header">
          <select class="sc-type-sel">
            <option value="dep" ${mode === 'dep' ? 'selected' : ''}>${order}. 📍発車時刻指定 (ピン)</option>
            <option value="pattern" ${mode === 'pattern' ? 'selected' : ''}>${order}. 🔁パターンダイヤ (発車間隔指定)</option>
            <option value="stop" ${mode === 'stop' ? 'selected' : ''}>${order}. ⏹停車時間指定 (時間帯)</option>
            <option value="pass" ${mode === 'pass' ? 'selected' : ''}>${order}. ⏩本線通過 (時間帯)</option>
          </select>
          <div class="sc-card-actions">
            <button class="sc-btn-reverse ${isReverse ? 'active' : ''}" title="この発車時刻・時間帯で発車時に進行方向を折り返します">
              🔄 折り返し: ${isReverse ? 'ON' : 'OFF'}
            </button>
            <button class="sc-btn-split ${isSplit ? 'active' : ''}" title="この発車・停車時に列車を前後に分割（切り離し）します">
              ✂️ 分割: ${isSplit ? 'ON' : 'OFF'}
            </button>
            <button class="sc-btn-copy">コピー</button>
            <button class="sc-btn-del">削除</button>
          </div>
        </div>
        <div class="sc-card-body">
          <div class="sc-time-inputs">
            <label>時刻:</label>
            <input type="time" class="sc-time-start" value="${this.formatTime(startMin)}">
            ${dataType === 'zone' ? `
              <span style="color:#94a3b8; margin:0 4px;">～</span>
              <input type="time" class="sc-time-end" value="${this.formatTime(endMin)}">
            ` : ''}
          </div>
          ${mode === 'stop' ? `
            <div class="sc-wait-input" style="margin-top:10px;">
              <label>停車時間:</label>
              <input type="number" class="sc-wait-val" min="1" max="60" value="${waitMinutes}"> 分
            </div>
          ` : ''}
          ${mode === 'pattern' ? `
            <div class="sc-pattern-input" style="margin-top:10px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:13px;">
              <label style="color:#cbd5e1; font-weight:bold;">発車間隔:</label>
              <input type="number" class="sc-pattern-hours" min="0" max="23" value="${intervalHours}" style="width:45px; text-align:center;"> 時間
              <input type="number" class="sc-pattern-mins" min="0" max="59" value="${intervalMins}" style="width:45px; text-align:center;"> 分毎
              <span style="color:#94a3b8; margin-left:6px;">(基準: 毎時</span>
              <input type="number" class="sc-pattern-val" min="0" max="59" value="${patternMinute}" style="width:45px; text-align:center;">
              <span style="color:#94a3b8;">分発)</span>
            </div>
          ` : ''}
          ${isSplit ? `
            <div class="sc-split-settings">
              <label>✂️ 分割設定:</label>
              <span style="color:#cbd5e1; font-weight:bold;">対象編成:</span>
              <select class="sc-split-total-cars" style="background:rgba(15,23,42,0.85); border:1px solid #f59e0b; color:#fff; border-radius:4px; padding:2px 6px; font-size:12px; font-weight:bold; cursor:pointer;">
                ${[2,3,4,5,6,7,8,9,10].map(c => `<option value="${c}" ${c === (splitFrontCars + splitRearCars) ? 'selected' : ''}>${c}両編成</option>`).join('')}
              </select>
              <span style="color:#94a3b8; margin:0 2px;">➔</span>
              <span style="color:#e2e8f0;">前</span>
              <input type="number" class="sc-split-front" min="1" max="${Math.max(1, (splitFrontCars + splitRearCars) - 1)}" value="${splitFrontCars}">
              <span style="color:#e2e8f0;">両 ＋ 後 <b class="sc-split-rear-val" style="color:#fbbf24; font-size:13px; font-family:monospace; padding:0 3px;">${splitRearCars}</b> 両</span>
              <span style="color:#94a3b8; font-size:11px;">(計 ${splitFrontCars + splitRearCars}両)</span>
              <label style="margin-left:8px; cursor:pointer; display:inline-flex; align-items:center; gap:4px; font-weight:normal; color:#cbd5e1;">
                <input type="checkbox" class="sc-split-rear-rev" ${splitRearReverses ? 'checked' : ''}>
                後編成を折り返し
              </label>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  private attachEvents(schedule: StationSchedule): void {
    const ruler = this.container.querySelector('#tl-ruler') as HTMLElement;

    // タイムラインをクリックして発車ピンを即座に追加（モーダル幅に100%連動）
    ruler.addEventListener('click', (e) => {
      const rect = ruler.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const minute = Math.min(1439, Math.floor(ratio * 1440));
      
      if (!schedule.departures.includes(minute)) {
        schedule.departures.push(minute);
        schedule.departures.sort((a, b) => a - b);
        this.notifyChanged();
      }
    });

    // 詳細カード内のイベント
    this.container.querySelectorAll('.sc-detail-card').forEach(card => {
      const type = card.getAttribute('data-type');
      const origIdx = parseInt(card.getAttribute('data-index') || '-1');
      const origId = card.getAttribute('data-id');

      // 折り返しボタンのトグル
      card.querySelector('.sc-btn-reverse')?.addEventListener('click', () => {
        schedule.reverseDepartures = schedule.reverseDepartures || [];
        if (type === 'dep') {
          const min = schedule.departures[origIdx];
          const revIdx = schedule.reverseDepartures.indexOf(min);
          if (revIdx >= 0) {
            schedule.reverseDepartures.splice(revIdx, 1);
          } else {
            schedule.reverseDepartures.push(min);
          }
        } else {
          const zone = schedule.timeZones.find(z => z.id === origId);
          if (zone) {
            zone.isReverse = !zone.isReverse;
          }
        }
        this.notifyChanged();
      });

      // 分割ボタンのトグル
      card.querySelector('.sc-btn-split')?.addEventListener('click', () => {
        schedule.splitDepartures = schedule.splitDepartures || [];
        if (type === 'dep') {
          const min = schedule.departures[origIdx];
          const spIdx = schedule.splitDepartures.indexOf(min);
          if (spIdx >= 0) {
            schedule.splitDepartures.splice(spIdx, 1);
          } else {
            schedule.splitDepartures.push(min);
          }
          if (!schedule.splitConfig) {
            schedule.splitConfig = {
              enabled: true,
              frontCars: 2,
              rearCars: 2,
              frontDeparture: { mode: 'timer' },
              rearDeparture: { mode: 'timer' },
              rearReverses: false
            };
          } else {
            schedule.splitConfig.enabled = schedule.splitDepartures.length > 0;
          }
        } else {
          const zone = schedule.timeZones.find(z => z.id === origId);
          if (zone) {
            zone.isSplit = !zone.isSplit;
            if (zone.splitFrontCars === undefined) zone.splitFrontCars = 2;
            if (zone.splitRearCars === undefined) zone.splitRearCars = 2;
          }
        }
        this.notifyChanged();
      });

      // 分割設定: 対象編成両数セレクトの変更
      card.querySelector('.sc-split-total-cars')?.addEventListener('change', (e) => {
        const total = parseInt((e.target as HTMLSelectElement).value) || 4;
        const front = Math.max(1, Math.min(total - 1, Math.floor(total / 2)));
        const rear = total - front;

        if (type === 'dep') {
          if (!schedule.splitConfig) {
            schedule.splitConfig = { enabled: true, frontCars: front, rearCars: rear, frontDeparture: { mode: 'timer' }, rearDeparture: { mode: 'timer' }, rearReverses: false };
          } else {
            schedule.splitConfig.frontCars = front;
            schedule.splitConfig.rearCars = rear;
          }
        } else {
          const zone = schedule.timeZones.find(z => z.id === origId);
          if (zone) {
            zone.splitFrontCars = front;
            zone.splitRearCars = rear;
          }
        }
        this.notifyChanged();
      });

      // 分割設定: 前両数入力の変更（自動で後両数が連動して合計整合を保証）
      card.querySelector('.sc-split-front')?.addEventListener('change', (e) => {
        const totalSelect = card.querySelector<HTMLSelectElement>('.sc-split-total-cars');
        const total = parseInt(totalSelect?.value || '4') || 4;
        let front = parseInt((e.target as HTMLInputElement).value) || 1;
        front = Math.max(1, Math.min(total - 1, front));
        const rear = total - front;

        if (type === 'dep') {
          if (!schedule.splitConfig) {
            schedule.splitConfig = { enabled: true, frontCars: front, rearCars: rear, frontDeparture: { mode: 'timer' }, rearDeparture: { mode: 'timer' }, rearReverses: false };
          } else {
            schedule.splitConfig.frontCars = front;
            schedule.splitConfig.rearCars = rear;
          }
        } else {
          const zone = schedule.timeZones.find(z => z.id === origId);
          if (zone) {
            zone.splitFrontCars = front;
            zone.splitRearCars = rear;
          }
        }
        this.notifyChanged();
      });

      card.querySelector('.sc-split-rear-rev')?.addEventListener('change', (e) => {
        const checked = (e.target as HTMLInputElement).checked;
        if (type === 'dep') {
          if (!schedule.splitConfig) schedule.splitConfig = { enabled: true, frontCars: 2, rearCars: 2, frontDeparture: { mode: 'timer' }, rearDeparture: { mode: 'timer' }, rearReverses: false };
          schedule.splitConfig.rearReverses = checked;
        } else {
          const zone = schedule.timeZones.find(z => z.id === origId);
          if (zone) zone.splitRearReverses = checked;
        }
        this.notifyChanged();
      });

      // 種類（発車・パターン・停車・通過）の切り替え
      card.querySelector('.sc-type-sel')?.addEventListener('change', (e) => {
        const newMode = (e.target as HTMLSelectElement).value;
        schedule.reverseDepartures = schedule.reverseDepartures || [];
        schedule.splitDepartures = schedule.splitDepartures || [];

        if (type === 'dep') {
          const min = schedule.departures[origIdx];
          const wasReverse = schedule.reverseDepartures.includes(min);
          const wasSplit = schedule.splitDepartures.includes(min);
          schedule.departures.splice(origIdx, 1); // ピンから削除
          const revIdx = schedule.reverseDepartures.indexOf(min);
          if (revIdx >= 0) schedule.reverseDepartures.splice(revIdx, 1);
          const spIdx = schedule.splitDepartures.indexOf(min);
          if (spIdx >= 0) schedule.splitDepartures.splice(spIdx, 1);

          if (newMode === 'pass' || newMode === 'stop' || newMode === 'pattern') {
            schedule.timeZones.push({
              id: `z_${Date.now()}_${Math.floor(Math.random()*1000)}`,
              startMin: min,
              endMin: Math.min(1439, min + 60), // デフォルト1時間幅
              mode: newMode as 'pass' | 'stop' | 'pattern',
              waitMinutes: newMode === 'stop' ? 2 : undefined,
              patternMinute: newMode === 'pattern' ? min % 60 : undefined,
              patternIntervalMinutes: newMode === 'pattern' ? 60 : undefined,
              isReverse: wasReverse,
              isSplit: wasSplit,
              splitFrontCars: schedule.splitConfig?.frontCars ?? 2,
              splitRearCars: schedule.splitConfig?.rearCars ?? 2,
              splitRearReverses: !!schedule.splitConfig?.rearReverses
            });
          }
        } else {
          const zoneIdx = schedule.timeZones.findIndex(z => z.id === origId);
          if (zoneIdx === -1) return;
          const zone = schedule.timeZones[zoneIdx];
          if (newMode === 'dep') {
            const wasReverse = !!zone.isReverse;
            const wasSplit = !!zone.isSplit;
            schedule.timeZones.splice(zoneIdx, 1); // ゾーンから削除
            schedule.departures.push(zone.startMin);
            if (wasReverse && !schedule.reverseDepartures.includes(zone.startMin)) {
              schedule.reverseDepartures.push(zone.startMin);
            }
            if (wasSplit && !schedule.splitDepartures.includes(zone.startMin)) {
              schedule.splitDepartures.push(zone.startMin);
              if (!schedule.splitConfig) {
                schedule.splitConfig = {
                  enabled: true,
                  frontCars: zone.splitFrontCars ?? 2,
                  rearCars: zone.splitRearCars ?? 2,
                  frontDeparture: { mode: 'timer' },
                  rearDeparture: { mode: 'timer' },
                  rearReverses: !!zone.splitRearReverses
                };
              }
            }
          } else {
            zone.mode = newMode as 'pass' | 'stop' | 'pattern';
            if (newMode === 'stop' && !zone.waitMinutes) zone.waitMinutes = 2;
            if (newMode === 'pattern') {
              if (zone.patternMinute === undefined) zone.patternMinute = zone.startMin % 60;
              if (zone.patternIntervalMinutes === undefined) zone.patternIntervalMinutes = 60;
            }
          }
        }
        schedule.departures.sort((a,b)=>a-b);
        this.notifyChanged();
      });

      // 時刻の変更 (changeイベント)
      card.querySelector('.sc-time-start')?.addEventListener('change', (e) => {
        const val = (e.target as HTMLInputElement).value;
        if (!val) return;
        const [h, m] = val.split(':').map(Number);
        const mins = h * 60 + m;
        schedule.reverseDepartures = schedule.reverseDepartures || [];
        schedule.splitDepartures = schedule.splitDepartures || [];

        if (type === 'dep') {
          const oldMin = schedule.departures[origIdx];
          const wasRev = schedule.reverseDepartures.includes(oldMin);
          const wasSp = schedule.splitDepartures.includes(oldMin);
          schedule.departures[origIdx] = mins;
          if (wasRev) {
            schedule.reverseDepartures = schedule.reverseDepartures.filter(x => x !== oldMin);
            schedule.reverseDepartures.push(mins);
          }
          if (wasSp) {
            schedule.splitDepartures = schedule.splitDepartures.filter(x => x !== oldMin);
            schedule.splitDepartures.push(mins);
          }
          schedule.departures.sort((a,b)=>a-b);
        } else {
          const zone = schedule.timeZones.find(z => z.id === origId);
          if (zone) {
            zone.startMin = mins;
            if (zone.endMin <= zone.startMin) zone.endMin = Math.min(1439, zone.startMin + 60);
            if (zone.mode === 'pattern') {
              // 開始時刻を変更した際、開始基準時間に確実に列車が発車するよう基準分を開始時刻の分に自動連動
              zone.patternMinute = mins % 60;
            }
          }
        }
        this.notifyChanged();
      });

      const updateEndTime = (e: Event) => {
        const val = (e.target as HTMLInputElement).value;
        if (!val) return;
        const [h, m] = val.split(':').map(Number);
        let mins = h * 60 + m;
        const zone = schedule.timeZones.find(z => z.id === origId);
        if (zone) {
          // 00:00が入力され、開始が00:00以外の場合は終日(24:00 = 1440分)として扱う
          if (mins === 0 && zone.startMin > 0) {
            mins = 1440;
          }
          zone.endMin = mins;
          this.notifyChanged();
        }
      };
      card.querySelector('.sc-time-end')?.addEventListener('change', updateEndTime);

      // 停車時間変更
      const updateWait = (e: Event) => {
        const w = parseInt((e.target as HTMLInputElement).value) || 1;
        const zone = schedule.timeZones.find(z => z.id === origId);
        if (zone && zone.waitMinutes !== w) {
          zone.waitMinutes = w;
          this.notifyChanged();
        }
      };
      card.querySelector('.sc-wait-val')?.addEventListener('change', updateWait);

      // パターンダイヤ発車間隔（時間・分）および基準分の変更
      const hoursInput = card.querySelector<HTMLInputElement>('.sc-pattern-hours');
      const minsInput = card.querySelector<HTMLInputElement>('.sc-pattern-mins');
      const baseInput = card.querySelector<HTMLInputElement>('.sc-pattern-val');

      const updatePatternInterval = () => {
        const h = Math.max(0, Math.min(23, parseInt(hoursInput?.value || '0') || 0));
        const m = Math.max(0, Math.min(59, parseInt(minsInput?.value || '0') || 0));
        const totalInterval = Math.max(1, h * 60 + m); // 最低1分以上
        const base = Math.max(0, Math.min(59, parseInt(baseInput?.value || '0') || 0));

        const zone = schedule.timeZones.find(z => z.id === origId);
        if (zone) {
          zone.patternIntervalMinutes = totalInterval;
          zone.patternMinute = base;
          this.notifyChanged();
        }
      };

      hoursInput?.addEventListener('change', updatePatternInterval);
      minsInput?.addEventListener('change', updatePatternInterval);
      baseInput?.addEventListener('change', updatePatternInterval);

      // コピーボタン
      card.querySelector('.sc-btn-copy')?.addEventListener('click', () => {
        schedule.reverseDepartures = schedule.reverseDepartures || [];
        schedule.splitDepartures = schedule.splitDepartures || [];
        if (type === 'dep') {
          const oldMin = schedule.departures[origIdx];
          const isRev = schedule.reverseDepartures.includes(oldMin);
          const isSp = schedule.splitDepartures.includes(oldMin);
          const newMin = Math.min(1439, oldMin + 10);
          schedule.departures.push(newMin);
          if (isRev) schedule.reverseDepartures.push(newMin);
          if (isSp) schedule.splitDepartures.push(newMin);
          schedule.departures.sort((a,b)=>a-b);
        } else {
          const zone = schedule.timeZones.find(z => z.id === origId);
          if (zone) {
            schedule.timeZones.push({ ...zone, id: `z_${Date.now()}_${Math.floor(Math.random()*1000)}` });
          }
        }
        this.notifyChanged();
      });

      // 削除ボタン
      card.querySelector('.sc-btn-del')?.addEventListener('click', () => {
        schedule.reverseDepartures = schedule.reverseDepartures || [];
        schedule.splitDepartures = schedule.splitDepartures || [];
        if (type === 'dep') {
          const oldMin = schedule.departures[origIdx];
          schedule.departures.splice(origIdx, 1);
          schedule.reverseDepartures = schedule.reverseDepartures.filter(x => x !== oldMin);
          schedule.splitDepartures = schedule.splitDepartures.filter(x => x !== oldMin);
        } else {
          schedule.timeZones = schedule.timeZones.filter(z => z.id !== origId);
        }
        this.notifyChanged();
      });
    });

    // 新規カード追加ボタン
    this.container.querySelector('#btn-add-sched-card')?.addEventListener('click', () => {
      schedule.departures.push(360); // デフォルトで 06:00 (360分) の発車を追加
      schedule.departures.sort((a,b)=>a-b);
      this.notifyChanged();
      
      // スクロールを最下部へ移動
      setTimeout(() => {
        const list = this.container.querySelector('.sc-body');
        if (list) list.scrollTop = list.scrollHeight;
      }, 10);
    });
  }
}
