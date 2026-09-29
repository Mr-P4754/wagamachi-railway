/**
 * ⑤ 列車カタログ（5種類に厳選・性能カスタマイズ済み）
 */
export interface VehicleModelInfo {
  id: string;
  name: string;
  category: 'freight' | 'commuter' | 'suburban' | 'rapid' | 'express' | 'limited-express';
  description: string;
  speedTilesPerMinute: number; // 移動速度 (マス/分 = 等速時のマス/秒)
  basePrice: number; // 1両あたりの購入価格 (円)
  baseCapacity: number; // 1両あたりの定員 (人)
  maxOccupancyRate: number; // 最大乗車率 (1.0 = 100%, 2.0 = 200%)
  maxSpeed: number; // 最高速度 (km/h)
  farePerRide: number; // 乗客1人あたりの運賃 (円)
  runningCostPerTripPerCar: number; // 1両・1区間(発着)あたりの運行費用 (円, 乗車率75%が損益分岐点)
  dailyRunningCostPerCar: number; // 1両1日あたりの運行維持費 (円, 表示・互換用)
  // Visual properties (切妻型モデル)
  bodyColor: number; // 車体メイン色
  stripeColor: number; // 帯・アクセント色
  roofColor: number; // 屋根色
}

export const VEHICLE_CATALOG: VehicleModelInfo[] = [
  {
    id: 'freight-train',
    name: '貨物列車 (EF級)',
    category: 'freight',
    description: 'コンテナ・物資輸送を担う電気機関車牽引編成。低速ながら着実な運賃収入と低運行費が特徴。',
    speedTilesPerMinute: 1.0, // 基準速度: 1.0 マス/分（現実1秒で1マス）
    basePrice: 15000000,
    baseCapacity: 0, // 貨物専用（旅客定員なし）
    maxOccupancyRate: 0,
    maxSpeed: 75,
    farePerRide: 0, // 旅客運賃なし（コンテナ輸送で運賃計上）
    runningCostPerTripPerCar: 1000,
    dailyRunningCostPerCar: 3000,
    bodyColor: 0x1e3a8a, // ディープブルー
    stripeColor: 0xf59e0b, // ゴールド帯
    roofColor: 0x334155
  },
  {
    id: 'commuter-train',
    name: '通勤型列車',
    category: 'commuter',
    description: '都市部の過密輸送を支える4ドア通勤型。高定員・手頃な運賃と低い運行費が強み（最大乗車率200%）。',
    speedTilesPerMinute: 1.5, // 1.5 マス/分（約0.67秒で1マス）
    basePrice: 12000000,
    baseCapacity: 150,
    maxOccupancyRate: 2.0, // 最大乗車率 200%（1両あたり最大300人乗車可能）
    maxSpeed: 95,
    farePerRide: 250,
    runningCostPerTripPerCar: 1500, // 1両あたり1,500円（2両3,000円、12人乗車で黒字）
    dailyRunningCostPerCar: 4000,
    bodyColor: 0xd1d5db, // メタリックシルバー
    stripeColor: 0x10b981, // 若草エメラルドグリーン
    roofColor: 0x475569
  },
  {
    id: 'suburban-train',
    name: '近郊型列車',
    category: 'suburban',
    description: '都市とベッドタウンを結ぶセミクロスシート近郊型。乗客定員と速度のバランスが優れ、汎用性抜群（最大乗車率175%）。',
    speedTilesPerMinute: 2.0, // 2.0 マス/分（0.5秒で1マス）
    basePrice: 18000000,
    baseCapacity: 120,
    maxOccupancyRate: 1.75, // 最大乗車率 175%（1両あたり最大210人乗車可能）
    maxSpeed: 110,
    farePerRide: 350,
    runningCostPerTripPerCar: 2200, // 1両あたり2,200円（2両4,400円、13人乗車で黒字）
    dailyRunningCostPerCar: 6000,
    bodyColor: 0xfef9c3, // アイボリークリーム
    stripeColor: 0xe67e22, // オレンジ帯
    roofColor: 0x64748b
  },
  {
    id: 'rapid-train',
    name: '快速用列車',
    category: 'rapid',
    description: '主要駅を結ぶ高速快速用トレイン。軽量ステンレス車体で俊敏に走行し、高い運賃収入を生み出します（最大乗車率175%）。',
    speedTilesPerMinute: 2.0, // 2.0 マス/分（0.5秒で1マス）
    basePrice: 25000000,
    baseCapacity: 100,
    maxOccupancyRate: 1.75, // 最大乗車率 175%（1両あたり最大175人乗車可能）
    maxSpeed: 125,
    farePerRide: 500,
    runningCostPerTripPerCar: 3000, // 1両あたり3,000円（2両6,000円、12人乗車で黒字）
    dailyRunningCostPerCar: 8000,
    bodyColor: 0xe2e8f0, // 明るいシルバー
    stripeColor: 0x0284c7, // スカイブルー
    roofColor: 0x334155
  },
  {
    id: 'express-train',
    name: '急行型列車',
    category: 'express',
    description: '長距離優等列車として設計された伝統の急行型。ゆったりとした車内空間と、割高な急行運賃が魅力（最大乗車率150%）。',
    speedTilesPerMinute: 2.5, // 2.5 マス/分（0.4秒で1マス）
    basePrice: 40000000,
    baseCapacity: 80,
    maxOccupancyRate: 1.5, // 最大乗車率 150%（1両あたり最大120人乗車可能）
    maxSpeed: 135,
    farePerRide: 800,
    runningCostPerTripPerCar: 4500, // 1両あたり4,500円（2両9,000円、12人乗車で黒字）
    dailyRunningCostPerCar: 12000,
    bodyColor: 0x991b1b, // バーガンディ・深紅
    stripeColor: 0xfde047, // ゴールドイエロー帯
    roofColor: 0x334155
  },
  {
    id: 'limited-express-train',
    name: '特急型列車',
    category: 'limited-express',
    description: '鉄道会社の威信をかけたフラッグシップ特急。最高峰の俊足走行と最高額の特急運賃で莫大な収益を実現（最大乗車率125%）。',
    speedTilesPerMinute: 3.0, // 3.0 マス/分（約0.33秒で1マス）
    basePrice: 60000000,
    baseCapacity: 60,
    maxOccupancyRate: 1.25, // 最大乗車率 125%（1両あたり最大75人乗車可能）
    maxSpeed: 160,
    farePerRide: 1400,
    runningCostPerTripPerCar: 7000, // 1両あたり7,000円（2両14,000円、10人乗車で黒字）
    dailyRunningCostPerCar: 18000,
    bodyColor: 0x0f172a, // ナイトネイビー
    stripeColor: 0x38bdf8, // ネオンシアン帯
    roofColor: 0x0284c7
  }
];

export function getVehicleById(id: string): VehicleModelInfo {
  return VEHICLE_CATALOG.find(v => v.id === id) || VEHICLE_CATALOG.find(v => v.id === 'commuter-train') || VEHICLE_CATALOG[0];
}

/**
 * ⑤ 走行費用（1日・1編成あたり）。各車種に定義された専用の走行費用 × 両数。
 */
export function getRunningCostPerDay(model: VehicleModelInfo, carCount: number): number {
  return model.dailyRunningCostPerCar * carCount;
}

/**
 * 1区間（発着）走行あたりの運行費用
 */
export function getRunningCostPerTrip(model: VehicleModelInfo, carCount: number): number {
  return (model.runningCostPerTripPerCar ?? Math.round(model.baseCapacity * 0.1 * (model.farePerRide || 200))) * carCount;
}

/**
 * 車種の最大乗車可能人数（混雑時上限）を取得
 * @param model 車両モデル
 * @param carCount 編成両数
 */
export function getMaxCapacity(model: VehicleModelInfo, carCount: number): number {
  if (model.category === 'freight') return 0;
  const rate = model.maxOccupancyRate ?? 1.0;
  return Math.round(model.baseCapacity * carCount * rate);
}


