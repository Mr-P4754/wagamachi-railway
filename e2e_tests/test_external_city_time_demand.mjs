/**
 * 外部都市（隣町）の時間帯別乗客需要増減 E2Eテスト
 *
 * 検証項目:
 * 1. 外部各都市（新東都・北ノ森市・南港市・西条重工市）の時間帯別需要カーブ算出
 * 2. 毎時乗客補充（updateHourlySupply）における時間帯（ラッシュ vs 深夜）による補充数の増減
 * 3. 50マス先の隣町到着時（handleNeighborCityArrival）における時間帯別の乗車数増減
 * 4. インスペクターにおける現在補充レートおよび需要フェーズラベル（ラッシュ、閑散等）の正常表示
 */

import { chromium } from 'playwright';

async function runExternalCityTimeDemandTest() {
  console.log('=== 外部都市の時間帯別乗客需要シミュレーション E2Eテスト開始 ===\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto('http://localhost:3000');
    await page.waitForTimeout(2000);

    // ==========================================
    // ステップ 1: 都市別・時間帯別の需要倍率ロジックの検証
    // ==========================================
    console.log('--- ステップ 1: 都市特性別の時間帯需要係数検証 ---');
    const demandCurveResults = await page.evaluate(() => {
      const app = window.gameApp;
      const ecm = app.externalConnectionManager;
      const cities = ecm.getAllCities();

      // 各都市の主要時間帯の需要倍率を調査
      // 7時(朝ラッシュ), 12時(昼間), 18時(夕ラッシュ), 2時(深夜)
      const hours = [2, 7, 12, 18];
      const matrix = {};

      for (const city of cities) {
        matrix[city.name] = {};
        for (const h of hours) {
          const mult = window.gameApp.constructor ? 
            // クラスメソッド呼び出し
            (city.role === 'commercial' ? (h === 18 ? 2.8 : h === 7 ? 2.2 : h === 12 ? 1.0 : 0.15) : 0) : 0;
          const actualMult = ecm.constructor.getCityPassengerDemandMultiplier(city, h);
          const phase = ecm.constructor.getDemandPhaseInfo(city, h);
          matrix[city.name][`${h}時`] = {
            multiplier: actualMult,
            percentage: phase.percentage,
            label: phase.label
          };
        }
      }
      return matrix;
    });

    console.log('  都市別時間帯需要マトリクス:');
    console.dir(demandCurveResults, { depth: null });

    const tokyo18 = demandCurveResults['新東都方面']['18時'].multiplier;
    const tokyo2 = demandCurveResults['新東都方面']['2時'].multiplier;
    const resort12 = demandCurveResults['北ノ森市方面']['12時'].multiplier;
    const resort2 = demandCurveResults['北ノ森市方面']['2時'].multiplier;
    const industry7 = demandCurveResults['西条重工市方面']['7時'].multiplier;
    const industry12 = demandCurveResults['西条重工市方面']['12時'].multiplier;

    if (tokyo18 < 2.5 || tokyo2 > 0.3) {
      throw new Error(`新東都の需要カーブが不正です: 18時=${tokyo18}, 2時=${tokyo2}`);
    }
    if (resort12 < 1.8 || resort2 > 0.2) {
      throw new Error(`北ノ森市（リゾート）の需要カーブが不正です: 12時=${resort12}, 2時=${resort2}`);
    }
    if (industry7 < 2.0 || industry12 > 1.0) {
      throw new Error(`西条重工市（工業）の需要カーブが不正です: 7時=${industry7}, 12時=${industry12}`);
    }
    console.log('  ✓ 商業・リゾート・工業各都市の性格に応じた時間帯ピーク（朝夕ラッシュ・昼間・深夜）の算出を確認');

    // ==========================================
    // ステップ 2: 毎時補充（updateHourlySupply）における需要連動検証
    // ==========================================
    console.log('\n--- ステップ 2: 毎時乗客補充（updateHourlySupply）の時間帯連動検証 ---');
    const supplyTest = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const ecm = app.externalConnectionManager;
      const half = Math.floor((wm.gridSize || 64) / 2);
      const minX = -half;

      // 西端境界線路から数マス線路を敷設して西条重工市を接続
      for (let x = minX; x <= minX + 3; x++) {
        wm.setTile(x, 0, 'rail_ground', 1, 1, 'right', 1);
      }
      ecm.checkConnections(wm);

      // (A) 深夜2時の補充
      ecm.updateHourlySupply(wm, 2);
      const borderTile = wm.getTile(minX, 0, 1);
      const nightPass = borderTile?.stationPassengers ?? 0;

      // リセット
      borderTile.stationPassengers = 0;

      // (B) 朝ラッシュ7時の補充
      ecm.updateHourlySupply(wm, 7);
      const rushPass = borderTile?.stationPassengers ?? 0;

      return {
        nightPassengers: nightPass,
        rushPassengers: rushPass,
        ratio: rushPass / Math.max(1, nightPass)
      };
    });

    console.log('  境界線路への乗客補充結果:', supplyTest);
    if (supplyTest.rushPassengers <= supplyTest.nightPassengers) {
      throw new Error(`朝ラッシュの補充乗客数が深夜を下回っています: ラッシュ=${supplyTest.rushPassengers}, 深夜=${supplyTest.nightPassengers}`);
    }
    if (supplyTest.ratio < 5) {
      throw new Error(`朝ラッシュと深夜の補充倍率差が不十分です: 倍率=${supplyTest.ratio}`);
    }
    console.log(`  ✓ 朝ラッシュ（${supplyTest.rushPassengers}人）が深夜（${supplyTest.nightPassengers}人）の約${Math.round(supplyTest.ratio)}倍補充されることを確認`);

    // ==========================================
    // ステップ 3: 50マス先の隣町到着時（handleNeighborCityArrival）の乗車数検証
    // ==========================================
    console.log('\n--- ステップ 3: 隣町到着時の時間帯別乗客乗車数検証 ---');
    const arrivalDemandTest = await page.evaluate(() => {
      const app = window.gameApp;
      const tm = app.trainManager;
      const wm = app.worldMap;
      const minX = -Math.floor((wm.gridSize || 64) / 2);

      // 列車を配置（2両編成、定員約600人）
      const train = tm.spawnTrain(minX + 2, 0, undefined, 2, undefined, undefined, 1);
      if (!train) return { error: '列車の生成に失敗しました' };

      const travelState = {
        cityId: 'ext_west',
        cityName: '西条重工市方面',
        entryTile: { x: minX, z: 0, layer: 1 },
        entryDirection: { x: -1, y: 0, z: 0 },
        phase: 'at_neighbor',
        distanceTiles: 50,
        remainingTiles: 0,
        stopMinutesRemaining: 5
      };

      // (A) 深夜2時に到着した場合の乗客乗車
      train.passengers = 0;
      tm.handleNeighborCityArrival(train, travelState, undefined, 2);
      const nightBoarding = train.passengers;

      // (B) 昼間12時に到着した場合の乗客乗車
      train.passengers = 0;
      tm.handleNeighborCityArrival(train, travelState, undefined, 12);
      const middayBoarding = train.passengers;

      // (C) 朝ラッシュ7時に到着した場合の乗客乗車
      train.passengers = 0;
      tm.handleNeighborCityArrival(train, travelState, undefined, 7);
      const rushBoarding = train.passengers;

      return {
        nightBoarding,
        middayBoarding,
        rushBoarding
      };
    });

    console.log('  隣町到着時の乗客乗車結果:', arrivalDemandTest);
    if (!arrivalDemandTest.nightBoarding || !arrivalDemandTest.middayBoarding || !arrivalDemandTest.rushBoarding) {
      throw new Error(`乗車データが不正です: ${JSON.stringify(arrivalDemandTest)}`);
    }
    if (arrivalDemandTest.rushBoarding <= arrivalDemandTest.middayBoarding ||
        arrivalDemandTest.middayBoarding <= arrivalDemandTest.nightBoarding) {
      throw new Error(`時間帯ごとの乗客数の順序が不正です: ラッシュ(${arrivalDemandTest.rushBoarding}) > 昼間(${arrivalDemandTest.middayBoarding}) > 深夜(${arrivalDemandTest.nightBoarding})`);
    }
    console.log(`  ✓ 隣町からの乗客数が 深夜(${arrivalDemandTest.nightBoarding}人) < 昼間(${arrivalDemandTest.middayBoarding}人) < ラッシュ(${arrivalDemandTest.rushBoarding}人) と明確に増減することを確認`);

    // ==========================================
    // ステップ 4: 境界線路インスペクターの表示検証
    // ==========================================
    console.log('\n--- ステップ 4: インスペクターにおける需要状況表示の検証 ---');
    const inspectorTest = await page.evaluate(() => {
      const app = window.gameApp;
      const wm = app.worldMap;
      const ui = app.uiManager;
      const minX = -Math.floor((wm.gridSize || 64) / 2);
      const borderTile = wm.getTile(minX, 0, 1);

      // 朝ラッシュ7時を設定
      ui.getCurrentHour = () => 7;
      ui.showInspector(borderTile);

      const panel = document.getElementById('inspector-panel');
      const text = panel ? panel.innerText : '';

      return {
        hasDemandText: text.includes('現在補充レート') || text.includes('ラッシュ'),
        panelTextSnippet: text.slice(0, 300)
      };
    });

    console.log('  インスペクター表示テスト:', inspectorTest);
    if (!inspectorTest.hasDemandText) {
      throw new Error('インスペクターに時間帯需要・現在補充レートが表示されていません');
    }
    console.log('  ✓ インスペクターに現在時刻に応じた需要フェーズおよび補充レートの表示を確認');

    console.log('\n=== 全てのテストが正常に完了しました！ ===');

  } catch (err) {
    console.error('テスト失敗:', err);
    throw err;
  } finally {
    await browser.close();
  }
}

runExternalCityTimeDemandTest().catch(() => process.exit(1));
