import * as THREE from 'three';
import { GridLayer } from '../../core/types';

export type TileType =
  | 'empty'
  | 'rail_ground'
  | 'rail_elevated'
  | 'rail_curve_ground'
  | 'rail_curve_elevated'
  | 'point_switch_ground'
  | 'point_switch_elevated'
  | 'scissors_crossing_ground'
  | 'scissors_crossing_elevated'
  | 'rail_slope'
  | 'rail_slope_underground'
  | 'station_ground'
  | 'station_elevated'
  | 'signal_yard'
  | 'cargo_station_ground'
  | 'cargo_station_elevated'
  | 'road'
  | 'level_crossing'
  | 'residence'
  | 'commercial'
  | 'industrial'
  | 'nature'
  | 'farmland'
  | 'external_connection';

export type CurveDirection = 'N_E' | 'E_S' | 'S_W' | 'W_N';
export type SwitchState = 'straight' | 'diverge';
export type CrossingState = 'straight' | 'cross-a' | 'cross-b';

export interface TileData {
  x: number;
  z: number;
  layer?: GridLayer; // 全7階層立体レイヤー (-2..5, デフォルトは地上1F: 1)
  type: TileType;
  rotation: number; // Straight/road/station/slope/踏切: 0=NS軸,1=EW軸。分岐器・シーサス: 0-3(北,東,南,西)=通過方向。
  level: number;
  mesh?: THREE.Group;
  stationPassengers: number;
  landValue: number;

  // Additional Railway Systems
  curveDir?: CurveDirection;
  switchState?: SwitchState;
  slopeReversed?: boolean;
  elevationOffset?: number; // 標高に応じた高さオフセット (elevation - 1) * 3.0

  // ① 4マス勾配レール: 0(地上側の端)〜3(高架側の端)のパート番号
  slopePart?: number;

  // ③ シーサスクロッシング(2×2)グループ管理: 4マスすべてが持つ、起点座標への参照・自身の役割・開通状態
  groupOrigin?: { x: number; z: number };
  crossingRole?: 0 | 1 | 2 | 3; // 0=A(起点/北西or北東側), 1=B, 2=C, 3=D
  crossingState?: CrossingState;

  // ⑤ 踏切: 交差する道路の軸（rotationと直交する軸）
  crossingRoadAxis?: number;

  // ② 分岐器の分岐方向 ('right': 右分岐 / 'left': 左分岐)
  switchBranchSide?: 'left' | 'right';

  // ① 駅舎ホームの配置方向 ('right': 線路進行右側 / 'left': 線路進行左側)
  stationPlatformSide?: 'left' | 'right';

  // ⑤ 駅・ホーム参照ポインタ（StationManager を正本とする）
  stationGroupId?: string; // StationData.id に対応
  stationPlatformId?: string; // PlatformData.id に対応
  stationPart?: 'single' | 'start' | 'mid' | 'end'; // 3Dメッシュ形状用
  stationName?: string; // 看板・UI用キャッシュ名称
  stationSchedule?: StationSchedule; // ダイヤ設定

  passengerAccumulator?: number;

  // ① 分岐器ダイヤ設定（24時間タイムラインバー方式: 直進、分岐、交互切替）
  switchSchedule?: SwitchSchedule;

  // ④ 貨物ヤード指定（駅・信号場タイルに付与し、貨物列車の積み降ろし拠点として扱う）
  isCargoYard?: boolean;
  // 貨物駅に蓄積されているコンテナ数（工業施設から毎日17:00に追加、列車積載で減少）
  cargoContainers?: number;

  // ② 隣町外部接続ゲートウェイノード
  externalCityId?: string;
  isExternalConnection?: boolean;
}

export type StationActionMode = 'stop' | 'wait' | 'pass' | 'reverse' | 'hold' | 'pattern';

export interface TimeZoneRule {
  id: string;
  startMin: number; // 0-1439 (開始時刻の分)
  endMin: number;   // 1-1440 (終了時刻の分)
  mode: 'pass' | 'stop' | 'pattern'; // 通過、〇分停車、またはパターンダイヤ
  waitMinutes?: number;  // stop時の停車分数
  patternMinute?: number; // pattern時の基準分 (0-59)
  patternIntervalMinutes?: number; // pattern時の発車間隔（分単位、例: 15, 20, 30, 60, 120。デフォルト60）
  isReverse?: boolean;   // この時間帯での発車時に折り返すか
  isSplit?: boolean;     // この時間帯での到着時に編成を分割するか
  splitFrontCars?: number; // 分割時の前編成両数（デフォルト2）
  splitRearCars?: number;  // 分割時の後編成両数（デフォルト2）
  splitRearReverses?: boolean; // 分割後の後発編成が折り返すか
}

/** 発車ルール（パターンダイヤ／特定時刻発／即時＝停車時間経過後・分割編成等の互換用） */
export type DepartureMode = 'timer' | 'pattern' | 'specific';

export interface DepartureRule {
  mode: DepartureMode;
  patternMinute?: number; // 'pattern': 基準分（0-59）
  patternIntervalMinutes?: number; // 'pattern': 発車間隔（分単位。デフォルト60）
  specificHour?: number;  // 'specific': 指定時刻発の時（0-23）
  specificMinute?: number; // 'specific': 指定時刻発の分（0-59）
}

/** 途中駅での分割（切り離し）設定。前○両／後○両に分離し、それぞれ独立した発車ルールを割り当てる */
export interface SplitConfig {
  enabled: boolean;
  frontCars: number; // 前○両（進行方向基準で先頭側）
  rearCars: number;  // 後○両
  frontDeparture: DepartureRule;
  rearDeparture: DepartureRule;
  rearReverses: boolean; // 後発編成が折り返し（逆方向発車）するか
}

export function createDefaultSplitConfig(frontCars: number = 2, rearCars: number = 2, rearReverses: boolean = false): SplitConfig {
  return {
    enabled: true,
    frontCars,
    rearCars,
    frontDeparture: { mode: 'timer' },
    rearDeparture: { mode: 'timer' },
    rearReverses
  };
}

export interface StationSchedule {
  // ① 1分単位の発車時刻ピン（0-1439の配列）
  departures: number[];
  // ② 時間帯ゾーン（通過 / 〇分停車 / パターンダイヤ）
  timeZones: TimeZoneRule[];
  // ③ 折り返し指定された発車ピン時刻(分)の配列
  reverseDepartures?: number[];
  // ④ 分割指定された発車ピン時刻(分)の配列
  splitDepartures?: number[];
  // ⑤ 折り返し・分割設定（既存機能の互換維持）
  reverseDelayMinutes?: number;
  splitConfig?: SplitConfig;
}

/** 路線・系統単位で再利用可能なダイヤ設定テンプレート */
export interface RouteScheduleTemplate {
  templateId: string;
  templateName: string;
  color: string;
  schedule: StationSchedule;
}

/**
 * 運行系統テンプレート用のプリセット識別カラーパレット
 */
export const ROUTE_COLORS: string[] = [
  '#38bdf8', // シアン (本線普通)
  '#f59e0b', // アンバー (快速)
  '#ef4444', // レッド (特急)
  '#10b981', // エメラルド (支線・環状線)
  '#8b5cf6', // パープル (空港アクセス)
  '#ec4899', // ピンク (観光列車)
  '#06b6d4', // ターコイズ
  '#84cc16'  // ライム
];

/**
 * StationSchedule の完全なディープコピーを生成するヘルパー
 * （配列や子オブジェクトの参照を完全に切り離し、他駅やテンプレートへの予期せぬ変更伝播を防止）
 */
export function cloneStationSchedule(src: StationSchedule): StationSchedule {
  return {
    departures: [...(src.departures || [])],
    timeZones: (src.timeZones || []).map(tz => ({ ...tz })),
    reverseDepartures: src.reverseDepartures ? [...src.reverseDepartures] : [],
    splitDepartures: src.splitDepartures ? [...src.splitDepartures] : [],
    reverseDelayMinutes: src.reverseDelayMinutes,
    splitConfig: src.splitConfig
      ? {
          enabled: src.splitConfig.enabled,
          frontCars: src.splitConfig.frontCars,
          rearCars: src.splitConfig.rearCars,
          frontDeparture: { ...src.splitConfig.frontDeparture },
          rearDeparture: { ...src.splitConfig.rearDeparture },
          rearReverses: src.splitConfig.rearReverses
        }
      : undefined
  };
}

/**
 * 駅ダイヤに何らかの設定（発車ピン、時間帯ゾーン、折り返し、分割等）が施されているかを判定する
 */
export function hasStationScheduleContent(src?: StationSchedule | null): boolean {
  if (!src) return false;
  if ((src.departures?.length ?? 0) > 0) return true;
  if ((src.timeZones?.length ?? 0) > 0) return true;
  if ((src.reverseDepartures?.length ?? 0) > 0) return true;
  if ((src.splitDepartures?.length ?? 0) > 0) return true;
  if (src.splitConfig && src.splitConfig.enabled) return true;
  if (src.reverseDelayMinutes !== undefined && src.reverseDelayMinutes > 0) return true;
  return false;
}

/**
 * ダイヤ設定の情報量（充実度）スコアを計算し、複数タイルの中から最も信頼できる設定を選定するために使用
 */
export function getStationScheduleScore(src?: StationSchedule | null): number {
  if (!src) return 0;
  let score = 0;
  score += (src.departures?.length ?? 0) * 2;
  score += (src.timeZones?.length ?? 0) * 10;
  score += (src.reverseDepartures?.length ?? 0) * 2;
  score += (src.splitDepartures?.length ?? 0) * 2;
  if (src.splitConfig && src.splitConfig.enabled) score += 5;
  if (src.reverseDelayMinutes !== undefined && src.reverseDelayMinutes > 0) score += 1;
  return score;
}

/**
 * 分単位の時刻が指定の時間帯（日またぎ対応）に含まれるか判定する
 */
export function isMinuteInZone(currentMin: number, startMin: number, endMin: number): boolean {
  if (startMin <= endMin) {
    return currentMin >= startMin && currentMin <= endMin;
  } else {
    // 日またぎ（例: 22:00〜06:00 -> 1320〜360分）
    return currentMin >= startMin || currentMin <= endMin;
  }
}

/**
 * 分岐線路・シーサスクロッシングの時間帯開通ルール
 */
export interface SwitchTimeZoneRule {
  id: string;
  type: 'time_range' | 'pattern'; // 'time_range': 時間帯指定, 'pattern': パターン指定
  startMin: number; // 0-1439 (開始時刻の分)
  endMin: number;   // 1-1440 (終了時刻の分)
  // パターン指定時（毎時 startPatternMin 分 〜 endPatternMin 分）
  startPatternMin?: number; // 0-59
  endPatternMin?: number;   // 0-59
  // シーサスクロッシング用渡り線指定（'cross-a' | 'cross-b'）、分岐器用（'diverge'）
  targetState?: 'diverge' | 'cross-a' | 'cross-b';
}

export type SwitchScheduleMode = 'manual' | 'timeline' | 'alternate';

export interface SwitchSchedule {
  mode: SwitchScheduleMode;
  defaultState?: 'straight'; // デフォルトは直進
  rules: SwitchTimeZoneRule[]; // 分岐開通ルール配列
  // レガシー互換用
  slots?: Array<'straight' | 'diverge'>;
  hourlyDirections?: Array<'straight' | 'diverge'>;
}

export function createDefaultDepartureRule(): DepartureRule {
  return { mode: 'timer', patternMinute: 0, specificHour: 7, specificMinute: 0 };
}

export function createDefaultStationSchedule(): StationSchedule {
  return {
    departures: [],
    timeZones: [], // 初期状態は空（＝24時間すべて「停車したまま」）
    reverseDepartures: [],
    reverseDelayMinutes: 3,
    splitConfig: undefined
  };
}

export function createDefaultCargoStationSchedule(): StationSchedule {
  return {
    departures: [],
    timeZones: [
      {
        id: 'cargo_default_stop',
        startMin: 0,
        endMin: 1440,
        mode: 'stop',
        waitMinutes: 5 // 貨物駅は荷役・入換作業のためデフォルト5分停車
      }
    ],
    reverseDelayMinutes: 5,
    splitConfig: undefined
  };
}

export function createDefaultSwitchSchedule(): SwitchSchedule {
  return {
    mode: 'timeline',
    defaultState: 'straight',
    rules: [],
    slots: new Array(144).fill('straight'),
    hourlyDirections: new Array(24).fill('straight')
  };
}

/**
 * SwitchSchedule の完全なディープコピーを生成するヘルパー
 */
export function cloneSwitchSchedule(src: SwitchSchedule): SwitchSchedule {
  return {
    mode: src.mode,
    defaultState: src.defaultState,
    rules: (src.rules || []).map(r => ({ ...r })),
    slots: src.slots ? [...src.slots] : undefined,
    hourlyDirections: src.hourlyDirections ? [...src.hourlyDirections] : undefined
  };
}

/**
 * Undo復元用のタイルスナップショットデータ構造（メッシュ以外の完全なタイル状態）
 */
export interface TileDataSnapshot {
  x: number;
  z: number;
  layer: GridLayer;
  type: TileType;
  rotation: number;
  level: number;
  stationPassengers?: number;
  landValue?: number;
  curveDir?: CurveDirection;
  switchState?: SwitchState;
  slopeReversed?: boolean;
  slopePart?: number;
  groupOrigin?: { x: number; z: number };
  crossingRole?: 0 | 1 | 2 | 3;
  crossingState?: CrossingState;
  crossingRoadAxis?: number;
  switchBranchSide?: 'left' | 'right';
  stationPlatformSide?: 'left' | 'right';
  stationGroupId?: string;
  stationPlatformId?: string;
  stationPart?: 'single' | 'start' | 'mid' | 'end';
  stationName?: string;
  stationSchedule?: StationSchedule;
  switchSchedule?: SwitchSchedule;
  isCargoYard?: boolean;
  cargoContainers?: number;
  elevationOffset?: number;
  externalCityId?: string;
  isExternalConnection?: boolean;
}

/**
 * TileData のディープコピースナップショットを生成するヘルパー
 */
export function cloneTileSnapshot(tile: TileData | undefined | null): TileDataSnapshot | null {
  if (!tile || tile.type === 'empty') return null;
  return {
    x: tile.x,
    z: tile.z,
    layer: (tile.layer ?? 1) as GridLayer,
    type: tile.type,
    rotation: tile.rotation,
    level: tile.level,
    stationPassengers: tile.stationPassengers,
    landValue: tile.landValue,
    curveDir: tile.curveDir,
    switchState: tile.switchState,
    slopeReversed: tile.slopeReversed,
    slopePart: tile.slopePart,
    groupOrigin: tile.groupOrigin ? { ...tile.groupOrigin } : undefined,
    crossingRole: tile.crossingRole,
    crossingState: tile.crossingState,
    crossingRoadAxis: tile.crossingRoadAxis,
    switchBranchSide: tile.switchBranchSide,
    stationPlatformSide: tile.stationPlatformSide,
    stationGroupId: tile.stationGroupId,
    stationPlatformId: tile.stationPlatformId,
    stationPart: tile.stationPart,
    stationName: tile.stationName,
    stationSchedule: tile.stationSchedule ? cloneStationSchedule(tile.stationSchedule) : undefined,
    switchSchedule: tile.switchSchedule ? cloneSwitchSchedule(tile.switchSchedule) : undefined,
    isCargoYard: tile.isCargoYard,
    cargoContainers: tile.cargoContainers,
    elevationOffset: tile.elevationOffset,
    externalCityId: tile.externalCityId,
    isExternalConnection: tile.isExternalConnection
  };
}

export function getStationSlotMode(schedule: StationSchedule | undefined, hour: number, minute: number): StationActionMode {
  if (!schedule) return 'hold';
  const currentMin = hour * 60 + minute;
  const activeModes: StationActionMode[] = [];
  for (const zone of schedule.timeZones || []) {
    let inRange = false;
    if (zone.startMin <= zone.endMin) {
      inRange = currentMin >= zone.startMin && currentMin <= zone.endMin;
    } else {
      inRange = currentMin >= zone.startMin || currentMin <= zone.endMin;
    }
    if (inRange) {
      activeModes.push(zone.mode);
    }
  }
  if (activeModes.includes('pass')) return 'pass';
  if (activeModes.includes('pattern')) return 'pattern';
  if (activeModes.includes('stop')) return 'stop';
  return 'hold';
}

export function getSwitchSlotDirection(schedule: SwitchSchedule | undefined, hour: number, minute: number): 'straight' | 'diverge' {
  if (!schedule) return 'straight';
  const slotIdx = ((hour % 24) * 6) + Math.min(5, Math.floor((minute % 60) / 10));
  if (schedule.slots && schedule.slots[slotIdx]) {
    return schedule.slots[slotIdx];
  }
  if (schedule.hourlyDirections && schedule.hourlyDirections[hour % 24]) {
    return schedule.hourlyDirections[hour % 24];
  }
  return 'straight';
}

/**
 * 指定時刻における分岐線路／シーサスクロッシングの開通方向を判定する
 * デフォルトは「直進（straight）」。合致する時間帯・パターンルールがあれば分岐方向を返す。
 */
export function getSwitchDirectionAtTime(
  schedule: SwitchSchedule | undefined,
  hour: number,
  minute: number,
  isScissors: boolean = false
): 'straight' | 'diverge' | 'cross-a' | 'cross-b' {
  if (!schedule) return 'straight';
  if (schedule.mode === 'manual') return 'straight';
  if (schedule.mode === 'alternate') return 'straight';

  const currentMin = hour * 60 + minute;
  const currentMinute = minute;

  // 新方式: rules 配列を評価
  if (schedule.rules && schedule.rules.length > 0) {
    for (const rule of schedule.rules) {
      if (!isMinuteInZone(currentMin, rule.startMin, rule.endMin)) {
        continue;
      }

      if (rule.type === 'time_range') {
        // 時間帯指定で分岐
        return rule.targetState || (isScissors ? 'cross-a' : 'diverge');
      } else if (rule.type === 'pattern') {
        // パターンで分岐（毎時 startPatternMin 〜 endPatternMin）
        const sPat = rule.startPatternMin ?? 0;
        const ePat = rule.endPatternMin ?? 0;
        let inPattern = false;
        if (sPat <= ePat) {
          inPattern = currentMinute >= sPat && currentMinute <= ePat;
        } else {
          // 毎時分またぎ（例: 55分〜05分）
          inPattern = currentMinute >= sPat || currentMinute <= ePat;
        }
        if (inPattern) {
          return rule.targetState || (isScissors ? 'cross-a' : 'diverge');
        }
      }
    }
    return 'straight';
  }

  // レガシー互換用フォールバック
  return getSwitchSlotDirection(schedule, hour, minute);
}

// ---------------------------------------------------------------------------
// ① ⑦ ⑧ 線路接続モデル（方向インデックス: 0=北, 1=東, 2=南, 3=西）
// レベルは 0(地上)〜4(高架) の5段階。4マス勾配レールは1マスごとに1段ずつ高さが変わるため、
// 「高い側と低い側」がそのまま隣接しても、レベルが完全一致しない限り接続とは判定されない。
// ---------------------------------------------------------------------------
export interface DirVec { x: number; z: number; }
export interface TileExit {
  idx: number;
  level: number;
  worldHeight?: number; // 線路端点の実際のワールド高さ（標高オフセット込み）
  targetOffset?: { dx: number; dz: number }; // ② シーサスクロッシング等の対角線移動用オフセット
}
export const LEVEL_GROUND = 0;
export const LEVEL_ELEVATED = 4;
export const SLOPE_PARTS = 4;
