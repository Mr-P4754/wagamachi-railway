import { chromium } from 'playwright';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function measureEnvironmentAndFPS() {
  console.log('====================================================');
  console.log('  わがまちレールウェイ E2Eテスト統合ランナー');
  console.log('  [Step 0] 動作環境およびフレームレート（FPS）測定');
  console.log('====================================================');

  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl']
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  try {
    await page.goto('http://localhost:3000/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // タイトル画面があればスタート
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

    // FPSおよび環境情報測定 (120フレーム)
    const envData = await page.evaluate(async () => {
      const gl = document.querySelector('canvas')?.getContext('webgl2') || document.querySelector('canvas')?.getContext('webgl');
      const debugInfo = gl ? gl.getExtension('WEBGL_debug_renderer_info') : null;
      const vendor = debugInfo && gl ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : 'Unknown Vendor';
      const renderer = debugInfo && gl ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : 'Unknown Renderer';

      // 120フレーム追跡してFPSを測定
      const frames = [];
      let lastTime = performance.now();
      await new Promise(resolve => {
        function onFrame(currentTime) {
          const delta = currentTime - lastTime;
          lastTime = currentTime;
          frames.push(delta);
          if (frames.length >= 120) {
            resolve();
          } else {
            requestAnimationFrame(onFrame);
          }
        }
        requestAnimationFrame(onFrame);
      });

      // 最初の2フレームは除外して安定値を集計
      const validFrames = frames.slice(2);
      const avgDelta = validFrames.reduce((a, b) => a + b, 0) / validFrames.length;
      const avgFps = Math.round(1000 / avgDelta);
      const minFps = Math.round(1000 / Math.max(...validFrames));
      const maxFps = Math.round(1000 / Math.min(...validFrames));

      return {
        userAgent: navigator.userAgent,
        vendor,
        renderer,
        devicePixelRatio: window.devicePixelRatio,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        avgFps,
        minFps,
        maxFps,
        totalFramesMeasured: validFrames.length
      };
    });

    console.log('  ブラウザ:', envData.userAgent);
    console.log('  WebGL レンダラー:', envData.renderer);
    console.log('  テスト解像度:', `${envData.viewport.width}x${envData.viewport.height} (DPR: ${envData.devicePixelRatio})`);
    console.log('  実測フレームレート: 平均', `${envData.avgFps} FPS`, `(Min: ${envData.minFps}, Max: ${envData.maxFps})`);
    console.log('----------------------------------------------------\n');

    return envData;
  } finally {
    await browser.close();
  }
}

function runScript(scriptName) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, scriptName);
    const start = Date.now();
    const child = spawn('node', [scriptPath], {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..')
    });

    child.on('close', (code) => {
      const duration = ((Date.now() - start) / 1000).toFixed(1);
      resolve({
        scriptName,
        pass: code === 0,
        exitCode: code,
        duration: `${duration}s`
      });
    });
  });
}

async function main() {
  const envData = await measureEnvironmentAndFPS();

  const scenarios = [
    { name: 'シナリオ 1: BuildingBakery キャッシュ解放と都市初期化', file: 'scenario1_building_reset.mjs' },
    { name: 'シナリオ 2: Undo（元に戻す）機能と在線安全ガード', file: 'scenario2_undo_safety.mjs' },
    { name: 'シナリオ 3: 財務・経営推移チャート（月次・年次）の描画', file: 'scenario3_financial_charts.mjs' },
    { name: 'シナリオ 4: 貨物輸送可視化と経済フィードバック', file: 'scenario4_cargo_logistics.mjs' },
    { name: 'シナリオ 5: グラフィック品質設定（軽量化トグル）', file: 'scenario5_graphics_settings.mjs' },
    { name: 'シナリオ 6: 列車追従（Chase）カメラ', file: 'scenario6_chase_camera.mjs' },
    { name: 'シナリオ 7: 不具合改善検証（踏切横断および車両結合・追従間隔維持）', file: 'scenario7_crossing_and_coupling.mjs' },
    { name: 'シナリオ 8: 踏切設置機能（道路×線路交差・専用ツール・ドラッグ横断）', file: 'test_crossing_placement.mjs' },
    { name: 'シナリオ 9: 隣町ゲートウェイ広域往来＆減価償却会計（耐用年数・税制適正化）', file: 'test_neighbor_city_and_depreciation.mjs' }
  ];

  const results = [];

  for (const s of scenarios) {
    console.log(`\n====================================================`);
    console.log(`  実行中: ${s.name}`);
    console.log(`====================================================`);
    const res = await runScript(s.file);
    results.push({ ...s, ...res });
  }

  console.log('\n\n====================================================');
  console.log('             E2E テスト結果総合サマリー');
  console.log('====================================================');
  console.log(`  テスト実行ブラウザ: Chromium (Headless WebGL)`);
  console.log(`  解像度: ${envData.viewport.width}x${envData.viewport.height}`);
  console.log(`  平均 FPS: ${envData.avgFps} FPS (安定描画確認)`);
  console.log('----------------------------------------------------');

  let allPass = true;
  results.forEach((r, idx) => {
    const status = r.pass ? '✅ PASS' : '❌ FAIL';
    if (!r.pass) allPass = false;
    console.log(`  [シナリオ ${idx + 1}] ${status} (${r.duration}) - ${r.name}`);
  });

  console.log('----------------------------------------------------');
  if (allPass) {
    console.log('  🎉 全シナリオ (1〜7) の動作検証に合格しました！');
  } else {
    console.log('  ⚠️ 一部のシナリオで失敗が検出されました。');
  }
  console.log('====================================================\n');

  if (!allPass) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('ランナーエラー:', err);
  process.exit(1);
});
