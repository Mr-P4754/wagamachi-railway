import { chromium } from 'playwright';

async function testExternalTravelTrainModalAndCars() {
  console.log('====================================================');
  console.log('  隣町直通走行中列車の車窓モーダル＆編成変更安全性検証');
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
      const ui = app.uiManager;

      const trains = tm.getTrains();
      if (trains.length === 0) {
        return { error: '列車が存在しません' };
      }

      const train = trains[0];
      const origCarCount = train.carCount;

      // 1. 列車を隣町直通中（マップ外走行中）状態にシミュレート
      train.externalTravel = {
        cityId: 'city_east',
        cityName: '東桜市',
        returnDistance: 50,
        currentProgress: 20,
        departureTime: 100,
        estimatedArrivalTime: 200,
        entryTile: { x: 31, z: 0, layer: 1 }
      };
      train.mesh.visible = false;
      train.occupiedTiles = [];

      // 2. 車窓選択モーダルを開く
      let selectedTrainId = null;
      ui.showCabTrainSelectModal(trains, (id) => {
        selectedTrainId = id;
      });

      const modalEl = document.getElementById('cab-train-select-modal');
      const listEl = document.getElementById('cab-train-list');
      const itemEl = listEl ? listEl.querySelector('.cab-train-item') : null;
      const btnEl = itemEl ? itemEl.querySelector('.cab-train-action-btn') : null;

      const btnDisabled = btnEl ? btnEl.disabled : false;
      const btnText = btnEl ? btnEl.textContent : '';
      const itemHtml = itemEl ? itemEl.innerHTML : '';

      // ボタンおよびアイテムをクリックしてみる（onSelect が呼ばれないことを確認）
      if (btnEl) btnEl.click();
      if (itemEl) itemEl.click();

      const clickedWhileExternalSelected = selectedTrainId;

      // 3. マップ外走行中に増車を実行（updateTrainCarCount）
      const newCount = origCarCount === 2 ? 3 : 2;
      const updateOk = tm.updateTrainCarCount(train.id, newCount);
      const isMeshVisibleAfterUpdate = train.mesh.visible;
      const occupiedLengthAfterUpdate = train.occupiedTiles.length;
      const carCountAfterUpdate = train.carCount;

      // 4. マップ外走行から帰還状態へ復帰
      train.externalTravel = undefined;
      train.mesh.visible = true;

      // 再度モーダル表示
      let selectedAfterReturn = null;
      ui.showCabTrainSelectModal(trains, (id) => {
        selectedAfterReturn = id;
      });

      const itemElReturned = listEl ? listEl.querySelector('.cab-train-item') : null;
      const btnElReturned = itemElReturned ? itemElReturned.querySelector('.cab-train-action-btn') : null;
      const btnDisabledReturned = btnElReturned ? btnElReturned.disabled : true;
      const btnTextReturned = btnElReturned ? btnElReturned.textContent : '';

      if (itemElReturned) itemElReturned.click();

      // モーダルを閉じる
      ui.hideCabTrainSelectModal();

      return {
        step1_modalWhileExternal: {
          btnDisabled,
          btnText,
          hasCityName: itemHtml.includes('東桜市へ直通運行中'),
          hasMapExternalText: itemHtml.includes('マップ外'),
          clickedWhileExternalSelected
        },
        step2_updateCarsWhileExternal: {
          updateOk,
          isMeshVisibleAfterUpdate,
          occupiedLengthAfterUpdate,
          carCountAfterUpdate
        },
        step3_modalAfterReturn: {
          btnDisabledReturned,
          btnTextReturned,
          selectedAfterReturn
        }
      };
    });

    console.log('検証結果:', JSON.stringify(result, null, 2));

    let success = true;

    // Step 1: マップ外走行中の車窓モーダル保護
    if (!result.step1_modalWhileExternal.btnDisabled ||
        result.step1_modalWhileExternal.btnText !== 'マップ外走行中' ||
        !result.step1_modalWhileExternal.hasCityName ||
        result.step1_modalWhileExternal.clickedWhileExternalSelected !== null) {
      console.error('❌ Step 1 失敗: マップ外走行中列車の車窓ボタンが無効化されていないか、ステータスが表示されていません。');
      success = false;
    } else {
      console.log('✅ Step 1 成功: 車窓モーダルでマップ外走行中が明示され、乗車ボタンが正しく無効化・クリック防止されました。');
    }

    // Step 2: マップ外走行中の増減車
    if (!result.step2_updateCarsWhileExternal.updateOk ||
        result.step2_updateCarsWhileExternal.isMeshVisibleAfterUpdate !== false ||
        result.step2_updateCarsWhileExternal.occupiedLengthAfterUpdate !== 0) {
      console.error('❌ Step 2 失敗: マップ外走行中の増車でメッシュが誤って表示されたか、在線タイルが空になっていません。');
      success = false;
    } else {
      console.log('✅ Step 2 成功: マップ外走行中に増車を行っても非表示状態と在線クリアが正常に維持されました。');
    }

    // Step 3: 帰還後の正常動作
    if (result.step3_modalAfterReturn.btnDisabledReturned !== false ||
        result.step3_modalAfterReturn.btnTextReturned !== '運転席に乗車' ||
        result.step3_modalAfterReturn.selectedAfterReturn === null) {
      console.error('❌ Step 3 失敗: 帰還後に乗車ボタンが有効化されていないか、選択コールバックが機能していません。');
      success = false;
    } else {
      console.log('✅ Step 3 成功: 帰還後は通常通り運転席への乗車ボタンが有効化され、選択が正常に完了しました。');
    }

    if (success) {
      console.log('\n🎉 すべてのテストに合格しました！マップ外走行列車の整合性保護は完璧です。');
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

testExternalTravelTrainModalAndCars();
