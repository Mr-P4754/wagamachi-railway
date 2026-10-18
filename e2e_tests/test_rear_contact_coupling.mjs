import { chromium } from 'playwright';

async function testRearContactCoupling() {
  console.log('=== 先行列車最後尾接触時での併合（Coupling）E2E検証 ===');
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

    const btnSpeed = await page.$('#btn-speed-2');
    if (btnSpeed) await btnSpeed.click();
    await page.waitForTimeout(300);

    console.log('--- ステップ1: 有効長4マスの駅と先行列車（2両）の配置 ---');
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
      wm.placeStationGroup(15, 20, 4, 1, false, '併合テスト駅', 'right', 1);

      // 先行列車 (leader: 2両編成) を駅先頭 (18, 20) に東向きでスポーンし、停車状態にする
      const leader = tm.spawnTrain(18, 20, undefined, 2, 1, undefined, 1);
      if (!leader) return { success: false, error: 'Failed to spawn leader' };

      leader.isStopped = true;
      leader.stopMode = 'wait';
      leader.stopElapsedMinutes = 0;
      leader.requiredStopMinutes = 10; // 10分停車

      // 後続列車 (follower: 2両編成) を手前の線路 (12, 20) に東向きでスポーン
      const follower = tm.spawnTrain(12, 20, undefined, 2, 1, undefined, 1);
      if (!follower) return { success: false, error: 'Failed to spawn follower' };

      follower.speed = 2.0;

      const leaderRearCar = leader.cars[leader.carCount - 1];

      return {
        success: true,
        leaderId: leader.id,
        leaderFrontX: leader.frontPosition.x,
        leaderRearX: leaderRearCar.position.x,
        followerId: follower.id,
        followerFrontX: follower.frontPosition.x
      };
    });
    console.log('セットアップ結果:', setupResult);

    const leaderId = setupResult.leaderId;
    const followerId = setupResult.followerId;

    console.log('--- ステップ2: 後続列車の走行と最後尾接触での併合監視 ---');
    let coupledAt = null;
    let followerMaxX = 0;

    for (let f = 0; f < 400; f++) {
      await page.waitForTimeout(40);
      const state = await page.evaluate(({ lId, fId }) => {
        const app = window.gameApp;
        const tm = app.trainManager;
        const trains = tm.getTrains();

        const leader = trains.find(t => t.id === lId);
        const follower = trains.find(t => t.id === fId);

        return {
          trainCount: trains.length,
          leaderCars: leader ? leader.carCount : 0,
          leaderFrontX: leader ? leader.frontPosition.x : 0,
          leaderCarPositions: leader ? leader.cars.map(c => c.position.x) : [],
          followerExists: !!follower,
          followerFrontX: follower ? follower.frontPosition.x : 0,
          followerSpeed: follower ? follower.speed : 0,
          followerTile: follower ? `${follower.currentTile.x},${follower.currentTile.z}` : '',
          followerStopped: follower ? follower.isStopped : false,
          followerAtsCooldown: follower ? (follower.atsStopTimer ?? 0) : 0
        };
      }, { lId: leaderId, fId: followerId });

      if (f % 10 === 0 || !state.followerExists) {
        console.log(`[f=${f}] followerExists: ${state.followerExists}, followerX: ${state.followerFrontX?.toFixed(2)}, speed: ${state.followerSpeed?.toFixed(2)}, stopped: ${state.followerStopped}, leaderCars: ${state.leaderCars}`);
      }

      if (state.followerExists) {
        if (state.followerFrontX > followerMaxX) {
          followerMaxX = state.followerFrontX;
        }
      }

      if (!state.followerExists && state.leaderCars === 4 && !coupledAt) {
        coupledAt = {
          frame: f,
          followerMaxX,
          leaderCars: state.leaderCars,
          leaderFrontX: state.leaderFrontX,
          carPositions: state.leaderCarPositions
        };
        console.log(`✓ フレーム ${f} で併合検出:`, coupledAt);
        break;
      }
    }

    if (!coupledAt) {
      throw new Error('指定時間内に併合が発生しませんでした');
    }

    console.log('後続列車先頭の最大到達X座標:', coupledAt.followerMaxX.toFixed(2));
    console.log('先行列車先頭のX座標:', coupledAt.leaderFrontX.toFixed(2));

    // WorldMap.TILE_SIZE は 2.0。18 * 2.0 = 36.0 が先頭。最後尾は 34.05 付近。
    // 後続列車先頭が 35.0 以下（先行列車先頭 36.0 より手前、最後尾接触位置）で併合されていること！
    if (coupledAt.followerMaxX > 35.0) {
      throw new Error(`後続列車が先行列車の先頭近くまで進んでから併合されました！ (到達X: ${coupledAt.followerMaxX}, 先行車先頭: ${coupledAt.leaderFrontX})`);
    }

    console.log(`✓ 併合位置確認: 後続列車は最後尾（X: ~34.0）接触時点（最大到達X: ${coupledAt.followerMaxX.toFixed(2)}）で即座に併合されました！`);
    console.log('併合後の全車両位置 (X):', coupledAt.carPositions.map(x => x.toFixed(2)).join(', '));

    console.log('=== すべての併合検証テストに完全合格しました！ ===');

  } catch (err) {
    console.error('テスト失敗:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

testRearContactCoupling();
