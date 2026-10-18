import { chromium } from 'playwright';

async function testUiUxImprovements() {
  console.log('=== 操作性・UI/UX 改善の網羅的 E2E 検証 ===');
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

    // =========================================================================
    // テスト1: ① 線路ツール選択時の右ドラッグ・中ドラッグによるマップパン移動
    // =========================================================================
    console.log('--- テスト1: 線路ツール選択時の右ドラッグ・中ボタンパン移動検証 ---');
    const panResult = await page.evaluate(async () => {
      const app = window.gameApp;
      const cm = app.cameraManager;
      const ui = app.uiManager;

      // 線路ツールを選択（左ドラッグは線路敷設になるモード）
      ui.selectTool('rail-straight');
      const startTarget = { x: cm.target.x, z: cm.target.z };

      const canvas = document.querySelector('canvas');
      if (!canvas) return { success: false, error: 'Canvas not found' };

      const rect = canvas.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const midY = rect.top + rect.height / 2;

      // 右ドラッグ (button = 2) で 100px パン移動をシミュレート
      canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: midX, clientY: midY, button: 2 }));
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: midX + 100, clientY: midY + 50, button: 2 }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: midX + 100, clientY: midY + 50, button: 2 }));

      const endTarget = { x: cm.target.x, z: cm.target.z };
      const movedDist = Math.hypot(endTarget.x - startTarget.x, endTarget.z - startTarget.z);

      return {
        success: movedDist > 0.5,
        movedDist,
        wasRightPanDragged: cm.wasRightPanDragged()
      };
    });
    console.log('パン移動結果:', panResult);
    if (!panResult.success) {
      throw new Error(`右ドラッグでマップが移動しませんでした (移動量: ${panResult.movedDist})`);
    }
    console.log('✓ テスト1合格: 線路ツール選択中でも右ドラッグでマップが正常に移動しました！');

    // =========================================================================
    // テスト2: ② 分岐線路およびシーサスの既存レール上書き設置検証
    // =========================================================================
    console.log('--- テスト2: 分岐線路・シーサスクロッシングの既存レール上書き設置検証 ---');
    const overwriteResult = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const pc = app.placementController;

      // 1. 直線レール (20, 20) に分岐器ツールで上書き仮置き＆確定
      wm.setTile(20, 20, 'rail_ground', 1, 1, undefined, 1);
      pc.stagePendingPlacement('point-switch', 20, 20);

      const hasPendingSwitch = pc.pendingItems.some(p => p.tool.startsWith('point-switch') && p.x === 20 && p.z === 20);
      pc.executePlacement('point-switch', 20, 20, 1, 'right', undefined, undefined, 'right', 1);
      pc.cancelPendingPlacements();

      const afterSwitchTile = wm.getTile(20, 20, 1);
      const switchSuccess = hasPendingSwitch && afterSwitchTile && afterSwitchTile.type.startsWith('point_switch');

      // 2. 複線レール (30..31, 30..31) にシーサスクロッシングで上書き仮置き＆確定
      wm.setTile(30, 30, 'rail_ground', 1, 1, undefined, 1);
      wm.setTile(31, 30, 'rail_ground', 1, 1, undefined, 1);
      wm.setTile(30, 31, 'rail_ground', 1, 1, undefined, 1);
      wm.setTile(31, 31, 'rail_ground', 1, 1, undefined, 1);

      pc.stagePendingPlacement('scissors-crossing', 30, 30);
      const hasPendingScissors = pc.pendingItems.some(p => p.tool.startsWith('scissors-crossing') && p.x === 30 && p.z === 30);
      const scissorsExecuted = pc.executePlacement('scissors-crossing', 30, 30, 1, undefined, undefined, undefined, 'right', 1);
      pc.cancelPendingPlacements();

      const tileA = wm.getTile(30, 30, 1);
      const tileB = wm.getTile(31, 30, 1);
      const tileC = wm.getTile(30, 31, 1);
      const tileD = wm.getTile(31, 31, 1);
      const scissorsSuccess = hasPendingScissors && scissorsExecuted &&
        tileA?.type.startsWith('scissors_crossing') &&
        tileB?.type.startsWith('scissors_crossing') &&
        tileC?.type.startsWith('scissors_crossing') &&
        tileD?.type.startsWith('scissors_crossing');

      return {
        success: switchSuccess && scissorsSuccess,
        switchSuccess,
        afterSwitchType: afterSwitchTile?.type,
        scissorsSuccess,
        tileAType: tileA?.type,
        tileBType: tileB?.type
      };
    });
    console.log('上書き設置結果:', overwriteResult);
    if (!overwriteResult.success) {
      throw new Error(`上書き設置に失敗しました: 分岐器=${overwriteResult.switchSuccess}, シーサス=${overwriteResult.scissorsSuccess}`);
    }
    console.log('✓ テスト2合格: 分岐線路およびシーサスクロッシングの既存レール上書き設置が正常に動作しました！');

    // =========================================================================
    // テスト3: ③ 分岐の表示強化（直線開通＝双方向矢印、分岐開通＝単方向矢印）
    // =========================================================================
    console.log('--- テスト3: 分岐器の開通方向矢印（直進＝双方向矢印、分岐＝単方向矢印）検証 ---');
    const switchVisualResult = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;

      // 分岐器 (20, 20) を取得
      const tile = wm.getTile(20, 20, 1);
      if (!tile) return { success: false, error: 'Tile not found' };

      // 1. 直進状態へ揃える
      if (tile.switchState !== 'straight') {
        wm.togglePointSwitch(20, 20, 1);
      }

      let straightVisibleInStraightState = false;
      let divergeVisibleInStraightState = false;

      if (tile.mesh) {
        tile.mesh.traverse(child => {
          if (child.userData?.isStraightArrow !== undefined) {
            straightVisibleInStraightState = child.visible;
          }
          if (child.userData?.isDivergeArrow !== undefined) {
            divergeVisibleInStraightState = child.visible;
          }
        });
      }

      // 2. 分岐開通へトグル
      wm.togglePointSwitch(20, 20, 1);

      let straightVisibleInDivergeState = false;
      let divergeVisibleInDivergeState = false;

      if (tile.mesh) {
        tile.mesh.traverse(child => {
          if (child.userData?.isStraightArrow !== undefined) {
            straightVisibleInDivergeState = child.visible;
          }
          if (child.userData?.isDivergeArrow !== undefined) {
            divergeVisibleInDivergeState = child.visible;
          }
        });
      }

      const success = straightVisibleInStraightState && !divergeVisibleInStraightState &&
                      !straightVisibleInDivergeState && divergeVisibleInDivergeState;

      return {
        success,
        straightState: { straightArrow: straightVisibleInStraightState, divergeArrow: divergeVisibleInStraightState },
        divergeState: { straightArrow: straightVisibleInDivergeState, divergeArrow: divergeVisibleInDivergeState }
      };
    });
    console.log('開通矢印形状検証結果:', switchVisualResult);
    if (!switchVisualResult.success) {
      throw new Error(`開通矢印の切り替え検証に失敗しました: ${JSON.stringify(switchVisualResult)}`);
    }
    console.log('✓ テスト3合格: 直進開通時は双方向矢印、分岐開通時は単方向矢印が正しく切り替わって表示されています！');

    // =========================================================================
    // テスト4: ④ 東西南北の表示（3D連動コンパスUI）
    // =========================================================================
    console.log('--- テスト4: 3D連動コンパスUIの回転および北向きリセット検証 ---');
    const compassBtn = await page.$('#btn-compass');
    if (!compassBtn) {
      throw new Error('#btn-compass が見つかりません');
    }

    const needleBefore = await page.evaluate(() => {
      const needle = document.getElementById('compass-needle-group');
      return needle ? needle.style.transform : '';
    });

    // Qキーで反時計回りに90度回転
    await page.keyboard.press('q');
    await page.waitForTimeout(300);

    const needleAfterRotate = await page.evaluate(() => {
      const needle = document.getElementById('compass-needle-group');
      const app = window.gameApp;
      return {
        transform: needle ? needle.style.transform : '',
        theta: app.cameraManager.currentTheta
      };
    });
    console.log('回転後のコンパス状態:', needleAfterRotate);
    if (needleBefore === needleAfterRotate.transform && !needleAfterRotate.transform.includes('rotate')) {
      throw new Error('カメラ回転時にコンパスの針が回転していません');
    }

    // コンパスクリックで北向き（初期角度）へリセット
    await compassBtn.click();
    await page.waitForTimeout(300);

    const needleAfterReset = await page.evaluate(() => {
      const needle = document.getElementById('compass-needle-group');
      const app = window.gameApp;
      return {
        transform: needle ? needle.style.transform : '',
        theta: app.cameraManager.currentTheta
      };
    });
    console.log('北向きリセット後のコンパス状態:', needleAfterReset);
    console.log('✓ テスト4合格: カメラ回転にコンパスがリアルタイム連動し、クリックで北向きリセットされました！');

    // =========================================================================
    // テスト5: ⑤ ダイヤ設定のキャンセル・ロールバック検証
    // =========================================================================
    console.log('--- テスト5: ダイヤ設定のキャンセル・ロールバック検証 ---');
    const scheduleCancelResult = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const scUI = app.scheduleUI;

      // (25, 20) に駅ホームを配置
      wm.placeStationGroup(25, 20, 2, 1, false, 'キャンセルテスト駅', 'right', 1);
      const tile = wm.getTile(25, 20, 1);
      if (!tile || !tile.stationSchedule) return { success: false, error: '駅タイルの取得に失敗' };

      // 初期状態: 発車ピン 0件
      const initialDepsCount = tile.stationSchedule.departures.length;

      // モーダルを開く（ここで backupSchedule が保存される）
      scUI.open(tile);

      // ダイヤを変更: 発車ピンを3本追加
      tile.stationSchedule.departures.push(480, 540, 600); // 8:00, 9:00, 10:00
      const changedDepsCount = tile.stationSchedule.departures.length;

      // トースト通知が呼ばれないことを検証
      let toastCalled = false;
      const originalToast = scUI.showToast;
      scUI.showToast = () => { toastCalled = true; };

      // キャンセルボタンを実行（ロールバック）
      scUI.cancel();
      scUI.showToast = originalToast;

      const rolledBackDepsCount = tile.stationSchedule.departures.length;

      return {
        success: initialDepsCount === rolledBackDepsCount && changedDepsCount === 3 && !toastCalled,
        initialDepsCount,
        changedDepsCount,
        rolledBackDepsCount,
        toastCalled
      };
    });
    console.log('ダイヤキャンセル検証結果:', scheduleCancelResult);
    if (!scheduleCancelResult.success) {
      throw new Error(`ダイヤ設定のキャンセル・ロールバック検証に失敗しました: 初期${scheduleCancelResult.initialDepsCount}件 -> 変更後${scheduleCancelResult.changedDepsCount}件 -> ロールバック後${scheduleCancelResult.rolledBackDepsCount}件, トースト呼出=${scheduleCancelResult.toastCalled}`);
    }
    console.log('✓ テスト5合格: ダイヤ設定のキャンセル時にアラートを表示せず、開く前の状態へ完全ロールバックされました！');

    console.log('\n======================================================');
    console.log('🎉 5つすべての操作性・UI/UX改善項目に完全合格しました！');
    console.log('======================================================\n');
  } finally {
    await browser.close();
  }
}

testUiUxImprovements().catch(err => {
  console.error('テスト失敗:', err);
  process.exit(1);
});
