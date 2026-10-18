import { WorldMap, TileData } from '../WorldMap';
import { GridLayer } from '../../core/types';
import { getMaxCapacity, getRunningCostPerTrip } from '../VehicleCatalog';
import { VehicleMeshBuilder } from '../../graphics/vehicles/VehicleMeshBuilder';
import { ArrivalDecision } from '../../core/ScheduleEngine';
import { TrainInstance, CargoHooks, CARGO_FARE_PER_CONTAINER_PER_TILE } from './types';
import { ExternalConnectionManager } from '../ExternalConnectionManager';

/**
 * 旅客・貨物ペイロード・駅需要専門クラス
 */
export class TrainPayloadSystem {
  public externalConnectionManager?: ExternalConnectionManager;

  public setExternalConnectionManager(mgr: ExternalConnectionManager): void {
    this.externalConnectionManager = mgr;
  }

  /**
   * 時間帯別の乗客需要係数を返す
   */
  public static getHourlyDemandMultiplier(hour: number): number {
    const h = ((hour % 24) + 24) % 24;
    switch (h) {
      case 0: return 0.08;
      case 1:
      case 2:
      case 3: return 0.02; // 深夜はほぼゼロ
      case 4: return 0.06;
      case 5: return 0.25;
      case 6: return 0.7;
      case 7: return 2.6;  // 朝ラッシュ
      case 8: return 3.4;  // 朝ラッシュピーク
      case 9: return 2.0;
      case 10:
      case 11: return 0.9;
      case 12:
      case 13: return 1.2; // 昼休み
      case 14:
      case 15:
      case 16: return 0.85;
      case 17: return 2.3; // 夕ラッシュ
      case 18: return 3.0; // 夕ラッシュピーク
      case 19: return 2.5;
      case 20: return 1.6;
      case 21: return 0.9;
      case 22: return 0.45;
      case 23: return 0.18;
      default: return 1.0;
    }
  }

  /**
   * 駅到着時の降車処理 (Alighting)
   */
  public processAlighting(
    train: TrainInstance,
    arrival: ArrivalDecision,
    isDeadEnd: boolean,
    worldMap: WorldMap,
    onPassengerFare?: (amount: number) => void
  ): void {
    if (train.passengers <= 0) return;

    const currentTileData = worldMap.getTile(
      train.currentTile.x,
      train.currentTile.z,
      train.currentTile.layer
    );
    const isExternalGateway = !!currentTileData?.isExternalConnection || currentTileData?.type === 'external_connection';

    let alighting = 0;
    if (arrival.isReverse || arrival.mode === 'reverse' || isDeadEnd || isExternalGateway) {
      // 終端または隣町ゲートウェイ到着時は全員降車
      alighting = train.passengers;
    } else {
      const alightRatio = 0.35 + Math.random() * 0.25;
      alighting = Math.min(train.passengers, Math.max(1, Math.round(train.passengers * alightRatio)));
    }
    train.passengers = Math.max(0, train.passengers - alighting);

    if (alighting > 0) {
      // 隣町ゲートウェイ到着時の長距離越境特別ボーナス運賃
      if (isExternalGateway && onPassengerFare) {
        const bonusFare = Math.round(train.model.farePerRide * 0.8 * alighting);
        train.totalRevenue += bonusFare;
        train.monthlyProfit = train.totalRevenue - train.totalCost;
        onPassengerFare(bonusFare);
        if (currentTileData?.externalCityId) {
          this.externalConnectionManager?.recordPassengersTransported(currentTileData.externalCityId, alighting);
        }
      }

      const platInfo = worldMap.stationManager.getPlatformByTile(
        train.currentTile.x,
        train.currentTile.z,
        train.currentTile.layer
      );
      if (platInfo) {
        worldMap.stationManager.addBoardingRecord(
          platInfo.station.id,
          platInfo.platform.id,
          alighting,
          0
        );
      }
    }
  }

  /**
   * 出発時の乗車処理 (Boarding) および区間運行費用計上
   */
  public processBoarding(
    train: TrainInstance,
    stoppedTile: TileData | null,
    worldMap: WorldMap,
    onPassengerFare: (amount: number) => void,
    onPassengerCost?: (amount: number) => void
  ): void {
    if (!stoppedTile) return;

    const isYard = stoppedTile.type === 'signal_yard';
    const isCargo = stoppedTile.type.startsWith('cargo_station') || !!stoppedTile.isCargoYard;

    // 旅客の乗車処理は旅客列車かつ旅客駅のみ実行
    if (train.model.category !== 'freight' && !isYard && !isCargo) {
      const isExternalGateway = !!stoppedTile.isExternalConnection || stoppedTile.type === 'external_connection';
      const waiting = stoppedTile.stationPassengers ?? 0;
      const maxCap = getMaxCapacity(train.model, train.carCount);
      const freeSeats = Math.max(0, maxCap - train.passengers);
      const boarding = Math.min(waiting, freeSeats);

      if (boarding > 0) {
        train.passengers += boarding;
        const remainingWaiting = waiting - boarding;
        stoppedTile.stationPassengers = remainingWaiting;

        const platInfo = worldMap.stationManager.getPlatformByTile(
          train.currentTile.x,
          train.currentTile.z,
          train.currentTile.layer
        );
        if (platInfo) {
          for (const t of platInfo.platform.tiles) {
            const tData = worldMap.getTile(t.x, t.z, (t.layer ?? 1) as GridLayer);
            if (tData) tData.stationPassengers = remainingWaiting;
          }
        }

        // 隣町ゲートウェイからの長距離幹線運賃（1.5倍プレミアム）
        const fareMultiplier = isExternalGateway ? 1.5 : 1.0;
        const fare = Math.round(train.model.farePerRide * fareMultiplier * boarding);
        train.totalPassengers += boarding;
        train.totalRevenue += fare;
        train.monthlyProfit = train.totalRevenue - train.totalCost;

        if (isExternalGateway && stoppedTile.externalCityId) {
          this.externalConnectionManager?.recordPassengersTransported(stoppedTile.externalCityId, boarding);
        }

        if (platInfo) {
          worldMap.stationManager.addBoardingRecord(
            platInfo.station.id,
            platInfo.platform.id,
            boarding,
            fare
          );
        }

        onPassengerFare(fare);
      }
    }

    // 区間運行費用は貨物列車も含め発車時に計上
    const tripCost = getRunningCostPerTrip(train.model, train.carCount);
    train.totalCost += tripCost;
    train.monthlyProfit = train.totalRevenue - train.totalCost;
    onPassengerCost?.(tripCost);
  }

  /**
   * 貨物駅での積み込み処理 (Cargo Loading)
   */
  public processCargoLoading(
    train: TrainInstance,
    cargoHooks: CargoHooks | undefined,
    worldMap: WorldMap
  ): void {
    const capacity = train.cargoCapacity ?? 0;
    const freeSlots = capacity - (train.cargoLoad ?? 0);
    if (freeSlots <= 0) return;

    const curTile = worldMap.getTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer);

    // 隣町・外部都市への直通線路からの貨物輸入（特産品コンテナ積み込み）
    if (curTile?.isExternalConnection || curTile?.type === 'external_connection') {
      const available = curTile.cargoContainers ?? 0;
      if (available > 0) {
        const loaded = Math.min(freeSlots, available);
        curTile.cargoContainers = available - loaded;
        train.cargoLoad = (train.cargoLoad ?? 0) + loaded;
        train.cargoPickup = { x: train.currentTile.x, z: train.currentTile.z };
        train.cargoTraveledTiles = 0;
        VehicleMeshBuilder.updateTrainCargoVisual(train.cars, train.cargoLoad);
        return;
      }
    }

    if (!cargoHooks) return;
    const loaded = cargoHooks.tryLoad(train.currentTile.x, train.currentTile.z, freeSlots, train.currentTile.layer);
    if (loaded > 0) {
      train.cargoLoad = (train.cargoLoad ?? 0) + loaded;
      train.cargoPickup = { x: train.currentTile.x, z: train.currentTile.z };
      train.cargoTraveledTiles = 0;

      const platInfo = worldMap.stationManager.getPlatformByTile(
        train.currentTile.x,
        train.currentTile.z,
        train.currentTile.layer
      );
      if (platInfo) {
        worldMap.stationManager.addCargoRecord(
          platInfo.station.id,
          platInfo.platform.id,
          loaded,
          0,
          0
        );
      }

      VehicleMeshBuilder.updateTrainCargoVisual(train.cars, train.cargoLoad);
      cargoHooks.onStationCargoChanged?.(train.currentTile.x, train.currentTile.z, train.currentTile.layer);
    }
  }

  /**
   * 商業エリアの貨物駅または隣町ゲートウェイでの荷降ろし・運賃計算処理 (Cargo Unloading / Export)
   */
  public processCargoUnloading(
    train: TrainInstance,
    cargoHooks: CargoHooks | undefined,
    onPassengerFare: (amount: number) => void,
    worldMap: WorldMap
  ): void {
    if ((train.cargoLoad ?? 0) <= 0) return;

    const curTile = worldMap.getTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer);
    const isExternalGateway = !!curTile?.isExternalConnection || curTile?.type === 'external_connection';

    // 隣町ゲートウェイへの輸出（全量荷降ろし＋1.5倍輸出プレミアム売上）
    if (isExternalGateway) {
      const delivered = train.cargoLoad ?? 0;
      if (delivered > 0) {
        const manhattanDist = train.cargoPickup
          ? (Math.abs(train.currentTile.x - train.cargoPickup.x) + Math.abs(train.currentTile.z - train.cargoPickup.z))
          : Math.min(train.cargoTraveledTiles ?? 1, 64);
        const distanceTiles = Math.max(1, Math.min(train.cargoTraveledTiles ?? 1, Math.round(manhattanDist * 1.5) + 4));
        const revenue = Math.round(distanceTiles * delivered * CARGO_FARE_PER_CONTAINER_PER_TILE * 1.5);

        train.totalPassengers += delivered;
        train.totalRevenue += revenue;
        train.monthlyProfit = train.totalRevenue - train.totalCost;

        if (curTile?.externalCityId) {
          this.externalConnectionManager?.recordCargoExported(curTile.externalCityId, delivered);
        }

        if (cargoHooks?.onCargoDelivered) {
          cargoHooks.onCargoDelivered(train.currentTile.x, train.currentTile.z, train.currentTile.layer, delivered, revenue);
        } else {
          onPassengerFare(revenue);
        }

        train.cargoLoad = 0;
        train.cargoPickup = null;
        train.cargoTraveledTiles = 0;
        VehicleMeshBuilder.updateTrainCargoVisual(train.cars, 0);
      }
      return;
    }

    if (!cargoHooks) return;

    const toUnload = train.cargoLoad ?? 0;
    const unloadResult = cargoHooks.tryUnload(train.currentTile.x, train.currentTile.z, toUnload, train.currentTile.layer);
    const delivered = typeof unloadResult === 'number'
      ? unloadResult
      : (unloadResult ? toUnload : 0);

    if (delivered > 0) {
      const manhattanDist = train.cargoPickup
        ? (Math.abs(train.currentTile.x - train.cargoPickup.x) + Math.abs(train.currentTile.z - train.cargoPickup.z))
        : Math.min(train.cargoTraveledTiles ?? 1, 64);
      const maxAllowedTiles = Math.max(1, Math.round(manhattanDist * 1.5) + 4);
      const distanceTiles = Math.max(1, Math.min(train.cargoTraveledTiles ?? 1, maxAllowedTiles));
      const revenue = Math.round(distanceTiles * delivered * CARGO_FARE_PER_CONTAINER_PER_TILE);
      train.totalPassengers += delivered;
      train.totalRevenue += revenue;
      train.monthlyProfit = train.totalRevenue - train.totalCost;
      if (cargoHooks.onCargoDelivered) {
        cargoHooks.onCargoDelivered(train.currentTile.x, train.currentTile.z, train.currentTile.layer, delivered, revenue);
      } else if (revenue > 0) {
        onPassengerFare(revenue);
      }

      train.cargoLoad = Math.max(0, (train.cargoLoad ?? 0) - delivered);
      if (train.cargoLoad === 0) {
        train.cargoPickup = null;
        train.cargoTraveledTiles = 0;
      }

      const platInfo = worldMap.stationManager.getPlatformByTile(
        train.currentTile.x,
        train.currentTile.z,
        train.currentTile.layer
      );
      if (platInfo) {
        worldMap.stationManager.addCargoRecord(
          platInfo.station.id,
          platInfo.platform.id,
          0,
          delivered,
          revenue
        );
      }
    }

    VehicleMeshBuilder.updateTrainCargoVisual(train.cars, train.cargoLoad ?? 0);
  }

  private stationScoreCache = new Map<string, { version: number; score: number }>();

  /**
   * 駅周辺の建物から乗客需要を算出
   */
  public calculateStationPassengerDemand(
    centerX: number,
    centerZ: number,
    currentHour: number,
    worldMap: WorldMap,
    getDemandMultiplier?: (x: number, z: number, hour: number) => number
  ): number {
    const cacheKey = `${centerX},${centerZ}`;
    const cached = this.stationScoreCache.get(cacheKey);
    let weightedScore = 0;

    if (cached && cached.version === worldMap.structureVersion) {
      weightedScore = cached.score;
    } else {
      let residenceCount = 0;
      let commercialCount = 0;
      let industrialCount = 0;

      for (let dx = -5; dx <= 5; dx++) {
        for (let dz = -5; dz <= 5; dz++) {
          if (dx === 0 && dz === 0) continue;
          const tx = centerX + dx;
          const tz = centerZ + dz;
          // ★修正: 山岳地表面(surfaceElevation)に建っている建物も確実に取得する
          const cell = worldMap.gridManagerRef?.getCell(tx, 1, tz);
          const surfaceLayer = (cell ? Math.max(1, cell.elevation) : 1) as GridLayer;
          const t = worldMap.getTile(tx, tz, surfaceLayer) || worldMap.getTile(tx, tz, 1);
          if (!t) continue;

          const chebyshevDist = Math.max(Math.abs(dx), Math.abs(dz));
          const distWeight = chebyshevDist <= 2 ? 1.0 : (chebyshevDist === 3 ? 0.85 : (chebyshevDist === 4 ? 0.7 : 0.55));

          if (t.type === 'residence') {
            residenceCount++;
            weightedScore += (2.5 + (t.level ?? 1) * 0.8) * distWeight;
          } else if (t.type === 'commercial') {
            commercialCount++;
            weightedScore += (4.0 + (t.level ?? 1) * 1.5) * distWeight;
          } else if (t.type === 'industrial') {
            industrialCount++;
            weightedScore += (2.5 + (t.level ?? 1) * 0.8) * distWeight;
          }
        }
      }

      if (residenceCount === 0 && commercialCount === 0 && industrialCount === 0) {
        weightedScore = 0;
      }
      this.stationScoreCache.set(cacheKey, { version: worldMap.structureVersion, score: weightedScore });
    }

    if (weightedScore <= 0) {
      return 0;
    }

    const demandMult = getDemandMultiplier
      ? getDemandMultiplier(centerX, centerZ, currentHour)
      : TrainPayloadSystem.getHourlyDemandMultiplier(currentHour);

    const fluctuation = 0.85 + Math.random() * 0.3;
    const calculated = Math.round(weightedScore * demandMult * fluctuation);

    return Math.max(1, calculated);
  }

  /**
   * 全旅客駅の待機乗客数を5分ごとに定期更新
   */
  public updateFiveMinuteStationPassengers(
    currentHour: number,
    worldMap: WorldMap,
    getDemandMultiplier?: (x: number, z: number, hour: number) => number
  ): void {
    const stations = worldMap.stationManager.getStations();
    for (const st of stations) {
      if (st.isSignalYard || st.isCargoStation) continue;
      for (const platform of st.platforms) {
        if (platform.isSignalYard || platform.isCargoStation || platform.tiles.length === 0) continue;
        const midIdx = Math.floor(platform.tiles.length / 2);
        const centerTile = platform.tiles[midIdx];
        const tileLayer = (centerTile.layer ?? 1) as GridLayer;

        const demand = this.calculateStationPassengerDemand(centerTile.x, centerTile.z, currentHour, worldMap, getDemandMultiplier);
        if (demand <= 0) continue;

        const curTile = worldMap.getTile(centerTile.x, centerTile.z, tileLayer);
        if (!curTile) continue;

        const maxCap = Math.max(10, Math.round(demand * 2.5));
        const currentWait = curTile.stationPassengers ?? 0;

        const hourlyIncremental = Math.max(1, Math.round(demand * 0.4));
        const fiveMinIncremental = hourlyIncremental / 12;

        curTile.passengerAccumulator = (curTile.passengerAccumulator ?? 0) + fiveMinIncremental;

        const wholePassengers = Math.floor(curTile.passengerAccumulator);
        if (wholePassengers > 0) {
          curTile.passengerAccumulator -= wholePassengers;
          const newWait = Math.min(maxCap, currentWait + wholePassengers);
          curTile.stationPassengers = newWait;

          for (const t of platform.tiles) {
            const tData = worldMap.getTile(t.x, t.z, (t.layer ?? 1) as GridLayer);
            if (tData) {
              tData.stationPassengers = newWait;
              tData.passengerAccumulator = curTile.passengerAccumulator;
            }
          }
        }
      }
    }
  }

  /**
   * 全旅客駅の待機乗客数を初期設定（ゲーム開始時やマップロード時）
   */
  public updateHourlyStationPassengers(
    currentHour: number,
    worldMap: WorldMap,
    getDemandMultiplier?: (x: number, z: number, hour: number) => number
  ): void {
    const stations = worldMap.stationManager.getStations();
    for (const st of stations) {
      if (st.isSignalYard || st.isCargoStation) continue;
      for (const platform of st.platforms) {
        if (platform.isSignalYard || platform.isCargoStation || platform.tiles.length === 0) continue;
        const midIdx = Math.floor(platform.tiles.length / 2);
        const centerTile = platform.tiles[midIdx];
        const tileLayer = (centerTile.layer ?? 1) as GridLayer;

        const demand = this.calculateStationPassengerDemand(centerTile.x, centerTile.z, currentHour, worldMap, getDemandMultiplier);
        if (demand <= 0) continue;

        const curTile = worldMap.getTile(centerTile.x, centerTile.z, tileLayer);
        if (!curTile) continue;

        const maxCap = Math.max(10, Math.round(demand * 2.5));
        const currentWait = curTile.stationPassengers ?? 0;
        const incremental = Math.max(1, Math.round(demand * 0.4));
        const newWait = Math.min(maxCap, currentWait + incremental);

        curTile.stationPassengers = newWait;
        for (const t of platform.tiles) {
          const tData = worldMap.getTile(t.x, t.z, (t.layer ?? 1) as GridLayer);
          if (tData) tData.stationPassengers = newWait;
        }
      }
    }
  }
}
