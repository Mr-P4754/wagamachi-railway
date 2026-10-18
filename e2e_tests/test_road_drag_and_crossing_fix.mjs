import { chromium } from 'playwright';

async function testRoadDragAndCrossingFix() {
  console.log('=== 道路ドラッグL字敷設時の角マス踏切誤生成防止＆プレビュー金額一致の検証 ===');
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

    // テスト1: 既存道路からの枝分かれL字ドラッグで、プレビュー金額と実請求額が完全一致するか
    console.log('--- テスト1: 既存道路からの枝分かれL字ドラッグ（金額・マス数の一致） ---');
    const test1Result = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const pc = app.placementController;
      const ui = app.uiManager;
      const econ = app.economy;

      // (10, 10) に既存道路を設置
      wm.setTile(10, 10, 'road', 1, 1, 1);
      const initialTile = wm.getTile(10, 10, 1);

      ui.selectTool('road');
      econ.funds = 10000000;
      const fundsBefore = econ.funds;

      // (10, 10) から (12, 12) へドラッグ (10,10)は既存道路
      // calculatePath: (10,10)[既], (11,10), (12,10)[角], (12,11), (12,12) -> 合計5マスのうち(10,10)が既存
      // プレビューと確定で4マス分が対象となるべき
      pc.updateDragPreview({ x: 10, z: 10 }, { x: 12, z: 12 });

      // hintText からプレビューマス数と金額を取得
      const hintText = document.getElementById('rotation-hint')?.textContent || '';
      const match = hintText.match(/(\d+)マス.*¥([0-9,]+)/);
      const previewCount = match ? parseInt(match[1], 10) : -1;
      const previewCost = match ? parseInt(match[2].replace(/,/g, ''), 10) : -1;

      // ドラッグ完了
      pc.finishDragPlacement();
      const pendingCount = pc.pendingItems.length;

      // 確定
      pc.confirmPendingPlacements();
      const fundsAfter = econ.funds;
      const actualSpent = fundsBefore - fundsAfter;

      return {
        initialTileType: initialTile?.type,
        hintText,
        previewCount,
        previewCost,
        pendingCount,
        actualSpent,
        isCountMatch: previewCount === pendingCount,
        isCostMatch: previewCost === actualSpent
      };
    });

    console.log('テスト1結果:', test1Result);
    if (!test1Result.isCountMatch) {
      throw new Error(`プレビュー件数(${test1Result.previewCount})と確定件数(${test1Result.pendingCount})が一致しません！`);
    }
    if (!test1Result.isCostMatch) {
      throw new Error(`プレビュー費用(${test1Result.previewCost})と実支出額(${test1Result.actualSpent})が一致しません！`);
    }
    console.log('✅ テスト1合格: プレビュー件数・費用と実請求額が完全一致しました！');

    // テスト2: 既存の東西線路に平行かつ重なる形で道路をL字ドラッグした際、角の1マスに誤って踏切が生成されないか
    console.log('--- テスト2: 平行線路上の道路L字ドラッグ時の角マス踏切誤生成防止 ---');
    const test2Result = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const pc = app.placementController;
      const ui = app.uiManager;
      const econ = app.economy;

      // (20, 20) から (23, 20) に東西線路（rail_ground, rot: 1=EW軸）を敷設
      for (let x = 20; x <= 23; x++) {
        wm.setTile(x, 20, 'rail_ground', 1, 1, 1);
      }

      ui.selectTool('road');

      // (20, 20) から (23, 22) へ道路をドラッグ
      // パス: (20,20)〜(22,20)は東西直線、(23,20)は角、(23,21)〜(23,22)は南北直線
      // (20,20)〜(23,20)には東西線路が存在する。
      // 角マス(23,20)で踏切（level_crossing）が誤生成されてはならない！
      pc.updateDragPreview({ x: 20, z: 20 }, { x: 23, z: 22 });
      pc.finishDragPlacement();

      // pendingItems の中に (23, 20) が含まれていないこと（線路保護によりスキップされること）
      const cornerPending = pc.pendingItems.find(p => p.x === 23 && p.z === 20);

      pc.confirmPendingPlacements();

      // (23, 20) のタイルが rail_ground のまま維持され、level_crossing になっていないこと
      const cornerTileAfter = wm.getTile(23, 20, 1);
      const isCornerTrackPreserved = cornerTileAfter?.type === 'rail_ground';

      // (23, 21), (23, 22) には道路が敷設されていること
      const roadTile1 = wm.getTile(23, 21, 1);
      const roadTile2 = wm.getTile(23, 22, 1);
      const areRoadsPlaced = roadTile1?.type === 'road' && roadTile2?.type === 'road';

      return {
        cornerPendingFound: !!cornerPending,
        cornerTileType: cornerTileAfter?.type,
        isCornerTrackPreserved,
        areRoadsPlaced
      };
    });

    console.log('テスト2結果:', test2Result);
    if (test2Result.cornerPendingFound) {
      throw new Error(`角マス(23, 20)が pendingItems に含まれており、平行線路上に誤って配置されようとしています！`);
    }
    if (!test2Result.isCornerTrackPreserved) {
      throw new Error(`角マス(23, 20)の線路が保護されず、タイプが ${test2Result.cornerTileType} に変更されてしまいました！`);
    }
    if (!test2Result.areRoadsPlaced) {
      throw new Error('更地部分(23, 21)-(23, 22)の道路が正常に敷設されていません！');
    }
    console.log('✅ テスト2合格: 角のマスで踏切が誤生成されることなく、既存線路が完全に保護されました！');

    // テスト3: 直線道路ドラッグで既存線路を真に直交横断した場合、正常に踏切が生成されるか
    console.log('--- テスト3: 直線道路ドラッグによる正しい踏切生成の健全性 ---');
    const test3Result = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const pc = app.placementController;
      const ui = app.uiManager;

      // (30, 18) から (30, 24) に南北線路（rail_ground, rot: 0=NS軸）を敷設
      for (let z = 18; z <= 24; z++) {
        wm.setTile(30, z, 'rail_ground', 0, 1, 1);
      }

      ui.selectTool('road');

      // (28, 21) から (32, 21) へ東西直線道路をドラッグ（(30, 21)で直交横断）
      pc.updateDragPreview({ x: 28, z: 21 }, { x: 32, z: 21 });
      pc.finishDragPlacement();
      pc.confirmPendingPlacements();

      const crossingTile = wm.getTile(30, 21, 1);
      const roadWest = wm.getTile(29, 21, 1);
      const roadEast = wm.getTile(31, 21, 1);

      return {
        crossingTileType: crossingTile?.type,
        crossingRailAxis: crossingTile?.rotation,
        crossingRoadAxis: crossingTile?.crossingRoadAxis,
        isCrossingCreated: crossingTile?.type === 'level_crossing',
        isRoadConnected: roadWest?.type === 'road' && roadEast?.type === 'road'
      };
    });

    console.log('テスト3結果:', test3Result);
    if (!test3Result.isCrossingCreated) {
      throw new Error(`直交横断マス(30, 21)で踏切が生成されませんでした (type: ${test3Result.crossingTileType})`);
    }
    if (!test3Result.isRoadConnected) {
      throw new Error('踏切前後の道路が正常に敷設されていません！');
    }
    console.log('✅ テスト3合格: 直線直交横断での踏切生成は正常に機能しています！');

    console.log('\n🎉 すべてのテストケースに合格しました！');
  } catch (err) {
    console.error('❌ テスト失敗:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

testRoadDragAndCrossingFix();
