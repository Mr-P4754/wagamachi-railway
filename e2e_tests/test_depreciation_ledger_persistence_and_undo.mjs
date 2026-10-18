/**
 * 減価償却台帳（AssetDepreciationManager）の永続化・Undo・返金整合性 E2Eテスト
 *
 * 検証項目:
 * 1. Economy.serialize / deserialize による減価償却台帳の完全保存と復元
 * 2. Economy.resetAll() による減価償却台帳の完全初期化（前ゲームの残留防止）
 * 3. PlacementController での設置時における実質コスト（netCost）のみの資産登録
 * 4. UndoManager による Undo 実行時の建設費返金および固定資産台帳からの安全な減額
 */

import { chromium } from 'playwright';

async function runDepreciationPersistenceTest() {
  console.log('=== 減価償却台帳の永続化・Undo・返金整合性 E2Eテスト開始 ===\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto('http://localhost:3000');
    await page.waitForTimeout(2000);

    // ==========================================
    // ステップ 1: セーブ・ロード・初期化における台帳データの完全保持検証
    // ==========================================
    console.log('--- ステップ 1: serialize / deserialize / resetAll における台帳保持・初期化検証 ---');
    const persistenceTest = await page.evaluate(() => {
      const app = window.gameApp;
      const eco = app.economy;

      // 初期状態をクリア
      eco.resetAll();
      const initialAssets = eco.depreciationManager.getAssets().length;
      const initialBookValue = eco.depreciationManager.getTotalBookValue();

      // 資産を新規登録（車両1件: 20,000,000円、インフラ1件: 5,000,000円）
      eco.spendFunds(20000000, true, 'vehicle', 'テスト特急型車両');
      eco.spendFunds(5000000, true, 'infrastructure', '中央幹線線路設備');
      eco.lastDepreciationCost = 1200000;
      eco.lastTotalBookValue = 23800000;

      const registeredAssets = eco.depreciationManager.getAssets().length;
      const registeredBookValue = eco.depreciationManager.getTotalBookValue();
      const registeredInitialCost = eco.depreciationManager.getTotalInitialCost();

      // シリアライズ（セーブデータ生成）
      const serialized = eco.serialize();

      // 都市初期化（リセット実行）
      eco.resetAll();
      const afterResetAssets = eco.depreciationManager.getAssets().length;
      const afterResetBookValue = eco.depreciationManager.getTotalBookValue();
      const afterResetDepCost = eco.lastDepreciationCost;

      // デシリアライズ（ロード復元実行）
      eco.deserialize(serialized);
      const restoredAssets = eco.depreciationManager.getAssets().length;
      const restoredBookValue = eco.depreciationManager.getTotalBookValue();
      const restoredInitialCost = eco.depreciationManager.getTotalInitialCost();
      const restoredDepCost = eco.lastDepreciationCost;
      const restoredTotalBook = eco.lastTotalBookValue;

      return {
        initialAssets,
        initialBookValue,
        registeredAssets,
        registeredBookValue,
        registeredInitialCost,
        hasSerializedLedger: !!serialized.depreciationLedger,
        serializedAssetCount: serialized.depreciationLedger?.assets?.length,
        afterResetAssets,
        afterResetBookValue,
        afterResetDepCost,
        restoredAssets,
        restoredBookValue,
        restoredInitialCost,
        restoredDepCost,
        restoredTotalBook
      };
    });

    console.log('  シリアライズ・復元・リセット結果:', persistenceTest);

    if (!persistenceTest.hasSerializedLedger || persistenceTest.serializedAssetCount !== 2) {
      throw new Error(`serialize() に減価償却台帳が含まれていません: count=${persistenceTest.serializedAssetCount}`);
    }
    if (persistenceTest.afterResetAssets !== 0 || persistenceTest.afterResetBookValue !== 0 || persistenceTest.afterResetDepCost !== 0) {
      throw new Error(`resetAll() で減価償却台帳がクリアされていません: assets=${persistenceTest.afterResetAssets}`);
    }
    if (persistenceTest.restoredAssets !== 2 || persistenceTest.restoredBookValue !== 25000000 || persistenceTest.restoredInitialCost !== 25000000) {
      throw new Error(`deserialize() による資産復元が不正です: restoredBookValue=${persistenceTest.restoredBookValue}`);
    }
    if (persistenceTest.restoredDepCost !== 1200000 || persistenceTest.restoredTotalBook !== 23800000) {
      throw new Error(`前年度決算償却費・簿価の復元が不正です: depCost=${persistenceTest.restoredDepCost}`);
    }
    console.log('  ✓ serialize / deserialize / resetAll による台帳の保存・復元・クリアを完全確認');

    // ==========================================
    // ステップ 2: 設置実行時の実質コスト（netCost）資産登録と過剰登録防止検証
    // ==========================================
    console.log('\n--- ステップ 2: 設置実行時の実質コスト資産登録検証 ---');
    const netCostTest = await page.evaluate(() => {
      const app = window.gameApp;
      const eco = app.economy;
      const pc = app.placementController;

      eco.resetAll();
      const bookValueBefore = eco.depreciationManager.getTotalBookValue();

      // 線路1マスを仮置き（コスト: 500,000円）
      pc.pendingItems = [
        { tool: 'rail-straight', x: 10, z: 10, rotation: 0, layer: 1 }
      ];

      // 設置確定
      pc.confirmPendingPlacements();

      const bookValueAfter = eco.depreciationManager.getTotalBookValue();
      const assetsCount = eco.depreciationManager.getAssets().length;
      const addedBookValue = bookValueAfter - bookValueBefore;

      return {
        bookValueBefore,
        bookValueAfter,
        addedBookValue,
        assetsCount
      };
    });

    console.log('  設置実行時の資産登録結果:', netCostTest);
    if (netCostTest.addedBookValue !== 500000 || netCostTest.assetsCount !== 1) {
      throw new Error(`設置時の実質コスト資産登録が不正です: added=${netCostTest.addedBookValue}, count=${netCostTest.assetsCount}`);
    }
    console.log('  ✓ 設置成功した実質コスト（¥500,000）のみが資産台帳へ正確に登録されたことを確認');

    // ==========================================
    // ステップ 3: Undo実行時の固定資産台帳からの減額・取り消し検証
    // ==========================================
    console.log('\n--- ステップ 3: Undo実行時の固定資産台帳減額検証 ---');
    const undoTest = await page.evaluate(() => {
      const app = window.gameApp;
      const eco = app.economy;
      const um = app.undoManager;

      const fundsBeforeUndo = eco.funds;
      const bookValueBeforeUndo = eco.depreciationManager.getTotalBookValue();
      const assetsCountBeforeUndo = eco.depreciationManager.getAssets().length;

      // 直前の設置（¥500,000）を取り消し
      const undoSuccess = um.undo();

      const fundsAfterUndo = eco.funds;
      const bookValueAfterUndo = eco.depreciationManager.getTotalBookValue();
      const assetsCountAfterUndo = eco.depreciationManager.getAssets().length;

      return {
        undoSuccess,
        refundAmount: fundsAfterUndo - fundsBeforeUndo,
        bookValueChange: bookValueAfterUndo - bookValueBeforeUndo,
        assetsCountBeforeUndo,
        assetsCountAfterUndo
      };
    });

    console.log('  Undo実行結果:', undoTest);
    if (!undoTest.undoSuccess) {
      throw new Error('Undoの実行に失敗しました');
    }
    if (undoTest.refundAmount !== 500000) {
      throw new Error(`Undoによる返金額が不正です: ¥${undoTest.refundAmount}`);
    }
    if (undoTest.bookValueChange !== -500000 || undoTest.assetsCountAfterUndo !== 0) {
      throw new Error(`Undo時に固定資産台帳から減額されていません: bookValueChange=${undoTest.bookValueChange}, assetsCount=${undoTest.assetsCountAfterUndo}`);
    }
    console.log('  ✓ Undo実行時に建設費が返金され、固定資産台帳からも資産（¥500,000）が正常に取り消されたことを確認');

    // ==========================================
    // ステップ 4: IndexedDB 永続化（PersistenceService セーブ＆ロード）の総合検証
    // ==========================================
    console.log('\n--- ステップ 4: IndexedDB 永続化（PersistenceService）検証 ---');
    const dbPersistenceTest = await page.evaluate(async () => {
      const app = window.gameApp;
      const ps = app.persistenceService;
      const eco = app.economy;

      // 資産を登録
      eco.resetAll();
      eco.spendFunds(15000000, true, 'vehicle', '通勤形2両編成');
      eco.spendFunds(8000000, true, 'infrastructure', '高架複線駅ホーム');

      // IndexedDB へセーブ
      await ps.saveGame();

      // 台帳をクリア
      eco.resetAll();
      const clearedBookValue = eco.depreciationManager.getTotalBookValue();

      // IndexedDB からロード
      await ps.loadGame();
      const loadedBookValue = eco.depreciationManager.getTotalBookValue();
      const loadedAssetsCount = eco.depreciationManager.getAssets().length;

      return {
        clearedBookValue,
        loadedBookValue,
        loadedAssetsCount
      };
    });

    console.log('  IndexedDB セーブ＆ロード結果:', dbPersistenceTest);
    if (dbPersistenceTest.clearedBookValue !== 0) {
      throw new Error('リセット後の簿価が0になっていません');
    }
    if (dbPersistenceTest.loadedBookValue !== 23000000 || dbPersistenceTest.loadedAssetsCount !== 2) {
      throw new Error(`IndexedDBからの台帳復元が不正です: bookValue=${dbPersistenceTest.loadedBookValue}, count=${dbPersistenceTest.loadedAssetsCount}`);
    }
    console.log('  ✓ IndexedDB 経由での減価償却台帳の完全な永続化・復元を確認');

    console.log('\n=== 全てのテストが正常に完了しました！ ===');

  } catch (err) {
    console.error('テスト失敗:', err);
    throw err;
  } finally {
    await browser.close();
  }
}

runDepreciationPersistenceTest().catch(() => process.exit(1));
