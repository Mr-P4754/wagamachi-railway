import { chromium } from 'playwright';

async function testDragAutoPointSwitch() {
  console.log('====================================================');
  console.log('  既存直線レールからのドラッグ自動ポイント分岐化検証');
  console.log('====================================================');

  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl']
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  page.on('console', msg => {
    console.log(`  [Browser ${msg.type()}]:`, msg.text());
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

    // テスト 1: 南北（NS）直線レールから東西へL字ドラッグした際の自動ポイント分岐器化
    console.log('--- テスト 1: 南北直線レールからのドラッグ自動ポイント分岐化 ---');
    const test1Result = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const pc = app.placementController;
      const ui = app.uiManager;

      // 平地陸地を探索
      let baseX = 0, baseZ = 0;
      outer: for (let x = -30; x <= 30; x++) {
        for (let z = -30; z <= 30; z++) {
          let ok = true;
          for (let dx = 0; dx < 6; dx++) {
            for (let dz = 0; dz < 6; dz++) {
              if (!wm.canPlaceAtWater(x + dx, z + dz, 1).allowed) {
                ok = false;
                break;
              }
            }
            if (!ok) break;
          }
          if (ok) {
            baseX = x;
            baseZ = z;
            break outer;
          }
        }
      }

      // クリーンアップ
      for (let dx = 0; dx < 6; dx++) {
        for (let dz = 0; dz < 6; dz++) {
          wm.setTile(baseX + dx, baseZ + dz, 'empty', 0, 1, 'right', 1);
        }
      }

      // 1. 南北直線レールを (baseX, baseZ) 〜 (baseX, baseZ + 5) に敷設 (rotation: 0)
      for (let z = baseZ; z <= baseZ + 5; z++) {
        wm.setTile(baseX, z, 'rail_ground', 0, 1, 'right', 1);
      }

      // 2. 線路ツールを選択し、(baseX + 4, baseZ + 2) から (baseX, baseZ + 5) へドラッグ
      // コーナーが (baseX, baseZ + 2) に発生
      ui.selectTool('rail-straight');
      wm.activeLayer = 1;
      pc.updateDragPreview({ x: baseX + 4, z: baseZ + 2 }, { x: baseX, z: baseZ + 5 });

      // ドラッグ中の segments 確認
      const segmentsBeforeFinish = pc.dragCurrentSegments.map(s => ({
        x: s.x,
        z: s.z,
        tool: s.tool,
        curveDir: s.curveDir,
        isAutoSwitch: s.isAutoSwitch
      }));
      const cornerSeg = pc.dragCurrentSegments.find(s => s.x === baseX && s.z === baseZ + 2);

      // 3. ドラッグ完了（仮置き登録）
      pc.finishDragPlacement();

      const pendingBefore = pc.pendingItems.map(p => ({ x: p.x, z: p.z, tool: p.tool }));
      const switchPending = pc.pendingItems.find(p => p.x === baseX && p.z === baseZ + 2);

      // 4. 仮置きを確定
      pc.confirmPendingPlacements();

      const afterTile = wm.getTile(baseX, baseZ + 2, 1);
      const isSwitch = afterTile?.type === 'point_switch_ground';

      return {
        baseX,
        baseZ,
        cornerSegTool: cornerSeg?.tool,
        cornerSegIsAutoSwitch: cornerSeg?.isAutoSwitch,
        segmentsBeforeFinish,
        pendingBefore,
        switchPendingTool: switchPending?.tool,
        switchPendingRotation: switchPending?.rotation,
        switchPendingBranch: switchPending?.switchBranchSide,
        afterTileType: afterTile?.type,
        afterTileRotation: afterTile?.rotation,
        afterTileBranch: afterTile?.switchBranchSide,
        isSwitch
      };
    });

    console.log('テスト1結果:', test1Result);
    if (!test1Result.isSwitch) {
      throw new Error(`南北直線レール上の重なりマスが分岐器に変換されませんでした: 実際 = ${test1Result.afterTileType}`);
    }
    if (test1Result.switchPendingTool !== 'point-switch') {
      throw new Error(`仮置きアイテムが point-switch ではありません: ${test1Result.switchPendingTool}`);
    }
    console.log('✓ 南北直線レールからのドラッグで自動的に point-switch が生成され確定しました！');

    // テスト 2: 東西（EW）高架直線レールから南北へL字ドラッグした際の自動高架分岐器化
    console.log('--- テスト 2: 東西高架直線レールからのドラッグ自動高架ポイント分岐化 ---');
    const test2Result = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const pc = app.placementController;
      const ui = app.uiManager;

      // 平地陸地を探索
      let baseX = 0, baseZ = 0;
      outer: for (let x = -30; x <= 30; x++) {
        for (let z = -30; z <= 30; z++) {
          let ok = true;
          for (let dx = 0; dx < 6; dx++) {
            for (let dz = 0; dz < 6; dz++) {
              if (!wm.canPlaceAtWater(x + dx, z + dz, 2).allowed) {
                ok = false;
                break;
              }
            }
            if (!ok) break;
          }
          if (ok) {
            baseX = x;
            baseZ = z;
            break outer;
          }
        }
      }

      // 1. 東西高架直線レールを (baseX, baseZ) 〜 (baseX + 5, baseZ) に敷設 (layer: 2, rotation: 1)
      for (let x = baseX; x <= baseX + 5; x++) {
        wm.setTile(x, baseZ, 'rail_elevated', 1, 1, 'right', 2);
      }

      // 2. 高架線路ツールを選択し、(baseX, baseZ) から (baseX + 3, baseZ + 4) へドラッグ (layer: 2)
      // horizontalFirst によりコーナーは (baseX + 3, baseZ) に発生（既存東西レール上）
      ui.selectTool('rail-elevated');
      wm.activeLayer = 2; // 高架階層
      pc.updateDragPreview({ x: baseX, z: baseZ }, { x: baseX + 3, z: baseZ + 4 });

      // 3. ドラッグ完了
      pc.finishDragPlacement();

      const switchPending = pc.pendingItems.find(p => p.x === baseX + 3 && p.z === baseZ && p.layer === 2);

      // 4. 仮置き確定
      pc.confirmPendingPlacements();

      const afterTile = wm.getTile(baseX + 3, baseZ, 2);
      const isElevatedSwitch = afterTile?.type === 'point_switch_elevated';

      return {
        switchPendingTool: switchPending?.tool,
        afterTileType: afterTile?.type,
        afterTileRotation: afterTile?.rotation,
        afterTileBranch: afterTile?.switchBranchSide,
        isElevatedSwitch
      };
    });

    console.log('テスト2結果:', test2Result);
    if (!test2Result.isElevatedSwitch) {
      throw new Error(`東西高架直線レール上の重なりマスが高架分岐器に変換されませんでした: 実際 = ${test2Result.afterTileType}`);
    }
    console.log('✓ 東西高架直線レールからのドラッグで自動的に point_switch_elevated が生成されました！');

    // テスト 3: 単発の rail-curve ツールで既存の直線レールをクリックした際の自動分岐化
    console.log('--- テスト 3: 単発 rail-curve ツールによる既存直線レールの自動分岐化 ---');
    const test3Result = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const pc = app.placementController;
      const ui = app.uiManager;

      // 平地陸地を1マス探索
      let targetX = 0, targetZ = 0;
      for (let x = -20; x <= 20; x++) {
        for (let z = -20; z <= 20; z++) {
          if (wm.canPlaceAtWater(x, z, 1).allowed) {
            targetX = x;
            targetZ = z;
            break;
          }
        }
      }

      wm.setTile(targetX, targetZ, 'empty', 0, 1, 'right', 1);

      // 1. 南北直線レールを敷設 (layer: 1, rotation: 0)
      wm.setTile(targetX, targetZ, 'rail_ground', 0, 1, 'right', 1);

      // 2. 単発 rail-curve ツールを選択
      ui.selectTool('rail-curve');
      wm.activeLayer = 1;
      pc.currentRotation = 0; // CURVE_DIR_ORDER[0] = 'N_E' (0と1のカーブ)

      // 3. 単発仮置きを追加
      pc.stagePendingPlacement('rail-curve', targetX, targetZ);

      const pending = pc.pendingItems;
      const singlePending = pending.find(p => p.x === targetX && p.z === targetZ);

      // 4. 確定
      pc.confirmPendingPlacements();

      const afterTile = wm.getTile(targetX, targetZ, 1);
      const isSwitch = afterTile?.type === 'point_switch_ground';

      return {
        targetX,
        targetZ,
        pendingTool: singlePending?.tool,
        pendingRotation: singlePending?.rotation,
        pendingBranch: singlePending?.switchBranchSide,
        afterTileType: afterTile?.type,
        isSwitch
      };
    });

    console.log('テスト3結果:', test3Result);
    if (!test3Result.isSwitch || test3Result.pendingTool !== 'point-switch') {
      throw new Error(`単発カーブレールツールでクリックした直線レールが分岐器に変換されませんでした: 実際 = ${test3Result.afterTileType}`);
    }
    console.log('✓ 単発 rail-curve ツールで直線レールをクリックした際も、自動的に point-switch に変換されました！');

    // テスト 4: 東西直線レール上から真北へ直線ドラッグした際の始点自動ポイント分岐化
    console.log('--- テスト 4: 東西直線レール上から真北へ直線ドラッグ（dx=0）した際の始点自動分岐化 ---');
    const test4Result = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const pc = app.placementController;
      const ui = app.uiManager;

      // 1. 東西直線レールを (40, 40) 〜 (45, 40) に敷設 (rotation: 1)
      for (let x = 40; x <= 45; x++) {
        wm.setTile(x, 40, 'rail_ground', 1, 1, 'right', 1);
      }

      // 2. (42, 40) から (42, 36) へ真北にドラッグ
      ui.selectTool('rail-straight');
      wm.activeLayer = 1;
      pc.updateDragPreview({ x: 42, z: 40 }, { x: 42, z: 36 });

      const startSeg = pc.dragCurrentSegments.find(s => s.x === 42 && s.z === 40);

      // 3. ドラッグ完了
      pc.finishDragPlacement();

      const switchPending = pc.pendingItems.find(p => p.x === 42 && p.z === 40);

      // 4. 確定
      pc.confirmPendingPlacements();

      const afterTile = wm.getTile(42, 40, 1);
      const branchNextTile = wm.getTile(42, 39, 1);
      const isSwitch = afterTile?.type === 'point_switch_ground';

      return {
        startSegTool: startSeg?.tool,
        startSegIsAutoSwitch: startSeg?.isAutoSwitch,
        switchPendingTool: switchPending?.tool,
        switchPendingRotation: switchPending?.rotation,
        switchPendingBranch: switchPending?.switchBranchSide,
        afterTileType: afterTile?.type,
        afterTileRotation: afterTile?.rotation,
        afterTileBranch: afterTile?.switchBranchSide,
        branchNextTileType: branchNextTile?.type,
        isSwitch
      };
    });

    console.log('テスト4結果:', test4Result);
    if (!test4Result.isSwitch || test4Result.switchPendingTool !== 'point-switch') {
      throw new Error(`東西直線レール上からの真北ドラッグで始点が分岐器に変換されませんでした: 実際 = ${test4Result.afterTileType}`);
    }
    console.log('✓ 東西直線レール上から直交（真北）へドラッグした際、始点が自動的に point-switch に変換されました！');

    // テスト 5: 南北直線レール上から真東へ直線ドラッグした際の始点自動ポイント分岐化
    console.log('--- テスト 5: 南北直線レール上から真東へ直線ドラッグ（dz=0）した際の始点自動分岐化 ---');
    const test5Result = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const pc = app.placementController;
      const ui = app.uiManager;

      // 1. 南北直線レールを (50, 40) 〜 (50, 45) に敷設 (rotation: 0)
      for (let z = 40; z <= 45; z++) {
        wm.setTile(50, z, 'rail_ground', 0, 1, 'right', 1);
      }

      // 2. (50, 42) から (54, 42) へ真東にドラッグ
      ui.selectTool('rail-straight');
      wm.activeLayer = 1;
      pc.updateDragPreview({ x: 50, z: 42 }, { x: 54, z: 42 });

      const startSeg = pc.dragCurrentSegments.find(s => s.x === 50 && s.z === 42);

      // 3. ドラッグ完了
      pc.finishDragPlacement();

      const switchPending = pc.pendingItems.find(p => p.x === 50 && p.z === 42);

      // 4. 確定
      pc.confirmPendingPlacements();

      const afterTile = wm.getTile(50, 42, 1);
      const isSwitch = afterTile?.type === 'point_switch_ground';

      return {
        startSegTool: startSeg?.tool,
        startSegIsAutoSwitch: startSeg?.isAutoSwitch,
        switchPendingTool: switchPending?.tool,
        switchPendingRotation: switchPending?.rotation,
        switchPendingBranch: switchPending?.switchBranchSide,
        afterTileType: afterTile?.type,
        isSwitch
      };
    });

    console.log('テスト5結果:', test5Result);
    if (!test5Result.isSwitch || test5Result.switchPendingTool !== 'point-switch') {
      throw new Error(`南北直線レール上からの真東ドラッグで始点が分岐器に変換されませんでした: 実際 = ${test5Result.afterTileType}`);
    }
    console.log('✓ 南北直線レール上から直交（真東）へドラッグした際、始点が自動的に point-switch に変換されました！');

    // テスト 6: 単発曲線ツールから自動変換された分岐器の仮置き中 R キー回転検証
    console.log('--- テスト 6: 自動変換分岐器の仮置き中 R キー回転軸維持検証 ---');
    const test6Result = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const pc = app.placementController;
      const ui = app.uiManager;

      // 1. 南北直線レールを (60, 40) に敷設 (rotation: 0, axis: 0)
      wm.setTile(60, 40, 'rail_ground', 0, 1, 'right', 1);

      // 2. 単発 rail-curve ツールを選択し、(60, 40) に仮置き
      ui.selectTool('rail-curve');
      wm.activeLayer = 1;
      pc.currentRotation = 0; // CURVE_DIR_ORDER[0] = 'N_E'
      pc.stagePendingPlacement('rail-curve', 60, 40);

      const itemBefore = pc.pendingItems.find(p => p.x === 60 && p.z === 40);
      const initialRot = itemBefore?.rotation;
      const initialBranch = itemBefore?.switchBranchSide;

      // Rキー（rotateCurrentPlacement）を4回連続で呼び出し、それぞれの回転と分岐方向を記録
      const history = [];
      for (let i = 1; i <= 4; i++) {
        pc.rotateCurrentPlacement();
        const item = pc.pendingItems.find(p => p.x === 60 && p.z === 40);
        history.push({
          step: i,
          rotation: item?.rotation,
          branchSide: item?.switchBranchSide
        });
      }

      // クリーンアップ
      pc.cancelPendingPlacements();

      return {
        itemTool: itemBefore?.tool,
        initialRot,
        initialBranch,
        history
      };
    });

    console.log('テスト6結果:', test6Result);
    if (test6Result.itemTool !== 'point-switch') {
      throw new Error(`仮置きアイテムが point-switch ではありません: ${test6Result.itemTool}`);
    }
    // すべての回転ステップで、rotation が南北軸（0 または 2）であり、東西軸（1 または 3）になっていないことを検証
    for (const h of test6Result.history) {
      if (h.rotation !== 0 && h.rotation !== 2) {
        throw new Error(`回転後の rotation が既存の南北直線レール軸 (0または2) に沿っていません: step ${h.step}, rotation = ${h.rotation}`);
      }
    }
    // 4回目で初期状態に戻ることを確認
    const finalStep = test6Result.history[3];
    if (finalStep.rotation !== test6Result.initialRot || finalStep.branchSide !== test6Result.initialBranch) {
      throw new Error(`4回の回転で初期状態に循環していません: 初期=(${test6Result.initialRot}, ${test6Result.initialBranch}), 4回目=(${finalStep.rotation}, ${finalStep.branchSide})`);
    }
    console.log('✓ 単発曲線から自動変換された分岐器が、Rキー回転で南北レールの軸を崩さず綺麗に4通り循環することを確認しました！');

    console.log('\n🎉 すべての自動ポイント分岐化テストケースに完全合格しました！');
  } catch (err) {
    console.error('❌ テスト失敗:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

testDragAutoPointSwitch();
