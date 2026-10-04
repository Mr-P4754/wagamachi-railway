import { WorldMap, TileData } from '../WorldMap';
import { GridLayer } from '../../core/types';
import { getMaxCapacity, getRunningCostPerTrip } from '../VehicleCatalog';
import { VehicleMeshBuilder } from '../../graphics/vehicles/VehicleMeshBuilder';
import { ArrivalDecision } from '../../core/ScheduleEngine';
import { TrainInstance, CargoHooks, CARGO_FARE_PER_CONTAINER_PER_TILE } from './types';

/**
 * 旅客・貨物ペイロード・駅需要専門クラス
 */
export class TrainPayloadSystem {
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
    worldMap: WorldMap
  ): void {
    if (train.passengers <= 0) return;

    let alighting = 0;
    if (arrival.isReverse || arrival.mode === 'reverse' || isDeadEnd) {
      alighting = train.passengers;
    } else {
      const alightRatio = 0.35 + Math.random() * 0.25;
      alighting = Math.min(train.passengers, Math.max(1, Math.round(train.passengers * alightRatio)));
    }
    train.passengers = Math.max(0, train.passengers - alighting);

    if (alighting > 0) {
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
    if (train.model.category === 'freight') return;
    if (!stoppedTile) return;

    const isYard = stoppedTile.type === 'signal_yard';
    const isCargo = stoppedTile.type.startsWith('cargo_station') || !!stoppedTile.isCargoYard;
    if (isYard || isCargo) return;

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

      const fare = Math.round(train.model.farePerRide * boarding);
      train.totalPassengers += boarding;
      train.totalRevenue += fare;
      train.monthlyProfit = train.totalRevenue - train.totalCost;

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
    if (!cargoHooks) return;
    const capacity = train.cargoCapacity ?? 0;
    const freeSlots = capacity - (train.cargoLoad ?? 0);
    if (freeSlots <= 0) return;

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
   * 商業エリアの貨物駅での荷降ろし・運賃計算処理 (Cargo Unloading)
   */
  public processCargoUnloading(
    train: TrainInstance,
    cargoHooks: CargoHooks | undefined,
    onPassengerFare: (amount: number) => void,
    worldMap: WorldMap
  ): void {
    if (!cargoHooks || (train.cargoLoad ?? 0) <= 0) return;

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
    let residenceCount = 0;
    let commercialCount = 0;
    let industrialCount = 0;
    let weightedScore = 0;

    for (let dx = -5; dx <= 5; dx++) {
      for (let dz = -5; dz <= 5; dz++) {
        if (dx === 0 && dz === 0) continue;
        const tx = centerX + dx;
        const tz = centerZ + dz;
        const t = worldMap.getTile(tx, tz, 1);
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
