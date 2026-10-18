import { GridManager } from '../src/core/GridManager';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
}

console.log('=== 地形プロシージャル生成（Perlin / fBm / シード永続化）検証開始 ===');

// 1. 同一シード値による決定論的一致性テスト
console.log('--- テスト1: 同一シードによる決定論的一致性 ---');
const seedA = 987654321;
const gmA1 = new GridManager(256, 'balanced', seedA);
const gmA2 = new GridManager(256, 'balanced', seedA);

assert(gmA1.seed === seedA, 'GridManager A1のシード値が正しくセットされていること');
assert(gmA2.seed === seedA, 'GridManager A2のシード値が正しくセットされていること');

const testCoords = [
  { x: -50, z: -50 },
  { x: 30, z: 40 },
  { x: -80, z: 20 },
  { x: 15, z: -15 },
  { x: 100, z: 100 },
  { x: -120, z: 60 }
];

for (const { x, z } of testCoords) {
  const p1 = gmA1.sampleTerrain(x, z);
  const p2 = gmA2.sampleTerrain(x, z);
  assert(p1.elevation === p2.elevation && p1.isWater === p2.isWater, `同一シードで座標 (${x}, ${z}) の地形が一致すること (p1: ${JSON.stringify(p1)}, p2: ${JSON.stringify(p2)})`);
}
console.log('✓ 同一シードで完全に一致する地形が生成されました！');

// 2. 異なるシード値による多様性テスト
console.log('--- テスト2: 異なるシードによる多様性 ---');
const seedB = 123456789;
const gmB = new GridManager(256, 'balanced', seedB);
assert(gmB.seed === seedB, 'GridManager Bのシード値が正しくセットされていること');

let differenceCount = 0;
for (let x = -60; x <= 60; x += 10) {
  for (let z = -60; z <= 60; z += 10) {
    if (Math.abs(x) <= 10 && Math.abs(z) <= 8) continue; // 初期都市除外
    const pA = gmA1.sampleTerrain(x, z);
    const pB = gmB.sampleTerrain(x, z);
    if (pA.elevation !== pB.elevation || pA.isWater !== pB.isWater) {
      differenceCount++;
    }
  }
}
assert(differenceCount > 10, `異なるシード値で地形に有意な差が生じていること (不一致マス数: ${differenceCount})`);
console.log(`✓ 異なるシードにより地形が多様に変化しています！ (変化マス数: ${differenceCount})`);

// 3. 中央都市保護エリアの検証
console.log('--- テスト3: 中央初期都市保護エリア (x: -8..8, z: -7..4) の検証 ---');
const templates: ('balanced' | 'mountain' | 'coastal' | 'random')[] = ['balanced', 'mountain', 'coastal', 'random'];
for (const tmpl of templates) {
  for (let s = 0; s < 5; s++) {
    const gmTest = new GridManager(256, tmpl, s * 10007 + 42);
    for (let x = -8; x <= 8; x++) {
      for (let z = -7; z <= 4; z++) {
        const pt = gmTest.sampleTerrain(x, z);
        assert(pt.elevation === 1 && !pt.isWater, `テンプレート ${tmpl}, シード ${gmTest.seed} の都市保護マス (${x}, ${z}) が標高1・陸地であること`);
      }
    }
  }
}
console.log('✓ すべてのテンプレートとシード値で初期都市エリア（x: -8..8, z: -7..4）が平地として完全に保護されています！');

// 4. チャンク遅延生成のステートレス検証
console.log('--- テスト4: チャンク遅延生成 (ensureChunk) とサンプリングの整合性 ---');
const gmChunkTest = new GridManager(256, 'mountain', 777);
const chunk = gmChunkTest.ensureChunk(4, 4); // チャンク取得
const half = 256 / 2;
const startX = 4 * 32 - half;
const startZ = 4 * 32 - half;

for (let lx = 0; lx < 32; lx += 4) {
  for (let lz = 0; lz < 32; lz += 4) {
    const wx = startX + lx;
    const wz = startZ + lz;
    const sampled = gmChunkTest.sampleTerrain(wx, wz);
    const cell = gmChunkTest.getCell(wx, 1, wz);
    assert(cell !== null, `セル (${wx}, 1, ${wz}) が取得できること`);
    assert(cell!.elevation === sampled.elevation, `セル標高 (${cell!.elevation}) とサンプリング標高 (${sampled.elevation}) が一致すること`);
    assert(cell!.isWater === sampled.isWater, `セル水域 (${cell!.isWater}) とサンプリング水域 (${sampled.isWater}) が一致すること`);
  }
}
console.log('✓ ensureChunk と sampleTerrain の結果が完全に一致しています！');

console.log('=== すべての地形プロシージャル生成テストに合格しました！ ===');
