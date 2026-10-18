import { chromium } from 'playwright';

async function testExternalConnectionDemolish() {
  console.log('====================================================');
  console.log('  外部接続線路の線路判定＆線路撤去ツールによる削除検証');
  console.log('====================================================');

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
    await page.goto('http://localhost:3001/');
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

    const result = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const ic = app.interactionController;
      const pc = app.placementController;
      const ui = app.uiManager;
      const tk = app.trainManager.kinematics;

      // 1. isTrackTile の判定検証
      const isKinematicsTrack = tk.isTrackTile({
        x: 0,
        z: 0,
        type: 'external_connection',
        rotation: 0,
        level: 1,
        stationPassengers: 0,
        landValue: 0
      });

      // 2. 外部接続タイルを配置
      const testX = 30;
      const testZ = 30;
      wm.placeExternalConnection(testX, testZ, 0, 'test_city', 'テスト市', 1);
      const placedTile = wm.getTile(testX, testZ, 1);
      const placedType = placedTile?.type;

      // 3. 線路撤去ツールを選択
      ui.selectTool('demolish-track');

      // 撤去前のタイル状態
      const beforeType = wm.getTile(testX, testZ, 1)?.type;

      // 撤去クリック実行 (pc.hoveredTile をセットして ic.handleTileClick())
      pc.hoveredTile = { x: testX, z: testZ };
      ic.handleTileClick();

      const afterTile = wm.getTile(testX, testZ, 1);
      const afterType = afterTile?.type ?? 'empty';

      // 4. Undo 検証
      let undoRestoredType = null;
      if (app.undoManager && app.undoManager.canUndo()) {
        app.undoManager.undo();
        const restoredTile = wm.getTile(testX, testZ, 1);
        undoRestoredType = restoredTile?.type;
      }

      return {
        isKinematicsTrack,
        placedType,
        beforeType,
        afterType,
        undoRestoredType
      };
    });

    console.log('テスト結果:', result);

    if (!result.isKinematicsTrack) {
      throw new Error(`TrainKinematics.isTrackTile が external_connection を false と判定しています`);
    }
    if (result.beforeType !== 'external_connection') {
      throw new Error(`外部接続タイルの配置に失敗しました: ${result.beforeType}`);
    }
    if (result.afterType !== 'empty') {
      throw new Error(`線路撤去ツールで external_connection が撤去されていません: 実際=${result.afterType}`);
    }
    console.log('✓ 線路撤去ツールにより外部接続線路が正常に撤去されました！');

    if (result.undoRestoredType !== 'external_connection') {
      throw new Error(`Undo で external_connection が復元されませんでした: 実際=${result.undoRestoredType}`);
    }
    console.log('✓ Undo により外部接続線路が正常に復元されました！');

    console.log('🎉 外部接続線路の線路判定および撤去・復元検証に完全合格しました！');
  } finally {
    await browser.close();
  }
}

testExternalConnectionDemolish().catch(err => {
  console.error('テスト失敗:', err);
  process.exit(1);
});
