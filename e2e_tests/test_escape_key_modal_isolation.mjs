import { chromium } from 'playwright';

async function testEscapeKeyModalIsolation() {
  console.log('=== ESCキー押下時のダイヤモーダル・インスペクター同時反応防止検証 ===');
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

    // テスト1: インスペクターを開いた状態で ScheduleUI を開き、ESCを押すと ScheduleUI だけが閉じること
    console.log('--- テスト1: インスペクター表示中の ScheduleUI ESCキャンセル分離 ---');
    const test1Setup = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const ui = app.uiManager;
      const schedUI = app.scheduleUI;

      // 駅 (10, 10) を設置
      wm.placeStationGroup(10, 10, 2, 1, false, 'テスト駅', 'right', 1);
      const stTile = wm.getTile(10, 10, 1);

      // 1. 駅のインスペクターを開く
      ui.showInspector(stTile);
      const isInspectorOpenBefore = !document.getElementById('inspector-panel')?.classList.contains('hidden');

      // 2. ScheduleUI を開く
      schedUI.open(stTile);
      const isScheduleOpenBefore = schedUI.isOpen();

      return {
        isInspectorOpenBefore,
        isScheduleOpenBefore
      };
    });

    console.log('テスト1セットアップ:', test1Setup);
    if (!test1Setup.isInspectorOpenBefore || !test1Setup.isScheduleOpenBefore) {
      throw new Error('インスペクターまたはScheduleUIの初期オープンに失敗しました');
    }

    // ESCキーを1回送信
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    const test1AfterFirstEsc = await page.evaluate(() => {
      const app = window.gameApp;
      const ui = app.uiManager;
      const schedUI = app.scheduleUI;

      const isScheduleOpen = schedUI.isOpen();
      const isInspectorOpen = !document.getElementById('inspector-panel')?.classList.contains('hidden');

      return {
        isScheduleOpen,
        isInspectorOpen
      };
    });

    console.log('テスト1 (1回目ESC後):', test1AfterFirstEsc);
    if (test1AfterFirstEsc.isScheduleOpen) {
      throw new Error('ScheduleUI が ESCキーで閉じませんでした');
    }
    if (!test1AfterFirstEsc.isInspectorOpen) {
      throw new Error('ScheduleUI と同時にインスペクターも閉じてしまいました！（同時反応バグ）');
    }
    console.log('✓ ScheduleUI だけが閉じ、インスペクターは開いたまま維持されました！');

    const test1BeforeSecondEsc = await page.evaluate(() => {
      const app = window.gameApp;
      const pc = app.placementController;
      const fc = app.fleetController;
      const hadPending = pc.hasPendingPlacements() || fc.hasPendingDeploy();
      const activeElTag = document.activeElement ? document.activeElement.tagName : null;
      const activeElId = document.activeElement ? document.activeElement.id : null;
      return { hadPending, activeElTag, activeElId };
    });
    console.log('2回目ESC前状態:', test1BeforeSecondEsc);

    // もう1回 ESCキーを送信
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    const test1AfterSecondEsc = await page.evaluate(() => {
      const isInspectorOpen = !document.getElementById('inspector-panel')?.classList.contains('hidden');
      const activeElTag = document.activeElement ? document.activeElement.tagName : null;
      return { isInspectorOpen, activeElTag };
    });

    console.log('テスト1 (2回目ESC後):', test1AfterSecondEsc);
    if (test1AfterSecondEsc.isInspectorOpen) {
      throw new Error('2回目の ESCキーでインスペクターが閉じませんでした');
    }
    console.log('✅ テスト1合格: ESCキーによる ScheduleUI とインスペクターの段階的クローズが正常に動作しました！');

    // テスト2: SwitchScheduleUI 表示中の ESCキーキャンセル分離
    console.log('--- テスト2: SwitchScheduleUI 表示中の ESCキャンセル分離 ---');
    const test2Setup = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const ui = app.uiManager;
      const switchUI = app.switchScheduleUI;

      // 分岐器 (20, 20) を設置
      wm.setTile(20, 20, 'point_switch_ground', 0, 1, undefined, 1);
      const swTile = wm.getTile(20, 20, 1);

      ui.showInspector(swTile);
      const isInspectorOpenBefore = !document.getElementById('inspector-panel')?.classList.contains('hidden');

      switchUI.open(swTile);
      const isSwitchOpenBefore = switchUI.isOpen();

      return {
        isInspectorOpenBefore,
        isSwitchOpenBefore
      };
    });

    console.log('テスト2セットアップ:', test2Setup);
    if (!test2Setup.isInspectorOpenBefore || !test2Setup.isSwitchOpenBefore) {
      throw new Error('インスペクターまたはSwitchScheduleUIのオープンに失敗しました');
    }

    // ESCキーを1回送信
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    const test2AfterEsc = await page.evaluate(() => {
      const app = window.gameApp;
      const switchUI = app.switchScheduleUI;
      const isSwitchOpen = switchUI.isOpen();
      const isInspectorOpen = !document.getElementById('inspector-panel')?.classList.contains('hidden');

      return { isSwitchOpen, isInspectorOpen };
    });

    console.log('テスト2 (1回目ESC後):', test2AfterEsc);
    if (test2AfterEsc.isSwitchOpen) {
      throw new Error('SwitchScheduleUI が ESCキーで閉じませんでした');
    }
    if (!test2AfterEsc.isInspectorOpen) {
      throw new Error('SwitchScheduleUI と同時にインスペクターも閉じてしまいました！');
    }
    console.log('✅ テスト2合格: SwitchScheduleUI だけが閉じ、インスペクターは正常に維持されました！');

    console.log('\n🎉 すべてのテストケースに合格しました！');
  } catch (err) {
    console.error('❌ テスト失敗:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

testEscapeKeyModalIsolation();
