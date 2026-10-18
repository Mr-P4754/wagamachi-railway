import { chromium } from 'playwright';

async function testFarmlandAndCellularAutomata() {
  console.log('====================================================');
  console.log('  田畑・農地（farmland）とセルラーオートマトン検証');
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

    // テスト 1: StructureMeshBuilder.createFarmland のメッシュ生成と BuildingBakery ベイク
    console.log('--- テスト 1: 農地メッシュ（稲穂・野菜・ビニールハウス）のベイク生成検証 ---');
    const meshTest = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;

      // 3種類の農地タイルを設置
      wm.setTile(5, 5, 'farmland', 0, 1, 'right', 1);
      wm.setTile(6, 5, 'farmland', 0, 1, 'right', 1);
      wm.setTile(7, 5, 'farmland', 0, 1, 'right', 1);

      const t0 = wm.getTile(5, 5, 1);
      const t1 = wm.getTile(6, 5, 1);
      const t2 = wm.getTile(7, 5, 1);

      const mesh0 = t0?.mesh;
      const mesh1 = t1?.mesh;
      const mesh2 = t2?.mesh;

      // ビニールハウスのマテリアル・メッシュプロパティ検証
      let greenhouseDepthWrite = null;
      let greenhouseCastShadow = null;
      for (const m of [mesh0, mesh1, mesh2]) {
        if (m) {
          m.traverse(child => {
            if (child.isMesh && child.material && child.material.opacity === 0.82) {
              greenhouseDepthWrite = child.material.depthWrite;
              greenhouseCastShadow = child.castShadow;
            }
          });
        }
      }

      return {
        t0Type: t0?.type,
        hasMesh0: !!mesh0,
        mesh0Name: mesh0?.name,
        hasLOD0: !!mesh0?.userData?.buildingLod,
        hasMesh1: !!mesh1,
        hasMesh2: !!mesh2,
        greenhouseDepthWrite,
        greenhouseCastShadow
      };
    });

    console.log('メッシュテスト結果:', meshTest);
    if (!meshTest.hasMesh0 || !meshTest.hasMesh1 || !meshTest.hasMesh2) {
      throw new Error('農地メッシュの生成またはアタッチに失敗しました');
    }
    if (!meshTest.hasLOD0) {
      throw new Error('BuildingBakery によるベイク（LOD設定）が行われていません');
    }
    if (meshTest.greenhouseDepthWrite !== false) {
      throw new Error(`greenhouseSheetMat の depthWrite が false ではありません: ${meshTest.greenhouseDepthWrite}`);
    }
    if (meshTest.greenhouseCastShadow !== false) {
      throw new Error(`ビニールハウス本体メッシュの castShadow が false ではありません: ${meshTest.greenhouseCastShadow}`);
    }
    console.log('✓ 農地メッシュ（3種バリエーション）が BuildingBakery で正常にベイクされ、ビニールハウスの depthWrite: false / castShadow: false も確認されました');

    // テスト 2: インスペクター表示検証
    console.log('--- テスト 2: 農地タイルのインスペクター情報表示検証 ---');
    const inspectorTest = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const ui = app.uiManager;

      const farmTile = wm.getTile(5, 5, 1);
      ui.showInspector(farmTile);

      const typeText = document.getElementById('inspect-type')?.textContent;
      const extraText = document.getElementById('inspect-extra-val')?.textContent;

      return { typeText, extraText };
    });

    console.log('インスペクター表示:', inspectorTest);
    if (!inspectorTest.typeText?.includes('田畑・農地')) {
      throw new Error(`インスペクターのタイトルが不正です: ${inspectorTest.typeText}`);
    }
    if (!inspectorTest.extraText?.includes('田園風景') && !inspectorTest.extraText?.includes('農地')) {
      throw new Error(`インスペクターの詳細説明が不正です: ${inspectorTest.extraText}`);
    }
    console.log('✓ インスペクターに「田畑・農地」および解説文が正常に表示されました');

    // テスト 3: セルラーオートマトン 誕生ルール（郊外農地の自律的クラスタ増殖）
    console.log('--- テスト 3: セルラーオートマトン 誕生ルール（駅から5〜14マス、道路隣接） ---');
    const spawnTest = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const cg = app.cityGrowth;

      // 郊外テストエリア (25, 25) に駅を設置
      wm.placeStationGroup(25, 25, 2, 1, false, '郊外駅', 'right', 1);

      // 駅から8マス離れた平地 (25, 33) の横 (26, 33) に道路を敷設
      wm.setTile(26, 33, 'road', 0, 1, 'right', 1);

      // (25, 33) は empty の状態
      const beforeTile = wm.getTile(25, 33, 1);
      const isBeforeEmpty = !beforeTile || beforeTile.type === 'empty';

      // 誕生ルールを数回評価（自律的増殖の確率試行）
      let spawnedAny = false;
      for (let day = 1; day <= 20; day++) {
        cg.evaluateGrowth(() => {});
        const allTiles = wm.getAllTiles();
        const farmlandsNear = allTiles.filter(t => {
          if (t.type !== 'farmland') return false;
          const dist = Math.hypot(t.x - 25, t.z - 25);
          return dist >= 4.5 && dist <= 14.5;
        });
        if (farmlandsNear.length > 0) {
          spawnedAny = true;
          break;
        }
      }

      const allTiles = wm.getAllTiles();
      const farmlandsNearStation = allTiles.filter(t => {
        if (t.type !== 'farmland') return false;
        const dist = Math.hypot(t.x - 25, t.z - 25);
        return dist >= 4.5 && dist <= 14.5;
      });

      return {
        isBeforeEmpty,
        spawnedAny,
        farmlandCountNearStation: farmlandsNearStation.length
      };
    });

    console.log('誕生ルール結果:', spawnTest);
    if (!spawnTest.spawnedAny || spawnTest.farmlandCountNearStation === 0) {
      throw new Error('駅から5〜14マスの範囲で自律的な農地の増殖（誕生ルール）が確認できませんでした');
    }
    console.log(`✓ 駅から5〜14マスの郊外平地に、農地が自律的に ${spawnTest.farmlandCountNearStation} マス誕生・増殖しました！`);

    // テスト 4: セルラーオートマトン 遷移ルール（都市化: 周囲8マスの建物が3つ以上で住宅Lv.1に転換）
    console.log('--- テスト 4: セルラーオートマトン 遷移ルール（都市化転換） ---');
    const transitionTest = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const cg = app.cityGrowth;

      // 別のテスト用駅 (40, 40) を設置し、十分な利用実績を設定（発展可能状態）
      wm.placeStationGroup(40, 40, 2, 1, false, '発展駅', 'right', 1);
      const platInfo = wm.stationManager.getPlatformByTile(40, 40, 1);
      if (platInfo) {
        platInfo.station.dailyPassengers = 15000;
        platInfo.station.previousDayPassengers = 15000;
        platInfo.station.twoDaysAgoPassengers = 15000;
      }

      // 駅の近く (41, 41) に農地を設置
      wm.setTile(41, 41, 'farmland', 0, 1, 'right', 1);

      // (41, 41) の周囲8マスのうち3マスに建物を設置
      wm.setTile(40, 41, 'residence', 0, 1, 'right', 1); // 建物1
      wm.setTile(42, 41, 'residence', 0, 1, 'right', 1); // 建物2
      wm.setTile(41, 42, 'commercial', 0, 1, 'right', 1); // 建物3

      const beforeType = wm.getTile(41, 41, 1)?.type;

      const debugInfo = {
        station: platInfo?.station,
        tileBefore: wm.getTile(41, 41, 1),
        n1: wm.getTile(40, 41, 1)?.type,
        n2: wm.getTile(42, 41, 1)?.type,
        n3: wm.getTile(41, 42, 1)?.type,
        surroundingCount: cg.countSurroundingBuildings(41, 41, 1)
      };

      // 発展評価を実行（念のため数回試行）
      let popIncreaseRecorded = 0;
      for (let day = 1; day <= 10; day++) {
        cg.evaluateGrowth((pop) => {
          popIncreaseRecorded += pop;
        });
        if (wm.getTile(41, 41, 1)?.type === 'residence') break;
      }

      const afterTile = wm.getTile(41, 41, 1);

      return {
        debugInfo,
        beforeType,
        afterType: afterTile?.type,
        afterLevel: afterTile?.level,
        popIncreaseRecorded
      };
    });

    console.log('遷移ルール結果:', transitionTest);
    if (transitionTest.beforeType !== 'farmland') {
      throw new Error('テスト前のタイルが農地ではありません');
    }
    if (transitionTest.afterType !== 'residence' || transitionTest.afterLevel !== 1) {
      throw new Error(`農地の都市化転換に失敗しました: 実際の結果 = ${transitionTest.afterType} (Lv.${transitionTest.afterLevel})`);
    }
    console.log('✓ 周囲に建物が3つ以上揃った農地が、住宅 (residence Lv.1) へ自動転換されました！');

    // テスト 5: 撤去ツール（ブルドーザー）での撤去動作
    console.log('--- テスト 5: 都市撤去ツールによる農地撤去検証 ---');
    const demolishTest = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const ic = app.interactionController;
      const pc = app.placementController;

      // (10, 10) に農地を設置
      wm.setTile(10, 10, 'farmland', 0, 1, 'right', 1);
      const isFarmBefore = wm.getTile(10, 10, 1)?.type === 'farmland';

      // 'demolish-city' で (10, 10) を撤去
      app.uiManager.selectTool('demolish-city');
      pc.hoveredTile = { x: 10, z: 10 };
      ic.handleTileClick();

      const afterTile = wm.getTile(10, 10, 1);
      const isRemoved = !afterTile || afterTile.type === 'empty';

      return { isFarmBefore, isRemoved, afterType: afterTile?.type };
    });

    console.log('撤去テスト結果:', demolishTest);
    if (!demolishTest.isFarmBefore || !demolishTest.isRemoved) {
      throw new Error(`農地の撤去に失敗しました: afterType = ${demolishTest.afterType}`);
    }
    console.log('✓ 都市撤去ツールで農地が正常に撤去され更地に戻りました！');

    console.log('\n🎉 すべてのテストケース（メッシュ生成、ベイクLOD、インスペクター、誕生ルール、遷移ルール、撤去）に完全合格しました！');
  } catch (err) {
    console.error('❌ テスト失敗:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

testFarmlandAndCellularAutomata();
