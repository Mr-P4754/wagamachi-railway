import * as THREE from 'three';
import { VehicleModelInfo } from '../VehicleCatalog';
import { GridLayer } from '../../core/types';
import { StationActionMode, DepartureRule } from '../WorldMap';
import { CARGO_FARE_PER_CONTAINER_PER_TILE } from '../../core/CargoSystem';

export { CARGO_FARE_PER_CONTAINER_PER_TILE };

/**
 * 先頭車の走行履歴サンプル
 * （各車両がこの履歴を「車両間隔ぶん遅れて」辿ることで、
 * カーブや勾配・進路変更を編成全体が一斉にではなく1両ずつ順番に通過するようにする）
 */
export interface PathSample {
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
  cant: number;
  dist: number; // 経路の始点からの累積距離（ワールド単位）
  layer: GridLayer; // 車両が存在する階層
}

/** ロード時の一時サンプリング点 */
export interface IntermediateSample {
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
  cant: number;
  layer: GridLayer;
}

/** 列車（編成）インスタンス */
export interface TrainInstance {
  id: number;
  name: string;
  model: VehicleModelInfo;
  carCount: number;
  mesh: THREE.Group; // 常に position/rotation ともに単位変換（子の各車両をワールド座標で個別配置する）
  frontPosition: THREE.Vector3; // 先頭車の現在位置（カメラ追従・ATS判定に使用）
  currentTile: { x: number; z: number; layer: GridLayer }; // 先頭車が今いるタイルと階層
  targetTile: { x: number; z: number; layer: GridLayer }; // 先頭車が次に向かうタイルと階層
  direction: THREE.Vector3;
  progress: number;
  speed: number; // tiles per second
  isStopped: boolean;
  isAtsBraked: boolean; // ATSによる先行列車接近停止
  isApproachingCouple?: boolean; // 併合（連結）接近時の徐行フラグ（speedプロパティ直接破壊の防止）
  isSignalStopped?: boolean; // 閉塞信号による停止
  isTrapped?: boolean; // 孤立（前後とも進行不能）による立ち往生停止
  occupiedTiles: Array<{ x: number; z: number; layer: GridLayer }>; // 最大10両全マスの占有タイル
  needsOccupancyUpdate?: boolean; // 在線タイル再計算フラグ（タイル境界通過時のみtrueにしてサブステップ計算を削減）
  stopTimer: number;
  passengers: number;
  capacity: number;
  isReversed: boolean;
  cars: THREE.Group[];
  heightY: number; // 現在の垂直高さ
  pathHistory: PathSample[]; // 先頭車の走行履歴（各車両の遅延追従に使用）

  // 列車収支・乗客データ
  totalPassengers: number;
  totalRevenue: number;
  totalCost: number;
  monthlyProfit: number;
  fleetId?: string; // 車両基地での保有ID

  // 駅グループ重複停車防止用
  lastStationGroupId: string | null;
  // 駅ダイヤ（折り返し待機、定時発車待機）
  isReversingAtStation?: boolean;
  scheduledDepartureMinute?: number | null;

  // 貨物列車の積荷状態（category: 'freight' の編成のみ使用）
  cargoLoad?: number;
  cargoCapacity?: number;
  cargoPickup?: { x: number; z: number } | null;
  cargoTraveledTiles?: number; // 積載中の実走行マス数（運賃計算用）

  // 純粋時間軸ダイヤエンジン用の停車状態追跡
  stopMode?: StationActionMode | null; // 現在停車中の動作モード（'hold'は毎フレーム再判定）
  stopElapsedMinutes?: number; // 現在の停車開始からの経過ゲーム内分
  requiredStopMinutes?: number; // 発車可能になるまでの最短停車分数
  // 分割後の編成に個別付与される発車ルール（未設定時はホームタイルの共通ダイヤに従う）
  overrideDepartureRule?: DepartureRule | null;
  // 同一分内での多重発車防止用タイムスタンプ（0-1439）
  lastDepartureMinute?: number;
  // 到着後まだ一度も現在分のダイヤ判定を行っていない場合の判定用（分境界・高速送り取りこぼし防止）
  lastEvaluatedMinute?: number;

  // 外部都市直通走行状態（マップ外の仮想走行・隣町往来）
  externalTravel?: ExternalTravelState;
}

/** 外部都市直通走行状態 */
export interface ExternalTravelState {
  cityId: string;
  cityName: string;
  entryTile: { x: number; z: number; layer: GridLayer };
  entryDirection: { x: number; y: number; z: number };
  phase: 'outward' | 'at_neighbor' | 'homeward';
  distanceTiles: number; // 接続部から隣町までの距離（50マス）
  remainingTiles: number; // 現在フェーズでの残り走行マス数
  stopMinutesRemaining: number; // 隣町での停車待機分数
}

/** 貨物駅での積み降ろし・運賃計算をTrainManagerへ橋渡しするフック群 */
export interface CargoHooks {
  tryLoad: (x: number, z: number, capacity: number, layer?: GridLayer) => number;
  tryUnload: (x: number, z: number, containers: number, layer?: GridLayer) => number | boolean;
  isCommercialStation?: (x: number, z: number, layer?: GridLayer) => boolean;
  onStationCargoChanged?: (x: number, z: number, layer?: GridLayer) => void;
  onCargoDelivered?: (x: number, z: number, layer: GridLayer, containers: number, revenue: number) => void;
}
