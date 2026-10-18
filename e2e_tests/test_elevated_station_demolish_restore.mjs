import { chromium } from 'playwright';

async function testElevatedStationDemolishRestore() {
  console.log('====================================================');
  console.log('  高架駅の設置・撤去・線路復元（InstancedMesh連携）検証');
  console.log('====================================================');

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

    const result = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const imm = wm.instancedMeshManager;

      const layer = 2; // 高架階層（elevation 1 の平地上の高架2F）
      const x1 = -10, z1 = -8;
      const x2 = -9, z2 = -8;
      const key1 = `${x1},${z1},${layer}`;
      const key2 = `${x2},${z2},${layer}`;

      function hasElevatedInstance(tileKey) {
        for (const [bucketKey, layerObj] of imm.layers.entries()) {
          if (bucketKey.startsWith('rail_elevated_structure') && layerObj.keyToIndex.has(tileKey)) {
            return true;
          }
        }
        return false;
      }

      // 1. 高架線路を2マス敷設
      wm.setTile(x1, z1, 'rail_elevated', 1, 1, 'right', layer);
      wm.setTile(x2, z2, 'rail_elevated', 1, 1, 'right', layer);

      const hasElevated1_initial = hasElevatedInstance(key1);
      const hasElevated2_initial = hasElevatedInstance(key2);

      const t1_initial = wm.getTile(x1, z1, layer);
      const isInitialMeshUndefined = t1_initial.mesh === undefined; // InstancedMeshなので個別meshはundefined

      // 2. 高架駅（2マス）をアタッチ設置
      const placed = wm.placeStationGroup(x1, z1, 2, 1, true, '高架検証駅', 'right', layer);

      const hasElevated1_afterPlace = hasElevatedInstance(key1);
      const hasElevated2_afterPlace = hasElevatedInstance(key2);

      const t1_station = wm.getTile(x1, z1, layer);
      const isStationMeshPresent = t1_station && t1_station.mesh !== undefined && t1_station.type === 'station_elevated';

      // 3. 駅を撤去（demolishTile）
      const demolished = wm.demolishTile(x1, z1, layer);

      const t1_restored = wm.getTile(x1, z1, layer);
      const t2_restored = wm.getTile(x2, z2, layer);

      const hasElevated1_restored = hasElevatedInstance(key1);
      const hasElevated2_restored = hasElevatedInstance(key2);

      // 復元された線路は InstancedMesh なので個別 mesh は undefined でなければならない！
      const isRestoredMeshUndefined1 = t1_restored ? t1_restored.mesh === undefined : false;
      const isRestoredMeshUndefined2 = t2_restored ? t2_restored.mesh === undefined : false;

      const restoredType1 = t1_restored ? t1_restored.type : null;
      const restoredType2 = t2_restored ? t2_restored.type : null;

      // 4. 更にもう一度更地化して撤去（線路撤去）
      const railDemolished = wm.demolishTile(x1, z1, layer);
      const hasElevated1_final = hasElevatedInstance(key1);
      const t1_final = wm.getTile(x1, z1, layer);
      const finalType = t1_final ? t1_final.type : 'empty';

      return {
        step1: {
          hasElevated1_initial,
          hasElevated2_initial,
          isInitialMeshUndefined
        },
        step2: {
          placed,
          hasElevated1_afterPlace,
          hasElevated2_afterPlace,
          isStationMeshPresent
        },
        step3: {
          demolished,
          restoredType1,
          restoredType2,
          hasElevated1_restored,
          hasElevated2_restored,
          isRestoredMeshUndefined1,
          isRestoredMeshUndefined2
        },
        step4: {
          railDemolished,
          hasElevated1_final,
          finalType
        }
      };
    });

    console.log('検証結果:', JSON.stringify(result, null, 2));

    let success = true;

    // Step 1: 初期線路の配置
    if (!result.step1.hasElevated1_initial || !result.step1.isInitialMeshUndefined) {
      console.error('❌ Step 1 失敗: 初期高架線路が InstancedMesh として登録されていません。');
      success = false;
    } else {
      console.log('✅ Step 1 成功: 初期高架線路が InstancedMesh として正常に配置されました。');
    }

    // Step 2: 駅のアタッチ設置
    if (!result.step2.placed || result.step2.hasElevated1_afterPlace || !result.step2.isStationMeshPresent) {
      console.error('❌ Step 2 失敗: 駅設置時に既存の高架レールInstancedMeshが削除されていないか、駅メッシュが設定されていません。');
      success = false;
    } else {
      console.log('✅ Step 2 成功: 駅設置により高架線路のInstancedMeshが除去され、駅メッシュが正常に生成されました。');
    }

    // Step 3: 駅撤去による線路復元
    if (!result.step3.demolished ||
        result.step3.restoredType1 !== 'rail_elevated' ||
        result.step3.restoredType2 !== 'rail_elevated' ||
        !result.step3.hasElevated1_restored ||
        !result.step3.hasElevated2_restored ||
        !result.step3.isRestoredMeshUndefined1 ||
        !result.step3.isRestoredMeshUndefined2) {
      console.error('❌ Step 3 失敗: 駅撤去時に正規の InstancedMesh として線路が復元されていません。');
      success = false;
    } else {
      console.log('✅ Step 3 成功: 駅撤去により正規の InstancedMesh 高架線路（個別meshなし）として復元されました！');
    }

    // Step 4: 復元後の線路撤去
    if (!result.step4.railDemolished || result.step4.hasElevated1_final) {
      console.error('❌ Step 4 失敗: 復元後の線路撤去時に InstancedMesh が正常に削除されませんでした。');
      success = false;
    } else {
      console.log('✅ Step 4 成功: 復元された線路も通常の線路として正常に撤去・InstancedMesh削除されました。');
    }

    if (success) {
      console.log('\n🎉 すべてのテストに合格しました！高架駅の設置・撤去・線路復元のライフサイクルは完璧です。');
    } else {
      process.exitCode = 1;
    }

  } catch (err) {
    console.error('テスト実行エラー:', err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

testElevatedStationDemolishRestore();
