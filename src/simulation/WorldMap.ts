import * as THREE from 'three';
import { ModelFactory } from '../models/ModelFactory';
import { GridLayer } from '../core/types';
import { Grid3D, layerToHeight } from '../core/Grid3D';
import { StationManager, StationSaveData } from '../core/StationManager';
import { disposeHierarchy } from '../graphics/materials';
import { InstancedMeshManager } from '../graphics/InstancedMeshManager';
import { RenderBucketRegistry } from '../graphics/RenderBucketRegistry';

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
    elevationOffset: tile.elevationOffset
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

export class WorldMap {
  public static GRID_SIZE = 64;
  public static readonly TILE_SIZE = 2.0;

  public static readonly DIRS: DirVec[] = [
    { x: 0, z: -1 }, // 0: North
    { x: 1, z: 0 },  // 1: East
    { x: 0, z: 1 },  // 2: South
    { x: -1, z: 0 }  // 3: West
  ];

  public static opposite(idx: number): number {
    return (idx + 2) % 4;
  }

  public static rotateCW(idx: number): number {
    return (idx + 1) % 4;
  }

  public static rotateCCW(idx: number): number {
    return (idx + 3) % 4;
  }

  public static curveDirToIndices(cd: CurveDirection): [number, number] {
    switch (cd) {
      case 'N_E': return [0, 1];
      case 'E_S': return [1, 2];
      case 'S_W': return [2, 3];
      case 'W_N': return [3, 0];
    }
  }

  public static indicesToCurveDir(a: number, b: number): CurveDirection {
    const key = [a, b].sort((x, y) => x - y).join(',');
    if (key === '0,1') return 'N_E';
    if (key === '1,2') return 'E_S';
    if (key === '2,3') return 'S_W';
    if (key === '0,3') return 'W_N';
    throw new Error(`Invalid curve direction pair: ${a},${b}`);
  }

  /**
   * ② 高架の橋脚は連続4マスごとに1本だけ設置する（間のマスは橋脚なしでデッキのみ）。
   * 線路の軸方向に沿った絶対座標が4の倍数のマスにのみ橋脚を表示する。
   */
  public static shouldShowPier(x: number, z: number, rotation: number): boolean {
    const coord = rotation === 1 ? x : z;
    return (((coord % 4) + 4) % 4) === 0;
  }

  /**
   * 直線高架レール用橋脚マトリクス配列の算出（地上または直下構造物デッキまで）
   */
  public getElevatedPierMatrices(x: number, z: number, layer: GridLayer, rotation: number): THREE.Matrix4[] {
    const pierMatrices: THREE.Matrix4[] = [];
    if (!WorldMap.shouldShowPier(x, z, rotation)) return pierMatrices;

    const groundH = this.getElevationOffset(x, z);
    for (let l = layer; l >= 2; l--) {
      const pierTopH = layerToHeight(l as GridLayer);
      const pierBottomH = pierTopH - 3.0;
      if (pierBottomH < groundH - 0.01) {
        break;
      }

      const pierDummy = new THREE.Object3D();
      pierDummy.position.set(x * WorldMap.TILE_SIZE, pierTopH, z * WorldMap.TILE_SIZE);
      pierDummy.updateMatrix();
      pierMatrices.push(pierDummy.matrix.clone());

      // 直下の階層に高架線路や駅等がある場合、その上面デッキに着地するためそれより下は生成しない
      if (l - 1 >= 2) {
        const lowerTile = this.getTile(x, z, (l - 1) as GridLayer);
        if (lowerTile && (lowerTile.type.startsWith('rail_') || lowerTile.type.startsWith('station_') || lowerTile.type.startsWith('cargo_station_') || lowerTile.type === 'signal_yard')) {
          break;
        }
      }
    }
    return pierMatrices;
  }

  /**
   * 直上の高架線路の橋脚を再計算・更新する（下層に構造物が設置/撤去された際）
   */
  public updateUpperElevatedPiers(x: number, z: number, startLayer: GridLayer): void {
    for (let l = (startLayer + 1) as GridLayer; l <= 5; l++) {
      const upperTile = this.getTile(x, z, l as GridLayer);
      if (upperTile && upperTile.type === 'rail_elevated') {
        const upperTileKey = `${x},${z},${l}`;
        const upperBaseH = layerToHeight(l as GridLayer);
        const dummy = new THREE.Object3D();
        dummy.position.set(x * WorldMap.TILE_SIZE, upperBaseH, z * WorldMap.TILE_SIZE);
        if (upperTile.rotation === 1) dummy.rotation.y = Math.PI / 2;
        dummy.updateMatrix();
        const pierMatrices = this.getElevatedPierMatrices(x, z, l as GridLayer, upperTile.rotation);
        this.instancedMeshManager.setElevatedTrack(upperTileKey, dummy.matrix, pierMatrices);
      }
    }
  }

  /**
   * 道路ネットワーク接続判定用: 道路および踏切（crossingRoadAxis）の接続方向・高さを返す
   */
  public static getRoadExits(tile: TileData): TileExit[] {
    const isElevated = tile.type.includes('elevated');
    const level: number = isElevated ? LEVEL_ELEVATED : LEVEL_GROUND;
    const elevOffset = tile.elevationOffset ?? 0;
    const tileLayer: GridLayer = tile.layer ?? (isElevated ? 2 : 1);
    const defaultWorldHeight = layerToHeight(tileLayer, elevOffset);

    if (tile.type === 'road') {
      return tile.rotation === 1
        ? [{ idx: 1, level, worldHeight: defaultWorldHeight }, { idx: 3, level, worldHeight: defaultWorldHeight }]
        : [{ idx: 0, level, worldHeight: defaultWorldHeight }, { idx: 2, level, worldHeight: defaultWorldHeight }];
    }

    if (tile.type === 'level_crossing') {
      const roadAxis = tile.crossingRoadAxis ?? (1 - (((tile.rotation ?? 0) % 2 + 2) % 2));
      return roadAxis === 1
        ? [{ idx: 1, level, worldHeight: defaultWorldHeight }, { idx: 3, level, worldHeight: defaultWorldHeight }]
        : [{ idx: 0, level, worldHeight: defaultWorldHeight }, { idx: 2, level, worldHeight: defaultWorldHeight }];
    }

    return [];
  }

  /**
   * ① ⑦ ⑧ タイルが実際に接続している方向・高さレベルの一覧を返す。
   * 曲線・勾配・分岐器（開通方向）を考慮し、これを基準に列車の経路探索・接続判定を行う。
   */
  public static getTileExits(tile: TileData): TileExit[] {
    const isElevated = tile.type.includes('elevated');
    const level: number = isElevated ? LEVEL_ELEVATED : LEVEL_GROUND;
    const elevOffset = tile.elevationOffset ?? 0;
    const tileLayer: GridLayer = tile.layer ?? (isElevated ? 2 : 1);
    const defaultWorldHeight = layerToHeight(tileLayer, elevOffset);

    switch (tile.type) {
      case 'rail_ground':
      case 'rail_elevated':
      case 'station_ground':
      case 'station_elevated':
      case 'signal_yard':
      case 'cargo_station_ground':
      case 'cargo_station_elevated':
      case 'level_crossing':
        return tile.rotation === 1
          ? [{ idx: 1, level, worldHeight: defaultWorldHeight }, { idx: 3, level, worldHeight: defaultWorldHeight }]
          : [{ idx: 0, level, worldHeight: defaultWorldHeight }, { idx: 2, level, worldHeight: defaultWorldHeight }];

      case 'external_connection': {
        // 自都市中心方向への片側接続終端ポート
        const connectDir = ((tile.rotation % 4) + 4) % 4;
        return [{ idx: connectDir, level, worldHeight: defaultWorldHeight }];
      }

      case 'rail_curve_ground':
      case 'rail_curve_elevated': {
        if (!tile.curveDir) return [];
        const [i1, i2] = WorldMap.curveDirToIndices(tile.curveDir);
        return [
          { idx: i1, level, worldHeight: defaultWorldHeight },
          { idx: i2, level, worldHeight: defaultWorldHeight }
        ];
      }

      case 'rail_slope': {
        // ① ③ 4マス勾配（地上⇔高架）: パート番号(0-3)ごとに地上(0)〜高架(4)のうち1段分だけ高さが変わる。
        const part = tile.slopePart ?? 0;
        const lowLevel = part;
        const highLevel = part + 1;
        // ★修正: 設置階層(tileLayer)の基準高さを加算し、2F→3F等の高架間スロープでも高さを一致させる
        const baseLayerH = layerToHeight(tileLayer, elevOffset);
        const lowWorldHeight = baseLayerH + part * 0.75;
        const highWorldHeight = baseLayerH + (part + 1) * 0.75;

        const axis: [number, number] = tile.rotation === 1 ? [1, 3] : [0, 2];
        const [lowIdx, highIdx] = tile.slopeReversed ? [axis[1], axis[0]] : [axis[0], axis[1]];
        return [
          { idx: lowIdx, level: lowLevel, worldHeight: lowWorldHeight },
          { idx: highIdx, level: highLevel, worldHeight: highWorldHeight }
        ];
      }

      case 'rail_slope_underground': {
        // ② 4マス地下勾配（地上⇔地下）: 地上(0m)から地下(-3.0m)へ4マスで潜る
        const part = tile.slopePart ?? 0;
        const highWorldHeight = elevOffset - part * 0.75;
        const lowWorldHeight = elevOffset - (part + 1) * 0.75;

        const axis: [number, number] = tile.rotation === 1 ? [1, 3] : [0, 2];
        const [highIdx, lowIdx] = tile.slopeReversed ? [axis[1], axis[0]] : [axis[0], axis[1]];
        return [
          { idx: highIdx, level: -part, worldHeight: highWorldHeight },
          { idx: lowIdx, level: -(part + 1), worldHeight: lowWorldHeight }
        ];
      }

      case 'point_switch_ground':
      case 'point_switch_elevated': {
        // ③ 分岐器は1マスに根元(back)、直進(forward)、分岐(branchDir)の3方向のポートを持つ。
        const forward = ((tile.rotation % 4) + 4) % 4;
        const back = WorldMap.opposite(forward);
        const branchDir = tile.switchBranchSide === 'left' ? WorldMap.rotateCCW(forward) : WorldMap.rotateCW(forward);
        return [
          { idx: back, level, worldHeight: defaultWorldHeight },
          { idx: forward, level, worldHeight: defaultWorldHeight },
          { idx: branchDir, level, worldHeight: defaultWorldHeight }
        ];
      }

      case 'scissors_crossing_ground':
      case 'scissors_crossing_elevated':
        return WorldMap.getScissorsExits(tile, level, defaultWorldHeight);

      default:
        return [];
    }
  }

  /**
   * ② シーサスクロッシング(2×2)の接続方向・対角移動オフセットを役割(A/B/C/D)と開通状態から計算する。
   * along = 通過方向の軸、across = 2本の並行線路を隔てる方向。
   * 'straight': 4マスとも通常の複線としてそれぞれ独立に直進。
   * 'cross-a' : A ⇄ D の対角渡り線が開通（中央のダイヤモンド交差を通って対向線路へ直進移動）。B, Cは直進。
   * 'cross-b' : C ⇄ B の対角渡り線が開通（中央のダイヤモンド交差を通って対向線路へ直進移動）。A, Dは直進。
   */
  private static getScissorsExits(tile: TileData, level: number, worldHeight: number): TileExit[] {
    const along = tile.rotation === 1 ? 1 : 2;
    const backAlong = WorldMap.opposite(along);
    const across = WorldMap.rotateCW(along);
    const alongVec = WorldMap.DIRS[along];
    const acrossVec = WorldMap.DIRS[across];
    const role = tile.crossingRole ?? 0;
    const state = tile.crossingState ?? 'straight';

    if (state === 'straight') {
      return [{ idx: along, level, worldHeight }, { idx: backAlong, level, worldHeight }];
    }

    if (state === 'cross-a') {
      if (role === 0) {
        // A: 手前から対角のDへ移動（渡り線）
        return [
          { idx: backAlong, level, worldHeight },
          { idx: along, level, worldHeight, targetOffset: { dx: alongVec.x + acrossVec.x, dz: alongVec.z + acrossVec.z } }
        ];
      }
      if (role === 3) {
        // D: 奥から対角のAへ戻る、またはAから進入してきた列車がDの先の主線(along)へ進出
        return [
          { idx: along, level, worldHeight },
          { idx: backAlong, level, worldHeight, targetOffset: { dx: -alongVec.x - acrossVec.x, dz: -alongVec.z - acrossVec.z } }
        ];
      }
      // B, C は主線直進可能
      return [{ idx: along, level, worldHeight }, { idx: backAlong, level, worldHeight }];
    }

    // cross-b
    if (role === 2) {
      // C: 手前から対角のBへ移動（渡り線）
      return [
        { idx: backAlong, level, worldHeight },
        { idx: along, level, worldHeight, targetOffset: { dx: alongVec.x - acrossVec.x, dz: alongVec.z - acrossVec.z } }
      ];
    }
    if (role === 1) {
      // B: 奥から対角のCへ戻る、またはCから進入してきた列車がBの先の主線(along)へ進出
      return [
        { idx: along, level, worldHeight },
        { idx: backAlong, level, worldHeight, targetOffset: { dx: -alongVec.x + acrossVec.x, dz: -alongVec.z + acrossVec.z } }
      ];
    }
    // A, D は主線直進可能
    return [{ idx: along, level, worldHeight }, { idx: backAlong, level, worldHeight }];
  }

  public gridSize: number = 64;
  private tiles: Map<string, TileData> = new Map();
  public grid3D: Grid3D<TileData> = new Grid3D();
  public activeLayer: GridLayer = 1; // 現在編集・フォーカス中の階層 (-2..5)
  public stationManager: StationManager = new StationManager();
  public instancedMeshManager: InstancedMeshManager;
  /** 静的タイルメッシュの「チャンク×階層」バケット管理（視錐台・階層スライスカリング） */
  public renderBuckets: RenderBucketRegistry;
  private elevationProvider: ((x: number, z: number) => number) | null = null;
  public gridManagerRef: { isWaterAtGroundLevel: (x: number, z: number) => boolean; getCell: (x: number, y: GridLayer, z: number) => any } | null = null;

  /** マップ変更検知ダーティフラグとシリアライズキャッシュ */
  public isDirty: boolean = true;
  public structureVersion: number = 0;
  private cachedSerializedData: string | null = null;

  public markDirty(): void {
    this.isDirty = true;
    this.structureVersion++;
    this.cachedSerializedData = null;
  }
  public groundHoleHandler: {
    add: (x: number, z: number, rotation: number) => void;
    remove: (x: number, z: number) => void;
    clear: () => void;
  } | null = null;

  constructor(scene: THREE.Scene, gridSize: number = 64) {
    // タイルメッシュは RenderBucketRegistry / InstancedMeshManager 経由でシーンへ登録する
    this.instancedMeshManager = new InstancedMeshManager(scene);
    this.renderBuckets = new RenderBucketRegistry(scene);
    this.gridSize = gridSize;
    WorldMap.GRID_SIZE = gridSize;
    this.initializeGrid();
  }

  public setGridSize(size: number): void {
    this.gridSize = size;
    WorldMap.GRID_SIZE = size;
    this.clearAll();
  }

  public setActiveLayer(layer: GridLayer): void {
    this.activeLayer = layer;
  }

  /**
   * 現在の表示モードにおいて、指定階層のタイルメッシュが表示対象かどうかを判定
   * 地下モード時は全層可視、地上モード時は 1F 以上を可視とする（スライサーでの半透明・カリングは main 側で制御）
   */
  public isLayerVisibleInCurrentMode(layer: GridLayer): boolean {
    return this.activeLayer < 0 ? true : layer >= 1;
  }

  public setElevationProvider(provider: (x: number, z: number) => number): void {
    this.elevationProvider = provider;
  }

  public getElevationOffset(x: number, z: number): number {
    return this.elevationProvider ? this.elevationProvider(x, z) : 0;
  }

  private getKey(x: number, z: number): string {
    return `${x},${z}`;
  }

  /**
   * タイルメッシュを「チャンク×階層」バケットへ登録し、タイルに紐付ける
   * （シーン直下に数万個を並べると、カリング判定・行列更新が毎フレーム全件走査されるため）
   */
  private attachTileMesh(tile: TileData, mesh: THREE.Group): void {
    this.renderBuckets.add(mesh, tile.x, tile.z, (tile.layer ?? 1) as GridLayer);
    tile.mesh = mesh;
  }

  /**
   * 外部（main.ts 等）で再生成したタイルメッシュを登録するための公開ラッパー
   */
  public attachExternalTileMesh(tile: TileData, mesh: THREE.Group): void {
    this.attachTileMesh(tile, mesh);
  }

  /**
   * 疎（Sparse）マップ構造の初期化
   * 大マップ（512x512, 1024x1024）でのヒープメモリ枯渇を防ぐため、
   * 空タイルオブジェクトを事前生成せず、マップコレクションをクリアして境界サイズのみを定義する
   */
  private initializeGrid() {
    this.tiles.clear();
    this.grid3D.clear();
  }

  /**
   * 指定座標がマップの境界内にあるかを判定する
   */
  public isInBounds(x: number, z: number): boolean {
    const half = Math.floor(this.gridSize / 2);
    // 南端(z = half)・東端(x = half)も北端・西端(-half)と同様に境界線上タイルとして許可
    return x >= -half && x <= half && z >= -half && z <= half;
  }

  /**
   * 指定した階層のタイルを取得する（デフォルトは現在のアクティブ階層）
   * 完全な読み取り専用であり、タイルが存在しない場合は undefined を返却する（メモリリーク防止）
   */
  public getTile(x: number, z: number, layer: GridLayer = this.activeLayer): TileData | undefined {
    // まず指定階層の3Dグリッドを検索
    const tile3D = this.grid3D.get(x, layer, z);
    if (tile3D) return tile3D;

    // 地上1Fの場合、互換性用Mapから取得
    if (layer === 1) {
      const tile1F = this.tiles.get(this.getKey(x, z));
      if (tile1F) return tile1F;
    }

    return undefined;
  }

  /**
   * タイルを取得する。指定座標にタイルが存在しない場合は、マップ境界内であれば
   * 空タイル（TileData）を新規生成・登録して返却する。
   * ※ 建築・敷設など、実際にマップデータを変更する処理でのみ呼び出すこと。
   */
  public getOrCreateTile(x: number, z: number, layer: GridLayer = this.activeLayer): TileData | undefined {
    const existing = this.getTile(x, z, layer);
    if (existing) return existing;

    if (this.isInBounds(x, z)) {
      const newTile: TileData = {
        x,
        z,
        layer,
        type: 'empty',
        rotation: 0,
        level: layer >= 1 ? layer : 0,
        stationPassengers: 0,
        landValue: 100,
        switchState: 'straight'
      };
      this.grid3D.set(x, layer, z, newTile);
      if (layer === 1) {
        this.tiles.set(this.getKey(x, z), newTile);
      }
      return newTile;
    }

    return undefined;
  }

  /**
   * 指定した (x, z) の全階層のタイル一覧を取得
   */
  public getTilesAtColumn(x: number, z: number): Array<{ layer: GridLayer; tile: TileData }> {
    const list = this.grid3D.getColumn(x, z);
    return list.map(item => ({ layer: item.layer, tile: item.value }));
  }

  /**
   * 全階層の有効なタイルを取得する
   */
  public getAllTiles(filterLayer?: GridLayer): TileData[] {
    const result: TileData[] = [];
    const seenTiles = new Set<TileData>(); // ★追加: スロープ跨がり登録による同一インスタンス重複を防止
    const seenGroundKeys = new Set<string>();
    for (const tile of this.grid3D.values()) {
      if (tile.type !== 'empty' && !seenTiles.has(tile)) {
        if (filterLayer === undefined || tile.layer === filterLayer) {
          seenTiles.add(tile);
          result.push(tile);
          if ((tile.layer ?? 1) === 1) {
            seenGroundKeys.add(this.getKey(tile.x, tile.z));
          }
        }
      }
    }
    // 互換性のため地上1Fのタイルもマージ（旧実装の result.some() による O(N^2) 走査を廃止）
    if (filterLayer === undefined || filterLayer === 1) {
      for (const tile of this.tiles.values()) {
        if (tile.type !== 'empty' && !seenTiles.has(tile) && !seenGroundKeys.has(this.getKey(tile.x, tile.z))) {
          seenTiles.add(tile);
          result.push(tile);
        }
      }
    }
    return result;
  }

  /**
   * 水辺（海・河川）敷設制約の判定
   * - 地上1F: 水面のため敷設不可
   * - 地上2F以上: 高架橋梁・鉄橋として敷設可能
   * - 地下B1F〜B2F: 海底・河底トンネルとして敷設可能
   */
  public canPlaceAtWater(x: number, z: number, layer: GridLayer): { allowed: boolean; reason?: string } {
    if (!this.gridManagerRef) return { allowed: true };
    const isWater = this.gridManagerRef.isWaterAtGroundLevel(x, z);
    if (!isWater) return { allowed: true };

    if (layer === 1) {
      return {
        allowed: false,
        reason: '水上（地上1F）には敷設できません。地上2F以上の高架橋梁、または地下トンネルをご利用ください。'
      };
    }
    return { allowed: true };
  }

  /**
   * 指定タイルが山岳地表より下を貫く「トンネル区間」かどうかを判定
   */
  public isTunnelSection(x: number, z: number, layer: GridLayer): boolean {
    if (!this.gridManagerRef) return layer < 0;
    const cell = this.gridManagerRef.getCell(x, 1, z);
    const surfaceElevation = cell ? cell.elevation : 1;
    // 地下階層はすべてトンネル
    if (layer < 0) return true;
    // 地上階層でも、地表の標高より低い位置にあればトンネル区間
    return layer < surfaceElevation;
  }

  /**
   * 【Hotfix】地上1Fの線路用の高さオフセットを算出する。
   * 山岳マス（地表標高 > 1F）を貫くトンネル区間では、線路は山の中腹を這い上がるのではなく
   * 常に基準の地表高さ（0）を保ったまま山を貫通させる。トンネルでない通常の平地・丘陵地では
   * 従来通り地表標高に応じたオフセット（丘の上に乗る通常の地上線路）を適用する。
   */
  public getTrackElevationOffset(x: number, z: number, layer: GridLayer): number {
    if (layer !== 1) return 0;
    if (this.isTunnelSection(x, z, layer)) return 0;
    return this.getElevationOffset(x, z);
  }

  /**
   * ② ③ 曲線レール（1マス・斜め接続）の敷設。地上/高架どちらも設置可能。
   */
  public placeCurve(x: number, z: number, curveDir: CurveDirection, isElevated: boolean = false, layer: GridLayer = this.activeLayer): boolean {
    const tile = this.getOrCreateTile(x, z, layer);
    if (!tile) return false;

    const cell = this.gridManagerRef?.getCell(x, 1, z);
    const surfaceElevation = cell ? cell.elevation : 1;
    const effectiveElevated = isElevated && (layer > surfaceElevation);

    const tileType: TileType = effectiveElevated ? 'rail_curve_elevated' : 'rail_curve_ground';

    this.removeTileMesh(tile);

    tile.type = tileType;
    tile.layer = layer;
    tile.curveDir = curveDir;
    tile.rotation = 0;
    const baseH = layerToHeight(layer);
    const elevY = this.getTrackElevationOffset(x, z, layer);
    tile.elevationOffset = elevY;

    const isTunnel = this.isTunnelSection(x, z, layer);
    const mesh = ModelFactory.createCurveTrackSegment(curveDir, effectiveElevated, baseH, isTunnel);
    mesh.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
    mesh.visible = this.isLayerVisibleInCurrentMode(layer);
    this.attachTileMesh(tile, mesh);

    this.markDirty();
    return true;
  }

  /**
   * ① 勾配レール（4マス直線）の敷設。origin を地上側の端として、rotation・reversed で決まる
   * 上り方向へ4マス連続で配置し、各マスが1/4ずつ高さを分担する（地上⇔高架を緩やかに接続）。
   */
  public placeSlope(originX: number, originZ: number, rotation: number, reversed: boolean, layer: GridLayer = 1): boolean {
    if (layer >= 5) return false; // 最上階（5F）からは上りスロープを敷設不可
    const axis: [number, number] = rotation === 1 ? [1, 3] : [0, 2];
    const [, highIdx] = reversed ? [axis[1], axis[0]] : [axis[0], axis[1]];
    const stepDir = WorldMap.DIRS[highIdx];

    const positions = Array.from({ length: SLOPE_PARTS }, (_, i) => ({
      x: originX + stepDir.x * i,
      z: originZ + stepDir.z * i
    }));
    for (const p of positions) {
      if (!this.isInBounds(p.x, p.z)) return false;
      if (this.isPermanentTrackOrStation(p.x, p.z, layer)) return false;
      const waterCheck = this.canPlaceAtWater(p.x, p.z, layer);
      if (!waterCheck.allowed) return false;
    }

    // トンネル区間内では 0m、地上地表では標高オフセットをベース高さ基準とする
    const originElevOffset = this.getTrackElevationOffset(originX, originZ, layer);
    const upperLayer: GridLayer = (layer + 1) as GridLayer;

    positions.forEach((p, i) => {
      const tile = this.getOrCreateTile(p.x, p.z, layer)!;
      this.applySlopeTile(tile, rotation, reversed, i, layer, originElevOffset);
      // 上位階層接続端（part 3）を上位レイヤーのGrid3Dにも登録
      if (i === SLOPE_PARTS - 1) {
        this.grid3D.set(p.x, upperLayer, p.z, tile);
      }
    });

    this.markDirty();
    return true;
  }

  /**
   * 勾配レール1マス分のデータ・メッシュを反映する（新規敷設・個別復元の両方で使用）
   */
  private applySlopeTile(tile: TileData, rotation: number, reversed: boolean, part: number, layer: GridLayer = 1, originElevOffset?: number) {
    this.removeTileMesh(tile);
    tile.type = 'rail_slope';
    tile.layer = layer;
    tile.rotation = rotation;
    tile.slopeReversed = reversed;
    tile.slopePart = part;
    tile.switchState = 'straight';
    tile.groupOrigin = undefined;
    const elevY = originElevOffset !== undefined ? originElevOffset : this.getElevationOffset(tile.x, tile.z);
    tile.elevationOffset = elevY;

    const baseH = layerToHeight(layer, elevY);
    const mesh = ModelFactory.createSlopeTrackPart(rotation, reversed, part);
    mesh.position.set(tile.x * WorldMap.TILE_SIZE, baseH, tile.z * WorldMap.TILE_SIZE);
    const upperLayer: GridLayer = (layer + 1) as GridLayer;
    mesh.visible = (this.isLayerVisibleInCurrentMode(layer) || this.isLayerVisibleInCurrentMode(upperLayer));
    this.attachTileMesh(tile, mesh);
  }

  /**
   * ② 地下勾配レール（4マス直線）の敷設。origin を地上側の端として、下り方向へ4マス連続で配置する（地上⇔地下を接続）。
   */
  public placeUndergroundSlope(originX: number, originZ: number, rotation: number, reversed: boolean, layer: GridLayer = 1): boolean {
    const axis: [number, number] = rotation === 1 ? [1, 3] : [0, 2];
    const [, downIdx] = reversed ? [axis[1], axis[0]] : [axis[0], axis[1]];
    const stepDir = WorldMap.DIRS[downIdx];

    const positions = Array.from({ length: SLOPE_PARTS }, (_, i) => ({
      x: originX + stepDir.x * i,
      z: originZ + stepDir.z * i
    }));
    for (const p of positions) {
      if (!this.isInBounds(p.x, p.z)) return false;
      if (this.isPermanentTrackOrStation(p.x, p.z, layer)) return false;
      const waterCheck = this.canPlaceAtWater(p.x, p.z, layer);
      if (!waterCheck.allowed) return false;

      // 【バグ修正】山岳・丘陵地（標高が平地より高い場所）からの地下スロープ建設を禁止
      if (layer === 1 && this.getElevationOffset(p.x, p.z) > 0) return false;
    }

    positions.forEach((p, i) => {
      const tile = this.getOrCreateTile(p.x, p.z, layer)!;
      this.applyUndergroundSlopeTile(tile, rotation, reversed, i, layer);
      // 地下側接続端（part 3）を地下レイヤー(layer -1)のGrid3Dにも登録
      if (i === SLOPE_PARTS - 1) {
        const lowerLayer: GridLayer = -1;
        this.grid3D.set(p.x, lowerLayer, p.z, tile);
      }
      // 地上側掘割区間（part 0, 1）の地表面をステンシル穴あけ
      if (i === 0 || i === 1) {
        this.groundHoleHandler?.add(p.x, p.z, rotation);
      }
    });

    this.markDirty();
    return true;
  }

  /**
   * 地下勾配レール1マス分のデータ・メッシュを反映する
   */
  private applyUndergroundSlopeTile(tile: TileData, rotation: number, reversed: boolean, part: number, layer: GridLayer = 1) {
    this.removeTileMesh(tile);
    tile.type = 'rail_slope_underground';
    tile.layer = layer;
    tile.rotation = rotation;
    tile.slopeReversed = reversed;
    tile.slopePart = part;
    tile.switchState = 'straight';
    tile.groupOrigin = undefined;
    const elevY = this.getElevationOffset(tile.x, tile.z);
    tile.elevationOffset = elevY;

    const mesh = ModelFactory.createUndergroundSlopeTrackPart(rotation, reversed, part);
    mesh.position.set(tile.x * WorldMap.TILE_SIZE, elevY, tile.z * WorldMap.TILE_SIZE);
    this.attachTileMesh(tile, mesh);
  }

  /**
   * 分岐器やシーサスクロッシングによって上書き設置可能な線路タイルかどうかを判定する
   * （直線・曲線・分岐器・シーサス等の通常線路は上書き可能。駅や信号場、建物、道路、踏切等は上書き不可）
   */
  public isOverwritableTrack(x: number, z: number, layer: GridLayer = this.activeLayer): boolean {
    const tile = this.getTile(x, z, layer);
    if (!tile || tile.type === 'empty') return true;
    return (
      tile.type === 'rail_ground' ||
      tile.type === 'rail_elevated' ||
      tile.type === 'rail_curve_ground' ||
      tile.type === 'rail_curve_elevated' ||
      tile.type === 'point_switch_ground' ||
      tile.type === 'point_switch_elevated'
    );
  }

  /**
   * ② 分岐器（ポイント）の敷設。曲線レールと同じ1マスで完結する
   * （進入側＋直進側＋分岐側の曲線レールを1タイル内に収める）。
   * rotation: 0-3 = 通過方向（進入→直進方向）のインデックス（0=北,1=東,2=南,3=西）。
   * branchSide: 'right'(右分岐) または 'left'(左分岐)。
   */
  public placeSwitch(x: number, z: number, rotation: number, isElevated: boolean = false, branchSide: 'left' | 'right' = 'right', layer: GridLayer = this.activeLayer): boolean {
    if (!this.isInBounds(x, z)) return false;
    if (!this.isOverwritableTrack(x, z, layer)) return false;
    const tile = this.getOrCreateTile(x, z, layer);
    if (!tile) return false;

    const cell = this.gridManagerRef?.getCell(x, 1, z);
    const surfaceElevation = cell ? cell.elevation : 1;
    const effectiveElevated = isElevated && (layer > surfaceElevation);

    const forward = ((rotation % 4) + 4) % 4;
    const switchType: TileType = effectiveElevated ? 'point_switch_elevated' : 'point_switch_ground';

    this.removeTileMesh(tile);

    tile.type = switchType;
    tile.layer = layer;
    tile.rotation = forward;
    tile.switchState = 'straight';
    tile.switchBranchSide = branchSide;
    tile.curveDir = undefined;
    tile.slopeReversed = undefined;
    tile.groupOrigin = undefined;
    const baseH = layerToHeight(layer);
    const elevY = this.getTrackElevationOffset(x, z, layer);
    tile.elevationOffset = elevY;

    const isTunnel = this.isTunnelSection(x, z, layer);
    const mesh = ModelFactory.createSwitchHub(forward, false, effectiveElevated, branchSide, baseH, isTunnel);
    mesh.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
    mesh.visible = this.isLayerVisibleInCurrentMode(layer);
    this.attachTileMesh(tile, mesh);

    this.markDirty();
    return true;
  }

  /**
   * ③ シーサスクロッシング（複線用の交差分岐）の敷設。2×2マスを使用する。
   * origin=A（左上/北西または北東側の角）。rotation: 0=南北方向に並走(横に2本), 1=東西方向に並走(縦に2本)。
   * A-B が1本目の線路、C-D が2本目の線路（Aから見て右手側=acrossDir に1マスずれた位置）。
   */
  public placeScissorsCrossing(originX: number, originZ: number, rotation: number, isElevated: boolean = false, layer: GridLayer = this.activeLayer): boolean {
    const along = (rotation % 2 === 1) ? 1 : 2;
    const across = WorldMap.rotateCW(along);
    const alongVec = WorldMap.DIRS[along];
    const acrossVec = WorldMap.DIRS[across];

    const posA = { x: originX, z: originZ };
    const posB = { x: originX + alongVec.x, z: originZ + alongVec.z };
    const posC = { x: originX + acrossVec.x, z: originZ + acrossVec.z };
    const posD = { x: originX + alongVec.x + acrossVec.x, z: originZ + alongVec.z + acrossVec.z };
    const positions = [posA, posB, posC, posD];

    for (const p of positions) {
      if (!this.isInBounds(p.x, p.z)) return false;
      if (!this.isOverwritableTrack(p.x, p.z, layer)) return false;
      const waterCheck = this.canPlaceAtWater(p.x, p.z, layer);
      if (!waterCheck.allowed) return false;
    }

    const sharedSchedule = createDefaultSwitchSchedule();

    positions.forEach((p, role) => {
      const cell = this.gridManagerRef?.getCell(p.x, 1, p.z);
      const surfaceElevation = cell ? cell.elevation : 1;
      const effectiveElevated = isElevated && (layer > surfaceElevation);
      const crossingType: TileType = effectiveElevated ? 'scissors_crossing_elevated' : 'scissors_crossing_ground';

      const t = this.getOrCreateTile(p.x, p.z, layer)!;
      this.removeTileMesh(t);
      t.type = crossingType;
      t.layer = layer;
      t.rotation = (rotation % 2 === 1) ? 1 : 0;
      t.curveDir = undefined;
      t.slopeReversed = undefined;
      t.switchState = 'straight';
      t.groupOrigin = { x: originX, z: originZ };
      t.crossingRole = role as 0 | 1 | 2 | 3;
      const baseH = layerToHeight(layer);
      const elevY = this.getTrackElevationOffset(p.x, p.z, layer);
      t.elevationOffset = elevY;

      const isTunnel = this.isTunnelSection(p.x, p.z, layer);
      const mesh = ModelFactory.createScissorsCrossingTile(along, role as 0 | 1 | 2 | 3, effectiveElevated, 'straight', baseH, isTunnel);
      mesh.position.set(p.x * WorldMap.TILE_SIZE, baseH + elevY, p.z * WorldMap.TILE_SIZE);
      mesh.visible = this.isLayerVisibleInCurrentMode(layer);
      this.attachTileMesh(t, mesh);
      t.switchSchedule = t.switchSchedule || sharedSchedule;
    });

    this.markDirty();
    return true;
  }

  /**
   * ③ シーサスクロッシングの開通状態を straight → cross-a → cross-b → straight … と切り替える。
   * グループ内のどのマスをクリックしても起点(A)を切り替え、4マス全てのメッシュを再構築する。
   */
  public cycleCrossingState(x: number, z: number, layer?: GridLayer): CrossingState | null {
    const checkLayer = (layer ?? this.activeLayer) as GridLayer;
    const clicked = this.getTile(x, z, checkLayer);
    if (!clicked || !clicked.groupOrigin) return null;
    const origin = this.getTile(clicked.groupOrigin.x, clicked.groupOrigin.z, (clicked.layer ?? checkLayer) as GridLayer);
    if (!origin || origin.crossingRole !== 0) return null;

    const order: CrossingState[] = ['straight', 'cross-a', 'cross-b'];
    const nextState = order[(order.indexOf(origin.crossingState ?? 'straight') + 1) % order.length];
    const success = this.setCrossingState(x, z, nextState, checkLayer, false);
    return success ? nextState : null;
  }

  /**
   * シーサスクロッシングの開通状態を指定の状態（'straight' | 'cross-a' | 'cross-b'）に設定する
   */
  public setCrossingState(x: number, z: number, targetState: CrossingState, layer?: GridLayer, isTransient: boolean = false): boolean {
    const checkLayer = (layer ?? this.activeLayer) as GridLayer;
    const clicked = this.getTile(x, z, checkLayer);
    if (!clicked || !clicked.groupOrigin) return false;
    const origin = this.getTile(clicked.groupOrigin.x, clicked.groupOrigin.z, (clicked.layer ?? checkLayer) as GridLayer);
    if (!origin || origin.crossingRole !== 0) return false;

    // 手動明示的切替（!isTransient）の時はモードを manual に設定し、
    // 列車通過時や時刻同期処理で勝手に straight へ戻されないようにする
    if (!isTransient) {
      if (!origin.switchSchedule) {
        origin.switchSchedule = createDefaultSwitchSchedule();
      }
      origin.switchSchedule.mode = 'manual';
    }

    // 既に同一状態なら再生成をスキップ
    if (origin.crossingState === targetState) return true;

    const along = (origin.rotation % 2 === 1) ? 1 : 2;
    const across = WorldMap.rotateCW(along);
    const alongVec = WorldMap.DIRS[along];
    const acrossVec = WorldMap.DIRS[across];
    const isElevated = origin.type.includes('elevated');

    const positions = [
      { x: origin.x, z: origin.z },
      { x: origin.x + alongVec.x, z: origin.z + alongVec.z },
      { x: origin.x + acrossVec.x, z: origin.z + acrossVec.z },
      { x: origin.x + alongVec.x + acrossVec.x, z: origin.z + alongVec.z + acrossVec.z }
    ];

    positions.forEach((p, role) => {
      const t = this.getTile(p.x, p.z, (origin.layer ?? checkLayer) as GridLayer);
      if (!t) return;
      t.crossingState = targetState;
      if (origin.switchSchedule) {
        t.switchSchedule = origin.switchSchedule;
      }
      const typedRole = role as 0 | 1 | 2 | 3;
      if (t.mesh && ModelFactory.updateScissorsCrossingTileState(t.mesh, typedRole, targetState)) {
        return;
      }
      this.removeTileMesh(t);
      const tileLayer = (t.layer ?? checkLayer) as GridLayer;
      const baseH = layerToHeight(tileLayer);
      const elevY = this.getTrackElevationOffset(p.x, p.z, tileLayer);
      t.elevationOffset = elevY;
      const isTunnel = this.isTunnelSection(p.x, p.z, tileLayer);
      const mesh = ModelFactory.createScissorsCrossingTile(along, typedRole, isElevated, targetState, baseH, isTunnel);
      mesh.position.set(p.x * WorldMap.TILE_SIZE, baseH + elevY, p.z * WorldMap.TILE_SIZE);
      mesh.visible = this.isLayerVisibleInCurrentMode(tileLayer);
      this.attachTileMesh(t, mesh);
    });

    if (!isTransient) {
      this.markDirty();
    }
    return true;
  }

  /**
   * シーサスクロッシンググループの代表(A)タイルを取得する
   */
  public resolveCrossingOrigin(x: number, z: number, layer?: GridLayer): TileData | undefined {
    const checkLayer = (layer ?? this.activeLayer) as GridLayer;
    const tile = this.getTile(x, z, checkLayer);
    if (!tile || !tile.groupOrigin) return undefined;
    return this.getTile(tile.groupOrigin.x, tile.groupOrigin.z, (tile.layer ?? checkLayer) as GridLayer);
  }

  /**
   * ② ポイント切り替え（直進 ⇄ 分岐）。分岐器は1マスなのでそのまま切り替える。
   */
  public togglePointSwitch(x: number, z: number, layer?: GridLayer): SwitchState | null {
    const checkLayer = (layer ?? this.activeLayer) as GridLayer;
    const tile = this.getTile(x, z, checkLayer);
    if (!tile || !tile.type.startsWith('point_switch')) return null;

    tile.switchState = (tile.switchState === 'straight') ? 'diverge' : 'straight';

    this.removeTileMesh(tile);

    const tileLayer = (tile.layer ?? checkLayer) as GridLayer;
    const isElevated = tile.type.includes('elevated');
    const branchSide = tile.switchBranchSide ?? 'right';
    const baseH = layerToHeight(tileLayer);
    const elevY = this.getTrackElevationOffset(tile.x, tile.z, tileLayer);
    tile.elevationOffset = elevY;
    const isTunnel = this.isTunnelSection(tile.x, tile.z, tileLayer);
    const mesh = ModelFactory.createSwitchHub(tile.rotation, tile.switchState === 'diverge', isElevated, branchSide, baseH, isTunnel);
    mesh.position.set(tile.x * WorldMap.TILE_SIZE, baseH + elevY, tile.z * WorldMap.TILE_SIZE);
    mesh.visible = this.isLayerVisibleInCurrentMode(tileLayer);
    this.attachTileMesh(tile, mesh);

    this.markDirty();
    return tile.switchState;
  }

  /**
   * ① 本設置済みの線路・駅等のインフラが存在するかを判定（仮置きによる誤上書き防止用）
   */
  public isPermanentTrackOrStation(x: number, z: number, layer: GridLayer = this.activeLayer): boolean {
    const tile = this.getTile(x, z, layer);
    if (!tile) return false;
    return (
      tile.type.startsWith('rail') ||
      tile.type.includes('station') ||
      tile.type === 'signal_yard' ||
      tile.type.startsWith('point_switch') ||
      tile.type.startsWith('scissors_crossing') ||
      tile.type === 'level_crossing' ||
      tile.type === 'external_connection'
    );
  }

  /**
   * 分岐器タイルそのものを取得する（インスペクター表示等で使用。1マスなので自分自身を返すだけ）
   */
  public resolveSwitchHub(x: number, z: number, layer?: GridLayer): TileData | undefined {
    const checkLayer = (layer ?? this.activeLayer) as GridLayer;
    const tile = this.getTile(x, z, checkLayer);
    if (!tile || !tile.type.startsWith('point_switch')) return undefined;
    return tile;
  }

  /**
   * 駅・信号場・貨物駅・隣町接続ゲートウェイのいずれかであるかを判定
   */
  public static isStationTileType(type: string): boolean {
    return (
      type.startsWith('station') ||
      type.startsWith('cargo_station') ||
      type === 'signal_yard'
    );
  }

  /**
   * ⑤ 踏切の自動検出: 直進レールと道路が直交して同じマスに置かれた場合、上書きするのではなく
   * 両方を兼ねる踏切タイルにする。軸が同じ（平行）場合は従来通り単純に上書きする。
   */
  private tryCreateLevelCrossing(x: number, z: number, type: TileType, rotation: number, level: number): boolean | null {
    const tile = this.getTile(x, z, 1);
    if (!tile) return null;
    const axis = ((rotation % 2) + 2) % 2;
    const tileAxis = (((tile.rotation ?? 0) % 2) + 2) % 2;

    if (type === 'road' && tile.type === 'rail_ground' && tileAxis !== axis) {
      return this.applyLevelCrossing(x, z, tileAxis, axis, level, 1);
    }
    if (type === 'rail_ground' && tile.type === 'road' && tileAxis !== axis) {
      return this.applyLevelCrossing(x, z, axis, tileAxis, level, 1);
    }
    return null;
  }

  private applyLevelCrossing(x: number, z: number, railAxis: number, roadAxis: number, level: number, layer: GridLayer = 1): boolean {
    const tile = this.getOrCreateTile(x, z, layer);
    if (!tile) return false;
    this.removeTileMesh(tile);
    tile.type = 'level_crossing';
    tile.layer = layer;
    tile.rotation = railAxis;
    tile.crossingRoadAxis = roadAxis;
    tile.level = level;
    tile.switchState = 'straight';
    tile.groupOrigin = undefined;
    tile.curveDir = undefined;
    tile.slopeReversed = undefined;
    tile.slopePart = undefined;
    tile.crossingRole = undefined;
    tile.crossingState = undefined;

    const elevY = this.getElevationOffset(x, z);
    tile.elevationOffset = elevY;

    const mesh = ModelFactory.createLevelCrossing(railAxis);
    mesh.position.set(x * WorldMap.TILE_SIZE, elevY, z * WorldMap.TILE_SIZE);
    this.attachTileMesh(tile, mesh);
    this.markDirty();
    return true;
  }

  /**
   * 踏切の明示的配置
   */
  public placeLevelCrossing(x: number, z: number, railAxis: number = 0, layer: GridLayer = 1): boolean {
    if (layer !== 1) return false;
    const normRailAxis = ((railAxis % 2) + 2) % 2;
    const normRoadAxis = 1 - normRailAxis;
    return this.applyLevelCrossing(x, z, normRailAxis, normRoadAxis, 1, layer);
  }

  /**
   * Set single tile
   */
  public setTile(x: number, z: number, type: TileType, rotation: number = 0, level: number = 1, platformSide: 'left' | 'right' = 'right', layer: GridLayer = this.activeLayer): boolean {
    // 疎マップ構造対応: 更地化の場合はオブジェクトを新規生成せず、既存タイルがあれば完全削除する
    if (type === 'empty') {
      const existing = this.getTile(x, z, layer);
      if (existing) {
        this.resetTileData(existing);
      }
      return true;
    }

    const tile = this.getOrCreateTile(x, z, layer);
    if (!tile) return false;

    // 踏切の直接指定配置（地上1F）
    if (type === 'level_crossing') {
      const railAxis = ((rotation % 2) + 2) % 2;
      const roadAxis = 1 - railAxis;
      return this.applyLevelCrossing(x, z, railAxis, roadAxis, level, layer);
    }

    // ⑤ 道路とレールが直交して重なる場合は踏切にする（地上1F限定）
    if (layer === 1) {
      const crossingResult = this.tryCreateLevelCrossing(x, z, type, rotation, level);
      if (crossingResult !== null) return crossingResult;
    }

    this.removeTileMesh(tile);

    tile.type = type;
    tile.layer = layer;
    tile.rotation = rotation;
    tile.level = level;
    tile.switchState = 'straight';
    tile.groupOrigin = undefined;
    tile.crossingRole = undefined;
    tile.crossingState = undefined;
    tile.crossingRoadAxis = undefined;
    if (!WorldMap.isStationTileType(type)) {
      tile.stationGroupId = undefined;
      tile.stationPlatformId = undefined;
      tile.stationPart = undefined;
      tile.stationPlatformSide = undefined;
      tile.isCargoYard = undefined;
    }


    // ⑧ 複数マス駅ホームの自動パーツ判定 (single / start / mid / end)
    let stationPart: 'single' | 'start' | 'mid' | 'end' = 'single';
    if (WorldMap.isStationTileType(type)) {
      tile.stationPlatformSide = platformSide;
      tile.stationSchedule = tile.stationSchedule || (type.startsWith('cargo_station') ? createDefaultCargoStationSchedule() : createDefaultStationSchedule());
      if (type.startsWith('station')) {
        stationPart = this.detectStationPart(x, z, tile.rotation, type, layer);
      }
      tile.stationPart = stationPart;
    }
    if (type.startsWith('point_switch')) {
      tile.switchSchedule = tile.switchSchedule || createDefaultSwitchSchedule();
    }

    let mesh: THREE.Group | undefined;
    const hasPole = Math.abs(x + z) % 3 === 0;
    const isTunnel = this.isTunnelSection(x, z, layer);
    const baseH = layerToHeight(layer);

    const cell = this.gridManagerRef?.getCell(x, 1, z);
    const surfaceElevation = cell ? cell.elevation : 1;

    // 山岳区間（isTunnel）では高架線路指定であっても山を貫くトンネル線路として扱い、
    // 山岳地表面（layer === surfaceElevation）では高架ではなく地表線路として扱う
    if (type === 'rail_elevated' && (isTunnel || layer === surfaceElevation)) {
      type = 'rail_ground';
      tile.type = 'rail_ground';
    }

    // ★修正: 駅や分岐器なども線路と同じく getTrackElevationOffset を使用し、山岳トンネル内の線路と高さを一致させる
    const isSurfaceStructure = type === 'road' || type === 'residence' || type === 'commercial' || type === 'industrial' || type === 'nature' || type === 'farmland';
    const elevY = isSurfaceStructure
      ? ((layer === 1) ? this.getElevationOffset(x, z) : 0)
      : this.getTrackElevationOffset(x, z, layer);
    tile.elevationOffset = elevY;
    const tileKey = `${x},${z},${layer}`;

    const isGroundStraight = (type === 'rail_ground' && !isTunnel && layer >= 0);
    const isElevatedStraight = (type === 'rail_elevated');
    const isNatureTree = (type === 'nature');

    if (isGroundStraight) {
      const dummy = new THREE.Object3D();
      dummy.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
      if (tile.rotation === 1) dummy.rotation.y = Math.PI / 2;
      dummy.updateMatrix();
      this.instancedMeshManager.setGroundTrack(tileKey, dummy.matrix, hasPole);
    } else if (isElevatedStraight) {
      const dummy = new THREE.Object3D();
      dummy.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
      if (tile.rotation === 1) dummy.rotation.y = Math.PI / 2;
      dummy.updateMatrix();
      const pierMatrices = this.getElevatedPierMatrices(x, z, layer, tile.rotation);
      this.instancedMeshManager.setElevatedTrack(tileKey, dummy.matrix, pierMatrices);
    } else if (isNatureTree) {
      const dummy = new THREE.Object3D();
      dummy.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
      dummy.updateMatrix();
      this.instancedMeshManager.setTree(tileKey, dummy.matrix);
    } else {
      switch (type) {
        case 'rail_ground': {
          let portalEnds: { start?: boolean; end?: boolean } | undefined;
          if (isTunnel) {
            const isEW = (tile.rotation === 1);
            const dirA = isEW ? { x: -1, z: 0 } : { x: 0, z: -1 };
            const dirB = isEW ? { x: 1, z: 0 } : { x: 0, z: 1 };
            const isTunnelA = this.isTunnelSection(x + dirA.x, z + dirA.z, layer);
            const isTunnelB = this.isTunnelSection(x + dirB.x, z + dirB.z, layer);
            portalEnds = {
              start: !isTunnelA,
              end: !isTunnelB
            };
          }
          mesh = ModelFactory.createTunnelTrack(tile.rotation, portalEnds);
          break;
        }
        case 'station_ground':
          mesh = ModelFactory.createStation(tile.rotation, false, stationPart, tile.stationPlatformSide ?? 'right', tile.stationName ?? '駅');
          break;
        case 'station_elevated':
          mesh = ModelFactory.createStation(tile.rotation, true, stationPart, tile.stationPlatformSide ?? 'right', tile.stationName ?? '駅', baseH);
          break;
        case 'signal_yard':
          mesh = ModelFactory.createSignalYard(tile.rotation, layer >= 2, tile.stationPlatformSide ?? 'right', baseH);
          break;
        case 'cargo_station_ground':
          mesh = ModelFactory.createCargoStation(tile.rotation, false, tile.stationPlatformSide ?? 'right');
          break;
        case 'cargo_station_elevated':
          mesh = ModelFactory.createCargoStation(tile.rotation, true, tile.stationPlatformSide ?? 'right', baseH);
          break;
        case 'road':
          mesh = ModelFactory.createRoad(tile.rotation);
          break;
        case 'residence':
          mesh = ModelFactory.createHouse(Math.abs(x * 7 + z * 13) % 4, level);
          break;
        case 'commercial':
          mesh = ModelFactory.createCommercialBuilding(level);
          break;
        case 'industrial':
          mesh = ModelFactory.createIndustrialBuilding(level);
          break;
        case 'farmland':
          mesh = ModelFactory.createFarmland(Math.abs(x * 11 + z * 17) % 3);
          break;
        case 'external_connection': {
          tile.isExternalConnection = true;
          if (isTunnel) {
            const isEW = (tile.rotation === 1);
            const dirA = isEW ? { x: -1, z: 0 } : { x: 0, z: -1 };
            const dirB = isEW ? { x: 1, z: 0 } : { x: 0, z: 1 };
            const isTunnelA = this.isTunnelSection(x + dirA.x, z + dirA.z, layer);
            const isTunnelB = this.isTunnelSection(x + dirB.x, z + dirB.z, layer);
            mesh = ModelFactory.createTunnelTrack(tile.rotation, {
              start: !isTunnelA,
              end: !isTunnelB
            });
          } else {
            mesh = ModelFactory.createGroundTrack(tile.rotation, false);
          }
          break;
        }
        default:
          mesh = undefined;
          break;
      }

      if (mesh) {
        mesh.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
        mesh.visible = this.isLayerVisibleInCurrentMode(layer);
        this.attachTileMesh(tile, mesh);
      }
    }

    // Update neighboring stations if this is a station
    if (WorldMap.isStationTileType(type)) {
      if (!tile.stationName) {
        tile.stationName = (type === 'external_connection')
          ? '隣町ゲートウェイ'
          : (type.startsWith('cargo_station')
            ? `第${this.getStationCount() + 1}貨物駅`
            : (type === 'signal_yard' ? `第${this.getStationCount() + 1}信号場` : `第${this.getStationCount() + 1}駅`));
      }

      if (type.startsWith('station')) {
        // ★修正: 第5引数に layer を渡す
        this.updateNeighborStations(x, z, tile.rotation, type, layer);
      }
    }

    // トンネル敷設時、隣接するトンネルタイルの坑口ポータル開閉を更新
    if ((type === 'rail_ground' || type === 'external_connection') && isTunnel) {
      const isEW = (rotation === 1);
      const dirA = isEW ? { x: -1, z: 0 } : { x: 0, z: -1 };
      const dirB = isEW ? { x: 1, z: 0 } : { x: 0, z: 1 };
      this.updateTunnelTilePortal(x + dirA.x, z + dirA.z, layer);
      this.updateTunnelTilePortal(x + dirB.x, z + dirB.z, layer);
    }

    // 直上階層の高架線路の橋脚を着地状況に合わせて更新
    this.updateUpperElevatedPiers(x, z, layer);

    this.markDirty();
    return true;
  }

  /**
   * トンネルタイルの坑口ポータル（アーチ額縁と庇）メッシュを隣接状況に合わせて更新
   */
  public updateTunnelTilePortal(x: number, z: number, layer: GridLayer = this.activeLayer): void {
    const tile = this.getTile(x, z, layer);
    if (!tile || tile.type !== 'rail_ground' || !this.isTunnelSection(x, z, layer)) return;

    const isEW = (tile.rotation === 1);
    const dirA = isEW ? { x: -1, z: 0 } : { x: 0, z: -1 };
    const dirB = isEW ? { x: 1, z: 0 } : { x: 0, z: 1 };
    const isTunnelA = this.isTunnelSection(x + dirA.x, z + dirA.z, layer);
    const isTunnelB = this.isTunnelSection(x + dirB.x, z + dirB.z, layer);
    const portalEnds = {
      start: !isTunnelA,
      end: !isTunnelB
    };

    if (tile.mesh) {
      tile.mesh.removeFromParent();
      disposeHierarchy(tile.mesh);
    }
    const baseH = layerToHeight(layer);
    const elevY = this.getTrackElevationOffset(x, z, layer);
    const newMesh = ModelFactory.createTunnelTrack(tile.rotation, portalEnds);
    newMesh.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
    newMesh.visible = this.isLayerVisibleInCurrentMode(layer);
    this.attachTileMesh(tile, newMesh);
  }

  /**
   * ⑧ 複数マス駅パーツの自動検出
   */
  private detectStationPart(x: number, z: number, rot: number, type: TileType, layer: GridLayer = this.activeLayer): 'single' | 'start' | 'mid' | 'end' {
    const prev = rot === 1 ? this.getTile(x - 1, z, layer) : this.getTile(x, z - 1, layer);
    const next = rot === 1 ? this.getTile(x + 1, z, layer) : this.getTile(x, z + 1, layer);

    const hasPrev = prev && prev.type === type && prev.rotation === rot;
    const hasNext = next && next.type === type && next.rotation === rot;

    if (hasPrev && hasNext) return 'mid';
    if (!hasPrev && hasNext) return 'start';
    if (hasPrev && !hasNext) return 'end';
    return 'single';
  }

  /**
   * ⑨ 駅の有効長（連続する同一駅タイル数 = 列車の最大両数）を取得
   */
  public getStationRunLength(x: number, z: number, layer: GridLayer = this.activeLayer): number {
    const tile = this.getTile(x, z, layer);
    if (!tile || !WorldMap.isStationTileType(tile.type)) return 0;

    const targetLayer = (tile.layer ?? layer) as GridLayer;
    // StationManager からホーム有効長を直接参照（正本優先）
    const platInfo = this.stationManager.getPlatformByTile(x, z, targetLayer);
    if (platInfo && platInfo.platform.length > 0) {
      return platInfo.platform.length;
    }

    // 未登録の場合のみ従来のタイル探索にフォールバック
    const rot = tile.rotation;
    const stepX = (rot % 2 === 1) ? 1 : 0;
    const stepZ = (rot % 2 === 1) ? 0 : 1;

    const isSameStation = (t: TileData | undefined): boolean => {
      if (!t) return false;
      if (((t.layer ?? layer) as GridLayer) !== targetLayer) return false;
      if (!WorldMap.isStationTileType(t.type)) return false;
      if (tile.stationPlatformId) {
        return t.stationPlatformId === tile.stationPlatformId;
      }
      if (tile.stationGroupId) {
        return t.stationGroupId === tile.stationGroupId;
      }
      return t.type === tile.type && (t.rotation % 2 === rot % 2);
    };

    let count = 1;
    let cx = x - stepX, cz = z - stepZ;
    while (true) {
      const t = this.getTile(cx, cz, targetLayer);
      if (isSameStation(t)) {
        count++;
        cx -= stepX;
        cz -= stepZ;
      } else break;
    }
    cx = x + stepX; cz = z + stepZ;
    while (true) {
      const t = this.getTile(cx, cz, targetLayer);
      if (isSameStation(t)) {
        count++;
        cx += stepX;
        cz += stepZ;
      } else break;
    }
    return count;
  }

  /**
   * ② マップ境界端に隣町接続ゲートウェイ（外部接続都市タイル）を配置
   */
  public placeExternalConnection(
    x: number,
    z: number,
    rotation: number,
    cityId: string,
    cityName: string,
    layer: GridLayer = 1
  ): TileData | undefined {
    const success = this.setTile(x, z, 'external_connection', rotation, 1, 'right', layer);
    if (!success) return undefined;
    const tile = this.getTile(x, z, layer);
    if (tile) {
      tile.externalCityId = cityId;
      tile.isExternalConnection = true;
      tile.stationName = cityName;
      if (tile.mesh) {
        ModelFactory.updateGatewaySign(tile.mesh, cityName, false);
      }
    }
    return tile;
  }

  public getStationCount(): number {
    return Array.from(this.tiles.values()).filter(t => WorldMap.isStationTileType(t.type)).length;
  }

  /**
   * ④ 駅グループの先頭タイル（最小座標側のタイル）を取得
   */
  public getStationStartTile(x: number, z: number, layer: GridLayer = this.activeLayer): TileData | null {
    const tile = this.getTile(x, z, layer);
    if (!tile || !WorldMap.isStationTileType(tile.type)) return null;

    const targetLayer = (tile.layer ?? layer) as GridLayer;
    const platInfo = this.stationManager.getPlatformByTile(x, z, targetLayer);
    if (platInfo && platInfo.platform && platInfo.platform.tiles.length > 0) {
      // 座標最小のタイルを先頭とする（X優先、同値ならZ優先）
      const sorted = [...platInfo.platform.tiles].sort((a, b) => (a.x - b.x) || (a.z - b.z));
      const first = sorted[0];
      const found = this.getTile(first.x, first.z, first.layer);
      if (found) return found;
    }

    const rot = tile.rotation;
    const stepX = (rot % 2 === 1) ? 1 : 0;
    const stepZ = (rot % 2 === 1) ? 0 : 1;

    const isSameStation = (t: TileData | undefined): boolean => {
      if (!t) return false;
      if (((t.layer ?? layer) as GridLayer) !== targetLayer) return false;
      if (!WorldMap.isStationTileType(t.type)) return false;
      if (tile.stationPlatformId) {
        return t.stationPlatformId === tile.stationPlatformId;
      }
      if (tile.stationGroupId) {
        return t.stationGroupId === tile.stationGroupId;
      }
      return t.type === tile.type && (t.rotation % 2 === rot % 2);
    };

    let cur = tile;
    while (true) {
      const t = this.getTile(cur.x - stepX, cur.z - stepZ, targetLayer);
      if (isSameStation(t)) {
        cur = t!;
      } else break;
    }
    return cur;
  }

  /**
   * ④ 駅グループを構成する全タイルを取得
   */
  public getStationTiles(x: number, z: number, layer: GridLayer = this.activeLayer): TileData[] {
    const tile = this.getTile(x, z, layer);
    if (!tile || !WorldMap.isStationTileType(tile.type)) return [];

    const targetLayer = (tile.layer ?? layer) as GridLayer;
    const platInfo = this.stationManager.getPlatformByTile(x, z, targetLayer);
    if (platInfo && platInfo.platform && platInfo.platform.tiles.length > 0) {
      const result: TileData[] = [];
      const sorted = [...platInfo.platform.tiles].sort((a, b) => (a.x - b.x) || (a.z - b.z));
      for (const pt of sorted) {
        const t = this.getTile(pt.x, pt.z, pt.layer);
        if (t && WorldMap.isStationTileType(t.type)) {
          result.push(t);
        }
      }
      if (result.length > 0) return result;
    }

    const startTile = this.getStationStartTile(x, z, layer);
    if (!startTile) return [];

    const rot = startTile.rotation;
    const stepX = (rot % 2 === 1) ? 1 : 0;
    const stepZ = (rot % 2 === 1) ? 0 : 1;

    const isSameStation = (t: TileData | undefined): boolean => {
      if (!t) return false;
      if (((t.layer ?? layer) as GridLayer) !== targetLayer) return false;
      if (!WorldMap.isStationTileType(t.type)) return false;
      if (startTile.stationPlatformId) {
        return t.stationPlatformId === startTile.stationPlatformId;
      }
      if (startTile.stationGroupId) {
        return t.stationGroupId === startTile.stationGroupId;
      }
      return t.type === startTile.type && (t.rotation % 2 === rot % 2);
    };

    const tiles: TileData[] = [];
    let curX = startTile.x, curZ = startTile.z;
    while (true) {
      const t = this.getTile(curX, curZ, targetLayer);
      if (isSameStation(t)) {
        tiles.push(t!);
        curX += stepX;
        curZ += stepZ;
      } else break;
    }
    return tiles;
  }

  /**
   * Phase3 ①: 近接する平行ホーム（同一駅の別番線）を「番線タブ」として束ねるための
   * 全駅・信号場グループの開始タイル一覧を取得する。同一駅名が設定されている場合はそれを優先し、
   * 未設定の場合は軌道軸が同じで近接（8マス以内）するグループを自動的に同一駅としてまとめる。
   */
  public getSiblingPlatformStartTiles(x: number, z: number, layer: GridLayer = this.activeLayer): TileData[] {
    const origin = this.getStationStartTile(x, z, layer);
    if (!origin) return [];

    const groupStarts = new Map<string, TileData>();
    // 全階層のタイルから駅・信号場・貨物駅グループの開始タイルを収集
    const allTiles = this.getAllTiles();
    for (const t of allTiles) {
      if (!WorldMap.isStationTileType(t.type)) continue;
      if (t.stationPart !== 'start' && t.stationPart !== 'single') continue;
      const key = t.stationGroupId || `${t.x}_${t.z}_${t.layer ?? 1}`;
      if (!groupStarts.has(key)) groupStarts.set(key, t);
    }

    // StationManager に所属する駅の兄弟ホーム開始タイルも追加
    const originLayer = (origin.layer ?? 1) as GridLayer;
    const originPlatInfo = this.stationManager.getPlatformByTile(origin.x, origin.z, originLayer);
    if (originPlatInfo) {
      for (const plat of originPlatInfo.station.platforms) {
        if (plat.tiles.length > 0) {
          const firstCoord = plat.tiles[0];
          const st = this.getTile(firstCoord.x, firstCoord.z, firstCoord.layer);
          if (st) {
            const key = st.stationGroupId || `${st.x}_${st.z}_${st.layer ?? 1}`;
            groupStarts.set(key, st);
          }
        }
      }
    }

    const originAxis = origin.rotation % 2;
    const named = origin.stationName;

    const getStationKind = (t: TileData) => {
      if (t.type.startsWith('cargo_station')) return 'cargo';
      if (t.type === 'signal_yard') return 'yard';
      if (t.type.startsWith('station')) return 'station';
      return 'other';
    };

    const siblings = Array.from(groupStarts.values()).filter(t => {
      if (t.x === origin.x && t.z === origin.z && (t.layer ?? 1) === originLayer) return true;
      if (getStationKind(t) !== getStationKind(origin)) return false; // 旅客駅・貨物駅・信号場は相互に別グループ
      
      // StationManagerで同一駅として紐付いている場合は無条件で兄弟番線
      if (originPlatInfo) {
        const plat = this.stationManager.getPlatformByTile(t.x, t.z, (t.layer ?? 1) as GridLayer);
        if (plat && plat.station.id === originPlatInfo.station.id) return true;
      }

      if ((t.rotation % 2) !== originAxis) return false;
      if (named && t.stationName === named) return true;
      const dist = Math.max(Math.abs(t.x - origin.x), Math.abs(t.z - origin.z));
      return dist <= 8;
    });

    // 番線番号は座標順（北西→南東）で安定させる
    siblings.sort((a, b) => (a.x - b.x) || (a.z - b.z));
    return siblings;
  }

  /**
   * ④ 既存の駅のホーム有効長（1〜10両）を設定・変更する
   * 始点タイルを基準に、指定した長さ分になるよう駅タイルを延伸または短縮する。
   */
  public setStationLength(
    x: number,
    z: number,
    targetLength: number,
    layer?: GridLayer,
    isTileOccupied?: (x: number, z: number, layer: GridLayer) => boolean
  ): boolean {
    if (targetLength < 1 || targetLength > 10) return false;
    const checkLayer = (layer ?? this.activeLayer) as GridLayer;
    const tile = this.getTile(x, z, checkLayer) || this.getTile(x, z);
    if (!tile || !WorldMap.isStationTileType(tile.type)) return false;

    const rot = tile.rotation;
    const stationType = tile.type;
    const stLayer = (tile.layer ?? checkLayer) as GridLayer;
    const startTile = this.getStationStartTile(x, z, stLayer);
    if (!startTile) return false;

    const stepX = (rot % 2 === 1) ? 1 : 0;
    const stepZ = (rot % 2 === 1) ? 0 : 1;
    const isYard = stationType === 'signal_yard';
    const isCargo = stationType.startsWith('cargo_station');
    const defaultName = isYard
      ? `信号場 (${startTile.x}, ${startTile.z})`
      : (isCargo
        ? `貨物駅 (${startTile.x}, ${startTile.z})`
        : `駅 (${startTile.x}, ${startTile.z})`);
    const stationName = startTile.stationName || defaultName;

    // 現在の駅タイル列を取得
    const currentTiles: TileData[] = [];
    let curX = startTile.x, curZ = startTile.z;
    while (true) {
      const t = this.getTile(curX, curZ, stLayer);
      if (t && t.type === stationType && (t.rotation % 2 === rot % 2)) {
        currentTiles.push(t);
        curX += stepX;
        curZ += stepZ;
      } else break;
    }

    const currentLen = currentTiles.length;
    if (currentLen === targetLength) return true;

    if (targetLength > currentLen) {
      // 延伸：末尾から追加
      for (let i = currentLen; i < targetLength; i++) {
        const nx = startTile.x + stepX * i;
        const nz = startTile.z + stepZ * i;
        if (!this.isInBounds(nx, nz)) return false;
        if (isTileOccupied && isTileOccupied(nx, nz, stLayer)) {
          return false;
        }
        const waterCheck = this.canPlaceAtWater(nx, nz, stLayer);
        if (!waterCheck.allowed) return false;

        const targetTile = this.getTile(nx, nz, stLayer);
        // ★修正: 更地、または同じ向き(rot)の直線レールのみ駅に置換可能とする（曲線や勾配・直交レールの上書き破壊を防止）
        const isCompatibleStraightRail =
          targetTile &&
          (targetTile.type === 'rail_ground' || targetTile.type === 'rail_elevated') &&
          (targetTile.rotation % 2) === (rot % 2);
        if (targetTile && targetTile.type !== 'empty' && !isCompatibleStraightRail) {
          return false; // スペース不足・障害物あり
        }
      }
      for (let i = currentLen; i < targetLength; i++) {
        const nx = startTile.x + stepX * i;
        const nz = startTile.z + stepZ * i;
        this.setTile(nx, nz, stationType, rot, 1, startTile.stationPlatformSide ?? 'right', stLayer);
        const t = this.getTile(nx, nz, stLayer);
        if (t) {
          t.stationName = stationName;
          t.stationSchedule = startTile.stationSchedule;
          t.stationGroupId = startTile.stationGroupId;
          t.stationPlatformId = startTile.stationPlatformId;
          t.stationPlatformSide = startTile.stationPlatformSide ?? 'right';
          if (isCargo) {
            t.isCargoYard = true;
          }
        }
      }
    } else {
      // 【列車安全ガード】短縮対象タイルおよび駅ホーム上に列車が停車・通過中の場合は短縮を禁止
      if (isTileOccupied) {
        for (let i = 0; i < currentLen; i++) {
          const nx = startTile.x + stepX * i;
          const nz = startTile.z + stepZ * i;
          if (isTileOccupied(nx, nz, stLayer)) {
            return false;
          }
        }
      }

      // 短縮：余剰タイルを撤去（または地上/高架線路へ戻す）
      const isElevatedTrack = stationType.includes('elevated') || stLayer >= 2;
      const normalTrack: TileType = isElevatedTrack ? 'rail_elevated' : 'rail_ground';
      for (let i = targetLength; i < currentLen; i++) {
        const nx = startTile.x + stepX * i;
        const nz = startTile.z + stepZ * i;
        this.setTile(nx, nz, normalTrack, rot, 1, 'right', stLayer);
        const t = this.getTile(nx, nz, stLayer);
        if (t) {
          t.stationGroupId = undefined;
          t.stationPlatformId = undefined;
          t.stationPart = undefined;
          t.stationPlatformSide = undefined;
          t.isCargoYard = undefined;
        }
      }
    }

    // 更新後の全駅タイルのパーツ（start, mid, end, single）とメッシュを再構築
    for (let i = 0; i < targetLength; i++) {
      const nx = startTile.x + stepX * i;
      const nz = startTile.z + stepZ * i;
      const t = this.getTile(nx, nz, stLayer);
      if (t && t.type === stationType) {
        t.stationSchedule = startTile.stationSchedule;
        t.stationGroupId = startTile.stationGroupId;
        t.stationPlatformId = startTile.stationPlatformId;
        if (isCargo) {
          t.isCargoYard = true;
        }
        const part = (targetLength === 1)
          ? 'single'
          : (i === 0 ? 'start' : (i === targetLength - 1 ? 'end' : 'mid'));
        t.stationPart = part; // ★追加: stationPart プロパティを同期更新

        this.removeTileMesh(t); // 古いメッシュの完全解放
        const isElevated = stationType.includes('elevated') || stLayer >= 2;
        const platformSide = startTile.stationPlatformSide ?? 'right';
        t.stationPlatformSide = platformSide;
        const tileLayer = (t.layer ?? this.activeLayer) as GridLayer;
        const baseH = layerToHeight(tileLayer);
        const elevY = this.getTrackElevationOffset(nx, nz, tileLayer);
        t.elevationOffset = elevY;
        const mesh = isYard
          ? ModelFactory.createSignalYard(rot, isElevated, platformSide, baseH)
          : (isCargo
            ? ModelFactory.createCargoStation(rot, isElevated, platformSide, baseH)
            : ModelFactory.createStation(rot, isElevated, part, platformSide, t.stationName ?? '駅', baseH));
        mesh.position.set(nx * WorldMap.TILE_SIZE, baseH + elevY, nz * WorldMap.TILE_SIZE);
        mesh.visible = this.isLayerVisibleInCurrentMode(tileLayer);
        this.attachTileMesh(t, mesh);
      }
    }

    // StationManager にホーム有効長（および更新されたタイル）を同期通知
    const platInfo = this.stationManager.getPlatformByTile(startTile.x, startTile.z, stLayer);
    const newTiles: Array<{ x: number; z: number; layer: GridLayer }> = [];
    for (let i = 0; i < targetLength; i++) {
      newTiles.push({
        x: startTile.x + stepX * i,
        z: startTile.z + stepZ * i,
        layer: stLayer
      });
    }

    if (platInfo) {
      this.stationManager.updatePlatformLength(
        platInfo.station.id,
        platInfo.platform.id,
        targetLength,
        newTiles
      );
      for (const tCoord of newTiles) {
        const t = this.getTile(tCoord.x, tCoord.z, tCoord.layer);
        if (t) {
          t.stationGroupId = platInfo.station.id;
          t.stationPlatformId = platInfo.platform.id;
        }
      }
    } else {
      // 未登録の場合はホームとして新規登録
      const isSignalYard = stationType === 'signal_yard';
      const reg = this.stationManager.registerPlatform({
        tiles: newTiles,
        length: targetLength,
        trackAxis: rot,
        isSignalYard,
        isCargoStation: isCargo,
        customName: stationName
      });
      for (const tCoord of newTiles) {
        const t = this.getTile(tCoord.x, tCoord.z, tCoord.layer);
        if (t) {
          t.stationGroupId = reg.station.id;
          t.stationPlatformId = reg.platform.id;
        }
      }
    }

    this.markDirty();
    return true;
  }

  /**
   * ⑤ 駅グループ全体の集計情報（合計乗降客数、合計運賃収入、維持費、純利益）を取得
   */
  public getStationAggregateData(x: number, z: number, layer: GridLayer = this.activeLayer): {
    id?: string;
    name: string;
    platformNumber?: number;
    platformCount?: number;
    length: number;
    dailyPassengers: number;
    previousDayPassengers: number;
    twoDaysAgoPassengers: number;
    dailyLoadedCargo?: number;
    dailyUnloadedCargo?: number;
    previousDayLoadedCargo?: number;
    previousDayUnloadedCargo?: number;
    totalPassengers: number;
    totalRevenue: number;
    maintenance: number;
    netProfit: number;
    isSignalYard?: boolean;
    isCargoYard?: boolean;
    cargoContainers?: number;
  } | null {
    const tile = this.getTile(x, z, layer);
    if (!tile || !WorldMap.isStationTileType(tile.type)) return null;

    const stLayer = (tile.layer ?? layer) as GridLayer;
    const isYard = tile.type === 'signal_yard';
    const isCargo = tile.type.startsWith('cargo_station') || !!tile.isCargoYard;

    // StationManager から所属駅とホームの正本データを直接取得（Single Source of Truth）
    const platInfo = this.stationManager.getPlatformByTile(x, z, stLayer);
    if (platInfo) {
      const { station, platform } = platInfo;
      return {
        id: station.id,
        name: station.name,
        platformNumber: platform.platformNumber,
        platformCount: station.platforms.length,
        length: platform.length,
        dailyPassengers: (isYard || isCargo) ? 0 : station.dailyPassengers,
        previousDayPassengers: (isYard || isCargo) ? 0 : (station.previousDayPassengers ?? 0),
        twoDaysAgoPassengers: (isYard || isCargo) ? 0 : (station.twoDaysAgoPassengers ?? 0),
        dailyLoadedCargo: isCargo ? (station.dailyLoadedCargo ?? 0) : 0,
        dailyUnloadedCargo: isCargo ? (station.dailyUnloadedCargo ?? 0) : 0,
        previousDayLoadedCargo: isCargo ? (station.previousDayLoadedCargo ?? 0) : 0,
        previousDayUnloadedCargo: isCargo ? (station.previousDayUnloadedCargo ?? 0) : 0,
        totalPassengers: (isYard || isCargo) ? 0 : station.totalPassengers,
        totalRevenue: station.totalRevenue,
        maintenance: station.maintenance,
        netProfit: station.netProfit,
        isSignalYard: station.isSignalYard,
        isCargoYard: isCargo,
        cargoContainers: tile.cargoContainers ?? 0
      };
    }

    // 未登録時のフォールバック（初期化時等）
    const length = this.getStationRunLength(x, z, stLayer) || 1;
    const defaultMaint = isYard ? 20000 : (isCargo ? 50000 : 200000);
    const defaultName = isYard
      ? `第1信号場`
      : (isCargo ? `第1貨物駅` : `第1駅`);

    return {
      id: tile.stationGroupId,
      name: tile.stationName || defaultName,
      platformNumber: 1,
      platformCount: 1,
      length,
      dailyPassengers: 0,
      previousDayPassengers: 0,
      twoDaysAgoPassengers: 0,
      dailyLoadedCargo: 0,
      dailyUnloadedCargo: 0,
      previousDayLoadedCargo: 0,
      previousDayUnloadedCargo: 0,
      totalPassengers: 0,
      totalRevenue: 0,
      maintenance: defaultMaint,
      netProfit: -defaultMaint,
      isSignalYard: isYard,
      isCargoYard: isCargo,
      cargoContainers: tile.cargoContainers ?? 0
    };
  }

  /**
   * 貨物駅グループの蓄積コンテナ数を取得する
   */
  public getStationCargoContainers(x: number, z: number, layer: GridLayer = this.activeLayer): number {
    const startTile = this.getStationStartTile(x, z, layer);
    if (!startTile) return 0;
    return startTile.cargoContainers ?? 0;
  }

  /**
   * 貨物駅グループの蓄積コンテナ数を設定・同期する
   */
  public setStationCargoContainers(x: number, z: number, count: number, layer: GridLayer = this.activeLayer): void {
    const startTile = this.getStationStartTile(x, z, layer);
    if (!startTile) return;
    const val = Math.max(0, count);
    const platInfo = this.stationManager.getPlatformByTile(startTile.x, startTile.z, (startTile.layer ?? layer) as GridLayer);
    if (platInfo) {
      for (const plat of platInfo.station.platforms) {
        for (const pt of plat.tiles) {
          const t = this.getTile(pt.x, pt.z, pt.layer);
          if (t) t.cargoContainers = val;
        }
      }
    } else {
      const tiles = this.getStationTiles(startTile.x, startTile.z, layer);
      for (const t of tiles) {
        t.cargoContainers = val;
      }
    }
    this.markDirty();
  }

  /**
   * 貨物駅グループの蓄積コンテナ数を増減加算する
   */
  public addStationCargoContainers(x: number, z: number, delta: number, layer: GridLayer = this.activeLayer): number {
    const cur = this.getStationCargoContainers(x, z, layer);
    const next = Math.max(0, cur + delta);
    this.setStationCargoContainers(x, z, next, layer);
    return next;
  }

  /**
   * 駅名・信号場名のリネーム
   * プレイヤーが自由に変更した名前を駅グループ全体および StationManager に反映する
   */
  public renameStation(x: number, z: number, newName: string, layer: GridLayer = this.activeLayer): boolean {
    const trimmed = newName.trim();
    if (!trimmed) return false;

    const startTile = this.getStationStartTile(x, z, layer);
    if (!startTile) return false;

    const stLayer = (startTile.layer ?? layer) as GridLayer;

    // StationManager の駅名をリネーム
    const platInfo = this.stationManager.getPlatformByTile(startTile.x, startTile.z, stLayer);
    if (platInfo) {
      this.stationManager.renameStation(platInfo.station.id, trimmed);
    }

    // 兄弟番線（全ホーム）の開始タイルを取得し、すべての番線の stationName と3D看板を一括更新
    const siblingStarts = this.getSiblingPlatformStartTiles(startTile.x, startTile.z, stLayer);
    const allStarts = siblingStarts.length > 0 ? siblingStarts : [startTile];

    for (const sibStart of allStarts) {
      const sibLayer = (sibStart.layer ?? stLayer) as GridLayer;
      const tiles = this.getStationTiles(sibStart.x, sibStart.z, sibLayer);
      for (const t of tiles) {
        t.stationName = trimmed;
        if (t.mesh) {
          ModelFactory.updateStationSign(t.mesh, trimmed);
        }
      }
    }

    // StationManager に所属する同一駅の全ホーム・全タイルも網羅して確実に同期
    if (platInfo) {
      for (const platform of platInfo.station.platforms) {
        for (const pt of platform.tiles) {
          const t = this.getTile(pt.x, pt.z, pt.layer);
          if (t) {
            t.stationName = trimmed;
            if (t.mesh) {
              ModelFactory.updateStationSign(t.mesh, trimmed);
            }
          }
        }
      }
    }

    this.markDirty();
    return true;
  }

  private updateNeighborStations(x: number, z: number, rot: number, type: TileType, layer: GridLayer = this.activeLayer) {
    const neighbors = rot === 1
      ? [this.getTile(x - 1, z, layer), this.getTile(x + 1, z, layer)]
      : [this.getTile(x, z - 1, layer), this.getTile(x, z + 1, layer)];

    neighbors.forEach(n => {
      if (n && n.type === type && n.mesh) {
        const tileLayer = (n.layer ?? layer) as GridLayer;
        const part = this.detectStationPart(n.x, n.z, n.rotation, n.type, tileLayer);
        n.stationPart = part;
        n.mesh.removeFromParent();
        disposeHierarchy(n.mesh); // 旧メッシュのGPUリソース解放（VRAMリーク防止）
        const isElevated = n.type.includes('elevated');
        const baseH = layerToHeight(tileLayer);
        const elevY = this.getTrackElevationOffset(n.x, n.z, tileLayer);
        n.elevationOffset = elevY;
        const newMesh = ModelFactory.createStation(n.rotation, isElevated, part, n.stationPlatformSide ?? 'right', n.stationName ?? '駅', baseH);
        newMesh.position.set(n.x * WorldMap.TILE_SIZE, baseH + elevY, n.z * WorldMap.TILE_SIZE);
        newMesh.visible = this.isLayerVisibleInCurrentMode(tileLayer);
        this.attachTileMesh(n, newMesh);
      }
    });
  }

  /**
   * ② 分岐器の開通状態を明示的に指定して切り替える
   */
  public setSwitchState(x: number, z: number, state: SwitchState, layer: GridLayer = this.activeLayer, isTransient: boolean = false): void {
    const tile = this.getTile(x, z, layer);
    if (!tile || !tile.type.startsWith('point_switch')) return;
    if (tile.switchState === state) return;

    tile.switchState = state;
    if (tile.mesh && ModelFactory.updateSwitchHubState(tile.mesh, tile.switchState === 'diverge')) {
      if (!isTransient) {
        this.markDirty();
      }
      return;
    }

    if (tile.mesh) {
      tile.mesh.removeFromParent();
      disposeHierarchy(tile.mesh); // 旧メッシュのGPUリソース解放（VRAMリーク防止）
      tile.mesh = undefined;
    }
    const tileLayer = (tile.layer ?? layer) as GridLayer;
    const isElevated = tile.type.includes('elevated');
    const branchSide = tile.switchBranchSide ?? 'right';
    const baseH = layerToHeight(tileLayer);
    const elevY = this.getTrackElevationOffset(tile.x, tile.z, tileLayer);
    tile.elevationOffset = elevY;
    const isTunnel = this.isTunnelSection(tile.x, tile.z, tileLayer);
    const mesh = ModelFactory.createSwitchHub(tile.rotation, tile.switchState === 'diverge', isElevated, branchSide, baseH, isTunnel);
    mesh.position.set(tile.x * WorldMap.TILE_SIZE, baseH + elevY, tile.z * WorldMap.TILE_SIZE);
    mesh.visible = this.isLayerVisibleInCurrentMode(tileLayer);
    this.attachTileMesh(tile, mesh);
    if (!isTransient) {
      this.markDirty();
    }
  }

  /**
   * ⑤ 指定された有効長（1〜4マス）の駅ホームを一括敷設する。
   * 全マスに共通の stationGroupId を割り当て、先頭・中間・末尾のパーツを正確に適用する。
   */
  public placeStationGroup(
    originX: number,
    originZ: number,
    length: number,
    rotation: number,
    isElevated: boolean = false,
    name?: string,
    platformSide: 'left' | 'right' = 'right',
    layer: GridLayer = this.activeLayer,
    isSignalYard: boolean = false,
    isCargoStation: boolean = false
  ): boolean {
    const rot = rotation % 2;
    const stepX = rot === 1 ? 1 : 0;
    const stepZ = rot === 1 ? 0 : 1;
    let stationType: TileType = isElevated ? 'station_elevated' : 'station_ground';
    if (isSignalYard) stationType = 'signal_yard';
    else if (isCargoStation) stationType = isElevated ? 'cargo_station_elevated' : 'cargo_station_ground';

    // 敷設可能チェック
    for (let i = 0; i < length; i++) {
      const tx = originX + stepX * i;
      const tz = originZ + stepZ * i;
      if (!this.isInBounds(tx, tz)) return false;
      const t = this.getTile(tx, tz, layer);
      if (t && t.type !== 'empty') {
        // 直線線路（地上・高架）かつ向きが一致していればアタッチ設置可能
        const isCompatibleTrack = (t.type === 'rail_ground' || t.type === 'rail_elevated') && t.rotation === rot;
        if (!isCompatibleTrack) return false;
      }
      const waterCheck = this.canPlaceAtWater(tx, tz, layer);
      if (!waterCheck.allowed) return false;
    }

    const groupId = isSignalYard
      ? `yard_${Date.now()}_${originX}_${originZ}`
      : (isCargoStation
        ? `cargo_${Date.now()}_${originX}_${originZ}`
        : `st_${Date.now()}_${originX}_${originZ}`);
    const stationName = name || (isSignalYard
      ? `第${this.getStationCount() + 1}信号場`
      : (isCargoStation
        ? `第${this.getStationCount() + 1}貨物駅`
        : `第${this.getStationCount() + 1}駅`));
    const baseH = layerToHeight(layer);

    const tiles: Array<{ x: number; z: number; layer: GridLayer }> = [];
    for (let i = 0; i < length; i++) {
      const tx = originX + stepX * i;
      const tz = originZ + stepZ * i;
      tiles.push({ x: tx, z: tz, layer });
      const part: 'single' | 'start' | 'mid' | 'end' =
        length === 1 ? 'single' : (i === 0 ? 'start' : (i === length - 1 ? 'end' : 'mid'));

      const tile = this.getOrCreateTile(tx, tz, layer)!;
      this.removeTileMesh(tile);

      tile.type = stationType;
      tile.layer = layer;
      tile.rotation = rot;
      tile.level = isElevated ? LEVEL_ELEVATED : LEVEL_GROUND;
      tile.stationGroupId = groupId;
      tile.stationPart = part;
      tile.stationPlatformSide = platformSide;
      tile.stationName = stationName;
      tile.stationSchedule = isCargoStation ? createDefaultCargoStationSchedule() : createDefaultStationSchedule();
      if (isCargoStation) {
        tile.isCargoYard = true;
      }

      const elevY = this.getTrackElevationOffset(tx, tz, layer);
      tile.elevationOffset = elevY;
      const mesh = isSignalYard
        ? ModelFactory.createSignalYard(rot, isElevated, platformSide, baseH)
        : (isCargoStation
          ? ModelFactory.createCargoStation(rot, isElevated, platformSide, baseH)
          : ModelFactory.createStation(rot, isElevated, part, platformSide, stationName, baseH));
      mesh.position.set(tx * WorldMap.TILE_SIZE, baseH + elevY, tz * WorldMap.TILE_SIZE);
      mesh.visible = this.isLayerVisibleInCurrentMode(layer);
      this.attachTileMesh(tile, mesh);
    }

    // StationManager にホーム（番線）として登録
    const reg = this.stationManager.registerPlatform({
      tiles,
      length,
      trackAxis: rot,
      isSignalYard,
      isCargoStation,
      customName: stationName
    });

    // 発番された stationId と platformId を構成タイルの stationGroupId と stationPlatformId に確実に書き込む
    for (const tCoord of tiles) {
      const t = this.getTile(tCoord.x, tCoord.z, tCoord.layer);
      if (t) {
        t.stationGroupId = reg.station.id;
        t.stationPlatformId = reg.platform.id;
        t.stationName = reg.station.name;
        if (t.mesh && !isSignalYard) {
          ModelFactory.updateStationSign(t.mesh, reg.station.name);
        }
      }
    }

    this.markDirty();
    return true;
  }

  /**
   * ① タイルメッシュの安全な破棄とGPUリソース完全解放（VRAMリーク防止）
   */
  private removeTileMesh(tile: TileData): void {
    const tileKey = `${tile.x},${tile.z},${tile.layer ?? 1}`;
    this.instancedMeshManager.removeGroundTrack(tileKey);
    this.instancedMeshManager.removeElevatedTrack(tileKey);
    this.instancedMeshManager.removeTree(tileKey);

    if (tile.mesh) {
      tile.mesh.removeFromParent();
      disposeHierarchy(tile.mesh);
      tile.mesh = undefined;
    }
  }

  private resetTileData(tile: TileData) {
    this.removeTileMesh(tile);
    // スロープの跨がり登録（高架・地下）を解除
    if (tile.type === 'rail_slope') {
      const baseLayer = (tile.layer ?? 1) as GridLayer;
      const upperLayer = (baseLayer + 1) as GridLayer;
      const upperTile = this.grid3D.get(tile.x, upperLayer, tile.z);
      if (upperTile === tile) {
        this.grid3D.delete(tile.x, upperLayer, tile.z);
      }
    } else if (tile.type === 'rail_slope_underground') {
      const lowerTile = this.grid3D.get(tile.x, -1, tile.z);
      if (lowerTile === tile) {
        this.grid3D.delete(tile.x, -1, tile.z);
      }
      this.groundHoleHandler?.remove(tile.x, tile.z);
    }
    if (tile.type === 'rail_ground') {
      const isEW = (tile.rotation === 1);
      const dirA = isEW ? { x: -1, z: 0 } : { x: 0, z: -1 };
      const dirB = isEW ? { x: 1, z: 0 } : { x: 0, z: 1 };
      const lyr = tile.layer ?? 1;
      const tx = tile.x;
      const tz = tile.z;
      setTimeout(() => {
        this.updateTunnelTilePortal(tx + dirA.x, tz + dirA.z, lyr);
        this.updateTunnelTilePortal(tx + dirB.x, tz + dirB.z, lyr);
      }, 0);
    }
    tile.type = 'empty';
    tile.rotation = 0;
    tile.level = 1;
    tile.stationPassengers = 0;
    tile.curveDir = undefined;
    tile.switchState = 'straight';
    tile.groupOrigin = undefined;
    tile.crossingRole = undefined;
    tile.crossingState = undefined;
    tile.crossingRoadAxis = undefined;
    tile.slopeReversed = undefined;
    tile.slopePart = undefined;
    tile.stationGroupId = undefined;
    tile.stationPlatformId = undefined;
    tile.stationPart = undefined;
    tile.stationPlatformSide = undefined;
    tile.stationSchedule = undefined;
    tile.switchSchedule = undefined;
    tile.stationName = undefined;
    tile.cargoContainers = undefined;
    tile.isCargoYard = undefined;

    // 疎マップ構造化: 地上1Fを含め、全階層で empty オブジェクトを Map に残さず完全削除する
    const layer = (tile.layer ?? 1) as GridLayer;
    const tx = tile.x;
    const tz = tile.z;
    this.grid3D.delete(tx, layer, tz);
    if (layer === 1) {
      this.tiles.delete(this.getKey(tx, tz));
    }

    // 直上階層の高架線路の橋脚を再計算（下層が撤去されたため地上まで延長）
    this.updateUpperElevatedPiers(tx, tz, layer);
    this.markDirty();
  }

  /**
   * ⑤ 撤去処理。駅タイルの場合は同一駅グループ（有効長分の全マス）を一括撤去する。
   * シーサスクロッシンググループの一員を撤去した場合は残りを単体線路化する。
   */
  public demolishTile(
    x: number,
    z: number,
    layer: GridLayer = this.activeLayer,
    demolishMode: 'track' | 'city' | 'all' = 'all'
  ): boolean {
    const tile = this.getTile(x, z, layer);
    if (!tile || tile.type === 'empty') return false;

    // 踏切の部分撤去: 線路撤去なら道路に戻し、街づくり撤去なら地上線路に戻す
    if (tile.type === 'level_crossing' && demolishMode !== 'all') {
      const railAxis = ((tile.rotation ?? 0) % 2 + 2) % 2;
      const roadAxis = tile.crossingRoadAxis ?? (1 - railAxis);
      if (demolishMode === 'track') {
        return this.setTile(x, z, 'road', roadAxis, 1, 'right', layer);
      } else if (demolishMode === 'city') {
        return this.setTile(x, z, 'rail_ground', railAxis, 1, 'right', layer);
      }
    }

    // ⑤ 駅・信号場タイルの場合: 同一グループ全体を一括撤去する
    // 【データ腐敗バグ解消】signal_yard / cargo_station も一括撤去の対象とし、全階層からグループタイルを収集
    if (tile.type.includes('station') || tile.type === 'signal_yard') {
      const tilesToDemolish: TileData[] = [];
      if (tile.stationPlatformId) {
        // ★修正: 駅全体(stationGroupId)ではなく、クリックした番線(stationPlatformId)のみを撤去対象にする
        const targetPlatId = tile.stationPlatformId;
        this.getAllTiles().forEach(t => {
          if (t.stationPlatformId === targetPlatId) {
            tilesToDemolish.push(t);
          }
        });
      } else if (tile.stationGroupId) {
        // stationPlatformId が未設定の場合でも、同一線路上の連続タイルのみを取得
        tilesToDemolish.push(...this.getStationTiles(x, z, layer));
      } else {
        // レガシー駅・信号場の場合: 連続するマスを収集
        const startTile = this.getStationStartTile(x, z, layer);
        if (startTile) {
          const rot = startTile.rotation;
          const stType = startTile.type;
          const stepX = (rot % 2 === 1) ? 1 : 0;
          const stepZ = (rot % 2 === 1) ? 0 : 1;
          let curX = startTile.x, curZ = startTile.z;
          while (true) {
            const t = this.getTile(curX, curZ, layer);
            if (t && t.type === stType && (t.rotation % 2 === rot % 2)) {
              tilesToDemolish.push(t);
              curX += stepX;
              curZ += stepZ;
            } else break;
          }
        } else {
          tilesToDemolish.push(tile);
        }
      }

      for (const st of tilesToDemolish) {
        const prevType = st.type;
        const rot = st.rotation;
        const sx = st.x;
        const sz = st.z;
        const stLayer = (st.layer ?? layer) as GridLayer;
        this.stationManager.removeTileFromPlatform(sx, sz, stLayer);

        // 駅舎・ホーム・コンテナ等は線路に付随するオプションパーツとして扱うため、
        // 駅撤去時は線路を残して元の直線線路（地上線路または高架線路）に復元する
        const isElevated = prevType.includes('elevated') || stLayer >= 2;
        const restoreTrackType: TileType = isElevated ? 'rail_elevated' : 'rail_ground';

        // 駅固有のプロパティをクリアしてから setTile で正規の直線線路（InstancedMesh対応）として再構築
        st.stationPassengers = 0;
        st.stationGroupId = undefined;
        st.stationPlatformId = undefined;
        st.stationPart = undefined;
        st.stationPlatformSide = undefined;
        st.stationSchedule = undefined;
        st.stationName = undefined;
        st.cargoContainers = undefined;
        st.isCargoYard = undefined;

        this.setTile(sx, sz, restoreTrackType, rot, 1, 'right', stLayer);

        if (prevType.startsWith('station')) {
          this.updateNeighborStations(sx, sz, rot, prevType, stLayer);
        }
      }
      return true;
    }

    // シーサスクロッシングの独立化処理
    if (tile.groupOrigin) {
      const origin = this.getTile(tile.groupOrigin.x, tile.groupOrigin.z, layer);
      if (origin && origin.crossingRole === 0) {
        const along = origin.rotation === 1 ? 1 : 2;
        const across = WorldMap.rotateCW(along);
        const alongVec = WorldMap.DIRS[along];
        const acrossVec = WorldMap.DIRS[across];
        const isElevated = origin.type.includes('elevated');
        const normalRailType: TileType = isElevated ? 'rail_elevated' : 'rail_ground';
        const mainAxisRot = origin.rotation === 1 ? 1 : 0;

        const group = [
          { x: origin.x, z: origin.z },
          { x: origin.x + alongVec.x, z: origin.z + alongVec.z },
          { x: origin.x + acrossVec.x, z: origin.z + acrossVec.z },
          { x: origin.x + alongVec.x + acrossVec.x, z: origin.z + alongVec.z + acrossVec.z }
        ];
        for (const p of group) {
          if (p.x === x && p.z === z) continue;
          const t = this.getTile(p.x, p.z, layer);
          if (t && t.type.startsWith('scissors_crossing')) {
            // 残ったマスを主線の向きに沿った通常の直線レールに安全に退行させる
            this.setTile(p.x, p.z, normalRailType, mainAxisRot, 1, 'right', layer);
          }
        }
      }
    }

    // 勾配線路（地上・地下ともに4マス構成）の一括撤去
    if (tile.type === 'rail_slope' || tile.type === 'rail_slope_underground') {
      const rot = tile.rotation;
      const rev = !!tile.slopeReversed;
      const part = tile.slopePart ?? 0;
      const axis: [number, number] = rot === 1 ? [1, 3] : [0, 2];
      const [, stepIdx] = rev ? [axis[1], axis[0]] : [axis[0], axis[1]];
      const stepDir = WorldMap.DIRS[stepIdx];
      // part 0 の起点マス座標を算出
      const originX = tile.x - stepDir.x * part;
      const originZ = tile.z - stepDir.z * part;
      const baseLayer = (tile.layer ?? 1) as GridLayer;

      for (let i = 0; i < SLOPE_PARTS; i++) {
        const sx = originX + stepDir.x * i;
        const sz = originZ + stepDir.z * i;
        const st = this.getTile(sx, sz, baseLayer);
        if (st && st.type === tile.type) {
          this.resetTileData(st);
        }
      }
      return true;
    }

    this.resetTileData(tile);
    return true;
  }

  /**
   * 指定座標のタイルのスナップショットを生成する
   */
  public createTileSnapshot(x: number, z: number, layer: GridLayer = this.activeLayer): TileDataSnapshot | null {
    const tile = this.getTile(x, z, layer);
    return cloneTileSnapshot(tile);
  }

  /**
   * 撤去時に影響を受けるすべてのタイル一覧（駅ホーム全体、シーサス4マス、勾配4マス等）を取得する
   */
  public getDemolitionAffectedTiles(x: number, z: number, layer: GridLayer = this.activeLayer): TileData[] {
    const tile = this.getTile(x, z, layer);
    if (!tile || tile.type === 'empty') return [];

    // 1. 駅・信号場・貨物駅（同一グループ全体）
    if (tile.type.includes('station') || tile.type === 'signal_yard') {
      const tiles: TileData[] = [];
      if (tile.stationPlatformId) {
        // ★修正: 駅全体(stationGroupId)ではなく、クリックした番線(stationPlatformId)のみを撤去対象にする
        const targetPlatId = tile.stationPlatformId;
        this.getAllTiles().forEach(t => {
          if (t.stationPlatformId === targetPlatId) {
            tiles.push(t);
          }
        });
      } else if (tile.stationGroupId) {
        // stationPlatformId が未設定の場合でも、同一線路上の連続タイルのみを取得
        tiles.push(...this.getStationTiles(x, z, layer));
      } else {
        const startTile = this.getStationStartTile(x, z, layer);
        if (startTile) {
          const rot = startTile.rotation;
          const stType = startTile.type;
          const stepX = (rot % 2 === 1) ? 1 : 0;
          const stepZ = (rot % 2 === 1) ? 0 : 1;
          let curX = startTile.x, curZ = startTile.z;
          while (true) {
            const t = this.getTile(curX, curZ, layer);
            if (t && t.type === stType && (t.rotation % 2 === rot % 2)) {
              tiles.push(t);
              curX += stepX;
              curZ += stepZ;
            } else break;
          }
        } else {
          tiles.push(tile);
        }
      }
      return tiles.length > 0 ? tiles : [tile];
    }

    // 2. シーサスクロッシング（2×2グループの4マス）
    if (tile.groupOrigin) {
      const origin = this.getTile(tile.groupOrigin.x, tile.groupOrigin.z, layer);
      if (origin && origin.crossingRole === 0) {
        const along = origin.rotation === 1 ? 1 : 2;
        const across = WorldMap.rotateCW(along);
        const alongVec = WorldMap.DIRS[along];
        const acrossVec = WorldMap.DIRS[across];
        const coords = [
          { x: origin.x, z: origin.z },
          { x: origin.x + alongVec.x, z: origin.z + alongVec.z },
          { x: origin.x + acrossVec.x, z: origin.z + acrossVec.z },
          { x: origin.x + alongVec.x + acrossVec.x, z: origin.z + alongVec.z + acrossVec.z }
        ];
        const tiles: TileData[] = [];
        for (const c of coords) {
          const t = this.getTile(c.x, c.z, layer);
          if (t) tiles.push(t);
        }
        return tiles.length > 0 ? tiles : [tile];
      }
    }

    // 3. 勾配線路（4マス）
    if (tile.type === 'rail_slope' || tile.type === 'rail_slope_underground') {
      const rot = tile.rotation;
      const rev = !!tile.slopeReversed;
      const part = tile.slopePart ?? 0;
      const axis: [number, number] = rot === 1 ? [1, 3] : [0, 2];
      const [, stepIdx] = rev ? [axis[1], axis[0]] : [axis[0], axis[1]];
      const stepDir = WorldMap.DIRS[stepIdx];
      const originX = tile.x - stepDir.x * part;
      const originZ = tile.z - stepDir.z * part;
      const baseLayer = (tile.layer ?? 1) as GridLayer;
      const tiles: TileData[] = [];
      for (let i = 0; i < SLOPE_PARTS; i++) {
        const sx = originX + stepDir.x * i;
        const sz = originZ + stepDir.z * i;
        const st = this.getTile(sx, sz, baseLayer);
        if (st && st.type === tile.type) {
          tiles.push(st);
        }
      }
      return tiles.length > 0 ? tiles : [tile];
    }

    // 4. 通常タイル（1マス）
    return [tile];
  }

  /**
   * スナップショットからタイルを完全復元する
   */
  public restoreTileFromSnapshot(snap: TileDataSnapshot | null, x: number, z: number, layer: GridLayer = this.activeLayer): void {
    if (!snap || snap.type === 'empty') {
      this.setTile(x, z, 'empty', 0, 1, 'right', layer);
      return;
    }

    const lyr = snap.layer ?? layer;
    const isElevated = snap.type.includes('elevated') || lyr >= 2;

    if (snap.type.startsWith('point_switch')) {
      this.placeSwitch(snap.x, snap.z, snap.rotation, isElevated, snap.switchBranchSide || 'right', lyr);
      if (snap.switchState === 'diverge') {
        this.togglePointSwitch(snap.x, snap.z, lyr);
      }
      const swTile = this.getTile(snap.x, snap.z, lyr);
      if (swTile && snap.switchSchedule) {
        swTile.switchSchedule = cloneSwitchSchedule(snap.switchSchedule);
      }
    } else if (snap.type.startsWith('scissors_crossing')) {
      if (snap.crossingRole === 0 && snap.groupOrigin && snap.groupOrigin.x === snap.x && snap.groupOrigin.z === snap.z) {
        this.placeScissorsCrossing(snap.x, snap.z, snap.rotation, isElevated, lyr);
        if (snap.switchSchedule) {
          const crTile = this.getTile(snap.x, snap.z, lyr);
          if (crTile) crTile.switchSchedule = cloneSwitchSchedule(snap.switchSchedule);
        }
        if (snap.crossingState) {
          this.setCrossingState(snap.x, snap.z, snap.crossingState, lyr, true); // ★第5引数 true
        }
      } else if (!snap.groupOrigin) {
        this.setTile(snap.x, snap.z, snap.type, snap.rotation, snap.level, 'right', lyr);
      }
    } else if (snap.type.startsWith('rail_curve') && snap.curveDir !== undefined) {
      this.placeCurve(snap.x, snap.z, snap.curveDir, isElevated, lyr);
    } else if (snap.type === 'rail_slope') {
      const tile = this.getOrCreateTile(snap.x, snap.z, lyr);
      if (tile) {
        this.applySlopeTile(tile, snap.rotation, !!snap.slopeReversed, snap.slopePart || 0, lyr, snap.elevationOffset);
        if ((snap.slopePart || 0) === 3) {
          const upperLayer: GridLayer = lyr === 1 ? 2 : ((lyr + 1) as GridLayer);
          this.grid3D.set(snap.x, upperLayer, snap.z, tile);
        }
      }
    } else if (snap.type === 'rail_slope_underground') {
      const tile = this.getOrCreateTile(snap.x, snap.z, lyr);
      if (tile) {
        this.applyUndergroundSlopeTile(tile, snap.rotation, !!snap.slopeReversed, snap.slopePart || 0, lyr);
        if ((snap.slopePart || 0) === 3) {
          this.grid3D.set(snap.x, -1, snap.z, tile);
        }
        if ((snap.slopePart || 0) === 0 || (snap.slopePart || 0) === 1) {
          this.groundHoleHandler?.add(snap.x, snap.z, snap.rotation);
        }
      }
    } else if (snap.type === 'level_crossing') {
      this.applyLevelCrossing(snap.x, snap.z, snap.rotation, snap.crossingRoadAxis ?? (1 - snap.rotation), snap.level, lyr);
    } else if (snap.type.includes('station') || snap.type === 'signal_yard') {
      this.setTile(snap.x, snap.z, snap.type, snap.rotation, snap.level, snap.stationPlatformSide || 'right', lyr);
      const restored = this.getTile(snap.x, snap.z, lyr);
      if (restored) {
        if (snap.stationName) restored.stationName = snap.stationName;
        if (snap.stationGroupId) restored.stationGroupId = snap.stationGroupId;
        if (snap.stationPlatformId) restored.stationPlatformId = snap.stationPlatformId;
        if (snap.stationPart) restored.stationPart = snap.stationPart;
        if (snap.stationPlatformSide) restored.stationPlatformSide = snap.stationPlatformSide;
        if (snap.stationSchedule) restored.stationSchedule = cloneStationSchedule(snap.stationSchedule);
        if (snap.stationPassengers !== undefined) restored.stationPassengers = snap.stationPassengers;
        if (snap.isCargoYard !== undefined) restored.isCargoYard = snap.isCargoYard;
        if (snap.cargoContainers !== undefined) restored.cargoContainers = snap.cargoContainers;
        if (restored.mesh && snap.stationName) {
          ModelFactory.updateStationSign(restored.mesh, snap.stationName);
        }
      }
    } else {
      this.setTile(snap.x, snap.z, snap.type, snap.rotation, snap.level, 'right', lyr);
    }

    this.updateUpperElevatedPiers(snap.x, snap.z, lyr);
    this.markDirty();
  }

  public clearAll() {
    // 全階層のタイルメッシュを破棄
    const all = this.getAllTiles();
    for (const tile of all) {
      this.resetTileData(tile);
      tile.landValue = 100;
    }
    this.instancedMeshManager.clearAll();
    this.renderBuckets.clear(); // 空になったチャンク×階層バケットも破棄
    this.groundHoleHandler?.clear();
    this.stationManager.clear();
    this.tiles.clear();
    this.grid3D.clear();
    this.initializeGrid();
  }

  public dispose() {
    this.clearAll();
    this.instancedMeshManager.dispose();
  }

  /**
   * 日次（日付変更時）の全駅・ホーム・タイルの本日乗降客数カウンタをリセット
   */
  public resetDailyStationPassengers(): void {
    this.stationManager.resetDailyPassengers();
  }

  public serialize(): string {
    if (!this.isDirty && this.cachedSerializedData !== null) {
      return this.cachedSerializedData;
    }

    const nonEmpties: any[] = [];
    const allTiles = this.getAllTiles();
    allTiles.forEach(t => {
      // ③ シーサスクロッシングの非起点マス(B/C/D)は起点(A)から復元可能なため保存対象から除外
      if (t.groupOrigin && t.crossingRole !== 0) return;
      if (t.type !== 'empty') {
        nonEmpties.push({
          x: t.x,
          z: t.z,
          layer: t.layer ?? 1,
          type: t.type,
          rot: t.rotation,
          lvl: t.level,
          curveDir: t.curveDir,
          sw: t.switchState,
          branchSide: t.switchBranchSide,
          slopeRev: t.slopeReversed,
          slopePart: t.slopePart,
          crossState: t.crossingState,
          roadAxis: t.crossingRoadAxis,
          cargoYard: t.isCargoYard,
          cargoContainers: t.cargoContainers,
          stationName: t.stationName,
          stationGroupId: t.stationGroupId,
          stationPlatformId: t.stationPlatformId,
          stationPart: t.stationPart,
          stationPlatformSide: t.stationPlatformSide,
          stationSchedule: t.stationSchedule,
          switchSchedule: t.switchSchedule,
          externalCityId: t.externalCityId,
          isExternalConnection: t.isExternalConnection,
          stationPassengers: t.stationPassengers,
          elevationOffset: t.elevationOffset
        });
      }
    });

    // 【駅の記憶喪失解消】v2 フォーマット: タイル一覧に加えて stationManager の全状態をシリアライズ
    const serialized = JSON.stringify({
      version: 2,
      tiles: nonEmpties,
      stations: this.stationManager.serialize()
    });

    this.cachedSerializedData = serialized;
    this.isDirty = false;
    return serialized;
  }

  public deserialize(jsonOrData: string | { tiles: any[]; stations?: any } | any[]) {
    try {
      let data: any[];
      let stationData: StationSaveData | null = null;

      if (typeof jsonOrData === 'string') {
        const parsed = JSON.parse(jsonOrData);
        if (Array.isArray(parsed)) {
          data = parsed;
        } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tiles)) {
          data = parsed.tiles;
          stationData = parsed.stations ?? null;
        } else {
          return;
        }
      } else if (Array.isArray(jsonOrData)) {
        data = jsonOrData;
      } else if (jsonOrData && typeof jsonOrData === 'object' && Array.isArray(jsonOrData.tiles)) {
        data = jsonOrData.tiles;
        stationData = jsonOrData.stations ?? null;
      } else {
        return;
      }

      this.clearAll();

      for (const item of data) {
        const lyr: GridLayer = (item.layer ?? 1) as GridLayer;
        const isElevated = item.type.includes('elevated') || lyr >= 2;
        const rot = item.rotation ?? item.rot ?? 0;
        const lvl = item.level ?? item.lvl ?? 1;
        const slopeRev = !!(item.slopeReversed ?? item.slopeRev);

        if (item.type.startsWith('point_switch')) {
          const branchSide = item.switchBranchSide ?? item.branchSide ?? 'right';
          const swState = item.switchState ?? item.sw ?? 'straight';
          this.placeSwitch(item.x, item.z, rot, isElevated, branchSide, lyr);
          if (swState === 'diverge') {
            this.togglePointSwitch(item.x, item.z, lyr);
          }
          const schedule = item.switchSchedule;
          if (schedule) {
            const swTile = this.getTile(item.x, item.z, lyr);
            if (swTile) swTile.switchSchedule = schedule;
          }
        } else if (item.type.startsWith('scissors_crossing')) {
          this.placeScissorsCrossing(item.x, item.z, rot, isElevated, lyr);
          const schedule = item.switchSchedule;
          if (schedule) {
            const crTile = this.getTile(item.x, item.z, lyr);
            if (crTile) crTile.switchSchedule = schedule;
          }
          const target: CrossingState = item.crossingState ?? item.crossState ?? 'straight';
          this.setCrossingState(item.x, item.z, target, lyr, true); // ★第5引数 true
        } else if (item.type.startsWith('rail_curve')) {
          const curveDir = item.curveDir ?? 'N_E';
          this.placeCurve(item.x, item.z, curveDir, isElevated, lyr);
        } else if (item.type === 'rail_slope') {
          const tile = this.getOrCreateTile(item.x, item.z, lyr);
          if (tile) {
            this.applySlopeTile(tile, rot, slopeRev, item.slopePart || 0, lyr, item.elevationOffset);
            // 【バグ修正】スロープ最上段(part 3)の場合、接続先の上の階層にもタイルを登録して断線を防ぐ
            if ((item.slopePart || 0) === 3) {
              const upperLayer: GridLayer = lyr === 1 ? 2 : ((lyr + 1) as GridLayer);
              this.grid3D.set(item.x, upperLayer, item.z, tile);
            }
          }
        } else if (item.type === 'rail_slope_underground') {
          const tile = this.getOrCreateTile(item.x, item.z, lyr);
          if (tile) {
            this.applyUndergroundSlopeTile(tile, rot, slopeRev, item.slopePart || 0, lyr);
            // 【バグ修正】地下スロープ最下段(part 3)の場合、地下1F(layer -1)にもタイルを登録
            if ((item.slopePart || 0) === 3) {
              this.grid3D.set(item.x, -1, item.z, tile);
            }
            if ((item.slopePart || 0) === 0 || (item.slopePart || 0) === 1) {
              this.groundHoleHandler?.add(item.x, item.z, rot);
            }
          }
        } else if (item.type === 'level_crossing') {
          this.applyLevelCrossing(item.x, item.z, rot, item.crossingRoadAxis ?? item.roadAxis ?? (1 - rot), lvl, lyr);
        } else if (item.type.includes('station') || item.type === 'signal_yard') {
          this.setTile(item.x, item.z, item.type, rot, lvl, item.stationPlatformSide || 'right', lyr);
          const restored = this.getTile(item.x, item.z, lyr);
          if (restored) {
            if (item.stationName) restored.stationName = item.stationName;
            if (item.stationGroupId) restored.stationGroupId = item.stationGroupId;
            if (item.stationPlatformId) restored.stationPlatformId = item.stationPlatformId;
            if (item.stationPart) restored.stationPart = item.stationPart;
            if (item.stationPlatformSide) restored.stationPlatformSide = item.stationPlatformSide;
            if (item.stationSchedule) restored.stationSchedule = item.stationSchedule;
            if (item.stationPassengers !== undefined) restored.stationPassengers = item.stationPassengers;
            if (restored.mesh && item.stationName) {
              ModelFactory.updateStationSign(restored.mesh, item.stationName);
            }
          }
        } else {
          this.setTile(item.x, item.z, item.type, rot, lvl, 'right', lyr);
        }

        if (item.isCargoYard || item.cargoYard) {
          const restored = this.getTile(item.x, item.z, lyr);
          if (restored) restored.isCargoYard = true;
        }
        if (item.cargoContainers !== undefined) {
          const restored = this.getTile(item.x, item.z, lyr);
          if (restored) restored.cargoContainers = item.cargoContainers;
        }
        if (item.externalCityId || item.isExternalConnection || item.type === 'external_connection') {
          const restored = this.getTile(item.x, item.z, lyr);
          if (restored) {
            restored.externalCityId = item.externalCityId;
            restored.isExternalConnection = true;
            if (item.stationPassengers !== undefined) restored.stationPassengers = item.stationPassengers;
            if (restored.mesh && item.stationName) {
              ModelFactory.updateGatewaySign(restored.mesh, item.stationName, false);
            }
          }
        }
      }

      // 【駅の記憶喪失解消】駅マネージャーの復元
      if (stationData) {
        // v2 保存データから駅・番線構成・財務・乗降客数・固有ID・タイルマッピングを完全復元
        this.stationManager.deserialize(stationData);

        // 各タイルの stationName, stationGroupId, stationPlatformId および看板メッシュを正本から同期
        for (const st of this.stationManager.getStations()) {
          for (const plat of st.platforms) {
            for (const pt of plat.tiles) {
              const t = this.getTile(pt.x, pt.z, pt.layer);
              if (t) {
                t.stationName = st.name;
                t.stationGroupId = st.id;
                t.stationPlatformId = plat.id;
                if (t.mesh && !plat.isSignalYard) {
                  ModelFactory.updateStationSign(t.mesh, st.name);
                }
              }
            }
          }
        }
      } else {
        // 旧フォーマット保存データ用のフォールバック再構築処理
        const processedGroups = new Set<string>();
        for (const item of data) {
          const lyr = (item.layer ?? 1) as GridLayer;
          const t = this.getTile(item.x, item.z, lyr);
          if (!t || (!t.type.includes('station') && t.type !== 'signal_yard')) continue;
          const groupId = t.stationGroupId || `${t.x},${lyr},${t.z}`;
          if (processedGroups.has(groupId)) continue;
          processedGroups.add(groupId);

          // 同一グループの全タイルを収集
          const groupTiles = this.getAllTiles().filter(tile => {
            if (t.stationGroupId) {
              return tile.stationGroupId === groupId &&
                (tile.type.includes('station') || tile.type === 'signal_yard');
            } else {
              return tile.x === t.x && tile.z === t.z && (tile.layer ?? 1) === lyr &&
                (tile.type.includes('station') || tile.type === 'signal_yard');
            }
          });
          if (groupTiles.length === 0) continue;

          const first = groupTiles[0];
          const isSignalYard = first.type === 'signal_yard';
          const isCargo = first.type.startsWith('cargo_station') || !!first.isCargoYard;
          const trackAxis = first.rotation === 1 ? 1 : 0;
          const reg = this.stationManager.registerPlatform({
            tiles: groupTiles.map(gt => ({ x: gt.x, z: gt.z, layer: (gt.layer ?? 1) as GridLayer })),
            length: groupTiles.length,
            trackAxis,
            isSignalYard,
            isCargoStation: isCargo,
            customName: first.stationName
          });
          for (const gt of groupTiles) {
            gt.stationGroupId = reg.station.id;
            gt.stationPlatformId = reg.platform.id;
          }
        }
      }
    } catch (e) {
      console.error('Failed to load save data', e);
    }
  }
}
