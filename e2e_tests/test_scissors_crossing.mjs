import { chromium } from 'playwright';

async function runComprehensiveScissorsTest() {
  console.log('=== シーサスクロッシング分岐機能の網羅的E2E検証 ===');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl']
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

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

    // -------------------------------------------------------------------------
    // テスト1: 手動切り替え（cross-a）での渡り線動作検証
    // -------------------------------------------------------------------------
    console.log('--- テスト1: 手動切り替え (cross-a) ---');
    const t1Setup = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const tm = app.trainManager;

      for (const t of tm.getTrains().slice()) tm.removeTrain(t.id);

      wm.placeScissorsCrossing(20, 20, 0, false, 1);
      for (let z = 15; z <= 25; z++) {
        if (z < 20 || z > 21) {
          wm.setTile(20, z, 'rail_ground', 0, 1, undefined, 1);
          wm.setTile(19, z, 'rail_ground', 0, 1, undefined, 1);
        }
      }

      // 手動で cross-a に設定 (isTransient はデフォルト false)
      wm.setCrossingState(20, 20, 'cross-a', 1);

      const origin = wm.getTile(20, 20, 1);
      const train = tm.spawnTrain(20, 19, undefined, 1, 2, undefined, 1);
      if (!train) return { success: false };

      train.speed = 4.0;
      app.speedMultiplier = 5;

      return {
        success: true,
        originState: origin?.crossingState,
        originMode: origin?.switchSchedule?.mode
      };
    });
    console.log('テスト1 セットアップ:', t1Setup);
    if (t1Setup.originMode !== 'manual') {
      throw new Error(`手動切り替え後のモードが manual になっていません: ${t1Setup.originMode}`);
    }

    const t1Visited = [];
    for (let f = 0; f < 150; f++) {
      await page.waitForTimeout(40);
      const detail = await page.evaluate(() => {
        const app = window.gameApp;
        const train = app.trainManager.getTrains()[0];
        if (!train) return null;
        return {
          current: { ...train.currentTile },
          target: { ...train.targetTile },
          dir: { x: parseFloat(train.direction.x.toFixed(3)), z: parseFloat(train.direction.z.toFixed(3)) },
          crossingState: app.worldMap.getTile(20, 20, 1)?.crossingState
        };
      });
      if (detail) {
        const last = t1Visited[t1Visited.length - 1];
        if (!last || last.current.x !== detail.current.x || last.current.z !== detail.current.z) {
          t1Visited.push(detail);
        }
      }
    }
    console.log('テスト1 通過タイル:', t1Visited.map(v => `(${v.current.x}, ${v.current.z}) [state=${v.crossingState}]`).join(' -> '));

    const crossedTo19 = t1Visited.some(v => v.current.x === 19 && v.current.z === 21);
    if (!crossedTo19) {
      throw new Error('テスト1失敗: cross-a で対角タイル (19, 21) へ渡りませんでした！');
    }
    console.log('✓ テスト1成功: cross-a で対角線路へ正常に渡りました！');

    // -------------------------------------------------------------------------
    // テスト2: 手動切り替え（cross-b）での渡り線動作検証
    // -------------------------------------------------------------------------
    console.log('--- テスト2: 手動切り替え (cross-b) ---');
    const t2Setup = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const tm = app.trainManager;

      for (const t of tm.getTrains().slice()) tm.removeTrain(t.id);

      wm.setCrossingState(20, 20, 'cross-b', 1);

      const origin = wm.getTile(20, 20, 1);
      // 西側の線路 (19, 19) から進入
      const train = tm.spawnTrain(19, 19, undefined, 1, 2, undefined, 1);
      if (!train) return { success: false };

      train.speed = 4.0;
      app.speedMultiplier = 5;

      return {
        success: true,
        originState: origin?.crossingState,
        originMode: origin?.switchSchedule?.mode
      };
    });
    console.log('テスト2 セットアップ:', t2Setup);

    const t2Visited = [];
    for (let f = 0; f < 150; f++) {
      await page.waitForTimeout(40);
      const detail = await page.evaluate(() => {
        const app = window.gameApp;
        const train = app.trainManager.getTrains()[0];
        if (!train) return null;
        return {
          current: { ...train.currentTile },
          target: { ...train.targetTile },
          dir: { x: parseFloat(train.direction.x.toFixed(3)), z: parseFloat(train.direction.z.toFixed(3)) },
          crossingState: app.worldMap.getTile(20, 20, 1)?.crossingState
        };
      });
      if (detail) {
        const last = t2Visited[t2Visited.length - 1];
        if (!last || last.current.x !== detail.current.x || last.current.z !== detail.current.z) {
          t2Visited.push(detail);
        }
      }
    }
    console.log('テスト2 通過タイル:', t2Visited.map(v => `(${v.current.x}, ${v.current.z}) [state=${v.crossingState}]`).join(' -> '));

    const crossedTo20 = t2Visited.some(v => v.current.x === 20 && v.current.z === 21);
    if (!crossedTo20) {
      throw new Error('テスト2失敗: cross-b で対角タイル (20, 21) へ渡りませんでした！');
    }
    console.log('✓ テスト2成功: cross-b で対角線路へ正常に渡りました！');

    console.log('=== すべてのテストに完全合格しました！ ===');

  } catch (err) {
    console.error('テスト実行エラー:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

runComprehensiveScissorsTest();
