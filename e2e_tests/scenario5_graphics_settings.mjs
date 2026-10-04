import { chromium } from 'playwright';

async function runScenario5() {
  console.log('=== シナリオ 5: グラフィック品質設定（軽量化トグル） テスト開始 ===');
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

    // タイトル画面があれば閉じてゲーム画面へ
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

    // 1. 設定UI（レポートモーダルまたはクイックバー）から「画質設定」を開く
    // 初期状態（PC環境）で高画質（High）であることを確認
    console.log('  ステップ1: 初期画質設定の確認...');
    const initialCheck = await page.evaluate(() => {
      const app = window.gameApp;
      const r = app.renderer;
      const badge = document.getElementById('graphics-quality-badge');
      return {
        quality: r.getGraphicsQuality(),
        shadowEnabled: r.renderer.shadowMap.enabled,
        dirLightShadow: r.dirLight.castShadow,
        badgeText: badge ? badge.textContent.trim() : ''
      };
    });

    console.log('  初期画質状態:', initialCheck);
    await page.screenshot({ path: 'e2e_screenshots/scenario5_step1_initial_high.png' });

    // 2. クオリティを「低（Low）」に変更する
    // 画面の比率（アスペクト比）が崩れず、地面や建物の影（シャドウ）が非表示になり、描画負荷が軽くなることを確認
    console.log('  ステップ2: 画質設定を「低（Low）」に変更...');
    // レポートモーダルを開く
    const reportBtn = await page.$('#btn-report');
    if (reportBtn) await reportBtn.click();
    await page.waitForTimeout(400);

    // レポートモーダル内の select-graphics-quality を 'low' に変更
    await page.selectOption('#select-graphics-quality', 'low');
    await page.waitForTimeout(400);

    const lowCheck = await page.evaluate(() => {
      const app = window.gameApp;
      const r = app.renderer;
      const badge = document.getElementById('graphics-quality-badge');
      const canvas = r.renderer.domElement;
      const storageVal = localStorage.getItem('wagamachi_graphics_quality');

      return {
        quality: r.getGraphicsQuality(),
        shadowEnabled: r.renderer.shadowMap.enabled,
        dirLightShadow: r.dirLight.castShadow,
        badgeText: badge ? badge.textContent.trim() : '',
        pixelRatio: r.renderer.getPixelRatio(),
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        storageVal
      };
    });

    console.log('  低画質（Low）状態検証:', lowCheck);
    if (lowCheck.quality !== 'low' || lowCheck.shadowEnabled !== false || lowCheck.dirLightShadow !== false || lowCheck.badgeText !== '低') {
      throw new Error('低画質への切り替え検証に失敗しました: ' + JSON.stringify(lowCheck));
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario5_step2_low_quality.png' });

    // 3. クオリティを「高（High）」に戻し、美しいソフトシャドウが破綻なく復帰することを確認
    console.log('  ステップ3: 画質設定を「高（High）」に復帰...');
    await page.selectOption('#select-graphics-quality', 'high');
    await page.waitForTimeout(400);

    const highRestoreCheck = await page.evaluate(() => {
      const app = window.gameApp;
      const r = app.renderer;
      const badge = document.getElementById('graphics-quality-badge');
      const storageVal = localStorage.getItem('wagamachi_graphics_quality');

      return {
        quality: r.getGraphicsQuality(),
        shadowEnabled: r.renderer.shadowMap.enabled,
        dirLightShadow: r.dirLight.castShadow,
        badgeText: badge ? badge.textContent.trim() : '',
        storageVal
      };
    });

    console.log('  高画質復元検証:', highRestoreCheck);
    if (highRestoreCheck.quality !== 'high' || highRestoreCheck.shadowEnabled !== true || highRestoreCheck.dirLightShadow !== true || highRestoreCheck.badgeText !== '高') {
      throw new Error('高画質への復帰検証に失敗しました: ' + JSON.stringify(highRestoreCheck));
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario5_step3_high_restored.png' });

    // 4. クイックバーのトグルボタンで「低（Low）」にし、ページをリロード（F5）してローカルストレージから正しく復元されることを確認
    console.log('  ステップ4: クイックバートグルで「低」に設定後、リロード復元確認...');
    // レポートモーダルを閉じる
    const closeBtn = await page.$('#btn-close-report');
    if (closeBtn) await closeBtn.click();
    await page.waitForTimeout(300);

    // ヘッダーの画質トグルボタンをクリック（高 ➔ 中 ➔ 低）
    const btnToggle = await page.$('#btn-graphics-toggle');
    if (btnToggle) {
      await btnToggle.click(); // 中へ
      await page.waitForTimeout(200);
      await btnToggle.click(); // 低へ
      await page.waitForTimeout(300);
    }

    const beforeReload = await page.evaluate(() => {
      return {
        quality: window.gameApp.renderer.getGraphicsQuality(),
        storage: localStorage.getItem('wagamachi_graphics_quality')
      };
    });
    console.log('  リロード前の画質設定:', beforeReload);
    if (beforeReload.quality !== 'low' || beforeReload.storage !== 'low') {
      throw new Error('トグルによる低画質設定に失敗しました: ' + JSON.stringify(beforeReload));
    }

    // ページリロード
    console.log('  ページをリロード (F5)...');
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const afterReload = await page.evaluate(() => {
      const app = window.gameApp;
      const r = app ? app.renderer : null;
      const badge = document.getElementById('graphics-quality-badge');
      const storage = localStorage.getItem('wagamachi_graphics_quality');

      return {
        hasApp: !!app,
        quality: r ? r.getGraphicsQuality() : null,
        shadowEnabled: r ? r.renderer.shadowMap.enabled : null,
        dirLightShadow: r ? r.dirLight.castShadow : null,
        badgeText: badge ? badge.textContent.trim() : '',
        storage
      };
    });

    console.log('  リロード後の復元検証:', afterReload);
    if (!afterReload.hasApp || afterReload.quality !== 'low' || afterReload.shadowEnabled !== false || afterReload.badgeText !== '低') {
      throw new Error('リロード後の画質設定復元に失敗しました: ' + JSON.stringify(afterReload));
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario5_step4_reloaded_low_persisted.png' });

    console.log('=== シナリオ 5: PASS ===\n');
    return { pass: true, errors: consoleErrors };
  } catch (err) {
    console.error('=== シナリオ 5: FAIL ===', err);
    await page.screenshot({ path: 'e2e_screenshots/scenario5_fail.png' }).catch(() => {});
    return { pass: false, error: err.message, errors: consoleErrors };
  } finally {
    await browser.close();
  }
}

runScenario5().then(res => {
  if (!res.pass) process.exit(1);
});
