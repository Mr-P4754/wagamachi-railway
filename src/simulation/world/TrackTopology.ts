import { GridLayer } from '../../core/types';
import { layerToHeight } from '../../core/Grid3D';
import {
  CurveDirection,
  DirVec,
  LEVEL_ELEVATED,
  LEVEL_GROUND,
  TileData,
  TileExit
} from './types';

/**
 * 線路・道路の接続方向、カーブ方向変換、高架橋脚配置間隔、シーサスクロッシング等の
 * トポロジー計算ロジックを専門に扱うユーティリティクラス
 */
export class TrackTopology {
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
        const [i1, i2] = TrackTopology.curveDirToIndices(tile.curveDir);
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
        const back = TrackTopology.opposite(forward);
        const branchDir = tile.switchBranchSide === 'left' ? TrackTopology.rotateCCW(forward) : TrackTopology.rotateCW(forward);
        return [
          { idx: back, level, worldHeight: defaultWorldHeight },
          { idx: forward, level, worldHeight: defaultWorldHeight },
          { idx: branchDir, level, worldHeight: defaultWorldHeight }
        ];
      }

      case 'scissors_crossing_ground':
      case 'scissors_crossing_elevated':
        return TrackTopology.getScissorsExits(tile, level, defaultWorldHeight);

      default:
        return [];
    }
  }

  /**
   * ② シーサスクロッシング(2×2)の接続方向・対角移動オフセットを役割(A/B/C/D)と開通状態から計算する。
   */
  public static getScissorsExits(tile: TileData, level: number, worldHeight: number): TileExit[] {
    const along = tile.rotation === 1 ? 1 : 2;
    const backAlong = TrackTopology.opposite(along);
    const across = TrackTopology.rotateCW(along);
    const alongVec = TrackTopology.DIRS[along];
    const acrossVec = TrackTopology.DIRS[across];
    const role = tile.crossingRole ?? 0;
    const state = tile.crossingState ?? 'straight';

    if (state === 'straight') {
      return [{ idx: along, level, worldHeight }, { idx: backAlong, level, worldHeight }];
    }

    if (state === 'cross-a') {
      if (role === 0) {
        return [
          { idx: backAlong, level, worldHeight },
          { idx: along, level, worldHeight, targetOffset: { dx: alongVec.x + acrossVec.x, dz: alongVec.z + acrossVec.z } }
        ];
      }
      if (role === 3) {
        return [
          { idx: along, level, worldHeight },
          { idx: backAlong, level, worldHeight, targetOffset: { dx: -alongVec.x - acrossVec.x, dz: -alongVec.z - acrossVec.z } }
        ];
      }
      return [{ idx: along, level, worldHeight }, { idx: backAlong, level, worldHeight }];
    }

    // cross-b
    if (role === 2) {
      return [
        { idx: backAlong, level, worldHeight },
        { idx: along, level, worldHeight, targetOffset: { dx: alongVec.x - acrossVec.x, dz: alongVec.z - acrossVec.z } }
      ];
    }
    if (role === 1) {
      return [
        { idx: along, level, worldHeight },
        { idx: backAlong, level, worldHeight, targetOffset: { dx: -alongVec.x + acrossVec.x, dz: -alongVec.z + acrossVec.z } }
      ];
    }
    return [{ idx: along, level, worldHeight }, { idx: backAlong, level, worldHeight }];
  }
}
