import { chromium } from 'playwright';

async function testDepartureMinuteEdgeFix() {
  console.log('=== ダイヤ判定（分境界＆到着時現在分取りこぼし防止）の検証 ===');
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

    // テスト1: 駅到着と同じ分（例: 08:00ちょうど）がパターン発車時刻の場合、即座に評価されて発車できるか
    console.log('--- テスト1: 駅到着と同分のパターンダイヤ発車（prevTotal === currentTotalMin） ---');
    const test1Result = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const tm = app.trainManager;
      const timeMgr = app.timeManager;

      // 時刻を 08:00 にセット
      timeMgr.hour = 8;
      timeMgr.minute = 0;

      // 駅 (15, 15) を設置
      wm.setTile(15, 15, 'station', 1, 1, 1);
      const stTile = wm.getTile(15, 15, 1);
      // パターンダイヤ（毎時00分発）を設定
      stTile.stationSchedule = {
        name: '中央駅',
        mode: 'pattern',
        departures: [],
        timeZones: [
          {
            startMin: 0,
            endMin: 1440,
            mode: 'pattern',
            patternMinute: 0,
            patternIntervalMinutes: 60
          }
        ]
      };

      // 前後に線路を敷設
      wm.setTile(14, 15, 'rail_ground', 1, 1, 1);
      wm.setTile(16, 15, 'rail_ground', 1, 1, 1);
      wm.setTile(17, 15, 'rail_ground', 1, 1, 1);

      // (15, 15) に列車をスポーンして停車状態にする
      const train = tm.spawnTrain(15, 15, undefined, 2, 1, undefined, 1);
      train.isStopped = true;
      train.stopMode = 'pattern';
      train.stopElapsedMinutes = 0;
      train.requiredStopMinutes = 0;
      train.lastEvaluatedMinute = undefined; // 到着時リセット相当

      // 1ステップ時間を進める（同一分内: 08:00）
      // prevTotal = 480, currentTotalMin = 480 なので prevTotal !== currentTotalMin は false
      // だが lastEvaluatedMinute !== currentTotalMin により shouldEvaluateSchedule が true になり発車できるはず
      const wasStoppedBefore = train.isStopped;
      tm.update(0.1, 1, () => {}, timeMgr.hour, timeMgr.minute);

      return {
        wasStoppedBefore,
        isStoppedAfter: train.isStopped,
        lastEvaluatedMinute: train.lastEvaluatedMinute,
        lastDepartureMinute: train.lastDepartureMinute,
        canDepartAtSameMinute: wasStoppedBefore && !train.isStopped
      };
    });

    console.log('テスト1結果:', test1Result);
    if (!test1Result.canDepartAtSameMinute) {
      throw new Error(`到着と同分のパターン発車時刻で発車できませんでした！ (isStoppedAfter: ${test1Result.isStoppedAfter})`);
    }
    console.log('✅ テスト1合格: 到着と同分（08:00）のパターン発車を逃さず即座に発車できました！');

    // テスト2: 5速（720倍速）進行時のダイヤ判定（1フレームで2分以上進んだ場合）
    console.log('--- テスト2: 720倍速（1フレームで2分以上進行）時のパターン発車評価 ---');
    const test2Result = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const tm = app.trainManager;
      const timeMgr = app.timeManager;

      // 時刻を 09:28 (568分) にセット
      timeMgr.hour = 9;
      timeMgr.minute = 28;

      // 駅 (25, 25) を設置
      wm.setTile(25, 25, 'station', 1, 1, 1);
      const stTile = wm.getTile(25, 25, 1);
      // パターンダイヤ（毎時30分発）
      stTile.stationSchedule = {
        name: '高速駅',
        mode: 'pattern',
        departures: [],
        timeZones: [
          {
            startMin: 0,
            endMin: 1440,
            mode: 'pattern',
            patternMinute: 30,
            patternIntervalMinutes: 60
          }
        ]
      };

      wm.setTile(24, 25, 'rail_ground', 1, 1, 1);
      wm.setTile(26, 25, 'rail_ground', 1, 1, 1);
      wm.setTile(27, 25, 'rail_ground', 1, 1, 1);

      const train = tm.spawnTrain(25, 25, undefined, 2, 1, undefined, 1);
      train.isStopped = true;
      train.stopMode = 'pattern';
      train.stopElapsedMinutes = 0;
      train.requiredStopMinutes = 0;
      train.lastEvaluatedMinute = 568;

      // 720倍速でdeltaTime = 0.2秒（0.2 * 720 / 60 = 2.4分進行）
      // 09:28から09:30.4へ一気に進む
      timeMgr.hour = 9;
      timeMgr.minute = 30; // 09:30を跨ぐ

      const wasStoppedBefore = train.isStopped;
      tm.update(0.2, 720, () => {}, timeMgr.hour, timeMgr.minute);

      return {
        wasStoppedBefore,
        isStoppedAfter: train.isStopped,
        lastEvaluatedMinute: train.lastEvaluatedMinute,
        lastDepartureMinute: train.lastDepartureMinute,
        departedAcrossMinutes: wasStoppedBefore && !train.isStopped
      };
    });

    console.log('テスト2結果:', test2Result);
    if (!test2Result.departedAcrossMinutes) {
      throw new Error(`720倍速進行時（2分以上進行）に09:30発のパターンダイヤが跨がれたにもかかわらず発車しませんでした！`);
    }
    console.log('✅ テスト2合格: 720倍速で1フレームに2分以上進んだ場合でも、パターンダイヤを跨いで正常に発車しました！');

    // テスト3: overrideDepartureRule（編成個別ダイヤ）での動作確認
    console.log('--- テスト3: 編成個別発車ルール (overrideDepartureRule) の現在分評価 ---');
    const test3Result = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const tm = app.trainManager;
      const timeMgr = app.timeManager;

      // 時刻を 12:15 にセット
      timeMgr.hour = 12;
      timeMgr.minute = 15;

      // 駅 (35, 35) を設置
      wm.setTile(35, 35, 'station', 1, 1, 1);
      wm.setTile(34, 35, 'rail_ground', 1, 1, 1);
      wm.setTile(36, 35, 'rail_ground', 1, 1, 1);

      const train = tm.spawnTrain(35, 35, undefined, 2, 1, undefined, 1);
      train.isStopped = true;
      train.stopMode = 'pattern';
      train.stopElapsedMinutes = 0;
      train.requiredStopMinutes = 0;
      train.overrideDepartureRule = {
        mode: 'pattern',
        patternMinute: 15,
        patternIntervalMinutes: 30
      };
      train.lastEvaluatedMinute = undefined;

      const wasStoppedBefore = train.isStopped;
      tm.update(0.1, 1, () => {}, timeMgr.hour, timeMgr.minute);

      return {
        wasStoppedBefore,
        isStoppedAfter: train.isStopped,
        lastEvaluatedMinute: train.lastEvaluatedMinute,
        canDepartOverride: wasStoppedBefore && !train.isStopped
      };
    });

    console.log('テスト3結果:', test3Result);
    if (!test3Result.canDepartOverride) {
      throw new Error('編成個別ルールでの到着現在分発車に失敗しました！');
    }
    console.log('✅ テスト3合格: overrideDepartureRule においても現在分の発車評価が正常に動作しました！');

    console.log('\n🎉 ダイヤ判定の全テストケースに合格しました！');
  } catch (err) {
    console.error('❌ テスト失敗:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

testDepartureMinuteEdgeFix();
