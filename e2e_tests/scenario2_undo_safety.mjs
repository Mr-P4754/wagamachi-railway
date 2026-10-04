import { chromium } from 'playwright';

async function runScenario2() {
  console.log('=== シナリオ 2: Undo（元に戻す）機能と在線安全ガード テスト開始 ===');
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

    // タイトル画面があれば閉じてゲーム画面へ
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

    // 1. 直線線路を選択し、更地に3マス敷設して「設置を決定」を押す。所持金が減少したことを確認。
    console.log('  ステップ1: 直線線路3マスの仮置きと確定...');
    const placeResult = await page.evaluate(() => {
      const app = window.gameApp;
      if (!app) return { success: false, error: 'gameApp not found' };

      const pc = app.placementController;
      const wm = app.worldMap;
      const eco = app.economy;
      const initialFunds = eco.funds;

      // 既存の更地 (30, 30), (31, 30), (32, 30)
      for (let x = 30; x <= 32; x++) {
        wm.setTile(x, 30, 'empty', 0, 1, 'right', 1);
      }

      app.uiManager.selectTool('rail-straight');
      pc.stagePendingPlacement('rail-straight', 30, 30);
      pc.stagePendingPlacement('rail-straight', 31, 30);
      pc.stagePendingPlacement('rail-straight', 32, 30);

      const hasPending = pc.hasPendingPlacements();
      pc.confirmPendingPlacements();

      const fundsAfter = eco.funds;
      const isRailPlaced = [30, 31, 32].every(x => {
        const t = wm.getTile(x, 30, 1);
        return t && t.type === 'rail_ground';
      });

      return {
        success: true,
        initialFunds,
        fundsAfter,
        fundsReduced: fundsAfter < initialFunds,
        isRailPlaced,
        undoCanUndo: app.undoManager.canUndo()
      };
    });

    console.log('  敷設結果:', placeResult);
    if (!placeResult.fundsReduced || !placeResult.isRailPlaced || !placeResult.undoCanUndo) {
      throw new Error('線路敷設またはUndo可能フラグの更新に失敗しました: ' + JSON.stringify(placeResult));
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario2_step1_placed.png' });

    // 2. 画面上の「元に戻す (Undo)」ボタンをクリック（または Ctrl+Z を入力）する。
    // 敷設した線路が消去されて更地に戻り、消費した資金が全額返金されることを確認。
    console.log('  ステップ2: Undoボタンによる線路消去と全額返金確認...');
    const undoResult = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const eco = app.economy;

      const undoSuccess = app.undoManager.undo();
      const fundsAfterUndo = eco.funds;

      const isBackToEmpty = [30, 31, 32].every(x => {
        const t = wm.getTile(x, 30, 1);
        return !t || t.type === 'empty';
      });

      return {
        undoSuccess,
        fundsAfterUndo,
        isBackToEmpty
      };
    });

    console.log('  Undo結果:', undoResult);
    if (!undoResult.undoSuccess || !undoResult.isBackToEmpty || undoResult.fundsAfterUndo !== placeResult.initialFunds) {
      throw new Error('Undoによる線路消去または資金全額返金に失敗しました: ' + JSON.stringify(undoResult));
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario2_step2_undo_refunded.png' });

    // 3. 線路に列車を配置して走行させる。走行中の列車が通過している線路タイルに対して撤去ツールを実行しようと試みる（「撤去不可」トースト）。
    console.log('  ステップ3: 走行中列車上の線路に対する撤去安全ガード確認...');
    const trainSafetyResult = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const tm = app.trainManager;
      const ic = app.interactionController;

      // 線路を環状・直線に敷設
      for (let x = 20; x <= 26; x++) {
        wm.setTile(x, 25, 'rail_ground', 1, 1, 'right', 1);
      }

      // 列車をスポーン
      const train = tm.spawnTrain(22, 25, undefined, 2, undefined, undefined, 1);

      if (!train) return { success: false, error: 'Failed to spawn train' };

      // 占有情報即座更新
      tm.updateOccupancyNow();
      const isOccupied = tm.isTileOccupiedByTrain(22, 25, 1);

      // 撤去ツールを選択して列車上のタイル (22, 25) を撤去試行
      app.uiManager.selectTool('demolish-track');
      app.placementController.hoveredTile = { x: 22, z: 25 };
      ic.handleTileClick();

      // タイルが消去されずに残っていることを確認
      const tileAfter = wm.getTile(22, 25, 1);
      const isRailStillThere = tileAfter && tileAfter.type === 'rail_ground';

      return {
        success: true,
        trainId: train.id,
        isOccupied,
        isRailStillThere
      };
    });

    console.log('  在線撤去ガード結果:', trainSafetyResult);
    if (!trainSafetyResult.success || !trainSafetyResult.isRailStillThere) {
      throw new Error('在線中の線路撤去ガードに失敗しました（線路が消去されてしまいました）');
    }

    // 4. 列車がいない安全な線路を撤去ツールで撤去する（撤去費用が発生）。
    // 5. Undo を実行する。撤去された線路が元の向き・形状で即座に再生成され、撤去費用が返金されることを確認。
    console.log('  ステップ4 & 5: 安全な線路の撤去とUndo復元・返金確認...');
    const demolishAndUndoResult = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const eco = app.economy;
      const ic = app.interactionController;

      const fundsBeforeDemolish = eco.funds;
      // 列車から離れた安全なマス (26, 25)
      const tileBefore = wm.getTile(26, 25, 1);
      const origType = tileBefore?.type;
      const origRot = tileBefore?.rotation;

      app.uiManager.selectTool('demolish-track');
      app.placementController.hoveredTile = { x: 26, z: 25 };
      ic.handleTileClick();

      const fundsAfterDemolish = eco.funds;
      const tileDemolished = wm.getTile(26, 25, 1);
      const isDemolished = !tileDemolished || tileDemolished.type === 'empty';

      // Undo実行
      const undoOk = app.undoManager.undo();
      const fundsAfterUndo = eco.funds;
      const tileRestored = wm.getTile(26, 25, 1);

      return {
        fundsBeforeDemolish,
        fundsAfterDemolish,
        isDemolished,
        undoOk,
        fundsAfterUndo,
        isRestored: tileRestored && tileRestored.type === origType && tileRestored.rotation === origRot,
        fundsRefunded: fundsAfterUndo === fundsBeforeDemolish
      };
    });

    console.log('  撤去＆Undo復元結果:', demolishAndUndoResult);
    if (!demolishAndUndoResult.isDemolished || !demolishAndUndoResult.undoOk || !demolishAndUndoResult.isRestored || !demolishAndUndoResult.fundsRefunded) {
      throw new Error('線路撤去のUndo復元または返金に失敗しました: ' + JSON.stringify(demolishAndUndoResult));
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario2_step3_demolish_undo.png' });

    // 6. 走行中の列車の直前のマスに線路を設置し、その上に列車が乗り上げた状態で Undo（設置の取消）を試みる。
    // 在線安全ガードが働き、線路が消滅せず「列車が在線中のため取り消せません」トーストが表示されることを確認。
    console.log('  ステップ6: 列車在線マスでの設置取消（Undo）安全ガード確認...');
    const occupiedUndoGuardResult = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const pc = app.placementController;
      const tm = app.trainManager;

      // 新しいマス (27, 25) に線路を設置してUndoスタックに積む
      wm.setTile(27, 25, 'empty', 0, 1, 'right', 1);
      pc.stagePendingPlacement('rail-straight', 27, 25);
      pc.confirmPendingPlacements();

      // 列車をそのマス (27, 25) の直上に移動・在線させる
      const trains = tm.getTrains();
      if (trains.length > 0) {
        trains[0].currentTile = { x: 27, z: 25, layer: 1 };
        trains[0].frontPosition.set(27 * 4, 0, 25 * 4);
        trains[0].occupiedTiles = [{ x: 27, z: 25, layer: 1 }];
      }
      tm.updateOccupancyNow();

      // 在線状態でUndoを実行
      const undoResult = app.undoManager.undo();
      const tileStillRail = wm.getTile(27, 25, 1)?.type === 'rail_ground';

      return {
        undoResult, // 拒否されて false であるべき
        tileStillRail // 線路が消滅せず残っているべき
      };
    });

    console.log('  在線Undo安全ガード結果:', occupiedUndoGuardResult);
    if (occupiedUndoGuardResult.undoResult !== false || !occupiedUndoGuardResult.tileStillRail) {
      throw new Error('在線中の線路設置Undo安全ガードが機能しませんでした: ' + JSON.stringify(occupiedUndoGuardResult));
    }

    // 7. 駅名リネーム欄にフォーカスを当て、テキスト入力中に Ctrl+Z を押しても、ワールドのタイルが元に戻らないことを確認。
    console.log('  ステップ7: テキスト入力中のCtrl+ZによるワールドUndo誤動作防止確認...');
    const initialUndoCount = await page.evaluate(() => window.gameApp.undoManager.getHistoryCount());

    // 駅インスペクターを開くか、リネーム欄を直接フォーカス
    await page.evaluate(() => {
      const renameInput = document.getElementById('inspect-rename-input');
      const renameRow = document.getElementById('inspect-rename-row');
      const inspector = document.getElementById('inspector-panel');
      if (inspector) inspector.classList.remove('hidden');
      if (renameRow) renameRow.classList.remove('hidden');
      if (renameInput) {
        renameInput.focus();
        renameInput.value = '新駅名テスト';
      }
    });

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);

    const undoCountAfterInputCtrlZ = await page.evaluate(() => window.gameApp.undoManager.getHistoryCount());
    console.log('  テキスト入力中Ctrl+Z後のUndoスタック件数:', initialUndoCount, '->', undoCountAfterInputCtrlZ);

    if (undoCountAfterInputCtrlZ !== initialUndoCount) {
      throw new Error('テキスト入力中のCtrl+ZでワールドのUndoが誤動作しました');
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario2_step4_input_ctrlz_guard.png' });

    console.log('=== シナリオ 2: PASS ===\n');
    return { pass: true, errors: consoleErrors };
  } catch (err) {
    console.error('=== シナリオ 2: FAIL ===', err);
    await page.screenshot({ path: 'e2e_screenshots/scenario2_fail.png' }).catch(() => {});
    return { pass: false, error: err.message, errors: consoleErrors };
  } finally {
    await browser.close();
  }
}

runScenario2().then(res => {
  if (!res.pass) process.exit(1);
});
