import { chromium } from 'playwright';

async function testExternalTravelSaveLoadPersistence() {
  console.log('====================================================');
  console.log('  マップ外（隣町直通）走行中列車のセーブ＆ロード永続化検証');
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
      const tm = app.trainManager;
      const wm = app.worldMap;

      const trains = tm.getTrains();
      if (trains.length === 0) {
        return { error: '列車が存在しません' };
      }

      const train = trains[0];
      const origTrainId = train.id;
      const origTrainName = train.name;

      // 1. 境界タイルを準備
      const borderTile = {
        x: 31,
        z: 0,
        layer: 1,
        type: 'external_connection',
        externalCityId: 'city_east',
        stationName: '東桜市ゲートウェイ'
      };

      // 列車が境界外へ1マスオーバーシュートした状態をシミュレート
      train.currentTile = { x: 32, z: 0, layer: 1 };
      train.targetTile = { x: 33, z: 0, layer: 1 };

      // startExternalTravel を実行
      tm.startExternalTravel(train, borderTile);

      const normalizedCurrent = { ...train.currentTile };
      const normalizedTarget = { ...train.targetTile };
      const entryTile = { ...train.externalTravel.entryTile };

      // 2. セーブ（シリアライズ）
      const serialized = tm.serialize();

      // 3. 列車を全消去して空にする
      tm.removeAllTrains();
      const countAfterClear = tm.getTrains().length;

      // 4. ロード（デシリアライズ）
      const loadOk = tm.deserialize(serialized);
      const trainsAfterLoad = tm.getTrains();
      const loadedTrain = trainsAfterLoad.find(t => t.id === origTrainId);

      const isLoadedTrainValid = loadedTrain !== undefined;
      const loadedIsExternal = loadedTrain ? !!loadedTrain.externalTravel : false;
      const loadedMeshVisible = loadedTrain ? loadedTrain.mesh.visible : null;
      const loadedOccupiedCount = loadedTrain ? loadedTrain.occupiedTiles.length : null;
      const loadedCityName = loadedTrain?.externalTravel ? loadedTrain.externalTravel.cityName : null;

      // 5. 境界外座標（currentTile: x=33）を含む旧セーブデータの耐久テスト
      const rawData = JSON.parse(serialized);
      rawData[0].id = 999;
      rawData[0].currentTile = { x: 99, z: 99, layer: 1 }; // 完全なマップ外座標
      rawData[0].targetTile = { x: 100, z: 99, layer: 1 };
      rawData[0].externalTravel.entryTile = { x: 31, z: 0, layer: 1 };

      const legacySerialized = JSON.stringify(rawData);
      const legacyLoadOk = tm.deserialize(legacySerialized);
      const legacyLoadedTrain = tm.getTrains().find(t => t.id === 999);
      const isLegacyRecovered = legacyLoadedTrain !== undefined && legacyLoadedTrain.currentTile.x === 31;

      return {
        step1_normalize: {
          normalizedCurrent,
          normalizedTarget,
          entryTile
        },
        step2_saveClear: {
          countAfterClear
        },
        step3_load: {
          loadOk,
          isLoadedTrainValid,
          loadedIsExternal,
          loadedMeshVisible,
          loadedOccupiedCount,
          loadedCityName
        },
        step4_legacyBoundaryOut: {
          legacyLoadOk,
          isLegacyRecovered
        }
      };
    });

    console.log('検証結果:', JSON.stringify(result, null, 2));

    let success = true;

    // Step 1: startExternalTravel での座標正規化
    if (result.step1_normalize.normalizedCurrent.x !== 31 ||
        result.step1_normalize.normalizedTarget.x !== 31 ||
        result.step1_normalize.entryTile.x !== 31) {
      console.error('❌ Step 1 失敗: startExternalTravel で境界タイル座標への正規化が行われていません。');
      success = false;
    } else {
      console.log('✅ Step 1 成功: startExternalTravel 呼び出し時に列車座標が境界タイル (31, 0, 1) へ正確に正規化されました。');
    }

    // Step 2 & 3: セーブ＆ロードによるマップ外走行中列車の復元
    if (!result.step3_load.loadOk ||
        !result.step3_load.isLoadedTrainValid ||
        !result.step3_load.loadedIsExternal ||
        result.step3_load.loadedMeshVisible !== false ||
        result.step3_load.loadedOccupiedCount !== 0) {
      console.error('❌ Step 2-3 失敗: マップ外走行中列車がセーブ＆ロードで正常に復元されず消滅または異常状態になりました。');
      success = false;
    } else {
      console.log(`✅ Step 2-3 成功: マップ外走行中列車（${result.step3_load.loadedCityName}行）がロード後も消滅せず、非表示・占有なしの安全な状態で完全復元されました！`);
    }

    // Step 4: 境界外座標セーブデータのフォールバック救済
    if (!result.step4_legacyBoundaryOut.legacyLoadOk || !result.step4_legacyBoundaryOut.isLegacyRecovered) {
      console.error('❌ Step 4 失敗: 境界外座標を持つセーブデータから entryTile 基準でのフォールバック救済が行われていません。');
      success = false;
    } else {
      console.log('✅ Step 4 成功: マップ外座標を持つ旧セーブデータであっても entryTile を基準に列車が安全に救済復元されました。');
    }

    if (success) {
      console.log('\n🎉 すべてのテストに合格しました！隣町直通列車のセーブ＆ロード永続化は完璧です。');
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

testExternalTravelSaveLoadPersistence();
