import { chromium } from 'playwright';

async function testCrossingPlacement() {
  console.log('=== 踏切設置（道路×線路交差および踏切専用ツール）の網羅的配置検証 ===');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl']
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('  [Browser Error]:', msg.text());
    }
  });

  try {
    await page.goto('http://localhost:3000/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

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

    // テスト1: ツールバーUIの検証（線路カテゴリを開くと「踏切」ボタンが存在するか）
    console.log('--- テスト1: UIツールバーの踏切ボタン確認 ---');
    const uiTestResult = await page.evaluate(() => {
      const app = window.gameApp;
      const ui = app.uiManager;
      // 線路カテゴリをクリック
      const trackCatBtn = document.querySelector('[data-category="track"]');
      if (trackCatBtn) {
        trackCatBtn.click();
      }
      const crossingBtn = document.querySelector('[data-tool="level-crossing"]');
      return {
        hasTrackCatBtn: !!trackCatBtn,
        hasCrossingBtn: !!crossingBtn,
        crossingBtnName: crossingBtn ? crossingBtn.textContent.trim() : null
      };
    });
    console.log('テスト1結果 (UIツールバー):', uiTestResult);
    if (!uiTestResult.hasCrossingBtn) {
      throw new Error('ツールバーに踏切ボタン [data-tool="level-crossing"] が見つかりません');
    }

    // テスト2: 踏切専用ツールで更地に直接配置（rot: 0: 南北線路×東西道路）
    console.log('--- テスト2: 踏切専用ツールで更地に直接配置 ---');
    const test2Result = await page.evaluate(() => {
      const app = window.gameApp;
      const pc = app.placementController;
      const wm = app.worldMap;

      pc.cancelPendingPlacements();
      pc.currentRotation = 0;
      pc.stagePendingPlacement('level-crossing', 20, 20);
      pc.confirmPendingPlacements();

      const tile = wm.getTile(20, 20, 1);
      return {
        success: tile && tile.type === 'level_crossing',
        type: tile?.type,
        rot: tile?.rotation,
        crossingRoadAxis: tile?.crossingRoadAxis
      };
    });
    console.log('テスト2結果 (更地直接配置):', test2Result);
    if (!test2Result.success || test2Result.rot !== 0 || test2Result.crossingRoadAxis !== 1) {
      throw new Error('更地への踏切配置に失敗しました: ' + JSON.stringify(test2Result));
    }

    // テスト3: 踏切専用ツールで既存の道路（NS軸: rot 0）の上に配置 ➔ 自動でEW軸線路の踏切になる
    console.log('--- テスト3: 踏切専用ツールで既存道路の上に配置 ---');
    const test3Result = await page.evaluate(() => {
      const app = window.gameApp;
      const pc = app.placementController;
      const wm = app.worldMap;

      // (22, 20) に道路 (rot 0: NS軸) を配置
      pc.cancelPendingPlacements();
      pc.currentRotation = 0;
      pc.stagePendingPlacement('road', 22, 20);
      pc.confirmPendingPlacements();

      // その上に踏切ツールを配置
      pc.stagePendingPlacement('level-crossing', 22, 20);
      pc.confirmPendingPlacements();

      const tile = wm.getTile(22, 20, 1);
      return {
        success: tile && tile.type === 'level_crossing',
        type: tile?.type,
        rot: tile?.rotation,
        crossingRoadAxis: tile?.crossingRoadAxis
      };
    });
    console.log('テスト3結果 (既存道路上への踏切配置):', test3Result);
    if (!test3Result.success || test3Result.rot !== 1 || test3Result.crossingRoadAxis !== 0) {
      throw new Error('既存道路への踏切配置に失敗しました: ' + JSON.stringify(test3Result));
    }

    // テスト4: 踏切専用ツールで既存の線路（EW軸: rot 1）の上に配置 ➔ 自動でEW軸線路の踏切になる
    console.log('--- テスト4: 踏切専用ツールで既存線路の上に配置 ---');
    const test4Result = await page.evaluate(() => {
      const app = window.gameApp;
      const pc = app.placementController;
      const wm = app.worldMap;

      // (24, 20) に直線線路 (rot 1: EW軸) を配置
      pc.cancelPendingPlacements();
      pc.currentRotation = 1;
      pc.stagePendingPlacement('rail-straight', 24, 20);
      pc.confirmPendingPlacements();

      // その上に踏切ツールを配置
      pc.stagePendingPlacement('level-crossing', 24, 20);
      pc.confirmPendingPlacements();

      const tile = wm.getTile(24, 20, 1);
      return {
        success: tile && tile.type === 'level_crossing',
        type: tile?.type,
        rot: tile?.rotation,
        crossingRoadAxis: tile?.crossingRoadAxis
      };
    });
    console.log('テスト4結果 (既存線路上への踏切配置):', test4Result);
    if (!test4Result.success || test4Result.rot !== 1 || test4Result.crossingRoadAxis !== 0) {
      throw new Error('既存線路への踏切配置に失敗しました: ' + JSON.stringify(test4Result));
    }

    // テスト5: 既存道路の上に直線線路を直交配置して自動踏切生成
    console.log('--- テスト5: 道路（NS）の上に直線線路（EW）を交差配置 ---');
    const test5Result = await page.evaluate(() => {
      const app = window.gameApp;
      const pc = app.placementController;
      const wm = app.worldMap;

      // (26, 20) に道路 (rot 0: NS軸) を配置
      pc.cancelPendingPlacements();
      pc.currentRotation = 0;
      pc.stagePendingPlacement('road', 26, 20);
      pc.confirmPendingPlacements();

      // その上に直線線路 (rot 1: EW軸) を配置
      pc.currentRotation = 1;
      pc.stagePendingPlacement('rail-straight', 26, 20);
      pc.confirmPendingPlacements();

      const tile = wm.getTile(26, 20, 1);
      return {
        success: tile && tile.type === 'level_crossing',
        type: tile?.type,
        rot: tile?.rotation,
        crossingRoadAxis: tile?.crossingRoadAxis
      };
    });
    console.log('テスト5結果 (道路×線路直交配置):', test5Result);
    if (!test5Result.success || test5Result.rot !== 1 || test5Result.crossingRoadAxis !== 0) {
      throw new Error('道路への線路交差配置に失敗しました: ' + JSON.stringify(test5Result));
    }

    // テスト6: 既存線路の上に道路を直交配置して自動踏切生成
    console.log('--- テスト6: 線路（EW）の上に道路（NS）を交差配置 ---');
    const test6Result = await page.evaluate(() => {
      const app = window.gameApp;
      const pc = app.placementController;
      const wm = app.worldMap;

      // (28, 20) に直線線路 (rot 1: EW軸) を配置
      pc.cancelPendingPlacements();
      pc.currentRotation = 1;
      pc.stagePendingPlacement('rail-straight', 28, 20);
      pc.confirmPendingPlacements();

      // その上に道路 (rot 0: NS軸) を配置
      pc.currentRotation = 0;
      pc.stagePendingPlacement('road', 28, 20);
      pc.confirmPendingPlacements();

      const tile = wm.getTile(28, 20, 1);
      return {
        success: tile && tile.type === 'level_crossing',
        type: tile?.type,
        rot: tile?.rotation,
        crossingRoadAxis: tile?.crossingRoadAxis
      };
    });
    console.log('テスト6結果 (線路×道路交差配置):', test6Result);
    if (!test6Result.success || test6Result.rot !== 1 || test6Result.crossingRoadAxis !== 0) {
      throw new Error('線路への道路交差配置に失敗しました: ' + JSON.stringify(test6Result));
    }

    // テスト7: ドラッグ敷設で道路を横断
    console.log('--- テスト7: 道路を跨ぐ直線線路ドラッグ敷設 ---');
    const test7Result = await page.evaluate(() => {
      const app = window.gameApp;
      const pc = app.placementController;
      const wm = app.worldMap;

      // (32, 25) に道路 (rot 0: NS軸) を配置
      pc.cancelPendingPlacements();
      pc.currentRotation = 0;
      pc.stagePendingPlacement('road', 32, 25);
      pc.confirmPendingPlacements();

      // (30, 25) から (34, 25) まで直線線路をドラッグ敷設
      pc.isDraggingTrack = true;
      pc.dragStartTile = { x: 30, z: 25 };
      pc.updateDragPreview({ x: 30, z: 25 }, { x: 34, z: 25 });
      pc.finishDragPlacement();
      pc.confirmPendingPlacements();

      const crossingTile = wm.getTile(32, 25, 1);
      const leftRail = wm.getTile(30, 25, 1);
      const rightRail = wm.getTile(34, 25, 1);

      return {
        crossingSuccess: crossingTile && crossingTile.type === 'level_crossing',
        crossingType: crossingTile?.type,
        crossingRot: crossingTile?.rotation,
        crossingRoadAxis: crossingTile?.crossingRoadAxis,
        leftRailType: leftRail?.type,
        rightRailType: rightRail?.type
      };
    });
    console.log('テスト7結果 (ドラッグ敷設横断):', test7Result);
    if (!test7Result.crossingSuccess || test7Result.crossingRot !== 1 || test7Result.crossingRoadAxis !== 0) {
      throw new Error('ドラッグ敷設による踏切生成に失敗しました: ' + JSON.stringify(test7Result));
    }

    // テスト8: 生成された踏切上を列車が問題なく走行・横断できるか
    console.log('--- テスト8: 列車による踏切横断走行 ---');
    const trainTestResult = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const tm = app.trainManager;

      // 既存列車をすべて削除
      for (const t of tm.getTrains().slice()) {
        tm.removeTrain(t.id);
      }

      // x: 30〜34 の直線レール＆踏切（32, 25）上に列車をスポーン
      const train = tm.spawnTrain(30, 25, undefined, 2, 1, undefined, 1);
      if (!train) return { success: false, error: '列車スポーン失敗' };

      // 100ステップ等速走行（東向き）
      let crossed = false;
      for (let s = 0; s < 100; s++) {
        tm.update(0.016, 1);
        if (train.currentTile.x === 32 && train.currentTile.z === 25) {
          crossed = true;
        }
      }

      return {
        success: true,
        crossed,
        finalPos: { x: train.currentTile.x, z: train.currentTile.z },
        speed: train.speed
      };
    });
    console.log('テスト8結果 (列車走行横断):', trainTestResult);
    if (!trainTestResult.success) {
      throw new Error('列車の踏切走行に失敗しました: ' + JSON.stringify(trainTestResult));
    }

    // スクリーンショット保存
    await page.screenshot({ path: 'e2e_screenshots/crossing_placement_verified.png' });
    console.log('=== 全ての踏切配置テストが正常に PASS しました！ ===');

  } finally {
    await browser.close();
  }
}

testCrossingPlacement().catch(err => {
  console.error('テスト失敗:', err);
  process.exit(1);
});
