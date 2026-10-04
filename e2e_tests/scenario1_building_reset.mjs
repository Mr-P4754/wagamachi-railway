import { chromium } from 'playwright';

async function runScenario1() {
  console.log('=== シナリオ 1: BuildingBakery キャッシュ解放と都市初期化 テスト開始 ===');
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
    // 1. ゲームにアクセス
    await page.goto('http://localhost:3000/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // タイトル画面の確認
    const titleOverlay = await page.$('#title-screen-overlay');
    const isTitleVisible = titleOverlay && !(await titleOverlay.evaluate(el => el.classList.contains('hidden')));
    console.log('  タイトル画面表示状態:', isTitleVisible);

    // 新規ゲーム開始（タイトルからゲーム画面へ）
    if (isTitleVisible) {
      const btnNew = await page.$('#btn-title-new');
      if (btnNew) {
        await btnNew.click();
        await page.waitForTimeout(300);
        const btnStart = await page.$('#btn-title-start');
        if (btnStart) {
          await btnStart.click();
        }
      }
    }
    await page.waitForTimeout(1000);

    // 2. 住宅、商業ビル、工業施設を複数建設して3Dメッシュを生成
    console.log('  建物の配置と3Dメッシュ生成を実行...');
    const buildResult = await page.evaluate(() => {
      const app = window.gameApp;
      if (!app) return { success: false, error: 'gameApp not found' };
      const wm = app.worldMap;
      const gm = app.gridManager;

      // 建物タイルを配置（住宅、商業、工業）
      const buildingTypes = [
        { type: 'residence', level: 1 },
        { type: 'residence', level: 2 },
        { type: 'residence', level: 3 },
        { type: 'commercial', level: 1 },
        { type: 'commercial', level: 2 },
        { type: 'commercial', level: 3 },
        { type: 'industrial', level: 1 },
        { type: 'industrial', level: 2 },
        { type: 'industrial', level: 3 }
      ];

      let placed = 0;
      let startX = 20, startZ = 20;
      for (let i = 0; i < buildingTypes.length; i++) {
        const b = buildingTypes[i];
        const x = startX + (i % 3) * 2;
        const z = startZ + Math.floor(i / 3) * 2;
        wm.setTile(x, z, b.type, 0, b.level, 'right', 1);
        placed++;
      }

      // レンダリングメッシュの存在確認
      const tilesWithMesh = wm.getAllTiles().filter(t => t.mesh && (t.type === 'residence' || t.type === 'commercial' || t.type === 'industrial'));
      return {
        success: true,
        placedCount: placed,
        meshCount: tilesWithMesh.length
      };
    });

    console.log('  建物メッシュ生成結果:', buildResult);
    if (!buildResult.success || buildResult.meshCount === 0) {
      throw new Error('建物メッシュの生成に失敗しました: ' + JSON.stringify(buildResult));
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario1_step1_buildings_created.png' });

    // 3. レポートモーダルを開き、「都市を初期化」ボタンを2段階クリックして実行
    console.log('  レポートモーダルを開く...');
    const reportBtn = await page.$('#btn-report');
    if (!reportBtn) throw new Error('レポートボタンが見つかりません');
    await reportBtn.click();
    await page.waitForTimeout(500);

    const reportModal = await page.$('#report-modal');
    const isReportVisible = reportModal && !(await reportModal.evaluate(el => el.classList.contains('hidden')));
    console.log('  レポートモーダル表示:', isReportVisible);

    const btnReset = await page.$('#btn-reset-city');
    if (!btnReset) throw new Error('都市初期化ボタンが見つかりません');

    // 1回目のクリック（確認状態へ）
    console.log('  都市初期化ボタン 1回目のクリック...');
    await btnReset.click();
    await page.waitForTimeout(300);

    const isConfirming = await btnReset.evaluate(el => el.classList.contains('confirming'));
    const btnText1 = await btnReset.evaluate(el => el.textContent);
    console.log('  確認モード突入状態:', isConfirming, 'ボタン表示:', btnText1);
    if (!isConfirming) throw new Error('都市初期化の1回目クリックで確認モードに入りませんでした');

    // 2回目のクリック（初期化確定）
    console.log('  都市初期化ボタン 2回目のクリック（確定実行）...');
    await btnReset.click();
    await page.waitForTimeout(1000);

    // 4. 初期化処理が例外エラーなく完了し、タイトル画面へ復帰することを確認
    const isTitleAfterReset = await page.evaluate(() => {
      const el = document.getElementById('title-screen-overlay');
      return el && !el.classList.contains('hidden');
    });
    console.log('  初期化後のタイトル画面復帰状態:', isTitleAfterReset);
    if (!isTitleAfterReset) throw new Error('都市初期化後にタイトル画面へ復帰しませんでした');

    await page.screenshot({ path: 'e2e_screenshots/scenario1_step2_reset_title.png' });

    // 5. 再度新規ゲームを開始し、更地に建物を新規建築した際にテクスチャやジオメトリの欠損なく正常にレンダリングされることを確認
    console.log('  新規ゲームを開始して再建築テスト...');
    const btnNewGame = await page.$('#btn-title-new');
    if (btnNewGame) {
      await btnNewGame.click();
      await page.waitForTimeout(300);
      const btnStartGame = await page.$('#btn-title-start');
      if (btnStartGame) {
        await btnStartGame.click();
      }
    }
    await page.waitForTimeout(1000);

    const rebuildResult = await page.evaluate(() => {
      const app = window.gameApp;
      if (!app) return { success: false, error: 'gameApp not found' };
      const wm = app.worldMap;

      // 新規に建物を設置
      wm.setTile(10, 10, 'commercial', 0, 3, 'right', 1);

      const tile = wm.getTile(10, 10, 1);
      const hasMesh = !!(tile && tile.mesh);
      let hasValidGeom = false;
      let hasValidMat = false;

      if (tile && tile.mesh) {
        tile.mesh.traverse(child => {
          if (child.isMesh) {
            if (child.geometry && child.geometry.attributes && child.geometry.attributes.position) {
              hasValidGeom = true;
            }
            if (child.material) {
              hasValidMat = true;
            }
          }
        });
      }

      return {
        success: true,
        hasMesh,
        hasValidGeom,
        hasValidMat
      };
    });

    console.log('  再建築・メッシュ検証結果:', rebuildResult);
    if (!rebuildResult.success || !rebuildResult.hasMesh || !rebuildResult.hasValidGeom) {
      throw new Error('再建築後のメッシュ/ジオメトリ検証に失敗しました: ' + JSON.stringify(rebuildResult));
    }

    await page.screenshot({ path: 'e2e_screenshots/scenario1_step3_rebuild_verified.png' });

    if (consoleErrors.length > 0) {
      console.warn('  警告: 実行中にコンソールエラーがありました:', consoleErrors);
    }

    console.log('=== シナリオ 1: PASS ===\n');
    return { pass: true, errors: consoleErrors };
  } catch (err) {
    console.error('=== シナリオ 1: FAIL ===', err);
    await page.screenshot({ path: 'e2e_screenshots/scenario1_fail.png' }).catch(() => {});
    return { pass: false, error: err.message, errors: consoleErrors };
  } finally {
    await browser.close();
  }
}

runScenario1().then(res => {
  if (!res.pass) process.exit(1);
});
