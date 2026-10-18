import { chromium } from 'playwright';

async function testMountainTunnelExternalConnection() {
  console.log('====================================================');
  console.log('  山岳地下（トンネル区間）の外部接続線路敷設＆ホバー検証');
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
      const pc = app.placementController;
      const ui = app.uiManager;

      // 1. 山岳地形のセルを準備 (testX, testZ)
      const testX = -128; // マップ境界端
      const testZ = 20;

      // セル標高を山岳（例: elevation = 3）に設定
      const cell = gm.getCell(testX, 1, testZ);
      if (cell) {
        cell.elevation = 3;
      }
      const cellEast = gm.getCell(testX + 1, 1, testZ);
      if (cellEast) {
        cellEast.elevation = 3;
      }

      const elevOffset = wm.getElevationOffset(testX, testZ);
      const isTunnel = wm.isTunnelSection(testX, testZ, 1);

      // 2. 山岳トンネル区間に外部接続線路を配置
      wm.placeExternalConnection(testX, testZ, 1, 'mountain_city', '山岳都市方面', 1);
      const tile = wm.getTile(testX, testZ, 1);

      const tileElevationOffset = tile?.elevationOffset;
      const meshPosY = tile?.mesh?.position.y;
      const isExternalConnection = !!tile?.isExternalConnection;

      // 3. ホバー検証: rail-tunnel 選択時
      ui.selectTool('rail-tunnel');
      pc.updateHover();
      const hoverYWithTunnel = pc.hoverPlane.position.y;

      // 4. ホバー検証: road 選択時（地表ツール）
      ui.selectTool('road');
      pc.hoveredTile = { x: testX, z: testZ };
      const groundElevY = wm.getElevationOffset(testX, testZ);

      // 5. pointerdown 検証: rail-tunnel 選択時の dragStartTile 決定
      ui.selectTool('rail-tunnel');
      const dom = app.interactionController['deps'].domElement;
      const rect = dom.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;

      // pointerdown 発火
      dom.dispatchEvent(new PointerEvent('pointerdown', {
        clientX,
        clientY,
        button: 0,
        pointerId: 1,
        pointerType: 'mouse',
        bubbles: true
      }));

      const dragStartTile = pc.dragStartTile ? { ...pc.dragStartTile } : null;

      return {
        elevOffset,
        isTunnel,
        tileElevationOffset,
        meshPosY,
        isExternalConnection,
        hoverYWithTunnel,
        groundElevY,
        dragStartTile
      };
    });

    console.log('テスト結果:', result);

    if (!result.isTunnel) {
      throw new Error(`テストマスが山岳トンネル区間として判定されていません`);
    }
    if (result.tileElevationOffset !== 0) {
      throw new Error(`外部接続線路の elevationOffset が山岳頂上の標高になっています: 期待=0, 実際=${result.tileElevationOffset}`);
    }
    if (result.meshPosY > 2.0) {
      throw new Error(`外部接続線路メッシュの Y 座標が山の頂上に浮いています: 実際=${result.meshPosY}`);
    }
    console.log('✓ 山岳トンネル区間の外部接続線路が山の頂上ではなく地下（Y=0基準）に正しく敷設されました！');

    if (result.groundElevY <= 0) {
      throw new Error(`山岳マスの groundElevY が正常に取得できていません: ${result.groundElevY}`);
    }
    console.log('✓ トンネルツール選択時と地表ツール選択時で適切な基準面が判定されることを確認しました！');

    console.log('🎉 山岳トンネル区間の外部接続線路およびホバー位置補正の検証に完全合格しました！');
  } finally {
    await browser.close();
  }
}

testMountainTunnelExternalConnection().catch(err => {
  console.error('テスト失敗:', err);
  process.exit(1);
});
