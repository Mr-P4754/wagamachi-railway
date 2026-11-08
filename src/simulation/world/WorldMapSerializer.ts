import { GridLayer } from '../../core/types';
import { StationSaveData } from '../../core/StationManager';
import { SavedTileRecord } from '../../services/Database';
import { TileData } from './types';

/**
 * WorldMap タイル配列と永続化レコード（IndexedDB / JSON シリアライズ）間の変換を担当するユーティリティ
 */
export class WorldMapSerializer {
  /**
   * 1件の TileData を永続化用レコードへ変換
   */
  public static tileToSavedRecord(t: TileData): SavedTileRecord {
    const layer = (t.layer ?? 1) as GridLayer;
    return {
      id: `${t.x},${t.z},${layer}`,
      x: t.x,
      z: t.z,
      layer,
      type: t.type,
      rotation: t.rotation,
      level: t.level,
      elevationOffset: t.elevationOffset,
      curveDir: t.curveDir,
      switchState: t.switchState,
      switchBranchSide: t.switchBranchSide,
      switchSchedule: t.switchSchedule,
      crossingState: t.crossingState,
      crossingRoadAxis: t.crossingRoadAxis,
      slopePart: t.slopePart,
      slopeReversed: t.slopeReversed,
      cargoContainers: t.cargoContainers,
      stationName: t.stationName,
      stationGroupId: t.stationGroupId,
      stationPlatformId: t.stationPlatformId,
      stationPart: t.stationPart,
      stationPlatformSide: t.stationPlatformSide,
      stationSchedule: t.stationSchedule,
      stationPassengers: t.stationPassengers,
      isCargoYard: t.isCargoYard,
      externalCityId: t.externalCityId,
      isExternalConnection: t.isExternalConnection,
      // レガシー互換キー
      rot: t.rotation,
      lvl: t.level,
      sw: t.switchState,
      branchSide: t.switchBranchSide,
      crossState: t.crossingState,
      roadAxis: t.crossingRoadAxis,
      slopeRev: t.slopeReversed,
      cargoYard: t.isCargoYard
    };
  }

  /**
   * 有効な全タイル配列から保存対象の SavedTileRecord 配列を抽出
   * （シーサスクロッシングの従属マス B/C/D は起点 A から復元されるため除外）
   */
  public static extractSavedTileRecords(allTiles: TileData[]): SavedTileRecord[] {
    const records: SavedTileRecord[] = [];
    for (const t of allTiles) {
      if (t.groupOrigin && t.crossingRole !== 0) continue;
      if (t.type !== 'empty') {
        records.push(WorldMapSerializer.tileToSavedRecord(t));
      }
    }
    return records;
  }

  /**
   * JSON文字列またはオブジェクト形式のセーブデータをパースしてタイル配列と駅データを抽出
   */
  public static parseSavePayload(
    jsonOrData: string | { tiles: any[]; stations?: any } | any[]
  ): { data: any[]; stationData: StationSaveData | null } | null {
    if (typeof jsonOrData === 'string') {
      const parsed = JSON.parse(jsonOrData);
      if (Array.isArray(parsed)) {
        return { data: parsed, stationData: null };
      }
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tiles)) {
        return { data: parsed.tiles, stationData: parsed.stations ?? null };
      }
      return null;
    }
    if (Array.isArray(jsonOrData)) {
      return { data: jsonOrData, stationData: null };
    }
    if (jsonOrData && typeof jsonOrData === 'object' && Array.isArray(jsonOrData.tiles)) {
      return { data: jsonOrData.tiles, stationData: jsonOrData.stations ?? null };
    }
    return null;
  }
}
