import { chromium } from 'playwright';

async function testBuildingPopulationLifecycle() {
  console.log('====================================================');
  console.log('  建物建設・撤去・Undo 人口同期ライフサイクル検証');
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
      const econ = app.economy;
      const undo = app.undoManager;

      const layer = 1;
      const tx = 0, tz = 5; // 平地更地座標

      // 事前に更地化
      wm.demolishTile(tx, tz, layer);
      const initialPop = econ.population;

      // 1. 住宅を建設（ツール配置モード）
      app.uiManager.selectTool('building-res');
      pc.stagePendingPlacement('building-res', tx, tz);
      pc.confirmPendingPlacements();

      const popAfterResidence = econ.population;
      const typeAfterResidence = wm.getTile(tx, tz, layer)?.type;

      // 2. 撤去ツールで住宅を撤去
      app.uiManager.selectTool('demolish-city');
      pc.hoveredTile = { x: tx, z: tz };
      ic.handleTileClick();

      const popAfterDemolish = econ.population;
      const typeAfterDemolish = wm.getTile(tx, tz, layer)?.type;

      // 3. 撤去を Undo（住宅が復活）
      const undoDemolishOk = undo.undo();
      const popAfterUndoDemolish = econ.population;
      const typeAfterUndoDemolish = wm.getTile(tx, tz, layer)?.type;

      // 4. 住宅配置を Undo（更地に戻る）
      const undoResidenceOk = undo.undo();
      const popAfterUndoResidence = econ.population;
      const typeAfterUndoResidence = wm.getTile(tx, tz, layer)?.type;

      // 5. 商業を建設（ツール配置モード）
      app.uiManager.selectTool('building-com');
      pc.stagePendingPlacement('building-com', tx, tz);
      pc.confirmPendingPlacements();

      const popAfterCommercial = econ.population;
      const typeAfterCommercial = wm.getTile(tx, tz, layer)?.type;

      // 6. 商業配置を Undo（更地に戻る）
      const undoCommercialOk = undo.undo();
      const popAfterUndoCommercial = econ.population;
      const typeAfterUndoCommercial = wm.getTile(tx, tz, layer)?.type;

      // 7. 工業を建設（ツール配置モード）
      app.uiManager.selectTool('building-ind');
      pc.stagePendingPlacement('building-ind', tx, tz);
      pc.confirmPendingPlacements();

      const popAfterIndustrial = econ.population;
      const typeAfterIndustrial = wm.getTile(tx, tz, layer)?.type;

      // 8. 撤去ツールで工業を撤去
      app.uiManager.selectTool('demolish-city');
      pc.hoveredTile = { x: tx, z: tz };
      ic.handleTileClick();

      const popAfterDemolishInd = econ.population;
      const typeAfterDemolishInd = wm.getTile(tx, tz, layer)?.type;

      // 9. 撤去を Undo（工業が復活）
      const undoDemolishIndOk = undo.undo();
      const popAfterUndoDemolishInd = econ.population;
      const typeAfterUndoDemolishInd = wm.getTile(tx, tz, layer)?.type;

      return {
        initialPop,
        step1_residence: {
          pop: popAfterResidence,
          delta: popAfterResidence - initialPop,
          type: typeAfterResidence
        },
        step2_demolish: {
          pop: popAfterDemolish,
          delta: popAfterDemolish - initialPop,
          type: typeAfterDemolish
        },
        step3_undoDemolish: {
          ok: undoDemolishOk,
          pop: popAfterUndoDemolish,
          delta: popAfterUndoDemolish - initialPop,
          type: typeAfterUndoDemolish
        },
        step4_undoResidence: {
          ok: undoResidenceOk,
          pop: popAfterUndoResidence,
          delta: popAfterUndoResidence - initialPop,
          type: typeAfterUndoResidence
        },
        step5_commercial: {
          pop: popAfterCommercial,
          delta: popAfterCommercial - initialPop,
          type: typeAfterCommercial
        },
        step6_undoCommercial: {
          ok: undoCommercialOk,
          pop: popAfterUndoCommercial,
          delta: popAfterUndoCommercial - initialPop,
          type: typeAfterUndoCommercial
        },
        step7_industrial: {
          pop: popAfterIndustrial,
          delta: popAfterIndustrial - initialPop,
          type: typeAfterIndustrial
        },
        step8_demolishInd: {
          pop: popAfterDemolishInd,
          delta: popAfterDemolishInd - initialPop,
          type: typeAfterDemolishInd
        },
        step9_undoDemolishInd: {
          ok: undoDemolishIndOk,
          pop: popAfterUndoDemolishInd,
          delta: popAfterUndoDemolishInd - initialPop,
          type: typeAfterUndoDemolishInd
        }
      };
    });

    console.log('検証結果:', JSON.stringify(result, null, 2));

    let success = true;

    // Step 1: 住宅建設で人口 +30
    if (result.step1_residence.delta !== 30 || result.step1_residence.type !== 'residence') {
      console.error('❌ Step 1 失敗: 住宅建設で人口が +30 されていません。');
      success = false;
    } else {
      console.log('✅ Step 1 成功: 住宅建設で人口が正確に +30 増加しました。');
    }

    // Step 2: 撤去で人口 -30（初期値に復帰）
    if (result.step2_demolish.delta !== 0 || (result.step2_demolish.type !== 'empty' && result.step2_demolish.type !== undefined)) {
      console.error('❌ Step 2 失敗: 撤去で人口が初期値に減算復帰していません。');
      success = false;
    } else {
      console.log('✅ Step 2 成功: 撤去で人口が減算され、初期人口に正しく戻りました。');
    }

    // Step 3: 撤去取り消し (Undo) で人口 +30
    if (!result.step3_undoDemolish.ok || result.step3_undoDemolish.delta !== 30 || result.step3_undoDemolish.type !== 'residence') {
      console.error('❌ Step 3 失敗: 撤去のUndoで人口が再加算されていません。');
      success = false;
    } else {
      console.log('✅ Step 3 成功: 撤去のUndoで住宅が復活し、人口が元通り +30 復元されました。');
    }

    // Step 4: 住宅建設のUndoで更地（人口初期値）に復帰
    if (!result.step4_undoResidence.ok || result.step4_undoResidence.delta !== 0) {
      console.error('❌ Step 4 失敗: 建設Undoで初期人口に復帰していません。');
      success = false;
    } else {
      console.log('✅ Step 4 成功: 建設のUndoで更地に戻り、人口が初期人口に完全一致しました。');
    }

    // Step 5: 商業建設で人口加算
    if (result.step5_commercial.delta <= 0 || result.step5_commercial.type !== 'commercial') {
      console.error('❌ Step 5 失敗: 商業建設で人口が加算されていません。');
      success = false;
    } else {
      console.log(`✅ Step 5 成功: 商業建設で人口が +${result.step5_commercial.delta} 増加しました。`);
    }

    // Step 6: 商業建設のUndoで更地（人口初期値）に復帰
    if (!result.step6_undoCommercial.ok || result.step6_undoCommercial.delta !== 0) {
      console.error('❌ Step 6 失敗: 商業Undoで初期人口に復帰していません。');
      success = false;
    } else {
      console.log('✅ Step 6 成功: 商業建設のUndoで更地に戻り、人口が初期値に完全一致しました。');
    }

    // Step 7-9: 工業建設・撤去・Undo
    if (result.step7_industrial.delta <= 0 ||
        result.step8_demolishInd.delta !== 0 ||
        !result.step9_undoDemolishInd.ok ||
        result.step9_undoDemolishInd.delta !== result.step7_industrial.delta) {
      console.error('❌ Step 7-9 失敗: 工業建設・撤去・Undoの人口同期に問題があります。');
      success = false;
    } else {
      console.log('✅ Step 7-9 成功: 工業施設の建設・撤去・Undoでも人口が完全に同期しました。');
    }

    if (success) {
      console.log('\n🎉 すべてのテストに合格しました！建設・撤去・Undoの人口同期ライフサイクルは完璧です。');
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

testBuildingPopulationLifecycle();
