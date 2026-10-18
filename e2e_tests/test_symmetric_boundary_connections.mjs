import { chromium } from 'playwright';

async function testSymmetricBoundaryConnections() {
  console.log('====================================================');
  console.log('  東西南北4方向の境界端対称性＆外部接続判定検証');
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
      const gm = app.gridManager;
      const ecm = app.externalConnectionManager;
      const gridSize = wm.gridSize;
      const half = Math.floor(gridSize / 2);

      // 1. 各境界端の isInBounds 検証
      const boundsCheck = {
        northBound: wm.isInBounds(0, -half),
        southBound: wm.isInBounds(0, half),
        westBound: wm.isInBounds(-half, 0),
        eastBound: wm.isInBounds(half, 0),
        beyondNorth: wm.isInBounds(0, -half - 1),
        beyondSouth: wm.isInBounds(0, half + 1),
        beyondWest: wm.isInBounds(-half - 1, 0),
        beyondEast: wm.isInBounds(half + 1, 0)
      };

      // 2. 各境界端の getCell 検証（例外発生せずセルが返ること）
      const cellsCheck = {
        northCell: !!gm.getCell(0, 1, -half),
        southCell: !!gm.getCell(0, 1, half),
        westCell: !!gm.getCell(-half, 1, 0),
        eastCell: !!gm.getCell(half, 1, 0)
      };

      // 3. 各境界端に線路を敷設し、getExternalConnectionDirection の対称性を検証
      // 北端: (0, -half), rotation: 0 (NS軸) -> 出口0(北)と2(南)を持つため 'north'
      wm.setTile(0, -half, 'rail_ground', 0, 1, 'right', 1);
      const northTile = wm.getTile(0, -half, 1);
      const northDir = northTile ? ecm.constructor.getExternalConnectionDirection(northTile, gridSize) : null;

      // 南端: (0, half), rotation: 0 (NS軸) -> 出口0(北)と2(南)を持つため 'south'
      wm.setTile(0, half, 'rail_ground', 0, 1, 'right', 1);
      const southTile = wm.getTile(0, half, 1);
      const southDir = southTile ? ecm.constructor.getExternalConnectionDirection(southTile, gridSize) : null;

      // 西端: (-half, 0), rotation: 1 (EW軸) -> 出口1(東)と3(西)を持つため 'west'
      wm.setTile(-half, 0, 'rail_ground', 1, 1, 'right', 1);
      const westTile = wm.getTile(-half, 0, 1);
      const westDir = westTile ? ecm.constructor.getExternalConnectionDirection(westTile, gridSize) : null;

      // 東端: (half, 0), rotation: 1 (EW軸) -> 出口1(東)と3(西)を持つため 'east'
      wm.setTile(half, 0, 'rail_ground', 1, 1, 'right', 1);
      const eastTile = wm.getTile(half, 0, 1);
      const eastDir = eastTile ? ecm.constructor.getExternalConnectionDirection(eastTile, gridSize) : null;

      // 4. checkConnections による4方向の外部都市接続検知
      ecm.checkConnections(wm);
      const connectedDirections = ecm.cities.filter(c => c.connected).map(c => c.direction);

      return {
        half,
        boundsCheck,
        cellsCheck,
        directions: {
          northDir,
          southDir,
          westDir,
          eastDir
        },
        connectedDirections
      };
    });

    console.log('テスト結果:', result);

    // 検証 1: 境界内外の判定
    if (!result.boundsCheck.northBound || !result.boundsCheck.southBound || !result.boundsCheck.westBound || !result.boundsCheck.eastBound) {
      throw new Error(`東西南北の境界線上のタイルで isInBounds が false になっています: ${JSON.stringify(result.boundsCheck)}`);
    }
    if (result.boundsCheck.beyondNorth || result.boundsCheck.beyondSouth || result.boundsCheck.beyondWest || result.boundsCheck.beyondEast) {
      throw new Error(`境界外のタイルで isInBounds が true になっています: ${JSON.stringify(result.boundsCheck)}`);
    }
    console.log('✓ isInBounds が東西南北すべてで ±half を境界端として完全対称に判定しています！');

    // 検証 2: 地形セルの取得
    if (!result.cellsCheck.northCell || !result.cellsCheck.southCell || !result.cellsCheck.westCell || !result.cellsCheck.eastCell) {
      throw new Error(`境界端の地表セル取得に失敗しました: ${JSON.stringify(result.cellsCheck)}`);
    }
    console.log('✓ GridManager.getCell が +half の境界端でも安全に地形セルを返却することを確認しました！');

    // 検証 3: 外部接続方向の判定
    if (result.directions.northDir !== 'north') throw new Error(`北端判定が不正です: ${result.directions.northDir}`);
    if (result.directions.southDir !== 'south') throw new Error(`南端判定が不正です: ${result.directions.southDir}`);
    if (result.directions.westDir !== 'west') throw new Error(`西端判定が不正です: ${result.directions.westDir}`);
    if (result.directions.eastDir !== 'east') throw new Error(`東端判定が不正です: ${result.directions.eastDir}`);
    console.log('✓ getExternalConnectionDirection が東西南北4方向すべてにおいて境界端タイルを正確に検知しました！');

    // 検証 4: checkConnections による接続成立
    const requiredDirs = ['north', 'south', 'east', 'west'];
    for (const d of requiredDirs) {
      if (!result.connectedDirections.includes(d)) {
        throw new Error(`方角 ${d} の外部都市接続が成立していません: ${JSON.stringify(result.connectedDirections)}`);
      }
    }
    console.log('✓ 東西南北4都市すべてで境界線上の線路敷設による幹線接続が成立することを確認しました！');

    console.log('🎉 東西南北の境界端対称性および外部接続判定の修正に完全合格しました！');
  } finally {
    await browser.close();
  }
}

testSymmetricBoundaryConnections().catch(err => {
  console.error('テスト失敗:', err);
  process.exit(1);
});
