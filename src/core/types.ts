// わがまちレールウェイ コア型定義（マスター設計書準拠）

/** マップ規模定義 */
export type MapSize = 64 | 128 | 256 | 512 | 1024;

/** 地形テンプレート */
export type TerrainType = 'flat' | 'balanced' | 'mountain' | 'coastal';

/** 立体階層 (地上1F〜5F: 1〜5, 地下B1F〜B2F: -1, -2) 全7階層 */
export type GridLayer = -2 | -1 | 1 | 2 | 3 | 4 | 5;

/** 3次元グリッド座標 */
export interface GridPosition3D {
  x: number;
  y: number; // 高さ/階層 (-2..5, 0は地表基準面または境界)
  z: number;
}

/** 列車種別と最高速度比率（マス/分） */
export type TrainType = 'freight' | 'local' | 'rapid' | 'express';

export interface TrainSpeedDefinition {
  type: TrainType;
  name: string;
  speedRatio: number; // 貨物: 1.0, 各停: 1.5, 快速: 2.0, 特急: 3.0
}

/** ダイヤアクション種別 */
export type TimetableActionType = 'stop' | 'pass' | 'layover' | 'turnaround' | 'split' | 'couple';

/** ダイヤ時刻エントリ */
export interface TimetableEntry {
  stationId: string;
  platformId: string;
  action: TimetableActionType;
  arrivalMinute?: number; // 0..1439 (分基準)
  departureMinute?: number;
  stopDurationMinutes?: number;
  targetTrainId?: string; // 分割・併合用
}

/** カメラ視界モード */
export type CameraViewMode = 'quarter_view' | 'cab_view' | 'chase_view';

/** クォータービューの4方向角度 (0度, 90度, 180度, 270度) */
export type QuarterViewDirection = 0 | 1 | 2 | 3;

/** ホーム（番線）データ定義 */
export interface PlatformData {
  id: string;
  stationId: string;
  platformNumber: number; // 1番線, 2番線...
  length: number; // ホーム有効長（1〜10両）
  trackAxis: number; // 0: 南北, 1: 東西
  tiles: Array<{ x: number; z: number; layer: GridLayer }>;
  isSignalYard: boolean; // 信号場・留置線フラグ
  isCargoStation?: boolean; // 貨物駅・コンテナヤードフラグ
  dailyPassengers: number;
  previousDayPassengers: number;
  twoDaysAgoPassengers?: number;
  dailyLoadedCargo?: number;
  dailyUnloadedCargo?: number;
  previousDayLoadedCargo?: number;
  previousDayUnloadedCargo?: number;
  totalPassengers: number;
  totalRevenue: number;
}

/** 駅エンティティデータ定義（複数ホームを統括） */
export interface StationData {
  id: string;
  name: string;
  platforms: PlatformData[];
  isSignalYard: boolean; // 信号場・留置線フラグ
  isCargoStation?: boolean; // 貨物駅フラグ
  dailyPassengers: number;
  previousDayPassengers: number;
  twoDaysAgoPassengers?: number;
  dailyLoadedCargo?: number;
  dailyUnloadedCargo?: number;
  previousDayLoadedCargo?: number;
  previousDayUnloadedCargo?: number;
  totalPassengers: number;
  totalRevenue: number;
  maintenance: number;
  netProfit: number;
}

/** 閉塞信号の現示状態 */
export type BlockSignalState = 'green' | 'red' | 'yellow';

/** 閉塞区間データ定義 */
export interface BlockSection {
  id: string;
  name: string;
  tiles: Array<{ x: number; z: number; layer: GridLayer }>;
  signalState: BlockSignalState;
  occupiedTrainId: number | null;
  entrySignals: Array<{
    x: number;
    z: number;
    layer: GridLayer;
    directionIdx: number;
  }>;
}

/** デッドロック（立ち往生）イベント定義 */
export interface DeadlockEvent {
  trainId: number;
  trainName: string;
  stuckDurationMinutes: number;
  position: { x: number; z: number; layer: GridLayer };
}
