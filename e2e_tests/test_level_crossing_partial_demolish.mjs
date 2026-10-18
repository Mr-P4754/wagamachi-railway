import { chromium } from 'playwright';

async function testLevelCrossingPartialDemolish() {
  console.log('====================================================');
  console.log('  踏切（level_crossing）の部分撤去およびUndo完全復元検証');
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
      const ic = app.interactionController;
      const undo = app.undoManager;

      const layer = 1;
      const tx = 5, tz = 5;

      // 事前に更地化
      wm.demolishTile(tx, tz, layer, 'all');

      // 1. 踏切を生成 (railAxis = 1(東西), roadAxis = 0(南北))
      // 道路の上に線路を敷く
      wm.setTile(tx, tz, 'road', 0, 1, 'right', layer);
      wm.setTile(tx, tz, 'rail_ground', 1, 1, 'right', layer);

      const tileInitial = wm.getTile(tx, tz, layer);
      const isInitialCrossing = tileInitial && tileInitial.type === 'level_crossing';
      const initialCrossingRoadAxis = tileInitial?.crossingRoadAxis;
      const initialRailRotation = tileInitial?.rotation;

      // 2. 線路撤去ツール (demolish-track) で踏切を撤去
      app.uiManager.selectTool('demolish-track');
      pc.hoveredTile = { x: tx, z: tz };
      ic.handleTileClick();

      const tileAfterTrackDemolish = wm.getTile(tx, tz, layer);
      const typeAfterTrackDemolish = tileAfterTrackDemolish?.type;
      const rotAfterTrackDemolish = tileAfterTrackDemolish?.rotation;

      // 3. Undo 実行（踏切に復元）
      const undoTrackOk = undo.undo();
      const tileAfterUndoTrack = wm.getTile(tx, tz, layer);
      const typeAfterUndoTrack = tileAfterUndoTrack?.type;

      // 4. 構造物撤去ツール (demolish-city) で踏切を撤去
      app.uiManager.selectTool('demolish-city');
      pc.hoveredTile = { x: tx, z: tz };
      ic.handleTileClick();

      const tileAfterCityDemolish = wm.getTile(tx, tz, layer);
      const typeAfterCityDemolish = tileAfterCityDemolish?.type;
      const rotAfterCityDemolish = tileAfterCityDemolish?.rotation;

      // 5. Undo 実行（踏切に復元）
      const undoCityOk = undo.undo();
      const tileAfterUndoCity = wm.getTile(tx, tz, layer);
      const typeAfterUndoCity = tileAfterUndoCity?.type;

      // 6. demolishMode = 'all' の場合は完全更地化
      wm.demolishTile(tx, tz, layer, 'all');
      const tileFinal = wm.getTile(tx, tz, layer);
      const typeFinal = tileFinal ? tileFinal.type : 'empty';

      return {
        step1_initial: {
          isInitialCrossing,
          initialCrossingRoadAxis,
          initialRailRotation
        },
        step2_demolishTrack: {
          typeAfterTrackDemolish,
          rotAfterTrackDemolish
        },
        step3_undoTrack: {
          undoTrackOk,
          typeAfterUndoTrack
        },
        step4_demolishCity: {
          typeAfterCityDemolish,
          rotAfterCityDemolish
        },
        step5_undoCity: {
          undoCityOk,
          typeAfterUndoCity
        },
        step6_demolishAll: {
          typeFinal
        }
      };
    });

    console.log('検証結果:', JSON.stringify(result, null, 2));

    let success = true;

    // Step 1: 踏切の初期生成
    if (!result.step1_initial.isInitialCrossing) {
      console.error('❌ Step 1 失敗: 線路と道路の交差で踏切が生成されていません。');
      success = false;
    } else {
      console.log('✅ Step 1 成功: 踏切（level_crossing）が正常に生成されました。');
    }

    // Step 2: 線路撤去ツールで道路 (road) が残ること
    if (result.step2_demolishTrack.typeAfterTrackDemolish !== 'road' || result.step2_demolishTrack.rotAfterTrackDemolish !== 0) {
      console.error('❌ Step 2 失敗: 線路撤去ツールで踏切を壊した際、道路に復元されていません。');
      success = false;
    } else {
      console.log('✅ Step 2 成功: 線路撤去ツールで踏切を撤去した際、交差していた道路（南北軸）が正常に残りました！');
    }

    // Step 3: Undo で踏切に復元
    if (!result.step3_undoTrack.undoTrackOk || result.step3_undoTrack.typeAfterUndoTrack !== 'level_crossing') {
      console.error('❌ Step 3 失敗: 線路撤去のUndoで踏切が復元されていません。');
      success = false;
    } else {
      console.log('✅ Step 3 成功: Undo で踏切が正常に復元されました。');
    }

    // Step 4: 構造物撤去ツールで地上線路 (rail_ground) が残ること
    if (result.step4_demolishCity.typeAfterCityDemolish !== 'rail_ground' || result.step4_demolishCity.rotAfterCityDemolish !== 1) {
      console.error('❌ Step 4 失敗: 構造物撤去ツールで踏切を壊した際、地上線路に復元されていません。');
      success = false;
    } else {
      console.log('✅ Step 4 成功: 構造物撤去ツールで踏切を撤去した際、交差していた線路（東西軸）が正常に残りました！');
    }

    // Step 5: Undo で踏切に復元
    if (!result.step5_undoCity.undoCityOk || result.step5_undoCity.typeAfterUndoCity !== 'level_crossing') {
      console.error('❌ Step 5 失敗: 構造物撤去のUndoで踏切が復元されていません。');
      success = false;
    } else {
      console.log('✅ Step 5 成功: Undo で踏切が正常に復元されました。');
    }

    // Step 6: 'all' で完全更地化
    if (result.step6_demolishAll.typeFinal !== 'empty') {
      console.error('❌ Step 6 失敗: demolishMode: all で完全更地化されていません。');
      success = false;
    } else {
      console.log('✅ Step 6 成功: demolishMode: all の場合は完全更地化されました。');
    }

    if (success) {
      console.log('\n🎉 すべてのテストに合格しました！踏切の部分撤去・Undo整合性は完璧です。');
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

testLevelCrossingPartialDemolish();
