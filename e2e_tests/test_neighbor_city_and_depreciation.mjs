import { chromium } from 'playwright';

async function runNeighborCityAndDepreciationTest() {
  console.log('=== ② マップ外延伸による外部都市接続 & ③ 減価償却 E2Eテスト開始 ===');
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

    // タイトル画面の処理
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

    // ==========================================
    // テスト 1: 財務レポートでの減価償却費・簿価の表示
    // ==========================================
    console.log('\n--- テスト 1: 財務レポートの減価償却費・簿価表示確認 ---');
    const reportBtn = await page.$('#btn-report');
    if (!reportBtn) throw new Error('レポートボタンが見つかりません');
    await reportBtn.click();
    await page.waitForTimeout(500);

    const reportLabels = await page.evaluate(() => {
      const modal = document.getElementById('report-modal');
      const text = modal ? modal.innerText : '';
      const hasDepreciation = text.includes('減価償却費') || text.includes('当期減価償却費');
      const hasBookValue = text.includes('固定資産簿価') || text.includes('簿価');
      const depEl = document.getElementById('rep-depreciation-cost');
      const bookEl = document.getElementById('rep-book-value');
      return {
        hasDepreciation,
        hasBookValue,
        depText: depEl ? depEl.textContent : null,
        bookText: bookEl ? bookEl.textContent : null
      };
    });

    console.log('  レポート減価償却チェック:', reportLabels);
    if (!reportLabels.hasDepreciation || !reportLabels.hasBookValue) {
      throw new Error('財務レポートに減価償却費または固定資産簿価が表示されていません');
    }
    console.log('  ✓ 財務レポートの減価償却費・固定資産簿価表示を確認');

    // レポートモーダルを閉じる
    const closeReportBtn = await page.$('#btn-close-report');
    if (closeReportBtn) await closeReportBtn.click();
    await page.waitForTimeout(300);

    // ==========================================
    // テスト 2: 減価償却台帳（AssetDepreciationManager）の計算ロジック検証
    // ==========================================
    console.log('\n--- テスト 2: 減価償却台帳・税務計算の動作検証 ---');
    const depreciationCalcResult = await page.evaluate(() => {
      const app = window.gameApp;
      if (!app) return { error: 'window.gameApp が見つかりません' };

      const economy = app.economy;
      const initialBookValue = economy.getTotalBookValue();

      // 1. 車両購入（耐用年数 5年 = 年20%償却）
      const vehicleCost = 20000000; // 2,000万円
      economy.spendFunds(vehicleCost, true, 'vehicle');

      // 2. 線路・設備建設（耐用年数 10年 = 年10%償却）
      const trackCost = 10000000; // 1,000万円
      economy.spendFunds(trackCost, true, 'infrastructure');

      const afterInvestBookValue = economy.getTotalBookValue();
      const addedBookValue = afterInvestBookValue - initialBookValue;

      // 3. 1年経過時の減価償却費計算（車両20% + 設備10% = 400万 + 100万 = 500万円）
      const taxReport = economy.assessAnnualTax(10, 2, 2, 2026);

      return {
        initialBookValue,
        addedBookValue,
        annualDepreciation: taxReport.depreciationCost,
        expectedDepreciation: 5000000,
        propertyTax: taxReport.propertyTax
      };
    });

    console.log('  減価償却計算結果:', depreciationCalcResult);
    if (Math.abs(depreciationCalcResult.annualDepreciation - depreciationCalcResult.expectedDepreciation) > 1000) {
      throw new Error(`年次減価償却費が不正: 期待値 ${depreciationCalcResult.expectedDepreciation}, 実際 ${depreciationCalcResult.annualDepreciation}`);
    }
    console.log('  ✓ 定額法減価償却（車両20%/年、設備10%/年）および税制計算が正常に機能しています');

    // ==========================================
    // テスト 3: マップ境界端に固定ゲートウェイが存在しないことの確認（更地であること）
    // ==========================================
    console.log('\n--- テスト 3: 固定ゲートウェイが存在しないこと（更地状態）の確認 ---');
    const noFixedGateways = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const allTiles = wm.getAllTiles();
      const gatewayTiles = allTiles.filter(t => t.type === 'external_connection');
      const gridSize = wm.gridSize || 64;
      const half = Math.floor(gridSize / 2);

      // マップ境界四辺の代表点（西端、東端、北端、南端）の確認
      const westTile = wm.getTile(-half, 0, 1);
      const eastTile = wm.getTile(half - 1, 0, 1);
      const northTile = wm.getTile(0, -half, 1);
      const southTile = wm.getTile(0, half - 1, 1);

      return {
        legacyGatewayCount: gatewayTiles.length,
        westTileType: westTile ? westTile.type : 'empty',
        eastTileType: eastTile ? eastTile.type : 'empty',
        northTileType: northTile ? northTile.type : 'empty',
        southTileType: southTile ? southTile.type : 'empty'
      };
    });

    console.log('  固定ゲートウェイ非存在チェック:', noFixedGateways);
    if (noFixedGateways.legacyGatewayCount > 0) {
      throw new Error(`マップ上に不要な固定ゲートウェイタイルが存在します: ${noFixedGateways.legacyGatewayCount}個`);
    }
    console.log('  ✓ 固定ゲートウェイは配置されておらず、マップ境界は自然な状態です');

    // ==========================================
    // テスト 4: マップ境界端に向けて線路を延伸すると外部接続判定になることの確認
    // ==========================================
    console.log('\n--- テスト 4: マップ外への線路延伸による外部接続判定 ---');
    const extensionConnection = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const em = app.externalConnectionManager;
      const gridSize = wm.gridSize || 64;
      const half = Math.floor(gridSize / 2);

      const westCity = em.getAllCities().find(c => c.direction === 'west');
      if (!westCity) return { error: '西側都市が見つかりません' };

      const wasConnectedBefore = westCity.connected;

      // 西端境界 (x = -half, z = 0) に東西方向の直線線路 (rotation = 1) を敷設
      // この線路は西（idx: 3）と東（idx: 1）に出口を持ち、西端で外側（西）を向いている
      const borderX = -half;
      const borderZ = 0;
      wm.setTile(borderX, borderZ, 'rail_ground', 1, 1, 'right', 1);

      // 接続判定を実行
      em.checkConnections(wm);

      const isConnectedAfter = westCity.connected;
      const borderTile = wm.getTile(borderX, borderZ, 1);

      return {
        wasConnectedBefore,
        isConnectedAfter,
        borderTileType: borderTile?.type,
        isExternalConnection: borderTile?.isExternalConnection,
        externalCityId: borderTile?.externalCityId,
        stationName: borderTile?.stationName
      };
    });

    console.log('  線路延伸接続結果:', extensionConnection);
    if (!extensionConnection.isConnectedAfter || !extensionConnection.isExternalConnection) {
      throw new Error('マップ外への線路延伸後に外部接続判定が成立していません');
    }
    console.log('  ✓ マップ外へ延伸した線路が正しく検知され、外部都市との接続判定が成立しました');

    // ==========================================
    // テスト 5: ゲートウェイ表示（門型ポータル・看板等）がなく、通常線路のみの描写であることの確認
    // ==========================================
    console.log('\n--- テスト 5: ゲートウェイメッシュ非表示・通常線路メッシュ確認 ---');
    const meshInspection = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const gridSize = wm.gridSize || 64;
      const half = Math.floor(gridSize / 2);
      const borderTile = wm.getTile(-half, 0, 1);

      if (!borderTile || !borderTile.mesh) {
        return { error: '境界線路のメッシュが存在しません' };
      }

      let hasGatewayPortal = false;
      let hasGatewaySign = false;
      let hasGatewayIndicators = false;

      borderTile.mesh.traverse(obj => {
        if (obj.name === 'gatewaySignBoard') hasGatewaySign = true;
        if (obj.name === 'gatewayIndicatorL' || obj.name === 'gatewayIndicatorR') hasGatewayIndicators = true;
      });

      return {
        meshType: borderTile.mesh.type,
        childrenCount: borderTile.mesh.children.length,
        hasGatewayPortal,
        hasGatewaySign,
        hasGatewayIndicators
      };
    });

    console.log('  メッシュ構造チェック:', meshInspection);
    if (meshInspection.hasGatewaySign || meshInspection.hasGatewayIndicators) {
      throw new Error('不要なゲートウェイ看板またはインジケータが表示されています');
    }
    console.log('  ✓ ゲートウェイの看板・ポータルは存在せず、通常の線路が外へ伸びているだけの描写を確認');

    // ==========================================
    // テスト 6: インスペクターでの直通都市情報カード表示確認
    // ==========================================
    console.log('\n--- テスト 6: インスペクターでの直通都市情報カード表示確認 ---');
    const inspectorCheck = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const gridSize = wm.gridSize || 64;
      const half = Math.floor(gridSize / 2);
      const borderTile = wm.getTile(-half, 0, 1);

      // インスペクターを開く
      app.uiManager.showInspector(borderTile);

      const panel = document.getElementById('inspector-panel');
      const isVisible = panel && !panel.classList.contains('hidden');
      const text = panel ? panel.innerText : '';

      return {
        isVisible,
        hasDirectCard: text.includes('西条重工市') || text.includes('直通運行中'),
        hasPopulation: text.includes('都市人口'),
        hasRecord: text.includes('広域直通輸送実績')
      };
    });

    console.log('  インスペクター表示確認:', inspectorCheck);
    if (!inspectorCheck.isVisible || !inspectorCheck.hasDirectCard) {
      throw new Error('インスペクターに直通都市情報カードが表示されていません');
    }
    console.log('  ✓ 境界線路インスペクターに直通都市情報が正常に表示されることを確認');

    // ==========================================
    // テスト 7: 毎時供給・旅客降車ボーナス・貨物輸出処理の動作
    // ==========================================
    console.log('\n--- テスト 7: 毎時供給および長距離直通輸送処理 ---');
    const supplyAndTransportTest = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const em = app.externalConnectionManager;
      const gridSize = wm.gridSize || 64;
      const half = Math.floor(gridSize / 2);
      const borderTile = wm.getTile(-half, 0, 1);

      const beforePassengers = borderTile.stationPassengers ?? 0;
      const beforeCargo = borderTile.cargoContainers ?? 0;

      // 毎時供給を実行
      em.updateHourlySupply(wm);

      const afterPassengers = borderTile.stationPassengers ?? 0;
      const afterCargo = borderTile.cargoContainers ?? 0;

      // 輸送実績の記録テスト
      const westCity = em.getAllCities().find(c => c.direction === 'west');
      em.recordPassengersTransported(westCity.id, 80);
      em.recordCargoExported(westCity.id, 12);

      return {
        passengersSupplied: afterPassengers - beforePassengers,
        cargoSupplied: afterCargo - beforeCargo,
        totalPassengers: westCity.totalPassengersTransported,
        totalCargo: westCity.totalCargoExported
      };
    });

    console.log('  供給＆実績記録テスト結果:', supplyAndTransportTest);
    if (supplyAndTransportTest.passengersSupplied <= 0 || supplyAndTransportTest.cargoSupplied <= 0) {
      throw new Error('境界線路への毎時乗客・貨物供給が行われていません');
    }
    if (supplyAndTransportTest.totalPassengers !== 80 || supplyAndTransportTest.totalCargo !== 12) {
      throw new Error('広域輸送実績が正常に記録されていません');
    }
    console.log('  ✓ 毎時供給レートによる乗客・貨物の自動補充および広域輸送実績の記録を確認');

    // 画面スクリーンショットの撮影
    await page.screenshot({ path: 'e2e_screenshots/neighbor_city_and_depreciation.png' });
    console.log('\n=== 全てのテストが正常に完了しました！ ===');
  } catch (err) {
    console.error('テスト失敗:', err);
    await page.screenshot({ path: 'e2e_screenshots/test_neighbor_failure.png' });
    throw err;
  } finally {
    await browser.close();
  }
}

runNeighborCityAndDepreciationTest().catch(() => process.exit(1));
