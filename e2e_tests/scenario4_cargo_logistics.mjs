import { chromium } from 'playwright';

async function runScenario4() {
  console.log('=== シナリオ 4: 貨物輸送可視化と経済フィードバック テスト開始 ===');
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

    // 1. ツールバーから「貨物駅」を工業ゾーン隣接部と商業ゾーン隣接部にそれぞれ建設し、貨物列車（EF級）を購入・配置する
    console.log('  ステップ1: 貨物駅・ゾーン・貨物列車の配置...');
    const setupResult = await page.evaluate(() => {
      const app = window.gameApp;
      if (!app) return { success: false, error: 'gameApp not found' };

      const wm = app.worldMap;
      const zm = app.zoneManager;
      const tm = app.trainManager;

      // 工業ゾーン (15, 20)
      zm.paintZone(15, 20, 'industrial', 0);
      // 工業隣接 貨物駅 (16, 20)
      wm.setTile(16, 20, 'cargo_station_ground', 1, 1, 'right', 1);

      // 接続線路 (17, 20) .. (24, 20)
      for (let x = 17; x <= 24; x++) {
        wm.setTile(x, 20, 'rail_ground', 1, 1, 'right', 1);
      }

      // 商業隣接 貨物駅 (25, 20)
      wm.setTile(25, 20, 'cargo_station_ground', 1, 1, 'right', 1);
      // 商業ゾーン (26, 20)
      zm.paintZone(26, 20, 'commercial', 0);

      // 貨物列車 (EF級) の配置 (18, 20)
      const freightModel = {
        id: 'freight-train',
        name: '貨物列車 (EF級)',
        category: 'freight',
        description: 'コンテナ輸送',
        speedTilesPerMinute: 1.0,
        basePrice: 15000000,
        baseCapacity: 0,
        maxOccupancyRate: 0,
        maxSpeed: 75,
        farePerRide: 0,
        runningCostPerTripPerCar: 1000,
        dailyRunningCostPerCar: 3000,
        bodyColor: 0x1e3a8a,
        stripeColor: 0xf59e0b,
        roofColor: 0x334155
      };

      const train = tm.spawnTrain(18, 20, freightModel, 3, 1, undefined, 1);
      if (train) {
        train.cargoLoad = 6;
        train.cargoCapacity = 6;
        train.cargoPickup = { x: 16, z: 20 };
        train.cargoTraveledTiles = 9;
        train.totalRevenue = 54000;
        train.monthlyProfit = 48000;
      }

      return {
        success: true,
        trainId: train?.id,
        isFreight: train?.model.category === 'freight',
        cargoLoad: train?.cargoLoad
      };
    });

    console.log('  配置結果:', setupResult);
    if (!setupResult.success || !setupResult.isFreight) {
      throw new Error('貨物駅または貨物列車の配置に失敗しました: ' + JSON.stringify(setupResult));
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario4_step1_cargo_setup.png' });

    // 2. レポートモーダルを開き、収支一覧に「貨物輸送収入」が旅客運賃とは独立した項目として表示されていることを確認する
    console.log('  ステップ2: レポートモーダル内の貨物輸送収入 独立表示確認...');
    const reportBtn = await page.$('#btn-report');
    if (!reportBtn) throw new Error('レポートボタンが見つかりません');
    await reportBtn.click();
    await page.waitForTimeout(500);

    const reportCheck = await page.evaluate(() => {
      const fareEl = document.getElementById('rep-fare-income');
      const cargoEl = document.getElementById('rep-cargo-income');
      return {
        hasFareEl: !!fareEl,
        hasCargoEl: !!cargoEl,
        fareText: fareEl?.textContent,
        cargoText: cargoEl?.textContent
      };
    });

    console.log('  収支項目確認:', reportCheck);
    if (!reportCheck.hasFareEl || !reportCheck.hasCargoEl) {
      throw new Error('収支一覧に旅客運賃または貨物輸送収入の項目が存在しません: ' + JSON.stringify(reportCheck));
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario4_step2_cargo_revenue_report.png' });

    // レポートモーダルを閉じる
    const closeReportBtn = await page.$('#btn-close-report');
    if (closeReportBtn) await closeReportBtn.click();
    await page.waitForTimeout(300);

    // 3. 画面右下の路線図ミニマップを開き、ヘッダーの「物資表示」トグルを有効化する
    console.log('  ステップ3: ミニマップの「物資表示」トグル有効化確認...');
    const minimapCheck = await page.evaluate(() => {
      const app = window.gameApp;
      const mm = app.miniMap;
      const cargoBtn = document.getElementById('minimap-cargo-btn');

      if (!cargoBtn) return { success: false, error: 'minimap-cargo-btn not found' };

      // クリックして物資表示（物流モード）を有効化
      cargoBtn.click();

      return {
        success: true,
        isLogisticsMode: mm.isLogisticsMode,
        btnActive: cargoBtn.classList.contains('active')
      };
    });

    console.log('  ミニマップ物流モード状態:', minimapCheck);
    if (!minimapCheck.success || !minimapCheck.isLogisticsMode || !minimapCheck.btnActive) {
      throw new Error('ミニマップの物資表示トグル有効化に失敗しました: ' + JSON.stringify(minimapCheck));
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario4_step3_minimap_cargo_mode.png' });

    // 4. 貨物列車が商業エリアの駅に到着してコンテナの荷降ろし・販売が行われた瞬間のフローティングバッジ出現を観察
    console.log('  ステップ4: 納品フローティングバッジ生成・アニメーション確認...');
    const badgeResult = await page.evaluate(() => {
      const app = window.gameApp;
      const wlm = app.worldLabelManager;

      // カメラを納品駅マスへ注視させて確実に視野内に入れる
      app.cameraManager.jumpToPosition({ x: 25 * 4, z: 20 * 4 });

      // 納品バッジを生成
      wlm.spawnCargoFloatingBadge(app.worldMap, 25, 20, 1, 6, 25200);

      // 生成されたバッジ要素の存在確認
      const badges = document.querySelectorAll('.cargo-floating-toast');
      const badge = badges[badges.length - 1];

      return {
        hasBadge: !!badge,
        text: badge ? badge.textContent : '',
        className: badge ? badge.className : ''
      };
    });

    console.log('  納品フローティングバッジ検証:', badgeResult);
    if (!badgeResult.hasBadge || !badgeResult.text.includes('6個納品') || !badgeResult.text.includes('25,200')) {
      throw new Error('納品フローティングバッジの生成またはテキストに失敗しました: ' + JSON.stringify(badgeResult));
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario4_step4_delivery_badge.png' });

    // 5. 貨物列車をクリックしてインスペクターを開き、積載数/容量、積込発駅、走行マス数、見込み運賃が表示されていることを確認
    console.log('  ステップ5: 貨物列車インスペクター詳細表示確認...');
    const inspectorCheck = await page.evaluate((trainId) => {
      const app = window.gameApp;
      const train = app.trainManager.getTrainById(trainId);
      if (!train) return { success: false, error: 'Train not found' };

      // インスペクターを表示
      app.uiManager.showTrainInspector(train);

      const panel = document.getElementById('inspector-panel');
      const isVisible = panel && !panel.classList.contains('hidden');
      const finBox = document.getElementById('inspect-financial-box');
      const finText = finBox ? finBox.textContent : '';
      const extraVal = document.getElementById('inspect-extra-val')?.textContent || '';

      return {
        success: true,
        isVisible,
        extraVal,
        hasFinBox: !!finBox,
        hasLoadCap: finText.includes('6 / 6個'),
        hasPickupLoc: finText.includes('(16, 20)'),
        hasRunTiles: finText.includes('9マス'),
        hasEstRevenue: finText.includes('全量納品見込売上'),
        hasTotalRevenue: finText.includes('累計貨物運賃収入')
      };
    }, setupResult.trainId);

    console.log('  貨物インスペクター検証結果:', inspectorCheck);
    if (!inspectorCheck.success || !inspectorCheck.isVisible || !inspectorCheck.hasLoadCap || !inspectorCheck.hasPickupLoc || !inspectorCheck.hasEstRevenue) {
      throw new Error('貨物列車インスペクターの詳細表示検証に失敗しました: ' + JSON.stringify(inspectorCheck));
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario4_step5_cargo_inspector.png' });

    console.log('=== シナリオ 4: PASS ===\n');
    return { pass: true, errors: consoleErrors };
  } catch (err) {
    console.error('=== シナリオ 4: FAIL ===', err);
    await page.screenshot({ path: 'e2e_screenshots/scenario4_fail.png' }).catch(() => {});
    return { pass: false, error: err.message, errors: consoleErrors };
  } finally {
    await browser.close();
  }
}

runScenario4().then(res => {
  if (!res.pass) process.exit(1);
});
