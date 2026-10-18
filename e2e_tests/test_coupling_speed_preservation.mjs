import { chromium } from 'playwright';

async function testCouplingSpeedPreservation() {
  console.log('=== 併合（連結）接近時の速度保持＆徐行分離テスト開始 ===');
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

    // テスト1: 先行列車の後方に接近した際、isApproachingCouple が true になるが train.speed は元の値を保持すること
    console.log('--- テスト1: 接近時 isApproachingCouple フラグ成立と train.speed の不変検証 ---');
    const test1Result = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const tm = app.trainManager;
      const cs = tm.collisionSystem;

      for (const t of tm.getTrains().slice()) tm.removeTrain(t.id);

      // 東西の線路 (z: 20, x: 8..25)
      for (let x = 8; x <= 25; x++) {
        wm.setTile(x, 20, 'rail_ground', 1, 1, undefined, 1);
      }

      // x: 12..19 (8マス) に駅ホームを配置
      wm.placeStationGroup(12, 20, 8, 1, false, '併合テスト駅', 'right', 1);

      // 先行列車 (leader: 2両) を (18, 20) で停止
      const leader = tm.spawnTrain(18, 20, undefined, 2, 1, undefined, 1);
      leader.isStopped = true;
      leader.stopMode = 'stop';
      leader.speed = 0;

      // 後続列車 (follower: 2両) を (15, 20) から東向きに進行
      // leaderの最後尾は (18-1*1.8=16.2)、followerの先頭は 15*2=30 なので接近している
      const follower = tm.spawnTrain(15, 20, undefined, 2, 1, undefined, 1);
      const originalSpeed = follower.speed;

      // ATS / 衝突判定を1回実行
      cs.checkAtsCollisionAvoidance([follower, leader], wm, 1);

      const isApproaching = !!follower.isApproachingCouple;
      const speedAfterAts = follower.speed;

      return {
        originalSpeed,
        speedAfterAts,
        isApproaching,
        isSpeedPreserved: speedAfterAts === originalSpeed,
        followerId: follower.id,
        leaderId: leader.id
      };
    });

    console.log('テスト1結果:', test1Result);
    if (!test1Result.isApproaching) {
      throw new Error('先行列車の後方に接近したにもかかわらず isApproachingCouple が true になりませんでした！');
    }
    if (!test1Result.isSpeedPreserved) {
      throw new Error(`follower.speed が直接書き換えられて低下してしまいました！ (元: ${test1Result.originalSpeed}, 現在: ${test1Result.speedAfterAts})`);
    }
    console.log('✅ テスト1合格: isApproachingCouple が正しく立ち、follower.speed は直接書き換えられず保護されました！');

    // テスト2: 先行列車が逃げた（発車または撤去された）際、isApproachingCouple が false に戻り、元の巡航速度で走行できること
    console.log('--- テスト2: 先行列車離脱後の通常速度復帰検証 ---');
    const test2Result = await page.evaluate(({ leaderId, followerId }) => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const tm = app.trainManager;
      const cs = tm.collisionSystem;

      // 先行列車を撤去
      tm.removeTrain(leaderId);

      const follower = tm.trains.find(t => t.id === followerId);
      if (!follower) return { error: 'follower not found' };

      // ATS / 衝突判定を再度実行
      cs.checkAtsCollisionAvoidance([follower], wm, 1);

      const isApproachingAfterClear = !!follower.isApproachingCouple;
      const speedAfterClear = follower.speed;

      // 1ステップ前進
      const progressBefore = follower.progress;
      const effectiveSpeed = follower.isApproachingCouple ? Math.min(follower.speed, 0.45) : follower.speed;
      tm.update(0.1, 1, () => {}, 12, 0);
      const progressAfter = follower.progress;

      return {
        isApproachingAfterClear,
        speedAfterClear,
        effectiveSpeed,
        progressDelta: progressAfter - progressBefore,
        isRestoredToFullSpeed: !isApproachingAfterClear && effectiveSpeed === speedAfterClear && speedAfterClear >= 1.0
      };
    }, { leaderId: test1Result.leaderId, followerId: test1Result.followerId });

    console.log('テスト2結果:', test2Result);
    if (!test2Result.isRestoredToFullSpeed) {
      throw new Error(`先行列車離脱後、通常速度に復帰していません！ (approaching: ${test2Result.isApproachingAfterClear}, effectiveSpeed: ${test2Result.effectiveSpeed})`);
    }
    console.log('✅ テスト2合格: 先行列車離脱後、即座に本来の巡航速度（1.5 tiles/sec）に復帰しました！');

    // テスト3: 実際の接触による併合（連結）動作の健全性確認
    console.log('--- テスト3: 接触による後方連結の正常動作確認 ---');
    const test3Setup = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const tm = app.trainManager;

      for (const t of tm.getTrains().slice()) tm.removeTrain(t.id);

      for (let x = 8; x <= 25; x++) {
        wm.setTile(x, 20, 'rail_ground', 1, 1, undefined, 1);
      }
      wm.placeStationGroup(15, 20, 4, 1, false, '併合テスト駅', 'right', 1);

      const btnSpeed = document.querySelector('#btn-speed-2');
      if (btnSpeed) btnSpeed.click();

      // leader (18, 20) で停止中 (2両)
      const leader = tm.spawnTrain(18, 20, undefined, 2, 1, undefined, 1);
      leader.isStopped = true;
      leader.stopMode = 'wait';
      leader.stopElapsedMinutes = 0;
      leader.requiredStopMinutes = 10;
      leader.speed = 0;

      // follower (14, 20) (2両)
      const follower = tm.spawnTrain(14, 20, undefined, 2, 1, undefined, 1);
      follower.speed = 2.0;

      return {
        leaderId: leader.id,
        followerId: follower.id
      };
    });

    let coupledAt = false;
    for (let f = 0; f < 300; f++) {
      await page.waitForTimeout(40);
      const state = await page.evaluate(({ lId, fId }) => {
        const app = window.gameApp;
        const tm = app.trainManager;
        const leader = tm.trains.find(t => t.id === lId);
        const follower = tm.trains.find(t => t.id === fId);
        return {
          leaderCars: leader ? leader.carCount : 0,
          followerExists: !!follower
        };
      }, { lId: test3Setup.leaderId, fId: test3Setup.followerId });

      if (!state.followerExists && state.leaderCars === 4) {
        coupledAt = true;
        break;
      }
    }

    if (!coupledAt) {
      throw new Error('指定時間内に併合が発生しませんでした');
    }
    console.log('✅ テスト3合格: 併合処理は正常に4両に連結完了しました！');

    console.log('\n🎉 すべてのテストケースに合格しました！');
  } catch (err) {
    console.error('❌ テスト失敗:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

testCouplingSpeedPreservation();
