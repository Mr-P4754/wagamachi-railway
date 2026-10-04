import { WorldMap, TileData } from './WorldMap';
import { GridManager } from '../core/GridManager';
import { ZoneManager } from '../core/ZoneManager';
import { GridLayer } from '../core/types';

export class CityGrowth {
  private worldMap: WorldMap;
  private gridManager: GridManager | null = null;
  private zoneManager: ZoneManager | null = null;
  private lastEvaluatedDay: number = -1; // 発展を実行した最後の日

  constructor(worldMap: WorldMap, gridManager?: GridManager) {
    this.worldMap = worldMap;
    if (gridManager) {
      this.gridManager = gridManager;
    }
  }

  public setGridManager(gridManager: GridManager) {
    this.gridManager = gridManager;
  }

  public setZoneManager(zoneManager: ZoneManager) {
    this.zoneManager = zoneManager;
  }

  /**
   * 1日1回、正午（12:00以降）にまとめて都市を発展させる（高倍速・フレームスキップ対応）
   */
  public update(hour: number, _minute: number, day: number, onNewBuildings: (popIncrease: number) => void) {
    if (hour >= 12 && this.lastEvaluatedDay !== day) {
      this.lastEvaluatedDay = day;
      this.evaluateGrowth(onNewBuildings);
    }
  }

  public evaluateGrowth(onNewBuildings: (popIncrease: number) => void) {
    const stationGroups = new Map<string, TileData>();
    const allTiles = this.worldMap.getAllTiles();
    for (const t of allTiles) {
      if (WorldMap.isStationTileType(t.type)) {
        const tLayer = (t.layer ?? 1) as GridLayer;
        const start = this.worldMap.getStationStartTile(t.x, t.z, tLayer) || t;
        const key = `${start.x}_${start.z}_${start.layer ?? 1}`;
        if (!stationGroups.has(key)) {
          stationGroups.set(key, start);
        }
      }
    }

    let totalNewPop = 0;

    for (const st of stationGroups.values()) {
      const agg = this.worldMap.getStationAggregateData(st.x, st.z, (st.layer ?? 1) as GridLayer);
      const isCargoStation = st.type.startsWith('cargo_station');

      // 直近2日間の利用人数（前日 d1、前々日 d2）
      let d1 = agg ? agg.previousDayPassengers : 0;
      let d2 = agg ? agg.twoDaysAgoPassengers : 0;

      // ゲーム開始初期などで過去データが未蓄積の場合は、当日の乗降客実績で補完
      // ※待機乗客（st.stationPassengers）は列車に乗降していないため判定から除外
      const currentDaily = agg ? agg.dailyPassengers : 0;

      if (d1 === 0 && d2 === 0) {
        d1 = currentDaily;
        d2 = currentDaily;
      } else if (d2 === 0) {
        d2 = d1;
      }

      // ユーザー要件に基づく乗降客数・発展上限判定
      let maxAllowedLevel = 0;
      let maxDailyGrowthCount = 0;

      if (isCargoStation) {
        // 貨物駅（コンテナヤード）: 取扱コンテナ数に応じた上限設定（未取扱時は発展しない）
        const containers = (agg?.cargoContainers ?? st.cargoContainers ?? 0);
        if (containers >= 30) {
          maxAllowedLevel = 3;
          maxDailyGrowthCount = 4;
        } else if (containers >= 10) {
          maxAllowedLevel = 2;
          maxDailyGrowthCount = 3;
        } else if (containers >= 1) {
          maxAllowedLevel = 1;
          maxDailyGrowthCount = 2;
        } else {
          maxAllowedLevel = 0;
          maxDailyGrowthCount = 0;
        }
      } else {
        // 旅客駅: 列車の乗降客が最低1日100人以上ないと発展しない
        // ① 10000人以上 ➔ Lv4が上限、建物8つが上限
        // ② 5000人以上10000人未満 ➔ Lv3が上限、建物6つが上限
        // ③ 1000人以上5000人未満 ➔ Lv2が上限、建物4つが上限
        // ④ 100人以上1000人未満 ➔ Lv1が上限、建物2つが上限
        // ⑤ 100人未満（列車未運行含む） ➔ 発展しない（上限0）
        if (d1 >= 10000 && d2 >= 10000) {
          maxAllowedLevel = 4;
          maxDailyGrowthCount = 8;
        } else if (d1 >= 5000 && d2 >= 5000) {
          maxAllowedLevel = 3;
          maxDailyGrowthCount = 6;
        } else if (d1 >= 1000 && d2 >= 1000) {
          maxAllowedLevel = 2;
          maxDailyGrowthCount = 4;
        } else if (d1 >= 100 && d2 >= 100) {
          maxAllowedLevel = 1;
          maxDailyGrowthCount = 2;
        } else {
          maxAllowedLevel = 0;
          maxDailyGrowthCount = 0;
        }
      }

      // 乗降客が1日100人未満などで発展条件を満たさない場合はこの駅の発展処理をスキップ
      if (maxDailyGrowthCount <= 0 || maxAllowedLevel <= 0) {
        continue;
      }

      // 駅ごとの影響半径（駅規模に応じて適正化）
      const radius = maxAllowedLevel >= 3 ? 5 : maxAllowedLevel === 2 ? 4 : 3;

      // その駅周辺で本日「建つ・Lvが上がる」建物の実行数カウンタ（上限に達したら即停止）
      let developedCount = 0;

      const candidateOffsets: { dx: number; dz: number; dist: number }[] = [];
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const dist = Math.hypot(dx, dz);
          if (dist > radius || (dx === 0 && dz === 0)) continue;
          candidateOffsets.push({ dx, dz, dist });
        }
      }
      // ランダム順に候補地を走査
      for (let i = candidateOffsets.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidateOffsets[i], candidateOffsets[j]] = [candidateOffsets[j], candidateOffsets[i]];
      }

      for (const { dx, dz, dist } of candidateOffsets) {
        if (developedCount >= maxDailyGrowthCount) break;

        const tx = st.x + dx;
        const tz = st.z + dz;

        // マップ境界外ならスキップ
        if (!this.worldMap.isInBounds(tx, tz)) continue;

        if (this.gridManager && this.gridManager.isWaterAtGroundLevel(tx, tz)) continue;

        const cell = this.gridManager ? this.gridManager.getCell(tx, 1, tz) : null;
        const surfaceElevation = cell ? cell.elevation : 1;
        const targetLayer = surfaceElevation as GridLayer;

        const tile = this.worldMap.getTile(tx, tz, targetLayer);
        const hasRoadAdjacent = this.hasNeighborOfType(tx, tz, 'road', targetLayer);
        const residentialZoned = this.zoneManager && this.zoneManager.hasAnyZoneOfType('residential');
        const commercialZoned = this.zoneManager && this.zoneManager.hasAnyZoneOfType('commercial');
        const zoneHere = this.zoneManager ? this.zoneManager.getZone(tx, tz) : undefined;

        // 1. 更地タイルの新規建築（Lv.1）
        // 疎マップ構造のため、未建築マス（!tile）または明示的な 'empty' を更地として扱う
        if (!tile || tile.type === 'empty') {
          const isComZone = zoneHere?.type === 'commercial';
          const isIndZone = zoneHere?.type === 'industrial';
          const isResZone = zoneHere?.type === 'residential' || (!residentialZoned && !commercialZoned && !isIndZone);

          // 駅距離と道路隣接に応じた自然な建築確率（適度なペースに調整）
          const baseChance = ((radius - dist + 1) / (radius + 1)) * (hasRoadAdjacent ? 0.25 : 0.12);

          if (Math.random() < baseChance) {
            if (isComZone) {
              this.worldMap.setTile(tx, tz, 'commercial', 0, 1, 'right', targetLayer);
              developedCount++;
              totalNewPop += Math.floor(Math.random() * 20 + 15);
            } else if (isIndZone) {
              this.worldMap.setTile(tx, tz, 'industrial', 0, 1, 'right', targetLayer);
              developedCount++;
              totalNewPop += Math.floor(Math.random() * 15 + 10);
            } else if (isResZone) {
              this.worldMap.setTile(tx, tz, 'residence', 0, 1, 'right', targetLayer);
              developedCount++;
              totalNewPop += Math.floor(Math.random() * 15 + 10);
            }
          }
        }
        // 2. 既存住宅タイルの処理（商業への転換 または 住宅自身のレベルアップ）
        else if (tile.type === 'residence') {
          let actionTaken = false;

          // 駅至近の住宅が商業へ転換（駅直近かつ商業ゾーン、または未ゾーニング時）
          if (dist <= 2.0 && maxAllowedLevel >= 2 && developedCount < maxDailyGrowthCount) {
            const allowedByZone = !commercialZoned || zoneHere?.type === 'commercial';
            if (allowedByZone && Math.random() < 0.15) {
              // 商業Lvも maxAllowedLevel を上限とする
              const nextLvl = Math.min(maxAllowedLevel, tile.level);
              this.worldMap.setTile(tx, tz, 'commercial', 0, nextLvl, 'right', targetLayer);
              developedCount++;
              totalNewPop += Math.floor(Math.random() * 25 + 20);
              actionTaken = true;
            }
          }

          // 商業に転換しなかった住宅のレベルアップ
          // 【最重要】tile.level < maxAllowedLevel の場合のみレベルアップ許可！
          if (!actionTaken && tile.level < maxAllowedLevel && developedCount < maxDailyGrowthCount) {
            // 立地条件（道路隣接や距離、ゾーン指定）
            const canUpgrade =
              (tile.level === 1 && (dist <= 4.0 || zoneHere?.type === 'residential')) ||
              (tile.level === 2 && dist <= 3.5 && (hasRoadAdjacent || zoneHere?.type === 'residential')) ||
              (tile.level === 3 && dist <= 2.5 && hasRoadAdjacent);

            if (canUpgrade) {
              const upgradeChance = ((radius - dist + 1) / (radius + 1)) * 0.25;
              if (Math.random() < Math.max(0.1, upgradeChance)) {
                const nextLevel = tile.level + 1;
                this.worldMap.setTile(tx, tz, 'residence', tile.rotation, nextLevel, 'right', targetLayer);
                developedCount++;
                const popGains = [0, 15, 30, 60, 100];
                totalNewPop += popGains[nextLevel] || 25;
              }
            }
          }
        }
        // 3. 既存商業ビルのレベルアップ
        else if (tile.type === 'commercial') {
          // 【最重要】tile.level < maxAllowedLevel の場合のみレベルアップ許可！
          if (tile.level < maxAllowedLevel && developedCount < maxDailyGrowthCount) {
            const canUpgrade =
              (tile.level === 1 && dist <= 4.0) ||
              (tile.level === 2 && dist <= 3.2 && (hasRoadAdjacent || zoneHere?.type === 'commercial')) ||
              (tile.level === 3 && dist <= 2.2 && hasRoadAdjacent);

            if (canUpgrade) {
              const upgradeChance = ((radius - dist + 1) / (radius + 1)) * 0.22;
              if (Math.random() < Math.max(0.1, upgradeChance)) {
                const nextLevel = tile.level + 1;
                this.worldMap.setTile(tx, tz, 'commercial', tile.rotation, nextLevel, 'right', targetLayer);
                developedCount++;
                const popGains = [0, 20, 40, 70, 120];
                totalNewPop += popGains[nextLevel] || 30;
              }
            }
          }
        }
        // 4. 既存工業施設のレベルアップ
        else if (tile.type === 'industrial') {
          if (tile.level < Math.min(3, maxAllowedLevel) && developedCount < maxDailyGrowthCount) {
            if (Math.random() < 0.15) {
              const nextLevel = tile.level + 1;
              this.worldMap.setTile(tx, tz, 'industrial', tile.rotation, nextLevel, 'right', targetLayer);
              developedCount++;
              totalNewPop += Math.floor(Math.random() * 20 + 15);
            }
          }
        }
      }
    }

    if (totalNewPop > 0) {
      onNewBuildings(totalNewPop);
    }
  }

  private hasNeighborOfType(x: number, z: number, typePrefix: string, layer: GridLayer = 1): boolean {
    const neighbors = [
      this.worldMap.getTile(x, z - 1, layer),
      this.worldMap.getTile(x, z + 1, layer),
      this.worldMap.getTile(x - 1, z, layer),
      this.worldMap.getTile(x + 1, z, layer)
    ];
    return neighbors.some(n => n && n.type.startsWith(typePrefix));
  }
}
