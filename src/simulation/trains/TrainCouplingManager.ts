import * as THREE from 'three';
import { WorldMap, TileData, SplitConfig } from '../WorldMap';
import { ModelFactory } from '../../models/ModelFactory';
import { AudioManager } from '../../engine/AudioManager';
import { GridLayer } from '../../core/types';
import { GRID_LAYERS } from '../../core/constants';
import { getMaxCapacity } from '../VehicleCatalog';
import { VehicleMeshBuilder } from '../../graphics/vehicles/VehicleMeshBuilder';
import { TrainInstance, PathSample } from './types';
import { TrainKinematics } from './TrainKinematics';

/**
 * 編成の結合・分割専門クラス
 */
export class TrainCouplingManager {
  private kinematics: TrainKinematics;

  constructor(kinematics: TrainKinematics) {
    this.kinematics = kinematics;
  }

  /**
   * 停止中の先行列車(leader)の最後尾に後続列車(follower)が接触したかを高精度に判定する
   * 先行列車の最後尾車両の後端に後続列車の前端が接触した時点で true を返す
   */
  public checkCouplingContact(
    follower: TrainInstance,
    leader: TrainInstance,
    _worldMap?: WorldMap
  ): boolean {
    if (!leader.isStopped) return false;
    if (leader.carCount <= 0 || follower.carCount <= 0) return false;
    if (leader.currentTile.layer !== follower.currentTile.layer) return false;

    // 先行列車の最後尾車両を取得
    const rearIndex = leader.carCount - 1;
    const rearCar = leader.cars[rearIndex];
    if (!rearCar) return false;

    // 鉛直方向（高低差）チェック
    if (Math.abs(rearCar.position.y - follower.frontPosition.y) > 1.5) {
      return false;
    }

    // 先行車最後尾車両の中心から、後続車前端への相対ベクトル
    const dx = rearCar.position.x - follower.frontPosition.x;
    const dz = rearCar.position.z - follower.frontPosition.z;
    const horizontalDist = Math.hypot(dx, dz);

    // ★追加: 進行方向に対する横方向のズレ（隣のホーム・別線路）を厳密に排除
    // 1マスの幅は2.0m。同一線路上の連結であれば横ズレ(lateralDist)はほぼ0になる
    const lateralDist = Math.abs(dx * follower.direction.z - dz * follower.direction.x);
    if (lateralDist > 0.45) {
      return false;
    }

    // 後続列車の進行方向との内積（follower が最後尾に向かって進んでいるか）
    const dot = dx * follower.direction.x + dz * follower.direction.z;

    if (horizontalDist <= 1.35 && dot >= -0.3) {
      return true;
    }

    return false;
  }

  /**
   * Phase3 ①: 併合（連結）処理
   * 後続編成(follower)を先行編成(leader)の最後尾に合体させ、「1本の統合編成（親編成の名称・ダイヤを継承）」とする。
   */
  public performCoupling(
    leader: TrainInstance,
    follower: TrainInstance,
    audioManager: AudioManager,
    getDistanceFactor: (pos: { x: number; z: number }) => number,
    updateTrainCarCount: (trainId: number, carCount: number) => boolean,
    disposeTrainMesh: (train: TrainInstance) => void,
    onTrainCoupled?: (leaderTrain: TrainInstance, followerTrain: TrainInstance) => void
  ): void {
    const combinedCars = leader.carCount + follower.carCount;
    disposeTrainMesh(follower);

    // 両編成の走行履歴（pathHistory）を隙間なく連続した1本の履歴として結合
    if (leader.pathHistory.length > 0 && follower.pathHistory.length > 0) {
      const leaderHeadDist = leader.pathHistory[leader.pathHistory.length - 1].dist;
      const followerHeadDist = follower.pathHistory[follower.pathHistory.length - 1].dist;
      // follower の先頭車が結合されるべき位置（leader 先頭から leader.carCount * CAR_SPACING 後方）
      const targetFollowerHeadDist = leaderHeadDist - leader.carCount * ModelFactory.CAR_SPACING;
      const distOffset = targetFollowerHeadDist - followerHeadDist;

      const adjustedFollowerHist = follower.pathHistory.map(s => ({
        pos: s.pos.clone(),
        yaw: s.yaw,
        pitch: s.pitch,
        cant: s.cant,
        dist: s.dist + distOffset,
        layer: s.layer
      }));

      // leader の履歴のうち、結合点より前の部分を保持し、後ろに follower の履歴を結合
      const validLeaderHist = leader.pathHistory.filter(s => s.dist > targetFollowerHeadDist);
      leader.pathHistory = [...adjustedFollowerHist, ...validLeaderHist];
    }

    updateTrainCarCount(leader.id, combinedCars);
    this.kinematics.applyCarTransforms(leader);

    // アクションSE: 車両連結音
    const distFactor = getDistanceFactor({ x: leader.frontPosition.x, z: leader.frontPosition.z });
    audioManager.playCouplingSound(distFactor);

    // 乗客・積荷データの引き継ぎ
    const leaderMaxCap = getMaxCapacity(leader.model, combinedCars);
    leader.passengers = Math.min(leaderMaxCap, leader.passengers + follower.passengers);
    if (leader.model.category === 'freight' || follower.model.category === 'freight') {
      leader.cargoCapacity = Math.max(0, (combinedCars - 1) * 3);
      leader.cargoLoad = Math.min(leader.cargoCapacity, (leader.cargoLoad ?? 0) + (follower.cargoLoad ?? 0));
    }
    leader.totalPassengers += follower.totalPassengers;
    leader.totalRevenue += follower.totalRevenue;
    leader.totalCost += follower.totalCost;

    // 連結作業時間: 既存の駅ダイヤモードを維持しつつ最低2分待機させる（'wait'への強制上書きを廃止）
    leader.isStopped = true;
    if (!leader.stopMode || leader.stopMode === 'pass') {
      leader.stopMode = 'hold';
    }
    leader.stopElapsedMinutes = 0;
    leader.requiredStopMinutes = Math.max(leader.requiredStopMinutes ?? 0, 2);

    if (onTrainCoupled) {
      onTrainCoupled(leader, follower);
    }
  }

  /**
   * Phase3 ②: 分割（切り離し）処理
   * 到着した編成(train)を「前○両／後○両」に分離する。
   */
  public performSplit(
    train: TrainInstance,
    config: SplitConfig,
    tile: TileData,
    nextTrainId: () => number,
    scene: THREE.Scene,
    audioManager: AudioManager,
    worldMap: WorldMap,
    getDistanceFactor: (pos: { x: number; z: number }) => number,
    updateTrainCarCount: (trainId: number, carCount: number) => boolean,
    onTrainSplit?: (parentTrain: TrainInstance, splitTrain: TrainInstance) => void
  ): TrainInstance {
    const requiredStopMinutes = 2;

    const rearSamples: PathSample[] = [];
    const startLag = config.frontCars * ModelFactory.CAR_SPACING;
    const endLag = (config.frontCars + config.rearCars - 1) * ModelFactory.CAR_SPACING;
    const steps = Math.max(1, Math.ceil((endLag - startLag) / 0.5));
    for (let k = 0; k <= steps; k++) {
      const lagDist = startLag + (endLag - startLag) * (k / steps);
      const s = this.kinematics.sampleHistoryAtLag(train.pathHistory, lagDist);
      rearSamples.push(s);
    }

    const originalPassengers = train.passengers;
    const totalCars = config.frontCars + config.rearCars;
    const rearPassengerRatio = config.rearCars / totalCars;
    const rearPassengers = Math.floor(originalPassengers * rearPassengerRatio);
    const frontPassengers = originalPassengers - rearPassengers;

    train.passengers = frontPassengers;

    let rearCargoLoad = 0;
    if (train.model.category === 'freight') {
      const frontCap = Math.max(0, (config.frontCars - 1) * 3);
      const rearCap = Math.max(0, (config.rearCars - 1) * 3);
      const originalCargo = train.cargoLoad ?? 0;

      if (frontCap + rearCap > 0 && originalCargo > 0) {
        rearCargoLoad = Math.min(rearCap, Math.round(originalCargo * (rearCap / (frontCap + rearCap))));
        let frontCargoLoad = Math.min(frontCap, originalCargo - rearCargoLoad);

        let remaining = originalCargo - (frontCargoLoad + rearCargoLoad);
        if (remaining > 0) {
          const rearAdd = Math.min(remaining, rearCap - rearCargoLoad);
          rearCargoLoad += rearAdd;
          remaining -= rearAdd;
        }
        if (remaining > 0) {
          const frontAdd = Math.min(remaining, frontCap - frontCargoLoad);
          frontCargoLoad += frontAdd;
          remaining -= frontAdd;
        }

        if (remaining > 0 && tile) {
          worldMap.addStationCargoContainers(tile.x, tile.z, remaining, tile.layer);
        }

        train.cargoLoad = frontCargoLoad;
      } else {
        train.cargoLoad = 0;
        rearCargoLoad = 0;
      }
      train.cargoCapacity = frontCap;
    }

    updateTrainCarCount(train.id, config.frontCars);
    train.isStopped = true;
    train.stopMode = 'wait';
    train.stopElapsedMinutes = 0;
    train.requiredStopMinutes = requiredStopMinutes;
    train.overrideDepartureRule = config.frontDeparture;
    train.isReversingAtStation = false;
    if (train.model.category === 'freight') {
      train.cargoCapacity = Math.max(0, (config.frontCars - 1) * 3);
      VehicleMeshBuilder.updateTrainCargoVisual(train.cars, train.cargoLoad ?? 0);
    }
    this.kinematics.applyCarTransforms(train);

    const distFactor = getDistanceFactor({ x: train.frontPosition.x, z: train.frontPosition.z });
    audioManager.playDecouplingSound(distFactor);

    const rearId = nextTrainId();
    const { group: rearGroup, cars: rearCars } = ModelFactory.createTrainFormation(train.model, config.rearCars);
    scene.add(rearGroup);

    let rearFrontPos: THREE.Vector3;
    let rearDir: THREE.Vector3;
    let rearTileX: number;
    let rearTileZ: number;
    let rearLayer: GridLayer = train.currentTile.layer;
    let rearTargetTile: { x: number; z: number; layer: GridLayer };
    const rearHistory: PathSample[] = [];

    if (config.rearReverses) {
      const newFrontSample = rearSamples[rearSamples.length - 1];
      rearFrontPos = newFrontSample.pos.clone();
      rearDir = train.direction.clone().negate();
      rearTileX = Math.round(rearFrontPos.x / WorldMap.TILE_SIZE);
      rearTileZ = Math.round(rearFrontPos.z / WorldMap.TILE_SIZE);

      rearLayer = (newFrontSample.layer ?? train.currentTile.layer) as GridLayer;
      let minDiff = Infinity;
      for (const lyr of GRID_LAYERS) {
        const t = worldMap.getTile(rearTileX, rearTileZ, lyr);
        if (t && this.kinematics.isTrackTile(t)) {
          const h = this.kinematics.getTileInterpolatedHeight(t, lyr);
          const diff = Math.abs(h - newFrontSample.pos.y);
          if (diff < minDiff) {
            minDiff = diff;
            rearLayer = lyr;
          }
        }
      }

      const next = this.kinematics.findNextTrackTile(rearTileX, rearTileZ, rearLayer, rearDir, true, worldMap);
      if (next) {
        rearDir.copy(new THREE.Vector3(next.x - rearTileX, 0, next.z - rearTileZ).normalize());
        rearTargetTile = { x: next.x, z: next.z, layer: (next.layer ?? rearLayer) as GridLayer };
      } else {
        rearTargetTile = { x: rearTileX, z: rearTileZ, layer: rearLayer };
      }

      let accumDist = 0;
      for (let k = 0; k < rearSamples.length; k++) {
        const s = rearSamples[k];
        if (rearHistory.length > 0) {
          accumDist += s.pos.distanceTo(rearHistory[rearHistory.length - 1].pos);
        }
        let reversedYaw = s.yaw + Math.PI;
        while (reversedYaw < -Math.PI) reversedYaw += Math.PI * 2;
        while (reversedYaw > Math.PI) reversedYaw -= Math.PI * 2;
        rearHistory.push({
          pos: s.pos.clone(),
          yaw: reversedYaw,
          pitch: -s.pitch,
          cant: -s.cant,
          dist: accumDist,
          layer: s.layer ?? rearLayer
        });
      }
    } else {
      const frontSample = rearSamples[0];
      rearFrontPos = frontSample.pos.clone();
      rearDir = train.direction.clone();
      rearTileX = Math.round(rearFrontPos.x / WorldMap.TILE_SIZE);
      rearTileZ = Math.round(rearFrontPos.z / WorldMap.TILE_SIZE);

      rearLayer = (frontSample.layer ?? train.currentTile.layer) as GridLayer;
      let minDiff = Infinity;
      for (const lyr of GRID_LAYERS) {
        const t = worldMap.getTile(rearTileX, rearTileZ, lyr);
        if (t && this.kinematics.isTrackTile(t)) {
          const h = this.kinematics.getTileInterpolatedHeight(t, lyr);
          const diff = Math.abs(h - frontSample.pos.y);
          if (diff < minDiff) {
            minDiff = diff;
            rearLayer = lyr;
          }
        }
      }

      const next = this.kinematics.findNextTrackTile(rearTileX, rearTileZ, rearLayer, rearDir, false, worldMap);
      if (next) {
        rearTargetTile = { x: next.x, z: next.z, layer: (next.layer ?? rearLayer) as GridLayer };
      } else {
        rearTargetTile = { ...train.targetTile };
      }

      let accumDist = 0;
      for (let k = rearSamples.length - 1; k >= 0; k--) {
        const s = rearSamples[k];
        if (rearHistory.length > 0) {
          accumDist += s.pos.distanceTo(rearHistory[rearHistory.length - 1].pos);
        }
        rearHistory.push({
          pos: s.pos.clone(),
          yaw: s.yaw,
          pitch: s.pitch,
          cant: s.cant,
          dist: accumDist,
          layer: s.layer ?? rearLayer
        });
      }
    }

    const rearTrain: TrainInstance = {
      id: rearId,
      name: `${train.name}-付属`,
      model: train.model,
      carCount: config.rearCars,
      mesh: rearGroup,
      frontPosition: rearFrontPos,
      currentTile: { x: rearTileX, z: rearTileZ, layer: rearLayer },
      targetTile: rearTargetTile,
      direction: rearDir,
      progress: 0,
      speed: train.speed,
      isStopped: true,
      isAtsBraked: false,
      isSignalStopped: false,
      occupiedTiles: [],
      stopTimer: 0,
      passengers: rearPassengers,
      capacity: train.model.baseCapacity * config.rearCars,
      isReversed: config.rearReverses ? !train.isReversed : train.isReversed,
      cars: rearCars,
      heightY: train.heightY,
      pathHistory: rearHistory,
      totalPassengers: 0,
      totalRevenue: 0,
      totalCost: 0,
      monthlyProfit: 0,
      fleetId: train.fleetId ? `${train.fleetId}-split` : undefined,
      // ★修正: stationPlatformId を優先してセット
      lastStationGroupId: tile.stationPlatformId ?? tile.stationGroupId ?? null,
      isReversingAtStation: false, // 既に performSplit 内で rearDir と rearHistory を反転構築しているため、発車時の再反転フラグは false にする
      cargoLoad: rearCargoLoad,
      cargoCapacity: train.model.category === 'freight' ? Math.max(0, (config.rearCars - 1) * 3) : 0,
      cargoPickup: train.cargoPickup ? { ...train.cargoPickup } : null,
      cargoTraveledTiles: train.cargoTraveledTiles ?? 0,
      stopMode: 'wait',
      stopElapsedMinutes: 0,
      requiredStopMinutes,
      overrideDepartureRule: config.rearDeparture
    };

    if (train.model.category === 'freight') {
      VehicleMeshBuilder.updateTrainCargoVisual(rearCars, rearCargoLoad);
    }

    this.kinematics.applyCarTransforms(rearTrain);

    if (onTrainSplit) {
      onTrainSplit(train, rearTrain);
    }

    return rearTrain;
  }
}
