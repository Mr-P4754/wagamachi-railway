import { chromium } from 'playwright';

async function testCouplingSchedulePreservation() {
  console.log('=== 列車併合時の駅ホームダイヤ保持・UI検証 ===');
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

    const btnSpeed = await page.$('#btn-speed-3');
    if (btnSpeed) await btnSpeed.click();
    await page.waitForTimeout(300);

    console.log('--- ステップ1: 有効長4マスの駅を設置し、パターンダイヤと分割を設定 ---');
    const setupResult = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const tm = app.trainManager;

      for (const t of tm.getTrains().slice()) tm.removeTrain(t.id);

      // 東西の線路 (z: 20, x: 8..25)
      for (let x = 8; x <= 25; x++) {
        wm.setTile(x, 20, 'rail_ground', 1, 1, undefined, 1);
      }

      // x: 15..18 (4マス) に駅ホームを配置
      wm.placeStationGroup(15, 20, 4, 1, false, '併合ダイヤ駅', 'right', 1);

      // ダイヤ設定（パターンダイヤ: 毎時0分発、分割: ON 4両→2両+2両）
      const testSchedule = {
        departures: [],
        timeZones: [
          {
            startMin: 0,
            endMin: 1439,
            mode: 'pattern',
            patternMinute: 0,
            patternIntervalMinutes: 60,
            isReverse: false,
            isSplit: true,
            splitFrontCars: 2,
            splitRearCars: 2
          }
        ],
        reverseDepartures: [],
        splitDepartures: [],
        splitConfig: {
          enabled: true,
          frontCars: 2,
          rearCars: 2,
          frontDeparture: { mode: 'pass', waitMinutes: 0 },
          rearDeparture: { mode: 'pass', waitMinutes: 0 }
        }
      };

      // 駅ホームの先頭タイル (15, 20) にダイヤを設定し、全タイルに同期
      const startTile = wm.getStationStartTile(15, 20, 1);
      if (!startTile) return { success: false, error: 'Start tile not found' };

      const tiles = wm.getStationTiles(15, 20, 1);
      for (const t of tiles) {
        t.stationSchedule = JSON.parse(JSON.stringify(testSchedule));
      }

      // 先行列車 (leader: 2両編成) を (18, 20) に停車
      const leader = tm.spawnTrain(18, 20, undefined, 2, 1, undefined, 1);
      if (!leader) return { success: false, error: 'Failed to spawn leader' };
      leader.isStopped = true;
      leader.speed = 0;
      leader.stopMode = 'wait';
      leader.requiredStopMinutes = 10;

      // 後続列車 (follower: 2両編成) を手前 (12, 20) に進入状態で配置
      const follower = tm.spawnTrain(12, 20, undefined, 2, 1, undefined, 1);
      if (!follower) return { success: false, error: 'Failed to spawn follower' };
      follower.isStopped = false;
      follower.speed = 2.0;

      return {
        success: true,
        stationTilesCount: tiles.length,
        leaderId: leader.id,
        followerId: follower.id
      };
    });

    console.log('セットアップ結果:', setupResult);
    if (!setupResult.success) throw new Error(setupResult.error);

    console.log('--- ステップ2: シミュレーションを実行して併合を発生させる ---');
    let coupled = false;
    for (let frame = 0; frame < 300; frame++) {
      await page.waitForTimeout(40);
      const check = await page.evaluate(({ lId, fId }) => {
        const app = window.gameApp;
        const tm = app.trainManager;
        const trains = tm.getTrains();
        const leader = trains.find(t => t.id === lId);
        const follower = trains.find(t => t.id === fId);
        return {
          trainCount: trains.length,
          cars: leader?.carCount,
          followerExists: !!follower,
          isStopped: leader?.isStopped,
          stopMode: leader?.stopMode
        };
      }, { lId: setupResult.leaderId, fId: setupResult.followerId });

      if (frame % 20 === 0) {
        console.log(`[frame=${frame}] 列車数=${check.trainCount}, leader両数=${check.cars}, follower存在=${check.followerExists}`);
      }

      if (!check.followerExists && check.cars === 4) {
        coupled = true;
        console.log(`フレーム ${frame} で併合完了: 列車数=${check.trainCount}, 両数=${check.cars}, stopMode=${check.stopMode}`);
        break;
      }
    }

    if (!coupled) {
      throw new Error('列車が併合されませんでした');
    }

    console.log('--- ステップ3: 併合後のホーム全タイルの stationSchedule を検証 ---');
    const scheduleCheck = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const tiles = wm.getStationTiles(15, 20, 1);
      const results = tiles.map(t => ({
        pos: `(${t.x}, ${t.z})`,
        hasSchedule: !!t.stationSchedule,
        timeZonesCount: t.stationSchedule?.timeZones?.length ?? 0,
        hasSplitConfig: !!t.stationSchedule?.splitConfig?.enabled
      }));
      return results;
    });

    console.log('併合後タイルダイヤ状態:', scheduleCheck);
    for (const r of scheduleCheck) {
      if (!r.hasSchedule || r.timeZonesCount === 0 || !r.hasSplitConfig) {
        throw new Error(`タイル ${r.pos} のダイヤが消失しています: ${JSON.stringify(r)}`);
      }
    }

    console.log('--- ステップ4: 併合後にホームの任意のタイルをクリックして ScheduleUI を開く ---');
    const uiOpenCheck = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const schedUI = app.scheduleUI;

      // 併合時に後続車がいたタイル (16, 20) をクリックしてダイヤUIを開く
      const clickTile = wm.getTile(16, 20, 1);
      if (!clickTile) return { success: false, error: 'Tile not found' };

      schedUI.open(clickTile);

      // UIで読み込まれた currentTile のダイヤを検証
      const current = schedUI['currentTile'];
      const sched = current?.stationSchedule;

      return {
        success: true,
        currentPos: current ? `(${current.x}, ${current.z})` : null,
        timeZonesCount: sched?.timeZones?.length ?? 0,
        hasSplitConfig: !!sched?.splitConfig?.enabled,
        mode: sched?.timeZones?.[0]?.mode
      };
    });

    console.log('UIオープン時ダイヤ状態:', uiOpenCheck);
    if (!uiOpenCheck.success || uiOpenCheck.timeZonesCount === 0 || !uiOpenCheck.hasSplitConfig) {
      throw new Error(`ScheduleUI を開いた際にダイヤが消失しました: ${JSON.stringify(uiOpenCheck)}`);
    }

    console.log('=== 全ての検証をパスしました！列車併合時のダイヤ消失問題は完全に解消されています。 ===');
  } catch (err) {
    console.error('テスト失敗:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

testCouplingSchedulePreservation();
