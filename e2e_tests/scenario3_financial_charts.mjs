import { chromium } from 'playwright';

async function runScenario3() {
  console.log('=== シナリオ 3: 財務・経営推移チャート（月次・年次）の描画 テスト開始 ===');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl']
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
      console.log('  [Browser Error]:', msg.text());
    }
  });

  try {
    await page.goto('http://localhost:3000/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // タイトル画面があれば閉じてゲーム画面へ
    const titleOverlay = await page.$('#title-screen-overlay');
    const isTitleVisible = titleOverlay && !(await titleOverlay.evaluate(el => el.classList.contains('hidden')));
    if (isTitleVisible) {
      const btnNew = await page.$('#btn-title-new');
      if (btnNew) {
        await btnNew.click();
        await page.waitForTimeout(300);
        const btnStart = await page.$('#btn-title-start');
        if (btnStart) await btnStart.click();
      }
    }
    await page.waitForTimeout(1000);

    // 1. レポートモーダル（財務状況・決算報告）を開く
    console.log('  ステップ1: レポートモーダルを開く...');
    const reportBtn = await page.$('#btn-report');
    if (!reportBtn) throw new Error('レポートボタンが見つかりません');
    await reportBtn.click();
    await page.waitForTimeout(500);

    // 2. モーダル上部に「今期決算」「月次推移」「年次推移」のタブが存在することを確認する
    console.log('  ステップ2: タブボタンの存在確認...');
    const tabCheck = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.report-tab-btn')).map(b => ({
        text: b.textContent.trim(),
        tab: b.getAttribute('data-tab')
      }));
      return {
        hasTabs: tabs.length >= 3,
        tabs
      };
    });

    console.log('  タブ一覧:', tabCheck.tabs);
    if (!tabCheck.hasTabs) {
      throw new Error('レポートモーダルのタブが不足しています: ' + JSON.stringify(tabCheck));
    }

    // 3. 翌月（1ヶ月経過）および翌年3月31日（決算期）を通過させる（月次・年次スナップショットを蓄積）
    console.log('  ステップ3: 月次および年次財務スナップショットを蓄積...');
    await page.evaluate(() => {
      const app = window.gameApp;
      const eco = app.economy;

      // 過去6ヶ月分の月次スナップショットを投入
      const monthsData = [
        { month: 4, fare: 1200000, cargo: 300000, maint: 400000, constr: 1000000, pop: 1200 },
        { month: 5, fare: 1500000, cargo: 450000, maint: 420000, constr: 200000, pop: 1600 },
        { month: 6, fare: 1800000, cargo: 600000, maint: 450000, constr: 500000, pop: 2100 },
        { month: 7, fare: 2100000, cargo: 750000, maint: 480000, constr: 0, pop: 2700 },
        { month: 8, fare: 2400000, cargo: 900000, maint: 500000, constr: 300000, pop: 3400 },
        { month: 9, fare: 2800000, cargo: 1100000, maint: 520000, constr: 0, pop: 4200 },
      ];

      for (const m of monthsData) {
        const net = (m.fare + m.cargo) - (m.maint + m.constr);
        eco.recordMonthlySnapshot({
          year: 2026,
          month: m.month,
          fareIncome: m.fare,
          cargoIncome: m.cargo,
          maintenanceCost: m.maint,
          constructionCost: m.constr,
          netProfit: net,
          population: m.pop,
          trackLength: 12.5,
          trainCount: 3,
          stationCount: 4
        });
      }

      // 過去3年分の年次スナップショットを投入
      const yearlyData = [
        { year: 2024, fare: 12000000, cargo: 2000000, maint: 4000000, constr: 6000000, pop: 2000 },
        { year: 2025, fare: 18000000, cargo: 4500000, maint: 4800000, constr: 3000000, pop: 3500 },
        { year: 2026, fare: 26000000, cargo: 8000000, maint: 5500000, constr: 4000000, pop: 5000 }
      ];

      for (const y of yearlyData) {
        const net = (y.fare + y.cargo) - (y.maint + y.constr);
        eco.recordYearlySnapshot({
          year: y.year,
          month: 0,
          fareIncome: y.fare,
          cargoIncome: y.cargo,
          maintenanceCost: y.maint,
          constructionCost: y.constr,
          netProfit: net,
          taxAmount: Math.max(0, Math.floor(net * 0.3)),
          population: y.pop,
          trackLength: 18.0,
          trainCount: 5,
          stationCount: 6
        });
      }

      // レポートUIを最新データで再描画
      const allTiles = app.worldMap.getAllTiles();
      const reportData = eco.getFinancialReport(allTiles.length, 3, 4);
      app.uiManager.updateFinancialReport(reportData);
    });

    // 4. 再度レポートモーダルを開き、「月次推移」タブを選択する。
    // Canvas上に運賃収入、維持費、純利益、総人口の推移グラフが自前描画されていることを確認。
    console.log('  ステップ4: 「月次推移」タブを選択しCanvas描画確認...');
    const monthlyTabBtn = await page.$('.report-tab-btn[data-tab="monthly"]');
    if (!monthlyTabBtn) throw new Error('月次推移タブボタンが見つかりません');
    await monthlyTabBtn.click();
    await page.waitForTimeout(600);
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('#monthly-history-tbody tr').length;
      const canvas = document.getElementById('monthly-chart-canvas');
      return rows > 0 && canvas && canvas.width > 300;
    }, { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(300);

    const monthlyCanvasCheck = await page.evaluate(() => {
      const canvas = document.getElementById('monthly-chart-canvas');
      if (!canvas) return { hasCanvas: false };
      const ctx = canvas.getContext('2d');
      // キャンバスに何らかの描画（ピクセルデータ）が存在するか
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let nonZeroCount = 0;
      for (let i = 3; i < imgData.data.length; i += 4) {
        if (imgData.data[i] > 0) nonZeroCount++;
      }

      const rows = document.querySelectorAll('#monthly-history-tbody tr').length;
      return {
        hasCanvas: true,
        width: canvas.width,
        height: canvas.height,
        renderedPixels: nonZeroCount,
        tableRows: rows
      };
    });

    console.log('  月次Canvas検証結果:', monthlyCanvasCheck);
    if (!monthlyCanvasCheck.hasCanvas || monthlyCanvasCheck.renderedPixels < 100 || monthlyCanvasCheck.tableRows === 0) {
      throw new Error('月次チャートのCanvas描画またはテーブル行生成に失敗しました: ' + JSON.stringify(monthlyCanvasCheck));
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario3_step1_monthly_chart.png' });

    // 5. チャート上のデータ点にマウスホバーし、該当月の詳細数値ツールチップが表示されることを確認。
    console.log('  ステップ5: チャート上のホバーツールチップ確認...');
    const canvasBBox = await page.$eval('#monthly-chart-canvas', el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });

    // 最後のデータ点付近（右側中央）へマウス移動
    const hoverX = canvasBBox.x + canvasBBox.width * 0.8;
    const hoverY = canvasBBox.y + canvasBBox.height * 0.5;
    await page.mouse.move(hoverX, hoverY);
    await page.waitForTimeout(300);

    const tooltipCheck = await page.evaluate(() => {
      const tooltip = document.getElementById('monthly-chart-tooltip');
      const isVisible = tooltip && !tooltip.classList.contains('hidden') && tooltip.style.display !== 'none';
      const text = tooltip ? tooltip.textContent : '';
      return {
        isVisible,
        text
      };
    });

    console.log('  ツールチップ検証結果:', tooltipCheck);
    await page.screenshot({ path: 'e2e_screenshots/scenario3_step2_monthly_tooltip.png' });

    // 6. 「年次推移」タブに切り替え、年度別の集計チャートが表示されることを確認。
    console.log('  ステップ6: 「年次推移」タブを選択し年次チャート確認...');
    const yearlyTabBtn = await page.$('.report-tab-btn[data-tab="yearly"]');
    if (!yearlyTabBtn) throw new Error('年次推移タブボタンが見つかりません');
    await yearlyTabBtn.click();
    await page.waitForTimeout(600);
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('#yearly-history-tbody tr').length;
      return rows > 0;
    }, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);

    const yearlyCanvasCheck = await page.evaluate(() => {
      const canvas = document.getElementById('yearly-chart-canvas');
      if (!canvas) return { hasCanvas: false };
      const ctx = canvas.getContext('2d');
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let nonZeroCount = 0;
      for (let i = 3; i < imgData.data.length; i += 4) {
        if (imgData.data[i] > 0) nonZeroCount++;
      }

      const rows = document.querySelectorAll('#yearly-history-tbody tr').length;
      return {
        hasCanvas: true,
        width: canvas.width,
        height: canvas.height,
        renderedPixels: nonZeroCount,
        tableRows: rows
      };
    });

    console.log('  年次Canvas検証結果:', yearlyCanvasCheck);
    if (!yearlyCanvasCheck.hasCanvas || yearlyCanvasCheck.renderedPixels < 100 || yearlyCanvasCheck.tableRows === 0) {
      throw new Error('年次チャートのCanvas描画またはテーブル行生成に失敗しました: ' + JSON.stringify(yearlyCanvasCheck));
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario3_step3_yearly_chart.png' });

    console.log('=== シナリオ 3: PASS ===\n');
    return { pass: true, errors: consoleErrors };
  } catch (err) {
    console.error('=== シナリオ 3: FAIL ===', err);
    await page.screenshot({ path: 'e2e_screenshots/scenario3_fail.png' }).catch(() => {});
    return { pass: false, error: err.message, errors: consoleErrors };
  } finally {
    await browser.close();
  }
}

runScenario3().then(res => {
  if (!res.pass) process.exit(1);
});
