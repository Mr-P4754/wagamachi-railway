import { chromium } from 'playwright';

async function runCrossingAndCouplingTest() {
  console.log('=== 不具合検証テスト: 踏切横断および列車車両結合・追従間隔 ===');
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

    // タイトル画面があれば閉じる
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

    // 1. 線路（東西直線 x: 10〜25, z: 20）と道路（南北直線 x: 18, z: 15〜25）を敷設して踏切（18, 20）を自動生成
    console.log('  ステップ1: 線路・道路・踏切の生成...');
    const setupResult = await page.evaluate(() => {
      const app = window.gameApp;
      if (!app) return { success: false, error: 'gameApp not found' };

      const wm = app.worldMap;
      const tm = app.trainManager;

      // 既存列車をクリア
      for (const t of tm.getTrains().slice()) {
        tm.removeTrain(t.id);
      }

      // 東西の線路を敷設 (x: 10..25, z: 20, rotation: 1 = EW軸)
      for (let x = 10; x <= 25; x++) {
        wm.setTile(x, 20, 'rail_ground', 1, 1, 'right', 1);
      }

      // 南北の道路を敷設 (x: 18, z: 15..25, rotation: 0 = NS軸)
      for (let z = 15; z <= 25; z++) {
        if (z === 20) {
          // 線路と交差して踏切になる
          wm.setTile(18, z, 'road', 0, 1, 'right', 1);
        } else {
          wm.setTile(18, z, 'road', 0, 1, 'right', 1);
        }
      }

      const crossingTile = wm.getTile(18, 20, 1);

      // 2両編成の列車を (13, 20) に東向きでスポーン
      const train = tm.spawnTrain(13, 20, undefined, 2, 1, undefined, 1);
      if (!train) return { success: false, error: 'Failed to spawn train' };

      return {
        success: true,
        crossingTileType: crossingTile ? crossingTile.type : 'none',
        crossingRotation: crossingTile ? crossingTile.rotation : -1,
        trainId: train.id,
        carCount: train.carCount
      };
    });

    console.log('  セットアップ結果:', setupResult);
    if (!setupResult.success || setupResult.crossingTileType !== 'level_crossing') {
      throw new Error('踏切タイルの生成に失敗しました: ' + JSON.stringify(setupResult));
    }

    // 2. 進行速度「等速（▷、speedMultiplier = 1）」で列車を走行させ、
    // 車両が分離せず常に設計値（1.95）近傍を維持しながら踏切（18, 20）を横断することを確認
    console.log('  ステップ2: 等速走行（▷、1倍速）での踏切横断および車両間隔追跡...');
    let crossedCrossing = false;
    let maxCarDistance = 0;
    let minCarDistance = Infinity;

    // 等速（speedMultiplier = 1）で 300 ステップ走行（約 5.0 秒分、距離約 7.2 マス）
    for (let f = 0; f < 300; f++) {
      const stepData = await page.evaluate(() => {
        const app = window.gameApp;
        const tm = app.trainManager;
        const train = tm.getTrains()[0];
        if (!train) return null;

        // 等速（1倍速）で1フレーム更新
        tm.update(0.016, 1, () => {}, 12, 0);

        // 車両間距離の測定
        const car0Pos = train.cars[0].position;
        const car1Pos = train.cars[1].position;
        const carDist = car0Pos.distanceTo(car1Pos);

        return {
          currTile: train.currentTile,
          targetTile: train.targetTile,
          carDist,
          carCount: train.carCount,
          direction: { x: train.direction.x, z: train.direction.z },
          frontPos: { x: train.frontPosition.x, z: train.frontPosition.z }
        };
      });

      if (!stepData) throw new Error('列車インスタンスが消失しました');

      if (stepData.carDist > maxCarDistance) maxCarDistance = stepData.carDist;
      if (stepData.carDist < minCarDistance) minCarDistance = stepData.carDist;

      // 列車が踏切 (x: 18) を通過してそれより東 (x >= 19) に到達したか
      if (stepData.currTile.x >= 19) {
        crossedCrossing = true;
      }

      await page.waitForTimeout(5);
    }

    console.log('  等速走行での踏切横断確認:', crossedCrossing ? '✅ 横断成功 (x >= 19 到達)' : '❌ 踏切を横断できず');
    console.log(`  等速走行時の車両間隔 (設計値 1.95): 最小 ${minCarDistance.toFixed(3)}, 最大 ${maxCarDistance.toFixed(3)}`);

    if (!crossedCrossing) {
      throw new Error('列車が等速走行時に踏切（level_crossing）を横断せず、手前で停止または折り返しました');
    }

    // 車両間隔が 1.80 〜 2.15 の範囲内に保たれているか（分離や過度の接近がないこと）
    if (maxCarDistance > 2.20 || minCarDistance < 1.70) {
      throw new Error(`車両間隔の破綻（分離または重複）を検出しました: 最小 ${minCarDistance}, 最大 ${maxCarDistance}`);
    }

    // 3. 線路終端（x: 25）到達後の折り返し時における車両間隔の追跡
    console.log('  ステップ3: 線路終端での折り返しと反転直後の車両間隔検証...');
    let reversed = false;
    for (let f = 0; f < 100; f++) {
      const stepData = await page.evaluate(() => {
        const app = window.gameApp;
        const tm = app.trainManager;
        const train = tm.getTrains()[0];
        if (!train) return null;

        tm.update(0.016, 3, () => {}, 12, 0);

        const carDist = train.cars[0].position.distanceTo(train.cars[1].position);
        return {
          currTile: train.currentTile,
          direction: { x: train.direction.x, z: train.direction.z },
          carDist,
          isReversed: train.isReversed
        };
      });

      if (!stepData) break;
      if (stepData.carDist > maxCarDistance) maxCarDistance = stepData.carDist;
      if (stepData.carDist < minCarDistance) minCarDistance = stepData.carDist;

      // 西向き（折り返し後）に走行開始したか
      if (stepData.direction.x < -0.5) {
        reversed = true;
      }
      await page.waitForTimeout(20);
    }

    console.log('  線路終端折り返し確認:', reversed ? '✅ 折り返し走行確認' : '❌ 折り返し未確認');
    console.log(`  全走行（折り返し含む）車両間隔: 最小 ${minCarDistance.toFixed(3)}, 最大 ${maxCarDistance.toFixed(3)}`);

    if (!reversed) {
      throw new Error('線路終端での折り返しが正常に行われませんでした');
    }

    if (maxCarDistance > 2.20 || minCarDistance < 1.70) {
      throw new Error(`折り返し後の車両間隔の破綻（分離または重複）を検出しました: 最小 ${minCarDistance}, 最大 ${maxCarDistance}`);
    }

    await page.screenshot({ path: 'e2e_screenshots/crossing_and_coupling_pass.png' });

    console.log('=== 不具合検証テスト: PASS（踏切横断・車両間隔ともに正常） ===\n');
    return { pass: true, errors: consoleErrors };
  } catch (err) {
    console.error('=== 不具合検証テスト: FAIL ===', err);
    await page.screenshot({ path: 'e2e_screenshots/crossing_and_coupling_fail.png' }).catch(() => {});
    return { pass: false, error: err.message, errors: consoleErrors };
  } finally {
    await browser.close();
  }
}

runCrossingAndCouplingTest().then(res => {
  if (!res.pass) process.exit(1);
});
