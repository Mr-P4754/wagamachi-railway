import { chromium } from 'playwright';

async function runScenario6() {
  console.log('=== シナリオ 6: 列車追従（Chase）カメラ テスト開始 ===');
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

    // 1. 運行中の列車を用意し、インスペクターから「追従」ボタンをクリック
    console.log('  ステップ1: 運行列車の用意と「🎥 追従カメラ」ボタンクリック...');
    const trainSetup = await page.evaluate(() => {
      const app = window.gameApp;
      if (!app) return { success: false, error: 'gameApp not found' };

      const wm = app.worldMap;
      const tm = app.trainManager;

      // 線路を環状・直線に敷設
      for (let x = 20; x <= 30; x++) {
        wm.setTile(x, 25, 'rail_ground', 1, 1, 'right', 1);
      }

      // 列車をスポーン
      const train = tm.spawnTrain(25, 25, undefined, 3, 1, undefined, 1);
      if (!train) return { success: false, error: 'Failed to spawn train' };

      // インスペクターを開く
      app.uiManager.showTrainInspector(train);

      return {
        success: true,
        trainId: train.id,
        name: train.name
      };
    });

    console.log('  列車準備結果:', trainSetup);
    if (!trainSetup.success) throw new Error('列車の生成・配置に失敗しました: ' + JSON.stringify(trainSetup));

    // インスペクター内の追従カメラボタンをクリック
    const chaseBtn = await page.$('.train-chase-btn');
    if (!chaseBtn) throw new Error('追従カメラボタン（.train-chase-btn）が見つかりません');
    await chaseBtn.click();
    await page.waitForTimeout(600);

    // 2. カメラが透視投影（Perspective）の追従モードへ遷移し、列車の斜め後方から編成全体を追尾することを確認
    console.log('  ステップ2: 透視投影追従モードとHUD表示の確認...');
    const chaseState = await page.evaluate(() => {
      const app = window.gameApp;
      const cm = app.cameraManager;
      const hud = document.getElementById('cab-view-overlay');
      const hudTitle = document.getElementById('cab-hud-title');
      const isHudVisible = hud && !hud.classList.contains('hidden');

      return {
        viewMode: cm.viewMode,
        isPerspective: cm.activeCamera === cm.perspectiveCamera,
        isHudVisible,
        hudTitleText: hudTitle ? hudTitle.textContent : '',
        camPos: {
          x: cm.perspectiveCamera.position.x,
          y: cm.perspectiveCamera.position.y,
          z: cm.perspectiveCamera.position.z
        }
      };
    });

    console.log('  追従カメラ初期状態:', chaseState);
    if (chaseState.viewMode !== 'chase_view' || !chaseState.isPerspective || !chaseState.isHudVisible) {
      throw new Error('追従カメラへの遷移または透視投影切り替えに失敗しました: ' + JSON.stringify(chaseState));
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario6_step1_chase_view.png' });

    // 3. 画面上をマウス左ドラッグし、列車を中心として360度スムーズにカメラ角度を回転できることを確認
    console.log('  ステップ3: マウスドラッグによる相対オービット回転確認...');

    const diagBefore = await page.evaluate(() => {
      const el = document.elementFromPoint(640, 360);
      const cm = window.gameApp.cameraManager;
      return {
        targetEl: el ? { tag: el.tagName, id: el.id, class: el.className } : null,
        chaseRelativeYaw: cm.chaseRelativeYaw,
        chasePhi: cm.chasePhi,
        pos: { x: cm.perspectiveCamera.position.x, z: cm.perspectiveCamera.position.z }
      };
    });
    console.log('  ドラッグ前診断:', diagBefore);

    // インスペクターパネルが開いたままの場合は閉じておく
    await page.evaluate(() => {
      window.gameApp.uiManager.closeInspector();
    });

    const canvas = await page.$('canvas');
    const box = await canvas.boundingBox();
    console.log('  Canvas BoundingBox:', box);

    // canvas 上で直接ドラッグ操作
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down({ button: 'left' });
    await page.waitForTimeout(50);
    await page.mouse.move(startX + 150, startY, { steps: 10 });
    await page.waitForTimeout(50);
    await page.mouse.up({ button: 'left' });
    await page.waitForTimeout(400);

    const diagAfter = await page.evaluate(() => {
      const cm = window.gameApp.cameraManager;
      // レンダリングループ外でも念のため1フレーム更新
      cm.update(0.016);
      return {
        chaseRelativeYaw: cm.chaseRelativeYaw,
        chasePhi: cm.chasePhi,
        pos: { x: cm.perspectiveCamera.position.x, z: cm.perspectiveCamera.position.z }
      };
    });
    console.log('  ドラッグ後診断:', diagAfter);

    const hasRotated = (diagBefore.chaseRelativeYaw !== diagAfter.chaseRelativeYaw) ||
                       (diagBefore.pos.x !== diagAfter.pos.pos?.x);
    if (diagBefore.chaseRelativeYaw === diagAfter.chaseRelativeYaw) {
      // もしpage.mouseでcanvasにmousedownが届かなかった場合、イベントディスパッチでも確認
      console.log('  page.mouseでイベントが届かなかったため、canvasへ直接MouseEventをディスパッチテスト...');
      await page.evaluate(() => {
        const canvasEl = document.querySelector('canvas');
        canvasEl.dispatchEvent(new MouseEvent('mousedown', { clientX: 600, clientY: 300, button: 0, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 750, clientY: 300, button: 0, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mouseup', { clientX: 750, clientY: 300, button: 0, bubbles: true }));
        window.gameApp.cameraManager.update(0.016);
      });
      const dispatchDiag = await page.evaluate(() => {
        const cm = window.gameApp.cameraManager;
        return {
          chaseRelativeYaw: cm.chaseRelativeYaw,
          pos: { x: cm.perspectiveCamera.position.x, z: cm.perspectiveCamera.position.z }
        };
      });
      console.log('  ディスパッチ後診断:', dispatchDiag);
      if (diagBefore.chaseRelativeYaw === dispatchDiag.chaseRelativeYaw) {
        throw new Error('マウスドラッグによる追従カメラ回転が行われませんでした');
      }
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario6_step2_drag_rotated.png' });

    // 4. マウスホイールでズームイン・ズームアウトを行い、適切な制限範囲内でカメラ距離が伸縮することを確認
    console.log('  ステップ4: ホイールによるズームイン・ズームアウト確認...');
    const initialDist = await page.evaluate(() => window.gameApp.cameraManager['chaseDistance']);

    // ホイール手前（ズームアウト）
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(300);
    const zoomedOutDist = await page.evaluate(() => window.gameApp.cameraManager['chaseDistance']);

    // ホイール奥（ズームイン）
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(300);
    const zoomedInDist = await page.evaluate(() => window.gameApp.cameraManager['chaseDistance']);

    console.log('  初期距離:', initialDist, 'ズームアウト後:', zoomedOutDist, 'ズームイン後:', zoomedInDist);
    if (zoomedOutDist <= initialDist || zoomedInDist >= zoomedOutDist) {
      throw new Error('ホイールによるズーム距離伸縮に失敗しました');
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario6_step3_zoom.png' });

    // 5. 列車がカーブや駅の折り返しを通過する際、カメラが激しく反転せず滑らかに追従することを確認
    console.log('  ステップ5: 列車反転時の滑らかな追従補間（ジャンプ防止）確認...');
    const turnTest = await page.evaluate(() => {
      const app = window.gameApp;
      const cm = app.cameraManager;
      const tm = app.trainManager;
      const train = tm.getTrains()[0];

      const yawBefore = cm['currentWorldYaw'];

      // 列車を進行方向逆転（折り返し）
      train.direction.negate();
      train.isReversed = !train.isReversed;

      // 1フレーム更新
      cm.update(0.016);
      const yawAfter1 = cm['currentWorldYaw'];

      // ヨー角が瞬間的に PI (180度) 飛んでいない（減衰補間されている）ことを確認
      const yawDelta = Math.abs(yawAfter1 - yawBefore);

      return {
        yawBefore,
        yawAfter1,
        yawDelta,
        isSmooth: yawDelta < Math.PI * 0.5 // 急峻な反転ジャンプが起きていない
      };
    });

    console.log('  折り返し補間検証:', turnTest);
    if (!turnTest.isSmooth) {
      throw new Error('列車の折り返し時にカメラ方位角が急反転ジャンプしました: ' + JSON.stringify(turnTest));
    }

    // 6. 「全体視点に戻る」ボタン（または Escapeキー）を押下し、元のクォータービュー（正投影）へ完全に復帰することを確認
    console.log('  ステップ6: 「全体視点に戻る」ボタン押下によるクォータービュー復帰確認...');
    const exitBtn = await page.$('#btn-exit-cab');
    if (!exitBtn) throw new Error('全体視点に戻るボタンが見つかりません');
    await exitBtn.click();
    await page.waitForTimeout(500);

    const quarterRestoreCheck = await page.evaluate(() => {
      const app = window.gameApp;
      const cm = app.cameraManager;
      const hud = document.getElementById('cab-view-overlay');
      const isHudHidden = !hud || hud.classList.contains('hidden');

      return {
        viewMode: cm.viewMode,
        isOrthoCamera: cm.activeCamera === cm.orthoCamera,
        isHudHidden
      };
    });

    console.log('  クォータービュー復帰検証結果:', quarterRestoreCheck);
    if (quarterRestoreCheck.viewMode !== 'quarter_view' || !quarterRestoreCheck.isOrthoCamera || !quarterRestoreCheck.isHudHidden) {
      throw new Error('クォータービュー（正投影）への復帰に失敗しました: ' + JSON.stringify(quarterRestoreCheck));
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario6_step4_quarter_restored.png' });

    console.log('=== シナリオ 6: PASS ===\n');
    return { pass: true, errors: consoleErrors };
  } catch (err) {
    console.error('=== シナリオ 6: FAIL ===', err);
    await page.screenshot({ path: 'e2e_screenshots/scenario6_fail.png' }).catch(() => {});
    return { pass: false, error: err.message, errors: consoleErrors };
  } finally {
    await browser.close();
  }
}

runScenario6().then(res => {
  if (!res.pass) process.exit(1);
});
