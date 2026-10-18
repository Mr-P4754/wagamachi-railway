// 貨物インフラ ＆ RCI経済連動ループ
// 工業施設で毎日17:00に自動生産されるコンテナを、貨物駅(コンテナヤード)経由で貨物列車が商業ゾーンへ輸送する。
// 輸送距離×コンテナ数で直接運賃収入を得るほか、商業ゾーンの魅力度を高めて旅客需要を押し上げる。

import { ZoneManager } from './ZoneManager';
import { WorldMap, TileData } from '../simulation/WorldMap';
import { GridLayer } from './types';

/** コンテナ1個・1マスあたりの貨物運賃（円） */
export const CARGO_FARE_PER_CONTAINER_PER_TILE = 4200;

/** 商業魅力度の自然減衰（コンテナ供給が途絶えると徐々に集客力が落ちる） */
const ATTRACTIVENESS_DECAY_PER_SEC = 0.06;

export class CargoSystem {
  private zoneManager: ZoneManager;

  constructor(zoneManager: ZoneManager) {
    this.zoneManager = zoneManager;
  }

  public update(deltaTime: number, speedMultiplier: number): void {
    if (speedMultiplier <= 0) return;
    const dt = deltaTime * speedMultiplier;

    // 商業魅力度の緩やかな自然減衰（貨物輸送を継続しないと商業エリアが停滞する）
    for (const cell of this.zoneManager.getAllZones()) {
      if (cell.type === 'commercial' && cell.commercialAttractiveness > 0) {
        cell.commercialAttractiveness = Math.max(0, cell.commercialAttractiveness - ATTRACTIVENESS_DECAY_PER_SEC * dt);
      }
    }
  }

  /**
   * 貨物駅グループが指定されたエリア（'industrial' または 'commercial'）に属しているかを判定。
   * 「1マスでも隣接していればエリア内と判定される」
   */
  public isStationInArea(worldMap: WorldMap, x: number, z: number, targetType: 'industrial' | 'commercial', layer: GridLayer = 1): boolean {
    const tiles = worldMap.getStationTiles(x, z, layer);
    const checkTiles = tiles.length > 0 ? tiles : [{ x, z, layer }];

    for (const st of checkTiles) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const tx = st.x + dx;
          const tz = st.z + dz;
          // ゾーンチェック
          const zCell = this.zoneManager.getZone(tx, tz);
          if (zCell && zCell.type === targetType) {
            return true;
          }
          // 施設タイルチェック（同階層施設または地上1F施設）
          const tData = worldMap.getTile(tx, tz, (st.layer ?? layer) as GridLayer) || worldMap.getTile(tx, tz, 1);
          if (tData && tData.type === targetType) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * 毎日17:00の工業生産処理:
   * マップ上の工業施設1つにつきコンテナが1日1個増え、同じ工業エリア内の最寄り貨物駅に自動で追加される。
   * @returns コンテナが追加された駅の代表タイル座標一覧
   */
  public processDailyIndustrialProduction(worldMap: WorldMap): Array<{ x: number; z: number; layer: GridLayer; added: number }> {
    const allTiles = worldMap.getAllTiles();
    const updatedStations = new Map<string, { x: number; z: number; layer: GridLayer; added: number }>();

    // 1. 工業エリアに隣接する貨物駅グループを収集
    const cargoStationGroups = new Map<string, {
      startTile: TileData;
      tiles: TileData[];
      isIndustrial: boolean;
    }>();

    for (const t of allTiles) {
      if (t.type.startsWith('cargo_station') || t.isCargoYard) {
        const groupId = t.stationGroupId || `${t.x},${t.z},${t.layer ?? 1}`;
        if (!cargoStationGroups.has(groupId)) {
          const stTiles = worldMap.getStationTiles(t.x, t.z, (t.layer ?? 1) as GridLayer);
          const start = worldMap.getStationStartTile(t.x, t.z, (t.layer ?? 1) as GridLayer) || t;
          const isInd = this.isStationInArea(worldMap, t.x, t.z, 'industrial', (t.layer ?? 1) as GridLayer);

          cargoStationGroups.set(groupId, {
            startTile: start,
            tiles: stTiles,
            isIndustrial: isInd
          });
        }
      }
    }

    const industrialStations = Array.from(cargoStationGroups.values()).filter(g => g.isIndustrial);

    // 2. マップ上の工業施設（building-ind、タイル種別 'industrial'）を収集
    const industrialFacilities: Array<{ x: number; z: number }> = [];
    for (const t of allTiles) {
      if (t.type === 'industrial') {
        industrialFacilities.push({ x: t.x, z: t.z });
      }
    }
    // 工業ゾーンで自然発展した施設（developmentLevel > 0）も計上
    for (const z of this.zoneManager.getAllZones()) {
      if (z.type === 'industrial' && z.developmentLevel > 0) {
        if (!industrialFacilities.some(f => f.x === z.x && f.z === z.z)) {
          industrialFacilities.push({ x: z.x, z: z.z });
        }
      }
    }

    if (industrialFacilities.length === 0) {
      return [];
    }

    // 工業施設の日々の生産活動により、工業ゾーンのストック（industrialStock）を加算・補充
    for (const fac of industrialFacilities) {
      const z = this.zoneManager.getZone(fac.x, fac.z);
      if (z && z.type === 'industrial') {
        this.zoneManager.addIndustrialStock(z, 1);
      }
    }

    if (industrialStations.length === 0) {
      return []; // 工業貨物駅がなければ駅へのコンテナ供給は行わない
    }

    // 3. 工業施設ごとに「同じ工業エリア内の最寄り貨物駅」にコンテナを1個追加
    for (const fac of industrialFacilities) {
      let bestDist = Infinity;
      let bestGroup: typeof industrialStations[0] | null = null;

      for (const stGroup of industrialStations) {
        for (const st of stGroup.tiles) {
          const dist = Math.abs(fac.x - st.x) + Math.abs(fac.z - st.z);
          if (dist < bestDist) {
            bestDist = dist;
            bestGroup = stGroup;
          }
        }
      }

      if (bestGroup) {
        const start = bestGroup.startTile;
        const currentCount = start.cargoContainers ?? 0;
        const newCount = currentCount + 1;
        worldMap.setStationCargoContainers(start.x, start.z, newCount, (start.layer ?? 1) as GridLayer);

        const groupId = start.stationGroupId || `${start.x},${start.z}`;
        if (!updatedStations.has(groupId)) {
          updatedStations.set(groupId, {
            x: start.x,
            z: start.z,
            layer: (start.layer ?? 1) as GridLayer,
            added: 0
          });
        }
        updatedStations.get(groupId)!.added += 1;
      }
    }

    return Array.from(updatedStations.values());
  }

  /**
   * 貨物駅(x, z)から最大 capacity 分のコンテナを積載する。
   * 積載した分だけ駅のコンテナ数が減少する。
   * @returns 実際に積載したコンテナ数
   */
  public tryLoadCargoFromStation(worldMap: WorldMap, x: number, z: number, capacity: number, layer: GridLayer = 1): number {
    if (capacity <= 0) return 0;
    const current = worldMap.getStationCargoContainers(x, z, layer);
    if (current <= 0) return 0;

    const toLoad = Math.min(capacity, current);
    worldMap.setStationCargoContainers(x, z, current - toLoad, layer);
    return toLoad;
  }

  /**
   * 商業エリアに設置された貨物駅(x, z)へコンテナを一括荷降ろしする。
   * 降ろされたコンテナは描写せず、駅で販売された扱いとして魅力度向上・売上計上。
   * ※商業エリア外の貨物駅では降ろせない（0を返す）。
   * @returns 実際に販売・納品されたコンテナ数
   */
  public tryUnloadCargoAtCommercialStation(worldMap: WorldMap, x: number, z: number, containers: number, layer: GridLayer = 1): number {
    if (containers <= 0) return 0;
    // 商業エリア外の貨物駅ではコンテナは降ろせない
    if (!this.isStationInArea(worldMap, x, z, 'commercial', layer)) {
      return 0;
    }

    let remaining = containers;
    let totalDelivered = 0;

    // 1. 周辺で魅力度に余力がある商業ゾーンへ優先的に納品（魅力度向上）
    // 1箇所で上限に達した場合は、周辺の他の商業ゾーンへも分散納品する
    while (remaining > 0) {
      const dest = this.zoneManager.findNearestCommercialWithDemand(x, z, 40, layer);
      if (!dest) break;
      const accepted = this.zoneManager.deliverToCommercial(dest, remaining);
      if (accepted <= 0) break;
      remaining -= accepted;
      totalDelivered += accepted;
    }

    // 2. 周辺の商業ゾーンが全て魅力度100に達しているか、商業ビル(施設タイル)のみが隣接している場合でも、
    // 冒頭の isStationInArea('commercial') を満たしているため商業貨物駅として全量受入・販売完了とする
    if (remaining > 0) {
      totalDelivered += remaining;
      remaining = 0;
    }

    // 納品先が全く見つからなかった場合はコンテナを消費せず 0 を返却（ブラックホール蒸発防止）
    return totalDelivered;
  }

  // 互換用メソッド
  public tryLoadCargo(_x: number, _z: number, _capacity: number, _layer: GridLayer = 1): number {
    return 0;
  }
  public tryUnloadCargo(_x: number, _z: number, _containers: number, _layer: GridLayer = 1): number {
    return 0;
  }
}
