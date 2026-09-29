import * as fs from 'fs';
import * as path from 'path';

interface BundleTarget {
  name: string;
  description: string;
  sourceDirs?: string[];
  specificFiles?: string[];
}

const targets: BundleTarget[] = [
  {
    name: 'main',
    description: 'エントリポイント・メインループ・HTML構造・CSSスタイリング',
    specificFiles: [
      'src/main.ts',
      'index.html',
      'src/style.css'
    ]
  },
  {
    name: 'core',
    description: 'コアエンジン・ゲーム状態・ダイヤ・閉塞信号・需要計算・ゾーン・駅・輸送システム',
    sourceDirs: ['src/core']
  },
  {
    name: 'engine',
    description: '3D描画エンジン・Web Audio音響・ライティング制御',
    sourceDirs: ['src/engine']
  },
  {
    name: 'graphics',
    description: 'カメラ管理・InstancedMeshバッチング・マテリアル・地形描画・各種メッシュビルダー',
    sourceDirs: ['src/graphics']
  },
  {
    name: 'models',
    description: '3Dモデルファクトリ・メッシュ生成統括',
    sourceDirs: ['src/models']
  },
  {
    name: 'simulation',
    description: 'ワールドマップ管理・列車物理・都市発展・経済・車両図鑑',
    sourceDirs: ['src/simulation']
  },
  {
    name: 'ui',
    description: 'UIマネージャー・ダイヤ編成UI・ミニマップ・入力制御・アイコン定義',
    sourceDirs: ['src/ui']
  }
];

function getAllFilesRecursively(dir: string, baseDir: string = dir): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllFilesRecursively(fullPath, baseDir));
    } else {
      if (file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.css') || file.endsWith('.html')) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function bundleFiles(target: BundleTarget): string {
  let filePaths: string[] = [];

  if (target.specificFiles) {
    for (const f of target.specificFiles) {
      if (fs.existsSync(f)) {
        filePaths.push(f);
      }
    }
  }

  if (target.sourceDirs) {
    for (const d of target.sourceDirs) {
      filePaths = filePaths.concat(getAllFilesRecursively(d));
    }
  }

  // ソート
  filePaths.sort();

  let totalLines = 0;
  const fileSummaries: Array<{ relPath: string; lines: number; size: number }> = [];

  for (const fp of filePaths) {
    const content = fs.readFileSync(fp, 'utf-8');
    const lines = content.split('\n').length;
    totalLines += lines;
    const relPath = path.relative(process.cwd(), fp).replace(/\\/g, '/');
    fileSummaries.push({ relPath, lines, size: Buffer.byteLength(content, 'utf-8') });
  }

  let output = `================================================================================\n`;
  output += `わがまちレールウェイ (Wagamachi Railway) - Code Bundle\n`;
  output += `BUNDLE: ${target.name.toUpperCase()} (${target.description})\n`;
  output += `GENERATED: ${new Date().toISOString()}\n`;
  output += `TOTAL FILES: ${fileSummaries.length} files\n`;
  output += `TOTAL LINES: ${totalLines.toLocaleString()} lines\n`;
  output += `================================================================================\n\n`;

  output += `--- 収録ファイル一覧 ---\n`;
  for (const s of fileSummaries) {
    output += `- ${s.relPath} (${s.lines.toLocaleString()} 行 / ${(s.size / 1024).toFixed(1)} KB)\n`;
  }
  output += `\n`;

  for (const fp of filePaths) {
    const relPath = path.relative(process.cwd(), fp).replace(/\\/g, '/');
    const content = fs.readFileSync(fp, 'utf-8');
    const lines = content.split('\n').length;

    output += `\n################################################################################\n`;
    output += `### FILE: ${relPath} (${lines.toLocaleString()} lines)\n`;
    output += `################################################################################\n\n`;
    output += content;
    if (!content.endsWith('\n')) output += '\n';
  }

  return output;
}

function main() {
  const outDir = 'shared_txt';

  // shared_txt ディレクトリの準備（存在しない場合は作成）
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  console.log('================================================================================');
  console.log('=== わがまちレールウェイ: 主要コードバンドル (.txt) 生成開始 ===');
  console.log('================================================================================\n');

  const allGeneratedFiles: Array<{ name: string; path: string; fileCount: number; totalLines: number; sizeKB: string }> = [];

  for (const target of targets) {
    const bundledText = bundleFiles(target);
    const fileName = `${target.name}.txt`;
    const outPath = path.join(outDir, fileName);

    fs.writeFileSync(outPath, bundledText, 'utf-8');
    const sizeKB = (Buffer.byteLength(bundledText, 'utf-8') / 1024).toFixed(1);
    const lines = bundledText.split('\n').length;

    // ファイル数のカウント
    let count = 0;
    if (target.specificFiles) count += target.specificFiles.filter(f => fs.existsSync(f)).length;
    if (target.sourceDirs) {
      for (const d of target.sourceDirs) {
        count += getAllFilesRecursively(d).length;
      }
    }

    allGeneratedFiles.push({
      name: fileName,
      path: outPath,
      fileCount: count,
      totalLines: lines,
      sizeKB
    });

    console.log(`[出力完了] ${outPath} (${count} ファイル / ${lines.toLocaleString()} 行 / ${sizeKB} KB)`);
  }

  console.log('\n================================================================================');
  console.log(`すべての主要コードバンドルが ${outDir}/ に正常に出力されました！`);
  console.log('================================================================================\n');
}

main();
