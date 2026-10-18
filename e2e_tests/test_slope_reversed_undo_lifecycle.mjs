import { chromium } from 'playwright';

async function testSlopeReversedUndoLifecycle() {
  console.log('====================================================');
  console.log('  逆向きスロープ（高架・地下）の配置およびUndo完全復元検証');
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

    const result = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const pc = app.placementController;
      const undo = app.undoManager;

      const layer = 1;
      // 平坦な平地エリア
      const ox = -5, oz = -5;

      // 1. 逆向き高架スロープ (rotation = 2: axis 0(Z軸), reversed=true: 北(Z -1)方向へ4マス)
      // 対象マス: (-5, -5), (-5, -6), (-5, -7), (-5, -8)
      // 反対側（バグ時に誤って消されていたマス）: (-5, -4), (-5, -3), (-5, -2)
      for (let z = -9; z <= -2; z++) {
        wm.setTile(ox, z, 'empty', 0, 1, 'right', 1);
        wm.setTile(ox, z, 'empty', 0, 1, 'right', 2);
      }

      app.uiManager.selectTool('rail-slope');
      pc.currentRotation = 2; // reversed = true
      pc.stagePendingPlacement('rail-slope', ox, oz);
      pc.confirmPendingPlacements();

      const placedTilesElevated = [
        wm.getTile(ox, -5, 1)?.type,
        wm.getTile(ox, -6, 1)?.type,
        wm.getTile(ox, -7, 1)?.type,
        wm.getTile(ox, -8, 1)?.type
      ];
      const upperTilePlaced = wm.getTile(ox, -8, 2);
      const isUpperSlopePlaced = upperTilePlaced && upperTilePlaced.type === 'rail_slope';

      // 2. Undo 実行
      const undoElevatedOk = undo.undo();

      const undoneTilesElevated = [
        wm.getTile(ox, -5, 1)?.type ?? 'empty',
        wm.getTile(ox, -6, 1)?.type ?? 'empty',
        wm.getTile(ox, -7, 1)?.type ?? 'empty',
        wm.getTile(ox, -8, 1)?.type ?? 'empty'
      ];
      const upperTileUndone = wm.getTile(ox, -8, 2)?.type ?? 'empty';

      // 3. 逆向き地下スロープ (rail-slope-underground, rotation = 2)
      // 対象マス: (0, -5), (0, -6), (0, -7), (0, -8)
      const ux = 0, uz = -5;
      for (let z = -9; z <= -2; z++) {
        wm.setTile(ux, z, 'empty', 0, 1, 'right', 1);
        wm.setTile(ux, z, 'empty', 0, 1, 'right', -1);
      }

      app.uiManager.selectTool('rail-slope-underground');
      pc.currentRotation = 2; // reversed = true
      pc.stagePendingPlacement('rail-slope-underground', ux, uz);
      pc.confirmPendingPlacements();

      const placedTilesUnderground = [
        wm.getTile(ux, -5, 1)?.type,
        wm.getTile(ux, -6, 1)?.type,
        wm.getTile(ux, -7, 1)?.type,
        wm.getTile(ux, -8, 1)?.type
      ];
      const lowerTilePlaced = wm.getTile(ux, -8, -1);
      const isLowerSlopePlaced = lowerTilePlaced && lowerTilePlaced.type === 'rail_slope_underground';
      const hasHolePlaced = app.renderer.groundHoles.has(`${ux},${uz}`);

      // 4. 地下スロープの Undo 実行
      const undoUndergroundOk = undo.undo();

      const undoneTilesUnderground = [
        wm.getTile(ux, -5, 1)?.type ?? 'empty',
        wm.getTile(ux, -6, 1)?.type ?? 'empty',
        wm.getTile(ux, -7, 1)?.type ?? 'empty',
        wm.getTile(ux, -8, 1)?.type ?? 'empty'
      ];
      const lowerTileUndone = wm.getTile(ux, -8, -1)?.type ?? 'empty';
      const hasHoleUndone = app.renderer.groundHoles.has(`${ux},${uz}`);

      return {
        step1_elevatedSlope: {
          placedTilesElevated,
          isUpperSlopePlaced
        },
        step2_undoElevated: {
          undoElevatedOk,
          undoneTilesElevated,
          upperTileUndone
        },
        step3_undergroundSlope: {
          placedTilesUnderground,
          isLowerSlopePlaced,
          hasHolePlaced
        },
        step4_undoUnderground: {
          undoUndergroundOk,
          undoneTilesUnderground,
          lowerTileUndone,
          hasHoleUndone
        }
      };
    });

    console.log('検証結果:', JSON.stringify(result, null, 2));

    let success = true;

    // Step 1: 逆向き高架スロープの配置
    const isStep1Placed = result.step1_elevatedSlope.placedTilesElevated.every(t => t === 'rail_slope') && result.step1_elevatedSlope.isUpperSlopePlaced;
    if (!isStep1Placed) {
      console.error('❌ Step 1 失敗: 逆向き高架スロープが正しく4マスおよび上位レイヤーに配置されていません。');
      success = false;
    } else {
      console.log('✅ Step 1 成功: 逆向き高架スロープが北方向4マス(-5〜-8)に正確に配置されました。');
    }

    // Step 2: 逆向き高架スロープのUndo
    const isStep2Undone = result.step2_undoElevated.undoElevatedOk &&
      result.step2_undoElevated.undoneTilesElevated.every(t => t === 'empty') &&
      result.step2_undoElevated.upperTileUndone === 'empty';
    if (!isStep2Undone) {
      console.error('❌ Step 2 失敗: 逆向き高架スロープのUndoで4マスおよび上位レイヤーが更地に完全復元されていません（残骸が残っています）。');
      success = false;
    } else {
      console.log('✅ Step 2 成功: 逆向き高架スロープのUndoで4マスおよび上位レイヤーの跨がり登録が完全に更地化復元されました！');
    }

    // Step 3: 逆向き地下スロープの配置
    const isStep3Placed = result.step3_undergroundSlope.placedTilesUnderground.every(t => t === 'rail_slope_underground') &&
      result.step3_undergroundSlope.isLowerSlopePlaced;
    if (!isStep3Placed) {
      console.error('❌ Step 3 失敗: 逆向き地下スロープが正しく4マスおよび地下レイヤーに配置されていません。');
      success = false;
    } else {
      console.log('✅ Step 3 成功: 逆向き地下スロープが北方向4マスに正確に配置されました。');
    }

    // Step 4: 逆向き地下スロープのUndo
    const isStep4Undone = result.step4_undoUnderground.undoUndergroundOk &&
      result.step4_undoUnderground.undoneTilesUnderground.every(t => t === 'empty') &&
      result.step4_undoUnderground.lowerTileUndone === 'empty' &&
      !result.step4_undoUnderground.hasHoleUndone;
    if (!isStep4Undone) {
      console.error('❌ Step 4 失敗: 逆向き地下スロープのUndoで更地化復元または開口マスク解除が失敗しました。');
      success = false;
    } else {
      console.log('✅ Step 4 成功: 逆向き地下スロープのUndoで4マス・地下レイヤー・開口マスクが完全にクリーンアップ復元されました！');
    }

    if (success) {
      console.log('\n🎉 すべてのテストに合格しました！逆向きスロープの配置・Undo整合性は完璧です。');
    } else {
      process.exitCode = 1;
    }

  } catch (err) {
    console.error('テスト実行エラー:', err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

testSlopeReversedUndoLifecycle();
