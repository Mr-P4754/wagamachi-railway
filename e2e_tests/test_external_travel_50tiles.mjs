import { chromium } from 'playwright';

async function runExternalTravelTest() {
  console.log('=== 外部接続線路のマップ外走行（50マス往復・隣町直通運行）E2Eテスト開始 ===');
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
    // ステップ 1: マップ端（西端）へ線路を敷設し、西条重工市との接続を確認
    // ==========================================
    console.log('\n--- ステップ 1: 西端境界への線路敷設と外部都市接続検知 ---');
    const borderSetup = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const em = app.externalConnectionManager;
      const gridSize = wm.gridSize || 64;
      const half = Math.floor(gridSize / 2);

      // 西端 x = -half から自都市内側へ向けて数マス線路を敷設（東西方向: rotation = 1）
      // x = -32, -31, -30, -29
      for (let x = -half; x <= -half + 3; x++) {
        wm.setTile(x, 0, 'rail_ground', 1, 1, 'right', 1);
      }

      // 外部接続判定を実行
      em.checkConnections(wm);
      const westCity = em.getAllCities().find(c => c.direction === 'west');
      const borderTile = wm.getTile(-half, 0, 1);

      return {
        isConnected: !!westCity?.connected,
        cityName: westCity?.name,
        borderTileType: borderTile?.type,
        isExternal: !!borderTile?.isExternalConnection,
        minX: -half
      };
    });

    console.log('  境界線路セットアップ結果:', borderSetup);
    if (!borderSetup.isConnected || !borderSetup.isExternal) {
      throw new Error('西端境界線路の敷設および外部接続検知が失敗しました');
    }
    console.log('  ✓ 西端境界線路の敷設と西条重工市方面との接続を確認');

    // ==========================================
    // ステップ 2: 列車を購入・配置し、マップ外（西方向）へ向けて走行開始
    // ==========================================
    console.log('\n--- ステップ 2: 列車の配置とマップ外への走行開始 ---');
    const departureTest = await page.evaluate(() => {
      const THREE = window.THREE;
      const app = window.gameApp;
      const wm = app.worldMap;
      const tm = app.trainManager;
      const minX = -Math.floor((wm.gridSize || 64) / 2);

      // 列車を x = minX + 2, z = 0, layer = 1 に配置（2両編成、初期乗客50人）
      const train = tm.spawnTrain(minX + 2, 0, undefined, 2, undefined, undefined, 1, undefined, 50);
      if (!train) return { error: '列車の生成に失敗しました' };

      // 最初の状態
      const initialVisible = train.mesh.visible;
      const initialTravel = !!train.externalTravel;

      // 列車を進めて境界線路（minX）に到達させ、外向きへ出発させる
      // 境界タイルへ移動させるシミュレーション
      train.currentTile = { x: minX, z: 0, layer: 1 };
      train.targetTile = { x: minX - 1, z: 0, layer: 1 }; // マップ外方向
      train.direction.set(-1, 0, 0); // 西向き
      train.progress = 1.0;

      // 1ステップ時間を進めて境界到達＆外部旅行突入をトリガー
      tm.update(0.1, 1);
      // さらに複数ステップ進めても在線占有（occupiedTiles）が復活しないことを確認
      tm.update(0.1, 1);
      tm.update(0.1, 1);

      return {
        trainId: train.id,
        initialVisible,
        initialTravel,
        afterVisible: train.mesh.visible,
        hasExternalTravel: !!train.externalTravel,
        phase: train.externalTravel?.phase,
        distanceTiles: train.externalTravel?.distanceTiles,
        remainingTiles: train.externalTravel?.remainingTiles,
        occupiedTilesCount: train.occupiedTiles.length
      };
    });

    console.log('  外部走行突入結果:', departureTest);
    if (!departureTest.hasExternalTravel || departureTest.afterVisible !== false) {
      throw new Error('列車がマップ外へ消えて外部直通走行状態に遷移していません');
    }
    if (departureTest.distanceTiles !== 50) {
      throw new Error(`隣町までの距離が50マスではありません: ${departureTest.distanceTiles}`);
    }
    if (departureTest.occupiedTilesCount !== 0) {
      throw new Error('外部走行中の列車の在線占有が解除されていません');
    }
    console.log('  ✓ 列車がマップ外へ消え、50マス先の隣町へ向けた直通運行を開始しました');

    const targetTrainId = departureTest.trainId;

    // ==========================================
    // ステップ 3: 往路50マス走行後の隣町到着＆客扱い・荷扱い検証
    // ==========================================
    console.log('\n--- ステップ 3: 50マス走行後の隣町到着・旅客降車（越境ボーナス）＆乗車 ---');
    const arrivalTest = await page.evaluate((trainId) => {
      const app = window.gameApp;
      const tm = app.trainManager;
      const train = tm.getTrains().find(t => t.id === trainId);
      if (!train || !train.externalTravel) return { error: '列車が見つかりません' };

      const revenueBefore = train.totalRevenue;

      // 往路の残りマス数を直前値にして、1ステップで隣町へ到着させる
      train.externalTravel.remainingTiles = 0.001;
      tm.update(0.1, 1);

      return {
        phase: train.externalTravel?.phase,
        stopMinutes: train.externalTravel?.stopMinutesRemaining,
        passengers: train.passengers,
        totalRevenue: train.totalRevenue,
        revenueIncreased: train.totalRevenue > revenueBefore
      };
    }, targetTrainId);

    console.log('  隣町到着・客扱い結果:', arrivalTest);
    if (arrivalTest.phase !== 'at_neighbor') {
      throw new Error(`隣町到着後のフェーズが不正です: ${arrivalTest.phase}`);
    }
    if (!arrivalTest.revenueIncreased || arrivalTest.passengers <= 0) {
      throw new Error('隣町での越境ボーナス運賃獲得または乗車処理が正常に行われていません');
    }
    console.log('  ✓ 50マス先の隣町に到着し、乗客降車（越境特別運賃）および自都市行き乗車を確認');

    // ==========================================
    // ステップ 4: 隣町での折り返し待機完了後、復路50マスの走行開始
    // ==========================================
    console.log('\n--- ステップ 4: 隣町折り返し発車と復路50マスの走行 ---');
    const returnTripTest = await page.evaluate((trainId) => {
      const app = window.gameApp;
      const tm = app.trainManager;
      const train = tm.getTrains().find(t => t.id === trainId);
      if (!train || !train.externalTravel) return { error: '列車が見つかりません' };

      // 隣町での停車分数を直前値にして、1ステップで折り返し発車させる
      train.externalTravel.stopMinutesRemaining = 0.0001;
      tm.update(0.1, 1);

      return {
        phase: train.externalTravel?.phase,
        remainingTiles: train.externalTravel?.remainingTiles,
        distanceTiles: train.externalTravel?.distanceTiles
      };
    }, targetTrainId);

    console.log('  復路走行開始結果:', returnTripTest);
    if (returnTripTest.phase !== 'homeward' || returnTripTest.remainingTiles !== 50) {
      throw new Error(`復路フェーズへの移行が不正です: phase=${returnTripTest.phase}, remaining=${returnTripTest.remainingTiles}`);
    }
    console.log('  ✓ 隣町を出発し、復路50マスの自都市接続部へ向けた走行を確認');

    // ==========================================
    // ステップ 5: 復路50マス走破後の自都市接続部からの帰還・マップ再登場
    // ==========================================
    console.log('\n--- ステップ 5: 復路完了・自都市接続部からの帰還・再登場 ---');
    const returnArrivalTest = await page.evaluate((trainId) => {
      const app = window.gameApp;
      const tm = app.trainManager;
      const wm = app.worldMap;
      const train = tm.getTrains().find(t => t.id === trainId);
      if (!train || !train.externalTravel) return { error: '列車が見つかりません' };

      const minX = -Math.floor((wm.gridSize || 64) / 2);

      // 復路残りマス数を直前値にして、接続部（minX）へ到着させる
      train.externalTravel.remainingTiles = 0.001;
      tm.update(0.1, 1);

      return {
        hasExternalTravel: !!train.externalTravel,
        isVisible: train.mesh.visible,
        currentX: train.currentTile.x,
        currentZ: train.currentTile.z,
        expectedX: minX,
        dirX: train.direction.x, // 東向き (+1) に反転しているはず
        occupiedTilesCount: train.occupiedTiles.length,
        passengers: train.passengers
      };
    }, targetTrainId);

    console.log('  接続部帰還結果:', returnArrivalTest);
    if (returnArrivalTest.hasExternalTravel) {
      throw new Error('帰還後に externalTravel が解除されていません');
    }
    if (!returnArrivalTest.isVisible) {
      throw new Error('帰還後に列車のメッシュが再表示されていません');
    }
    if (returnArrivalTest.currentX !== returnArrivalTest.expectedX) {
      throw new Error(`帰還した接続部タイルの位置が不正です: 期待値 ${returnArrivalTest.expectedX}, 実際 ${returnArrivalTest.currentX}`);
    }
    if (returnArrivalTest.dirX <= 0) {
      throw new Error(`帰還後の列車の進行方向が自都市向き（東向き）になっていません: dirX=${returnArrivalTest.dirX}`);
    }
    console.log('  ✓ 接続部から自都市を向いて列車が再登場し、自都市路線へ正常に合流しました');

    // ==========================================
    // ステップ 6: インスペクター表示の確認
    // ==========================================
    console.log('\n--- ステップ 6: 帰還後のインスペクター表示確認 ---');
    const inspectorCheck = await page.evaluate((trainId) => {
      const app = window.gameApp;
      const tm = app.trainManager;
      const ui = app.uiManager;
      const train = tm.getTrains().find(t => t.id === trainId);
      if (!train) return { isVisible: false, hasTrainName: false, hasPassengerCount: false };

      ui.showTrainInspector(train);
      const panel = document.getElementById('inspector-panel');
      const isVisible = panel && !panel.classList.contains('hidden');
      const text = panel ? panel.innerText : '';

      return {
        isVisible,
        hasTrainName: text.includes(train.name),
        hasPassengerCount: text.includes('乗客')
      };
    }, targetTrainId);

    console.log('  インスペクター確認結果:', inspectorCheck);
    if (!inspectorCheck.isVisible || !inspectorCheck.hasTrainName) {
      throw new Error('インスペクターが正常に表示されていません');
    }
    console.log('  ✓ 列車インスペクターの正常表示を確認');

    // スクリーンショット撮影
    await page.screenshot({ path: 'e2e_screenshots/external_travel_50tiles.png' });
    console.log('\n=== 全てのテストが正常に完了しました！ ===');

  } catch (err) {
    console.error('テスト失敗:', err);
    await page.screenshot({ path: 'e2e_screenshots/test_external_travel_failure.png' });
    throw err;
  } finally {
    await browser.close();
  }
}

runExternalTravelTest().catch(() => process.exit(1));
