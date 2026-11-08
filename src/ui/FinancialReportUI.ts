import { FinancialReportData, FinancialSnapshot, Economy } from '../simulation/Economy';

/**
 * 財務・決算報告モーダルおよび Canvas 2D 経営推移チャートの描画・操作を担当するサブUIクラス
 */
export class FinancialReportUI {
  private reportBtn = document.getElementById('btn-report')!;
  private reportModal = document.getElementById('report-modal')!;
  private closeReportBtn = document.getElementById('btn-close-report')!;
  private reportTabBtns = document.querySelectorAll<HTMLButtonElement>('.report-tab-btn');
  private reportTabCurrent = document.getElementById('report-tab-current');
  private reportTabMonthly = document.getElementById('report-tab-monthly');
  private reportTabYearly = document.getElementById('report-tab-yearly');
  private monthlyChartCanvas = document.getElementById('monthly-chart-canvas') as HTMLCanvasElement | null;
  private monthlyChartTooltip = document.getElementById('monthly-chart-tooltip');
  private monthlyHistoryTbody = document.getElementById('monthly-history-tbody');
  private yearlyChartCanvas = document.getElementById('yearly-chart-canvas') as HTMLCanvasElement | null;
  private yearlyChartTooltip = document.getElementById('yearly-chart-tooltip');
  private yearlyHistoryTbody = document.getElementById('yearly-history-tbody');
  private activeReportTab: 'current' | 'monthly' | 'yearly' = 'current';

  private getFinancialReportData: () => FinancialReportData | undefined;
  private getEconomy: () => Economy | undefined;

  constructor(
    getFinancialReportData: () => FinancialReportData | undefined,
    getEconomy: () => Economy | undefined
  ) {
    this.getFinancialReportData = getFinancialReportData;
    this.getEconomy = getEconomy;
    this.bindEvents();
  }

  private bindEvents(): void {
    this.reportBtn?.addEventListener('click', () => {
      this.openFinancialReportModal();
    });
    this.closeReportBtn?.addEventListener('click', () => {
      this.reportModal?.classList.add('hidden');
    });

    // 財務モーダル タブ切り替え
    this.reportTabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab as 'current' | 'monthly' | 'yearly';
        if (tab) {
          this.switchReportTab(tab);
        }
      });
    });

    // 財務推移チャートのインタラクション（ホバー・ツールチップ）初期化
    this.initFinancialChartInteractions();

    // ウィンドウリサイズ時の財務チャート再描画
    window.addEventListener('resize', () => {
      if (this.reportModal && !this.reportModal.classList.contains('hidden')) {
        this.renderActiveReportTab();
      }
    });
  }

  public updateFinancialReport(rep: FinancialReportData): void {
    const fareElem = document.getElementById('rep-fare-income');
    if (fareElem) fareElem.textContent = '¥' + rep.fareIncome.toLocaleString();
    const cargoElem = document.getElementById('rep-cargo-income');
    if (cargoElem) cargoElem.textContent = '¥' + (rep.cargoIncome ?? 0).toLocaleString();
    const landElem = document.getElementById('rep-land-value');
    if (landElem) landElem.textContent = '¥' + rep.landValue.toLocaleString();
    const constElem = document.getElementById('rep-construction-cost');
    if (constElem) constElem.textContent = '-¥' + rep.constructionCost.toLocaleString();
    const maintElem = document.getElementById('rep-maintenance-cost');
    if (maintElem) maintElem.textContent = '-¥' + rep.maintenanceCost.toLocaleString();
    const depElem = document.getElementById('rep-depreciation-cost');
    if (depElem) depElem.textContent = '-¥' + (rep.depreciationCost ?? 0).toLocaleString();
    const bookElem = document.getElementById('rep-book-value');
    if (bookElem) bookElem.textContent = '¥' + (rep.bookValue ?? 0).toLocaleString();

    const netElem = document.getElementById('rep-net-profit');
    if (netElem) {
      netElem.textContent = (rep.netProfit >= 0 ? '+' : '') + '¥' + rep.netProfit.toLocaleString();
      netElem.className = rep.netProfit >= 0 ? 'positive' : 'negative';
    }

    const popElem = document.getElementById('rep-total-pop');
    if (popElem) popElem.textContent = rep.totalPopulation.toLocaleString() + '人';
    const trackElem = document.getElementById('rep-track-length');
    if (trackElem) trackElem.textContent = rep.trackLength + ' km';
    const trainElem = document.getElementById('rep-train-count');
    if (trainElem) trainElem.textContent = rep.trainCount + ' 編成';
    const stationElem = document.getElementById('rep-station-count');
    if (stationElem) stationElem.textContent = rep.stationCount + ' 駅';
  }

  /**
   * 財務・決算報告モーダルを開き、最新データを取得・反映
   */
  public openFinancialReportModal(): void {
    this.reportModal?.classList.remove('hidden');

    const data = this.getFinancialReportData();
    if (data) {
      this.updateFinancialReport(data);
    }

    // モーダル表示後のDOMレイアウト確定に合わせてチャートを描画
    requestAnimationFrame(() => {
      this.renderActiveReportTab();
    });
  }

  /**
   * 財務・決算報告モーダルを閉じる
   */
  public closeFinancialReportModal(): void {
    this.reportModal?.classList.add('hidden');
  }

  /**
   * 財務モーダルのタブ切り替え（今期決算 / 月次推移 / 年次推移）
   */
  public switchReportTab(tab: 'current' | 'monthly' | 'yearly'): void {
    this.activeReportTab = tab;

    this.reportTabBtns.forEach(btn => {
      if (btn.dataset.tab === tab) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    if (this.reportTabCurrent) {
      if (tab === 'current') {
        this.reportTabCurrent.classList.remove('hidden');
        this.reportTabCurrent.classList.add('active');
      } else {
        this.reportTabCurrent.classList.add('hidden');
        this.reportTabCurrent.classList.remove('active');
      }
    }

    if (this.reportTabMonthly) {
      if (tab === 'monthly') {
        this.reportTabMonthly.classList.remove('hidden');
        this.reportTabMonthly.classList.add('active');
      } else {
        this.reportTabMonthly.classList.add('hidden');
        this.reportTabMonthly.classList.remove('active');
      }
    }

    if (this.reportTabYearly) {
      if (tab === 'yearly') {
        this.reportTabYearly.classList.remove('hidden');
        this.reportTabYearly.classList.add('active');
      } else {
        this.reportTabYearly.classList.add('hidden');
        this.reportTabYearly.classList.remove('active');
      }
    }

    // 表示ペインのサイズ確定後にチャートを描画
    requestAnimationFrame(() => {
      this.renderActiveReportTab();
    });
  }

  /**
   * アクティブなタブに応じたチャート＆テーブル描画
   */
  public renderActiveReportTab(): void {
    const eco = this.getEconomy();
    if (!eco) return;

    if (this.activeReportTab === 'monthly') {
      const monthly = eco.getMonthlyHistory();
      if (this.monthlyChartCanvas && this.monthlyChartTooltip) {
        this.renderFinancialChart(this.monthlyChartCanvas, this.monthlyChartTooltip, monthly, false);
      }
      if (this.monthlyHistoryTbody) {
        this.renderFinancialHistoryTable(this.monthlyHistoryTbody, monthly, false);
      }
    } else if (this.activeReportTab === 'yearly') {
      const yearly = eco.getYearlyHistory();
      if (this.yearlyChartCanvas && this.yearlyChartTooltip) {
        this.renderFinancialChart(this.yearlyChartCanvas, this.yearlyChartTooltip, yearly, true);
      }
      if (this.yearlyHistoryTbody) {
        this.renderFinancialHistoryTable(this.yearlyHistoryTbody, yearly, true);
      }
    }
  }

  /**
   * 財務チャートのホバー・タップ・ツールチップのイベント設定
   */
  private initFinancialChartInteractions(): void {
    const setupCanvas = (
      canvas: HTMLCanvasElement | null,
      tooltip: HTMLElement | null,
      isYearly: boolean
    ) => {
      if (!canvas || !tooltip) return;

      const handleMove = (clientX: number, clientY: number) => {
        const eco = this.getEconomy();
        if (!eco) return;
        const history = isYearly ? eco.getYearlyHistory() : eco.getMonthlyHistory();
        if (history.length === 0) {
          tooltip.classList.add('hidden');
          return;
        }

        const rect = canvas.getBoundingClientRect();
        const mouseX = clientX - rect.left;
        const mouseY = clientY - rect.top;

        const padLeft = 70;
        const padRight = 60;
        const chartW = rect.width - padLeft - padRight;
        if (chartW <= 0) return;

        // 最寄りのデータ点インデックスを探索
        let closestIdx = 0;
        let minDiff = Infinity;
        for (let i = 0; i < history.length; i++) {
          const x = history.length === 1 ? padLeft + chartW / 2 : padLeft + (i / (history.length - 1)) * chartW;
          const diff = Math.abs(mouseX - x);
          if (diff < minDiff) {
            minDiff = diff;
            closestIdx = i;
          }
        }

        const d = history[closestIdx];
        if (!d) return;

        // ガイド線付きでチャートを更新
        this.renderFinancialChart(canvas, tooltip, history, isYearly);
        this.renderChartCursor(canvas, closestIdx, history);

        // ツールチップHTML生成
        const title = isYearly ? `${d.year}年度 決算` : `${d.year}年${d.month}月`;
        const netColor = d.netProfit >= 0 ? '#38bdf8' : '#ef4444';
        const netSign = d.netProfit >= 0 ? '+' : '';

        const cIncome = d.cargoIncome ?? 0;
        tooltip.innerHTML = `
          <div class="tooltip-title" style="font-weight:700; border-bottom:1px solid rgba(255,255,255,0.15); padding-bottom:4px; margin-bottom:6px;">${title}</div>
          <div class="tooltip-row" style="display:flex; justify-content:space-between; gap:12px; color:#10b981;"><span>旅客運賃:</span><span>¥${d.fareIncome.toLocaleString()}</span></div>
          <div class="tooltip-row" style="display:flex; justify-content:space-between; gap:12px; color:#f59e0b;"><span>貨物運賃:</span><span>¥${cIncome.toLocaleString()}</span></div>
          <div class="tooltip-row" style="display:flex; justify-content:space-between; gap:12px; color:#ef4444;"><span>維持管理費:</span><span>-¥${d.maintenanceCost.toLocaleString()}</span></div>
          <div class="tooltip-row" style="display:flex; justify-content:space-between; gap:12px; color:#f87171;"><span>建設投資費:</span><span>-¥${d.constructionCost.toLocaleString()}</span></div>
          ${d.taxAmount !== undefined && d.taxAmount > 0 ? `<div class="tooltip-row" style="display:flex; justify-content:space-between; gap:12px; color:#f87171;"><span>納税額:</span><span>-¥${d.taxAmount.toLocaleString()}</span></div>` : ''}
          <div class="tooltip-row" style="display:flex; justify-content:space-between; gap:12px; color:${netColor}; font-weight:700; margin-top:2px; border-top:1px dashed rgba(255,255,255,0.1); padding-top:2px;">
            <span>純利益:</span><span>${netSign}¥${d.netProfit.toLocaleString()}</span>
          </div>
          <div class="tooltip-divider" style="height:1px; background:rgba(255,255,255,0.1); margin:4px 0;"></div>
          <div class="tooltip-row" style="display:flex; justify-content:space-between; gap:12px; color:#c084fc;"><span>総人口:</span><span>${d.population.toLocaleString()}人</span></div>
          <div class="tooltip-row" style="display:flex; justify-content:space-between; gap:12px; color:#94a3b8; font-size:10px;"><span>路線規模:</span><span>${d.trackLength}km / ${d.stationCount}駅 / ${d.trainCount}編成</span></div>
        `;

        tooltip.classList.remove('hidden');

        // ツールチップ位置決め（Canvas領域内からはみ出さないよう調整）
        let tipX = mouseX + 14;
        let tipY = mouseY - 10;
        const tipW = tooltip.offsetWidth || 190;
        const tipH = tooltip.offsetHeight || 150;

        if (tipX + tipW > rect.width) {
          tipX = mouseX - tipW - 14;
        }
        if (tipY + tipH > rect.height) {
          tipY = rect.height - tipH - 6;
        }
        if (tipY < 6) tipY = 6;

        tooltip.style.left = `${Math.max(6, tipX)}px`;
        tooltip.style.top = `${tipY}px`;
      };

      const handleLeave = () => {
        tooltip.classList.add('hidden');
        const eco = this.getEconomy();
        if (!eco) return;
        const history = isYearly ? eco.getYearlyHistory() : eco.getMonthlyHistory();
        this.renderFinancialChart(canvas, tooltip, history, isYearly);
      };

      canvas.addEventListener('mousemove', (e) => handleMove(e.clientX, e.clientY));
      canvas.addEventListener('mouseleave', handleLeave);

      canvas.addEventListener('touchmove', (e) => {
        if (e.touches.length > 0) {
          handleMove(e.touches[0].clientX, e.touches[0].clientY);
        }
      }, { passive: true });
      canvas.addEventListener('touchend', handleLeave);
    };

    setupCanvas(this.monthlyChartCanvas, this.monthlyChartTooltip, false);
    setupCanvas(this.yearlyChartCanvas, this.yearlyChartTooltip, true);
  }

  /**
   * ゼロ依存 Canvas 2D API による財務・経営推移チャートの描画
   */
  private renderFinancialChart(
    canvas: HTMLCanvasElement,
    _tooltipEl: HTMLElement,
    history: FinancialSnapshot[],
    isYearly: boolean
  ): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // HiDPI解像度対応
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width > 0 ? rect.width : 680;
    const height = rect.height > 0 ? rect.height : 250;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    if (history.length === 0) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const msg = isYearly
        ? '年次決算データがまだありません（毎年3月31日 決算時に自動記録されます）'
        : '月次推移データがまだありません（毎月末の集計時に自動記録されます）';
      ctx.fillText(msg, width / 2, height / 2);
      ctx.restore();
      return;
    }

    // チャート表示領域マージン
    const padLeft = 70;
    const padRight = 60;
    const padTop = 25;
    const padBottom = 35;
    const chartW = width - padLeft - padRight;
    const chartH = height - padTop - padBottom;

    if (chartW <= 0 || chartH <= 0) {
      ctx.restore();
      return;
    }

    // 1. 金額レンジおよび人口レンジの計算
    let minFin = 0;
    let maxFin = 0;
    let maxPop = 0;

    for (const item of history) {
      const cInc = item.cargoIncome ?? 0;
      minFin = Math.min(minFin, item.fareIncome, cInc, item.maintenanceCost, item.netProfit);
      maxFin = Math.max(maxFin, item.fareIncome, cInc, item.maintenanceCost, item.netProfit);
      maxPop = Math.max(maxPop, item.population);
    }

    // 0ラインが必ず含まれるようにマージンを設定
    if (maxFin === 0 && minFin === 0) {
      maxFin = 1000000;
      minFin = -500000;
    } else {
      const range = maxFin - minFin;
      const margin = Math.max(range * 0.12, 100000);
      maxFin += margin;
      if (minFin < 0) {
        minFin -= margin;
      }
    }

    if (maxPop <= 0) {
      maxPop = 100;
    } else {
      maxPop = Math.ceil(maxPop * 1.25);
    }

    // 座標計算関数
    const getYFin = (val: number): number => {
      const ratio = (val - minFin) / (maxFin - minFin);
      return padTop + chartH - ratio * chartH;
    };

    const getYPop = (pop: number): number => {
      const ratio = pop / maxPop;
      return padTop + chartH - ratio * chartH;
    };

    const getX = (idx: number): number => {
      if (history.length === 1) return padLeft + chartW / 2;
      return padLeft + (idx / (history.length - 1)) * chartW;
    };

    // 2. 背景水平グリッド線および軸ラベル
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const val = minFin + ((maxFin - minFin) * i) / yTicks;
      const y = getYFin(val);

      // グリッド線
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
      ctx.lineWidth = 1;
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + chartW, y);
      ctx.stroke();

      // 金額ラベル（左Y軸）
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.formatMoneyShort(val), padLeft - 8, y);

      // 人口ラベル（右Y軸）
      const popVal = Math.round((maxPop * i) / yTicks);
      ctx.fillStyle = '#c084fc';
      ctx.textAlign = 'left';
      ctx.fillText(this.formatPopShort(popVal), padLeft + chartW + 8, y);
    }

    // 3. ゼロライン基準線
    if (minFin <= 0 && maxFin >= 0) {
      const y0 = getYFin(0);
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 1.5;
      ctx.moveTo(padLeft, y0);
      ctx.lineTo(padLeft + chartW, y0);
      ctx.stroke();
    }

    // 4. X軸目盛りラベル（年月・年度）
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const maxLabels = Math.min(history.length, width < 500 ? 6 : 12);
    const step = Math.ceil(history.length / maxLabels);

    for (let i = 0; i < history.length; i++) {
      if (i % step === 0 || i === history.length - 1) {
        const x = getX(i);
        const item = history[i];
        const label = isYearly
          ? `${item.year}年度`
          : `${item.year.toString().slice(-2)}/${item.month < 10 ? '0' + item.month : item.month}`;
        ctx.fillText(label, x, padTop + chartH + 8);
      }
    }

    // 5. 各データ系列の折れ線描画
    const drawSeries = (
      color: string,
      lineWidth: number,
      dash: number[],
      valGetter: (d: FinancialSnapshot) => number,
      yCalc: (v: number) => number,
      pointRadius: number
    ) => {
      ctx.save();
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash(dash);

      for (let i = 0; i < history.length; i++) {
        const x = getX(i);
        const y = yCalc(valGetter(history[i]));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // データ点マーカー
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      for (let i = 0; i < history.length; i++) {
        const x = getX(i);
        const y = yCalc(valGetter(history[i]));
        ctx.beginPath();
        ctx.arc(x, y, pointRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#0f172a';
        ctx.stroke();
      }
      ctx.restore();
    };

    // 人口（紫破線・右軸）
    drawSeries('#a855f7', 2, [4, 4], d => d.population, getYPop, 3);
    // 旅客運賃（緑実線）
    drawSeries('#10b981', 2.5, [], d => d.fareIncome, getYFin, 3.5);
    // 貨物運賃（アンバー実線）
    drawSeries('#f59e0b', 2, [], d => d.cargoIncome ?? 0, getYFin, 3);
    // 維持管理費（赤実線）
    drawSeries('#ef4444', 2.5, [], d => d.maintenanceCost, getYFin, 3.5);
    // 純利益（青実線）
    drawSeries('#38bdf8', 2.5, [], d => d.netProfit, getYFin, 3.5);

    ctx.restore();
  }

  /**
   * チャートホバー時の垂直カーソル線描画
   */
  private renderChartCursor(
    canvas: HTMLCanvasElement,
    highlightIdx: number,
    history: FinancialSnapshot[]
  ): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width > 0 ? rect.width : 680;
    const height = rect.height > 0 ? rect.height : 250;

    const padLeft = 70;
    const padRight = 60;
    const padTop = 25;
    const padBottom = 35;
    const chartW = width - padLeft - padRight;
    const chartH = height - padTop - padBottom;

    const getX = (idx: number): number => {
      if (history.length === 1) return padLeft + chartW / 2;
      return padLeft + (idx / (history.length - 1)) * chartW;
    };

    const x = getX(highlightIdx);

    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + chartH);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * 財務履歴テーブルの動的生成
   */
  private renderFinancialHistoryTable(
    tbody: HTMLElement,
    history: FinancialSnapshot[],
    isYearly: boolean
  ): void {
    tbody.innerHTML = '';

    if (history.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="8" class="empty-cell">履歴データがまだありません</td>`;
      tbody.appendChild(tr);
      return;
    }

    // 最新月/年度が上に来るよう降順に反転
    const reversed = [...history].reverse();

    for (const snap of reversed) {
      const tr = document.createElement('tr');
      const netClass = snap.netProfit >= 0 ? 'val-pos' : 'val-neg';
      const netSign = snap.netProfit >= 0 ? '+' : '';
      const cIncome = snap.cargoIncome ?? 0;

      if (isYearly) {
        tr.innerHTML = `
          <td><strong>${snap.year}年度</strong></td>
          <td class="val-num val-pos">¥${snap.fareIncome.toLocaleString()}</td>
          <td class="val-num" style="color:#fbbf24;">¥${cIncome.toLocaleString()}</td>
          <td class="val-num val-neg">-¥${snap.maintenanceCost.toLocaleString()}</td>
          <td class="val-num val-neg">-¥${snap.constructionCost.toLocaleString()}</td>
          <td class="val-num val-neg">${snap.taxAmount !== undefined && snap.taxAmount > 0 ? `-¥${snap.taxAmount.toLocaleString()}` : '¥0'}</td>
          <td class="val-num ${netClass}"><strong>${netSign}¥${snap.netProfit.toLocaleString()}</strong></td>
          <td class="val-num">${snap.population.toLocaleString()}人</td>
        `;
      } else {
        tr.innerHTML = `
          <td><strong>${snap.year}年${snap.month}月</strong></td>
          <td class="val-num val-pos">¥${snap.fareIncome.toLocaleString()}</td>
          <td class="val-num" style="color:#fbbf24;">¥${cIncome.toLocaleString()}</td>
          <td class="val-num val-neg">-¥${snap.maintenanceCost.toLocaleString()}</td>
          <td class="val-num val-neg">-¥${snap.constructionCost.toLocaleString()}</td>
          <td class="val-num ${netClass}"><strong>${netSign}¥${snap.netProfit.toLocaleString()}</strong></td>
          <td class="val-num">${snap.population.toLocaleString()}人</td>
          <td class="val-num">${snap.trackLength}km / ${snap.stationCount}駅 / ${snap.trainCount}編成</td>
        `;
      }
      tbody.appendChild(tr);
    }
  }

  /**
   * 金額の短縮フォーマット（万・億表記）
   */
  private formatMoneyShort(val: number): string {
    const sign = val < 0 ? '-' : '';
    const abs = Math.abs(val);
    if (abs >= 100000000) {
      return `${sign}¥${(abs / 100000000).toFixed(1)}億`;
    }
    if (abs >= 10000) {
      return `${sign}¥${Math.round(abs / 10000)}万`;
    }
    return `${sign}¥${Math.round(abs).toLocaleString()}`;
  }

  /**
   * 人口の短縮フォーマット
   */
  private formatPopShort(val: number): string {
    if (val >= 10000) {
      return `${(val / 10000).toFixed(1)}万人`;
    }
    return `${val.toLocaleString()}人`;
  }
}
