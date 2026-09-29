import * as THREE from 'three';
import { ModelFactory } from '../models/ModelFactory';
import { GridLayer } from '../core/types';
import { Grid3D, layerToHeight } from '../core/Grid3D';
import { StationManager, StationSaveData } from '../core/StationManager';
import { disposeHierarchy } from '../graphics/materials';
import { InstancedMeshManager } from '../graphics/InstancedMeshManager';

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
  | 'nature';

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

  // ⑤ 駅の詳細情報・収支・有効長設定
  stationName?: string;
  dailyPassengers?: number;
  previousDayPassengers?: number;
  twoDaysAgoPassengers?: number;
  dailyLoadedCargo?: number;
  dailyUnloadedCargo?: number;
  previousDayLoadedCargo?: number;
  previousDayUnloadedCargo?: number;
  totalPassengers?: number;
  totalRevenue?: number;
  stationMaintenance?: number;
  stationNetProfit?: number;
  stationTargetLength?: number;
  passengerAccumulator?: number;

  // ⑤ 駅グループ識別子（複数マス駅を単一駅として扱う）
  stationGroupId?: string;
  stationPart?: 'single' | 'start' | 'mid' | 'end';

  // ① 駅ダイヤ設定（24時間タイムラインバー方式: 停車、待避、通過、折り返し）
  stationSchedule?: StationSchedule;

  // ① 分岐器ダイヤ設定（24時間タイムラインバー方式: 直進、分岐、交互切替）
  switchSchedule?: SwitchSchedule;

  // ④ 貨物ヤード指定（駅・信号場タイルに付与し、貨物列車の積み降ろし拠点として扱う）
  isCargoYard?: boolean;
  // 貨物駅に蓄積されているコンテナ数（工業施設から毎日17:00に追加、列車積載で減少）
  cargoContainers?: number;
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
      case 'road':
      case 'level_crossing':
        return tile.rotation === 1
          ? [{ idx: 1, level, worldHeight: defaultWorldHeight }, { idx: 3, level, worldHeight: defaultWorldHeight }]
          : [{ idx: 0, level, worldHeight: defaultWorldHeight }, { idx: 2, level, worldHeight: defaultWorldHeight }];

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
        const lowWorldHeight = elevOffset + part * 0.75;
        const highWorldHeight = elevOffset + (part + 1) * 0.75;

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
  private scene: THREE.Scene;
  public instancedMeshManager: InstancedMeshManager;
  private elevationProvider: ((x: number, z: number) => number) | null = null;
  public gridManagerRef: { isWaterAtGroundLevel: (x: number, z: number) => boolean; getCell: (x: number, y: GridLayer, z: number) => any } | null = null;
  public groundHoleHandler: {
    add: (x: number, z: number, rotation: number) => void;
    remove: (x: number, z: number) => void;
    clear: () => void;
  } | null = null;

  constructor(scene: THREE.Scene, gridSize: number = 64) {
    this.scene = scene;
    this.instancedMeshManager = new InstancedMeshManager(scene);
    this.gridSize = gridSize;
    WorldMap.GRID_SIZE = gridSize;
    this.initializeGrid();
  }

  public setGridSize(size: number): void {
    this.gridSize = size;
    WorldMap.GRID_SIZE = size;
    this.clearAll();
    this.tiles.clear();
    this.grid3D.clear();
    this.initializeGrid();
  }

  public setActiveLayer(layer: GridLayer): void {
    this.activeLayer = layer;
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

  private initializeGrid() {
    const half = Math.floor(this.gridSize / 2);
    for (let x = -half; x < half; x++) {
      for (let z = -half; z < half; z++) {
        const defaultTile: TileData = {
          x,
          z,
          layer: 1,
          type: 'empty',
          rotation: 0,
          level: 1,
          stationPassengers: 0,
          landValue: 100,
          switchState: 'straight'
        };
        this.tiles.set(this.getKey(x, z), defaultTile);
        this.grid3D.set(x, 1, z, defaultTile);
      }
    }
  }

  /**
   * 指定座標がマップの境界内にあるかを判定する
   */
  public isInBounds(x: number, z: number): boolean {
    const half = Math.floor(this.gridSize / 2);
    return x >= -half && x < half && z >= -half && z < half;
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
    for (const tile of this.grid3D.values()) {
      if (tile.type !== 'empty') {
        if (filterLayer === undefined || tile.layer === filterLayer) {
          result.push(tile);
        }
      }
    }
    // 互換性のため地上1Fのタイルもマージ
    if (filterLayer === undefined || filterLayer === 1) {
      for (const tile of this.tiles.values()) {
        if (tile.type !== 'empty' && !result.some(t => t.x === tile.x && t.z === tile.z && (t.layer ?? 1) === 1)) {
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

    const tileType: TileType = isElevated ? 'rail_curve_elevated' : 'rail_curve_ground';

    this.removeTileMesh(tile);

    tile.type = tileType;
    tile.layer = layer;
    tile.curveDir = curveDir;
    tile.rotation = 0;
    const baseH = layerToHeight(layer);
    const elevY = this.getTrackElevationOffset(x, z, layer);
    tile.elevationOffset = elevY;

    const isTunnel = this.isTunnelSection(x, z, layer);
    const mesh = ModelFactory.createCurveTrackSegment(curveDir, isElevated, baseH, isTunnel);
    mesh.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
    mesh.visible = (layer === this.activeLayer);
    this.scene.add(mesh);
    tile.mesh = mesh;

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

    // 起点マスの標高オフセットをスロープ全体のベース高さ基準とする
    const originElevOffset = this.getElevationOffset(originX, originZ);
    const upperLayer: GridLayer = (layer + 1) as GridLayer;

    positions.forEach((p, i) => {
      const tile = this.getOrCreateTile(p.x, p.z, layer)!;
      this.applySlopeTile(tile, rotation, reversed, i, layer, originElevOffset);
      // 上位階層接続端（part 3）を上位レイヤーのGrid3Dにも登録
      if (i === SLOPE_PARTS - 1) {
        this.grid3D.set(p.x, upperLayer, p.z, tile);
      }
    });

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
    mesh.visible = (layer === this.activeLayer || upperLayer === this.activeLayer);
    this.scene.add(mesh);
    tile.mesh = mesh;
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
    this.scene.add(mesh);
    tile.mesh = mesh;
  }

  /**
   * ② 分岐器（ポイント）の敷設。曲線レールと同じ1マスで完結する
   * （進入側＋直進側＋分岐側の曲線レールを1タイル内に収める）。
   * rotation: 0-3 = 通過方向（進入→直進方向）のインデックス（0=北,1=東,2=南,3=西）。
   * branchSide: 'right'(右分岐) または 'left'(左分岐)。
   */
  public placeSwitch(x: number, z: number, rotation: number, isElevated: boolean = false, branchSide: 'left' | 'right' = 'right', layer: GridLayer = this.activeLayer): boolean {
    const tile = this.getOrCreateTile(x, z, layer);
    if (!tile) return false;

    const forward = ((rotation % 4) + 4) % 4;
    const switchType: TileType = isElevated ? 'point_switch_elevated' : 'point_switch_ground';

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
    const mesh = ModelFactory.createSwitchHub(forward, false, isElevated, branchSide, baseH, isTunnel);
    mesh.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
    mesh.visible = (layer === this.activeLayer);
    this.scene.add(mesh);
    tile.mesh = mesh;

    return true;
  }

  /**
   * ③ シーサスクロッシング（複線用の交差分岐）の敷設。2×2マスを使用する。
   * origin=A（左上/北西または北東側の角）。rotation: 0=南北方向に並走(横に2本), 1=東西方向に並走(縦に2本)。
   * A-B が1本目の線路、C-D が2本目の線路（Aから見て右手側=acrossDir に1マスずれた位置）。
   */
  public placeScissorsCrossing(originX: number, originZ: number, rotation: number, isElevated: boolean = false, layer: GridLayer = this.activeLayer): boolean {
    const along = rotation === 1 ? 1 : 2;
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
      if (this.isPermanentTrackOrStation(p.x, p.z, layer)) return false;
      const waterCheck = this.canPlaceAtWater(p.x, p.z, layer);
      if (!waterCheck.allowed) return false;
    }

    const crossingType: TileType = isElevated ? 'scissors_crossing_elevated' : 'scissors_crossing_ground';

    positions.forEach((p, role) => {
      const t = this.getOrCreateTile(p.x, p.z, layer)!;
      this.removeTileMesh(t);
      t.type = crossingType;
      t.layer = layer;
      t.rotation = rotation === 1 ? 1 : 0;
      t.curveDir = undefined;
      t.slopeReversed = undefined;
      t.switchState = 'straight';
      t.groupOrigin = { x: originX, z: originZ };
      t.crossingRole = role as 0 | 1 | 2 | 3;
      const baseH = layerToHeight(layer);
      const elevY = this.getTrackElevationOffset(p.x, p.z, layer);
      t.elevationOffset = elevY;

      const isTunnel = this.isTunnelSection(p.x, p.z, layer);
      const mesh = ModelFactory.createScissorsCrossingTile(along, role as 0 | 1 | 2 | 3, isElevated, 'straight', baseH, isTunnel);
      mesh.position.set(p.x * WorldMap.TILE_SIZE, baseH + elevY, p.z * WorldMap.TILE_SIZE);
      mesh.visible = (layer === this.activeLayer);
      this.scene.add(mesh);
      t.mesh = mesh;
      t.switchSchedule = t.switchSchedule || createDefaultSwitchSchedule();
    });

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
    const success = this.setCrossingState(x, z, nextState, checkLayer);
    return success ? nextState : null;
  }

  /**
   * シーサスクロッシングの開通状態を指定の状態（'straight' | 'cross-a' | 'cross-b'）に設定する
   */
  public setCrossingState(x: number, z: number, targetState: CrossingState, layer?: GridLayer): boolean {
    const checkLayer = (layer ?? this.activeLayer) as GridLayer;
    const clicked = this.getTile(x, z, checkLayer);
    if (!clicked || !clicked.groupOrigin) return false;
    const origin = this.getTile(clicked.groupOrigin.x, clicked.groupOrigin.z, (clicked.layer ?? checkLayer) as GridLayer);
    if (!origin || origin.crossingRole !== 0) return false;

    // 既に同一状態なら再生成をスキップ
    if (origin.crossingState === targetState) return true;

    const along = origin.rotation === 1 ? 1 : 2;
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
      this.removeTileMesh(t);
      const tileLayer = (t.layer ?? checkLayer) as GridLayer;
      const baseH = layerToHeight(tileLayer);
      const elevY = this.getTrackElevationOffset(p.x, p.z, tileLayer);
      t.elevationOffset = elevY;
      const isTunnel = this.isTunnelSection(p.x, p.z, tileLayer);
      const mesh = ModelFactory.createScissorsCrossingTile(along, role as 0 | 1 | 2 | 3, isElevated, targetState, baseH, isTunnel);
      mesh.position.set(p.x * WorldMap.TILE_SIZE, baseH + elevY, p.z * WorldMap.TILE_SIZE);
      mesh.visible = (tileLayer === this.activeLayer);
      this.scene.add(mesh);
      t.mesh = mesh;
    });

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
    mesh.visible = (tileLayer === this.activeLayer);
    this.scene.add(mesh);
    tile.mesh = mesh;

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
      tile.type === 'level_crossing'
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
   * 駅・信号場・貨物駅のいずれかであるかを判定
   */
  public static isStationTileType(type: string): boolean {
    return type.startsWith('station') || type.startsWith('cargo_station') || type === 'signal_yard';
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
    this.scene.add(mesh);
    tile.mesh = mesh;
    return true;
  }

  /**
   * Set single tile
   */
  public setTile(x: number, z: number, type: TileType, rotation: number = 0, level: number = 1, platformSide: 'left' | 'right' = 'right', layer: GridLayer = this.activeLayer): boolean {
    const tile = this.getOrCreateTile(x, z, layer);
    if (!tile) return false;

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
      tile.stationPart = undefined;
      tile.stationPlatformSide = undefined;
      tile.stationTargetLength = undefined;
      tile.isCargoYard = undefined;
    }


    // ⑧ 複数マス駅ホームの自動パーツ判定 (single / start / mid / end)
    let stationPart: 'single' | 'start' | 'mid' | 'end' = 'single';
    if (WorldMap.isStationTileType(type)) {
      tile.stationPlatformSide = platformSide;
      tile.stationSchedule = tile.stationSchedule || (type.startsWith('cargo_station') ? createDefaultCargoStationSchedule() : createDefaultStationSchedule());
      tile.stationTargetLength = tile.stationTargetLength || 1;
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

    const elevY = (type === 'rail_ground')
      ? this.getTrackElevationOffset(x, z, layer)
      : ((layer === 1) ? this.getElevationOffset(x, z) : 0);
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
        case 'level_crossing':
          mesh = ModelFactory.createLevelCrossing(tile.rotation);
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
        default:
          mesh = undefined;
          break;
      }

      if (mesh) {
        mesh.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
        mesh.visible = (layer === this.activeLayer);
        this.scene.add(mesh);
        tile.mesh = mesh;
      }
    }

    // Update neighboring stations if this is a station
    if (WorldMap.isStationTileType(type)) {
      if (!tile.stationName) {
        tile.stationName = type.startsWith('cargo_station')
          ? `第${this.getStationCount() + 1}貨物駅`
          : (type === 'signal_yard' ? `第${this.getStationCount() + 1}信号場` : `第${this.getStationCount() + 1}駅`);
      }
      tile.dailyPassengers = tile.dailyPassengers ?? 0;
      tile.totalPassengers = tile.totalPassengers ?? 0;
      tile.totalRevenue = tile.totalRevenue ?? 0;
      tile.stationMaintenance = type.startsWith('cargo_station') ? 25000 : (type === 'signal_yard' ? 10000 : 50000);
      tile.stationNetProfit = (tile.totalRevenue ?? 0) - (tile.stationMaintenance ?? 0);
      tile.stationTargetLength = this.getStationRunLength(x, z);

      if (type.startsWith('station')) {
        this.updateNeighborStations(x, z, tile.rotation, type);
      }
    }

    // トンネル敷設時、隣接するトンネルタイルの坑口ポータル開閉を更新
    if (type === 'rail_ground' && isTunnel) {
      const isEW = (rotation === 1);
      const dirA = isEW ? { x: -1, z: 0 } : { x: 0, z: -1 };
      const dirB = isEW ? { x: 1, z: 0 } : { x: 0, z: 1 };
      this.updateTunnelTilePortal(x + dirA.x, z + dirA.z, layer);
      this.updateTunnelTilePortal(x + dirB.x, z + dirB.z, layer);
    }

    // 直上階層の高架線路の橋脚を着地状況に合わせて更新
    this.updateUpperElevatedPiers(x, z, layer);

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
      this.scene.remove(tile.mesh);
      disposeHierarchy(tile.mesh);
    }
    const baseH = layerToHeight(layer);
    const elevY = this.getTrackElevationOffset(x, z, layer);
    const newMesh = ModelFactory.createTunnelTrack(tile.rotation, portalEnds);
    newMesh.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
    newMesh.visible = (layer === this.activeLayer);
    this.scene.add(newMesh);
    tile.mesh = newMesh;
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

    const rot = tile.rotation;
    const stepX = rot === 1 ? 1 : 0;
    const stepZ = rot === 1 ? 0 : 1;
    const targetLayer = (tile.layer ?? layer) as GridLayer;

    const isSameStation = (t: TileData | undefined): boolean => {
      if (!t) return false;
      if (((t.layer ?? layer) as GridLayer) !== targetLayer) return false;
      if (!WorldMap.isStationTileType(t.type)) return false;
      if (tile.stationGroupId) {
        return t.stationGroupId === tile.stationGroupId;
      }
      return t.type === tile.type && t.rotation === rot;
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

  public getStationCount(): number {
    return Array.from(this.tiles.values()).filter(t => WorldMap.isStationTileType(t.type)).length;
  }

  /**
   * ④ 駅グループの先頭タイル（最小座標側のタイル）を取得
   */
  public getStationStartTile(x: number, z: number, layer: GridLayer = this.activeLayer): TileData | null {
    const tile = this.getTile(x, z, layer);
    if (!tile || !WorldMap.isStationTileType(tile.type)) return null;

    const rot = tile.rotation;
    const stepX = rot === 1 ? 1 : 0;
    const stepZ = rot === 1 ? 0 : 1;
    const targetLayer = (tile.layer ?? layer) as GridLayer;

    const isSameStation = (t: TileData | undefined): boolean => {
      if (!t) return false;
      if (((t.layer ?? layer) as GridLayer) !== targetLayer) return false;
      if (!WorldMap.isStationTileType(t.type)) return false;
      if (tile.stationGroupId) {
        return t.stationGroupId === tile.stationGroupId;
      }
      return t.type === tile.type && t.rotation === rot;
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
    const startTile = this.getStationStartTile(x, z, layer);
    if (!startTile) return [];

    const rot = startTile.rotation;
    const stepX = rot === 1 ? 1 : 0;
    const stepZ = rot === 1 ? 0 : 1;
    const targetLayer = (startTile.layer ?? layer) as GridLayer;

    const isSameStation = (t: TileData | undefined): boolean => {
      if (!t) return false;
      if (((t.layer ?? layer) as GridLayer) !== targetLayer) return false;
      if (!WorldMap.isStationTileType(t.type)) return false;
      if (startTile.stationGroupId) {
        return t.stationGroupId === startTile.stationGroupId;
      }
      return t.type === startTile.type && t.rotation === rot;
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

    const stepX = rot === 1 ? 1 : 0;
    const stepZ = rot === 1 ? 0 : 1;
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
      if (t && t.type === stationType && t.rotation === rot) {
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
        // 【列車安全ガード】延伸対象タイル上に列車が在線・通過中の場合は上書きを禁止
        if (isTileOccupied && isTileOccupied(nx, nz, stLayer)) {
          return false;
        }
        const targetTile = this.getTile(nx, nz, stLayer);
        // 更地または線路なら駅に置換可能（未配置マスも空き地と判定）
        if (targetTile && targetTile.type !== 'empty' && !targetTile.type.includes('rail')) {
          return false; // スペース不足
        }
      }
      for (let i = currentLen; i < targetLength; i++) {
        const nx = startTile.x + stepX * i;
        const nz = startTile.z + stepZ * i;
        this.setTile(nx, nz, stationType, rot, 1, startTile.stationPlatformSide ?? 'right', stLayer);
        const t = this.getTile(nx, nz, stLayer);
        if (t) {
          t.stationName = stationName;
          t.stationTargetLength = targetLength;
          t.stationSchedule = startTile.stationSchedule;
          t.stationGroupId = startTile.stationGroupId;
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
      const normalTrack: TileType = stationType.includes('elevated') ? 'rail_elevated' : 'rail_ground';
      for (let i = targetLength; i < currentLen; i++) {
        const nx = startTile.x + stepX * i;
        const nz = startTile.z + stepZ * i;
        this.setTile(nx, nz, normalTrack, rot, 1, 'right', stLayer);
        const t = this.getTile(nx, nz, stLayer);
        if (t) {
          t.stationGroupId = undefined;
          t.stationPart = undefined;
          t.stationPlatformSide = undefined;
          t.stationTargetLength = undefined;
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
        t.stationTargetLength = targetLength;
        t.stationSchedule = startTile.stationSchedule;
        t.stationGroupId = startTile.stationGroupId;
        if (isCargo) {
          t.isCargoYard = true;
        }
        const part = (targetLength === 1)
          ? 'single'
          : (i === 0 ? 'start' : (i === targetLength - 1 ? 'end' : 'mid'));

        this.removeTileMesh(t); // 古いメッシュの完全解放
        const isElevated = stationType.includes('elevated');
        const platformSide = startTile.stationPlatformSide ?? 'right';
        t.stationPlatformSide = platformSide;
        const tileLayer = (t.layer ?? this.activeLayer) as GridLayer;
        const baseH = layerToHeight(tileLayer);
        const elevY = (tileLayer === 1) ? this.getElevationOffset(nx, nz) : 0;
        t.elevationOffset = elevY;
        const mesh = isYard
          ? ModelFactory.createSignalYard(rot, isElevated, platformSide, baseH)
          : (isCargo
            ? ModelFactory.createCargoStation(rot, isElevated, platformSide, baseH)
            : ModelFactory.createStation(rot, isElevated, part, platformSide, t.stationName ?? '駅', baseH));
        mesh.position.set(nx * WorldMap.TILE_SIZE, baseH + elevY, nz * WorldMap.TILE_SIZE);
        mesh.visible = (tileLayer === this.activeLayer);
        this.scene.add(mesh);
        t.mesh = mesh;
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
    } else {
      // 未登録の場合はホームとして新規登録
      const isSignalYard = stationType === 'signal_yard';
      this.stationManager.registerPlatform({
        tiles: newTiles,
        length: targetLength,
        trackAxis: rot,
        isSignalYard,
        isCargoStation: isCargo,
        customName: stationName
      });
    }

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
    const startTile = this.getStationStartTile(x, z, layer);
    if (!startTile) return null;

    const rot = startTile.rotation;
    const stationType = startTile.type;
    const stepX = rot === 1 ? 1 : 0;
    const stepZ = rot === 1 ? 0 : 1;
    const stLayer = (startTile.layer ?? layer) as GridLayer;

    let length = 0;
    let daily = 0;
    let prevDaily = 0;
    let twoDaysDaily = 0;
    let totalPass = 0;
    let totalRev = 0;
    let loadedCargo = 0;
    let unloadedCargo = 0;
    let prevLoadedCargo = 0;
    let prevUnloadedCargo = 0;

    let curX = startTile.x, curZ = startTile.z;
    while (true) {
      const t = this.getTile(curX, curZ, stLayer);
      if (t && t.type === stationType && t.rotation === rot) {
        length++;
        daily += t.dailyPassengers ?? 0;
        prevDaily += t.previousDayPassengers ?? 0;
        twoDaysDaily += t.twoDaysAgoPassengers ?? 0;
        totalPass += t.totalPassengers ?? 0;
        totalRev += t.totalRevenue ?? 0;
        loadedCargo += t.dailyLoadedCargo ?? 0;
        unloadedCargo += t.dailyUnloadedCargo ?? 0;
        prevLoadedCargo += t.previousDayLoadedCargo ?? 0;
        prevUnloadedCargo += t.previousDayUnloadedCargo ?? 0;
        curX += stepX;
        curZ += stepZ;
      } else break;
    }

    const isYard = stationType === 'signal_yard';
    const isCargo = stationType.startsWith('cargo_station');
    // StationManager から番線情報を取得
    const platInfo = this.stationManager.getPlatformByTile(startTile.x, startTile.z, stLayer);
    const baseMaint = isYard ? 20000 : (isCargo ? 50000 : 200000); // 信号場は月¥20,000、貨物駅は月¥50,000、通常駅ホームは月¥200,000 (StationManagerと完全同期)
    const maintenance = platInfo ? platInfo.station.maintenance : (length * baseMaint);
    const netProfit = totalRev - maintenance;
    const defaultName = isYard
      ? `第1信号場`
      : (isCargo ? `貨物駅` : `駅 (${startTile.x}, ${startTile.z})`);
    const stationName = platInfo?.station.name || startTile.stationName || defaultName;

    return {
      id: platInfo?.station.id,
      name: stationName,
      platformNumber: platInfo?.platform.platformNumber ?? 1,
      platformCount: platInfo?.station.platforms.length ?? 1,
      length,
      dailyPassengers: (isYard || isCargo) ? 0 : (platInfo?.station.dailyPassengers ?? daily),
      previousDayPassengers: (isYard || isCargo) ? 0 : (platInfo?.station.previousDayPassengers ?? prevDaily),
      twoDaysAgoPassengers: (isYard || isCargo) ? 0 : (platInfo?.station.twoDaysAgoPassengers ?? twoDaysDaily),
      dailyLoadedCargo: isCargo ? (platInfo?.station.dailyLoadedCargo ?? loadedCargo) : 0,
      dailyUnloadedCargo: isCargo ? (platInfo?.station.dailyUnloadedCargo ?? unloadedCargo) : 0,
      previousDayLoadedCargo: isCargo ? (platInfo?.station.previousDayLoadedCargo ?? prevLoadedCargo) : 0,
      previousDayUnloadedCargo: isCargo ? (platInfo?.station.previousDayUnloadedCargo ?? prevUnloadedCargo) : 0,
      totalPassengers: (isYard || isCargo) ? 0 : totalPass,
      totalRevenue: totalRev,
      maintenance,
      netProfit,
      isSignalYard: isYard,
      isCargoYard: isCargo,
      cargoContainers: startTile.cargoContainers ?? 0
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
    const tiles = this.getStationTiles(startTile.x, startTile.z, layer);
    for (const t of tiles) {
      t.cargoContainers = val;
    }
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
        this.scene.remove(n.mesh);
        const isElevated = n.type.includes('elevated');
        const baseH = layerToHeight(tileLayer);
        const elevY = (tileLayer === 1) ? this.getElevationOffset(n.x, n.z) : 0;
        n.elevationOffset = elevY;
        const newMesh = ModelFactory.createStation(n.rotation, isElevated, part, n.stationPlatformSide ?? 'right', n.stationName ?? '駅', baseH);
        newMesh.position.set(n.x * WorldMap.TILE_SIZE, baseH + elevY, n.z * WorldMap.TILE_SIZE);
        newMesh.visible = (tileLayer === this.activeLayer);
        this.scene.add(newMesh);
        n.mesh = newMesh;
      }
    });
  }

  /**
   * ② 分岐器の開通状態を明示的に指定して切り替える
   */
  public setSwitchState(x: number, z: number, state: SwitchState, layer: GridLayer = this.activeLayer): void {
    const tile = this.getTile(x, z, layer);
    if (!tile || !tile.type.startsWith('point_switch')) return;
    if (tile.switchState === state) return;

    tile.switchState = state;
    if (tile.mesh) {
      this.scene.remove(tile.mesh);
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
    mesh.visible = (tileLayer === this.activeLayer);
    this.scene.add(mesh);
    tile.mesh = mesh;
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
      tile.stationTargetLength = length;
      tile.dailyPassengers = 0;
      tile.totalPassengers = 0;
      tile.totalRevenue = 0;
      tile.stationMaintenance = isSignalYard ? 10000 * length : (isCargoStation ? 25000 * length : 50000 * length);
      tile.stationNetProfit = 0;
      tile.stationSchedule = isCargoStation ? createDefaultCargoStationSchedule() : createDefaultStationSchedule();
      if (isCargoStation) {
        tile.isCargoYard = true;
      }

      const elevY = (layer === 1) ? this.getElevationOffset(tx, tz) : 0;
      tile.elevationOffset = elevY;
      const mesh = isSignalYard
        ? ModelFactory.createSignalYard(rot, isElevated, platformSide, baseH)
        : (isCargoStation
          ? ModelFactory.createCargoStation(rot, isElevated, platformSide, baseH)
          : ModelFactory.createStation(rot, isElevated, part, platformSide, stationName, baseH));
      mesh.position.set(tx * WorldMap.TILE_SIZE, baseH + elevY, tz * WorldMap.TILE_SIZE);
      mesh.visible = (layer === this.activeLayer);
      this.scene.add(mesh);
      tile.mesh = mesh;
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

    for (const tCoord of tiles) {
      const t = this.getTile(tCoord.x, tCoord.z, tCoord.layer);
      if (t) {
        t.stationName = reg.station.name;
        if (t.mesh && !isSignalYard) {
          ModelFactory.updateStationSign(t.mesh, reg.station.name);
        }
      }
    }

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
      this.scene.remove(tile.mesh);
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
    tile.stationPart = undefined;
    tile.stationPlatformSide = undefined;
    tile.stationSchedule = undefined;
    tile.switchSchedule = undefined;
    tile.stationName = undefined;
    tile.dailyPassengers = undefined;
    tile.totalPassengers = undefined;
    tile.totalRevenue = undefined;
    tile.stationMaintenance = undefined;
    tile.stationNetProfit = undefined;
    tile.stationTargetLength = undefined;
    tile.cargoContainers = undefined;
    tile.isCargoYard = undefined;

    // 地上1F以外のタイルは撤去時にGrid3Dから削除してメモリ解放
    if (tile.layer !== undefined && tile.layer !== 1) {
      this.grid3D.delete(tile.x, tile.layer, tile.z);
    }

    // 直上階層の高架線路の橋脚を再計算（下層が撤去されたため地上まで延長）
    this.updateUpperElevatedPiers(tile.x, tile.z, (tile.layer ?? 1) as GridLayer);
  }

  /**
   * ⑤ 撤去処理。駅タイルの場合は同一駅グループ（有効長分の全マス）を一括撤去する。
   * シーサスクロッシンググループの一員を撤去した場合は残りを単体線路化する。
   */
  public demolishTile(x: number, z: number, layer: GridLayer = this.activeLayer): boolean {
    const tile = this.getTile(x, z, layer);
    if (!tile || tile.type === 'empty') return false;

    // ⑤ 駅・信号場タイルの場合: 同一グループ全体を一括撤去する
    // 【データ腐敗バグ解消】signal_yard / cargo_station も一括撤去の対象とし、全階層からグループタイルを収集
    if (tile.type.includes('station') || tile.type === 'signal_yard') {
      const tilesToDemolish: TileData[] = [];
      if (tile.stationGroupId) {
        const targetGroupId = tile.stationGroupId;
        this.getAllTiles().forEach(t => {
          if (t.stationGroupId === targetGroupId) {
            tilesToDemolish.push(t);
          }
        });
      } else {
        // レガシー駅・信号場の場合: 連続するマスを収集
        const startTile = this.getStationStartTile(x, z, layer);
        if (startTile) {
          const rot = startTile.rotation;
          const stType = startTile.type;
          const stepX = rot === 1 ? 1 : 0;
          const stepZ = rot === 1 ? 0 : 1;
          let curX = startTile.x, curZ = startTile.z;
          while (true) {
            const t = this.getTile(curX, curZ, layer);
            if (t && t.type === stType && t.rotation === rot) {
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

        // 【ユーザー要件③】駅舎・ホーム・コンテナ等は線路に付随するオプションパーツとして扱うため、
        // 駅撤去時は線路を残して元の直線線路（地上線路または高架線路）に復元する！
        const isElevated = prevType.includes('elevated') || stLayer >= 2;
        const restoreTrackType: TileType = isElevated ? 'rail_elevated' : 'rail_ground';

        this.removeTileMesh(st);
        st.type = restoreTrackType;
        st.rotation = rot;
        st.level = isElevated ? LEVEL_ELEVATED : LEVEL_GROUND;
        st.stationPassengers = 0;
        st.curveDir = undefined;
        st.switchState = 'straight';
        st.groupOrigin = undefined;
        st.crossingRole = undefined;
        st.crossingState = undefined;
        st.crossingRoadAxis = undefined;
        st.slopeReversed = undefined;
        st.slopePart = undefined;
        st.stationGroupId = undefined;
        st.stationPart = undefined;
        st.stationPlatformSide = undefined;
        st.stationSchedule = undefined;
        st.switchSchedule = undefined;
        st.stationName = undefined;
        st.dailyPassengers = undefined;
        st.totalPassengers = undefined;
        st.totalRevenue = undefined;
        st.stationMaintenance = undefined;
        st.stationNetProfit = undefined;
        st.stationTargetLength = undefined;
        st.cargoContainers = undefined;
        st.isCargoYard = undefined;

        // 線路メッシュを再生成
        const baseH = layerToHeight(stLayer);
        const elevY = this.getTrackElevationOffset(sx, sz, stLayer);
        st.elevationOffset = elevY;
        const isTunnel = this.isTunnelSection(sx, sz, stLayer);
        const trackMesh = isTunnel
          ? ModelFactory.createTunnelTrack(rot)
          : (isElevated
            ? ModelFactory.createElevatedTrack(rot, WorldMap.shouldShowPier(sx, sz, rot), baseH)
            : ModelFactory.createGroundTrack(rot, false));
        trackMesh.position.set(sx * WorldMap.TILE_SIZE, baseH + elevY, sz * WorldMap.TILE_SIZE);
        trackMesh.visible = (stLayer === this.activeLayer);
        this.scene.add(trackMesh);
        st.mesh = trackMesh;

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

  public clearAll() {
    // 全階層のタイルメッシュを破棄
    const all = this.getAllTiles();
    for (const tile of all) {
      this.resetTileData(tile);
      tile.landValue = 100;
    }
    this.instancedMeshManager.clearAll();
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
    for (const tile of this.getAllTiles()) {
      if (tile.type.includes('station') || tile.type === 'signal_yard') {
        tile.twoDaysAgoPassengers = tile.previousDayPassengers ?? 0;
        tile.previousDayPassengers = tile.dailyPassengers ?? 0;
        tile.dailyPassengers = 0;
        tile.previousDayLoadedCargo = tile.dailyLoadedCargo ?? 0;
        tile.dailyLoadedCargo = 0;
        tile.previousDayUnloadedCargo = tile.dailyUnloadedCargo ?? 0;
        tile.dailyUnloadedCargo = 0;
      }
    }
  }

  public serialize(): string {
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
          stationTargetLength: t.stationTargetLength,
          stationPart: t.stationPart,
          stationPlatformSide: t.stationPlatformSide,
          stationSchedule: t.stationSchedule,
          switchSchedule: t.switchSchedule
        });
      }
    });

    // 【駅の記憶喪失解消】v2 フォーマット: タイル一覧に加えて stationManager の全状態をシリアライズ
    return JSON.stringify({
      version: 2,
      tiles: nonEmpties,
      stations: this.stationManager.serialize()
    });
  }

  public deserialize(jsonStr: string) {
    try {
      const parsed = JSON.parse(jsonStr);
      this.clearAll();

      let data: any[];
      let stationData: StationSaveData | null = null;

      if (Array.isArray(parsed)) {
        // 旧バージョン互換（配列形式）
        data = parsed;
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tiles)) {
        // 新バージョン（v2形式）
        data = parsed.tiles;
        stationData = parsed.stations ?? null;
      } else {
        return;
      }

      for (const item of data) {
        const lyr: GridLayer = (item.layer ?? 1) as GridLayer;
        const isElevated = item.type.includes('elevated') || lyr >= 2;

        if (item.type.startsWith('point_switch')) {
          this.placeSwitch(item.x, item.z, item.rot || 0, isElevated, item.branchSide || 'right', lyr);
          if (item.sw === 'diverge') {
            this.togglePointSwitch(item.x, item.z, lyr);
          }
          if (item.switchSchedule) {
            const swTile = this.getTile(item.x, item.z, lyr);
            if (swTile) swTile.switchSchedule = item.switchSchedule;
          }
        } else if (item.type.startsWith('scissors_crossing')) {
          this.placeScissorsCrossing(item.x, item.z, item.rot || 0, isElevated, lyr);
          const target: CrossingState = item.crossState || 'straight';
          this.setCrossingState(item.x, item.z, target, lyr);
          if (item.switchSchedule) {
            const crTile = this.getTile(item.x, item.z, lyr);
            if (crTile) crTile.switchSchedule = item.switchSchedule;
          }
        } else if (item.type.startsWith('rail_curve') && item.curveDir !== undefined) {
          this.placeCurve(item.x, item.z, item.curveDir, isElevated, lyr);
        } else if (item.type === 'rail_slope') {
          const tile = this.getOrCreateTile(item.x, item.z, lyr);
          if (tile) {
            this.applySlopeTile(tile, item.rot || 0, !!item.slopeRev, item.slopePart || 0, lyr);
            // 【バグ修正】スロープ最上段(part 3)の場合、接続先の上の階層にもタイルを登録して断線を防ぐ
            if ((item.slopePart || 0) === 3) {
              const upperLayer: GridLayer = lyr === 1 ? 2 : ((lyr + 1) as GridLayer);
              this.grid3D.set(item.x, upperLayer, item.z, tile);
            }
          }
        } else if (item.type === 'rail_slope_underground') {
          const tile = this.getOrCreateTile(item.x, item.z, lyr);
          if (tile) {
            this.applyUndergroundSlopeTile(tile, item.rot || 0, !!item.slopeRev, item.slopePart || 0, lyr);
            // 【バグ修正】地下スロープ最下段(part 3)の場合、地下1F(layer -1)にもタイルを登録
            if ((item.slopePart || 0) === 3) {
              this.grid3D.set(item.x, -1, item.z, tile);
            }
            if ((item.slopePart || 0) === 0 || (item.slopePart || 0) === 1) {
              this.groundHoleHandler?.add(item.x, item.z, item.rot || 0);
            }
          }
        } else if (item.type === 'level_crossing') {
          this.applyLevelCrossing(item.x, item.z, item.rot || 0, item.roadAxis ?? (1 - (item.rot || 0)), item.lvl || 1, lyr);
        } else if (item.type.includes('station') || item.type === 'signal_yard') {
          this.setTile(item.x, item.z, item.type, item.rot || 0, item.lvl || 1, item.stationPlatformSide || 'right', lyr);
          const restored = this.getTile(item.x, item.z, lyr);
          if (restored) {
            if (item.stationName) restored.stationName = item.stationName;
            if (item.stationGroupId) restored.stationGroupId = item.stationGroupId;
            if (item.stationTargetLength) restored.stationTargetLength = item.stationTargetLength;
            if (item.stationPart) restored.stationPart = item.stationPart;
            if (item.stationPlatformSide) restored.stationPlatformSide = item.stationPlatformSide;
            if (item.stationSchedule) restored.stationSchedule = item.stationSchedule;
            if (restored.mesh && item.stationName) {
              ModelFactory.updateStationSign(restored.mesh, item.stationName);
            }
          }
        } else {
          this.setTile(item.x, item.z, item.type, item.rot || 0, item.lvl || 1, 'right', lyr);
        }

        if (item.cargoYard) {
          const restored = this.getTile(item.x, item.z, lyr);
          if (restored) restored.isCargoYard = true;
        }
        if (item.cargoContainers !== undefined) {
          const restored = this.getTile(item.x, item.z, lyr);
          if (restored) restored.cargoContainers = item.cargoContainers;
        }
      }

      // 【駅の記憶喪失解消】駅マネージャーの復元
      if (stationData) {
        // v2 保存データから駅・番線構成・財務・乗降客数・固有IDを完全復元
        this.stationManager.deserialize(stationData);
        // 各駅・ホームの乗降客数・収支データを対応する全タイルに同期復元
        for (const st of this.stationManager.getStations()) {
          for (const plat of st.platforms) {
            for (const tCoord of plat.tiles) {
              const tile = this.getTile(tCoord.x, tCoord.z, tCoord.layer);
              if (tile) {
                tile.dailyPassengers = plat.dailyPassengers;
                tile.totalPassengers = plat.totalPassengers;
                tile.totalRevenue = plat.totalRevenue;
                tile.stationNetProfit = (plat.totalRevenue ?? 0) - (tile.stationMaintenance ?? 0);
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
          this.stationManager.registerPlatform({
            tiles: groupTiles.map(gt => ({ x: gt.x, z: gt.z, layer: (gt.layer ?? 1) as GridLayer })),
            length: first.stationTargetLength || groupTiles.length,
            trackAxis,
            isSignalYard,
            isCargoStation: isCargo,
            customName: first.stationName
          });
        }
      }
    } catch (e) {
      console.error('Failed to load save data', e);
    }
  }
}
