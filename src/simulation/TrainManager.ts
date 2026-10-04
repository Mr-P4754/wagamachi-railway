import * as THREE from 'three';
import { WorldMap, TileData, TileExit, SwitchState, CrossingState, getSwitchDirectionAtTime } from './WorldMap';
import { ModelFactory } from '../models/ModelFactory';
import { AudioManager } from '../engine/AudioManager';
import { FollowTarget } from '../graphics/CameraManager';
import { VehicleModelInfo, getVehicleById, getRunningCostPerDay } from './VehicleCatalog';
import { BlockSignalManager } from '../core/BlockSignal';
import { GridLayer, DeadlockEvent } from '../core/types';
import { GRID_LAYERS } from '../core/constants';
import { layerToHeight } from '../core/Grid3D';
import * as ScheduleEngine from '../core/ScheduleEngine';
import { checkCoupleEligibility, validateSplitConfig } from '../core/CouplingSystem';
import { disposeHierarchy } from '../graphics/materials';
import { VehicleMeshBuilder } from '../graphics/vehicles/VehicleMeshBuilder';

// 専門クラス群および共通型定義のインポート
import { TrainInstance, PathSample, IntermediateSample, CargoHooks } from './trains/types';
import { TrainKinematics } from './trains/TrainKinematics';
import { TrainCollisionSystem } from './trains/TrainCollisionSystem';
import { TrainCouplingManager } from './trains/TrainCouplingManager';
import { TrainPayloadSystem } from './trains/TrainPayloadSystem';

// 既存コードからの参照互換性のための再エクスポート
export * from './trains/types';
export { TrainKinematics } from './trains/TrainKinematics';
export { TrainCollisionSystem } from './trains/TrainCollisionSystem';
export { TrainCouplingManager } from './trains/TrainCouplingManager';
export { TrainPayloadSystem } from './trains/TrainPayloadSystem';

/**
 * 列車運行シミュレーション オーケストレーター（メインファサード）
 */
export class TrainManager {
  private trains: TrainInstance[] = [];
  public blockSignalManager: BlockSignalManager = new BlockSignalManager();
  public onDeadlockDetected?: (event: DeadlockEvent) => void;
  public onTrainSplit?: (parentTrain: TrainInstance, splitTrain: TrainInstance) => void;
  public onTrainCoupled?: (leaderTrain: TrainInstance, followerTrain: TrainInstance) => void;
  private scene: THREE.Scene;
  private worldMap: WorldMap;
  private audioManager: AudioManager;
  private nextTrainId: number = 1;
  private soundTimer: number = 0;
  private listenerPosition: { x: number; z: number } = { x: 0, z: 0 };
  private lastUpdateHour: number = -1;
  private lastUpdateMinute: number = -1;

  // 専門クラスインスタンス
  public readonly kinematics: TrainKinematics = new TrainKinematics();
  public readonly collisionSystem: TrainCollisionSystem = new TrainCollisionSystem(this.kinematics);
  public readonly couplingManager: TrainCouplingManager = new TrainCouplingManager(this.kinematics);
  public readonly payloadSystem: TrainPayloadSystem = new TrainPayloadSystem();

  // 編成単位カリング用の一時オブジェクト
  private readonly cullFrustum = new THREE.Frustum();
  private readonly cullProjScreen = new THREE.Matrix4();
  private readonly cullBox = new THREE.Box3();
  private static readonly CULL_MARGIN = 1.5;

  constructor(scene: THREE.Scene, worldMap: WorldMap, audioManager: AudioManager) {
    this.scene = scene;
    this.worldMap = worldMap;
    this.audioManager = audioManager;
    this.blockSignalManager.onDeadlockDetected = (event) => {
      if (this.onDeadlockDetected) {
        this.onDeadlockDetected(event);
      }
    };
  }

  /**
   * 3D空間音響用カメラ注視点の登録
   */
  public setListenerPosition(pos: { x: number; z: number }): void {
    this.listenerPosition = pos;
  }

  /**
   * 注視点からの距離減衰係数（0.0〜1.0）を算出
   */
  public getDistanceFactor(pos: { x: number; z: number }): number {
    const dx = pos.x - this.listenerPosition.x;
    const dz = pos.z - this.listenerPosition.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist <= 12) return 1.0;
    return Math.max(0.0, 1.0 / (1.0 + (dist - 12) * 0.05));
  }

  public getTrains(): TrainInstance[] {
    return this.trains;
  }

  /**
   * カメラ視錐台カリング（画面外の編成非表示）
   */
  public applyVisibility(camera: THREE.Camera, isLayerVisible: (layer: GridLayer) => boolean): void {
    camera.updateMatrixWorld();
    this.cullProjScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.cullFrustum.setFromProjectionMatrix(this.cullProjScreen);

    for (const train of this.trains) {
      const curLyr = train.currentTile.layer;
      const tgtLyr = train.targetTile.layer;
      const curVis = isLayerVisible(curLyr);
      const tgtVis = isLayerVisible(tgtLyr);

      if (!curVis && !tgtVis) {
        train.mesh.visible = false;
        continue;
      }

      this.cullBox.makeEmpty();
      this.cullBox.expandByPoint(train.frontPosition);
      for (const car of train.cars) {
        this.cullBox.expandByPoint(car.position);
      }
      this.cullBox.min.x -= TrainManager.CULL_MARGIN;
      this.cullBox.min.y -= TrainManager.CULL_MARGIN;
      this.cullBox.min.z -= TrainManager.CULL_MARGIN;
      this.cullBox.max.x += TrainManager.CULL_MARGIN;
      this.cullBox.max.y += TrainManager.CULL_MARGIN;
      this.cullBox.max.z += TrainManager.CULL_MARGIN;

      train.mesh.visible = this.cullFrustum.intersectsBox(this.cullBox);
    }
  }

  public getTrainById(id: number): TrainInstance | undefined {
    return this.trains.find(t => t.id === id);
  }

  /**
   * 新しい列車インスタンスを生成して配置
   */
  public spawnTrain(
    x: number,
    z: number,
    modelInfo: VehicleModelInfo = getVehicleById('commuter-train'),
    carCount: number = 3,
    initialDirIdx?: number,
    fleetId?: string,
    layer?: GridLayer,
    overrideId?: number,
    initialPassengers: number = 0,
    initialCargoLoad?: number
  ): TrainInstance | null {
    const spawnLayer: GridLayer = layer ?? (this.worldMap.getTile(x, z)?.layer ?? this.worldMap.activeLayer);
    const tile = this.worldMap.getTile(x, z, spawnLayer);
    if (!tile || !this.kinematics.isTrackTile(tile)) return null;

    const elevOffset = tile.elevationOffset ?? 0;
    const baseHeight = layerToHeight(spawnLayer, elevOffset);

    // 車両編成の3Dメッシュ生成
    const { group: trainGroup, cars } = ModelFactory.createTrainFormation(modelInfo, carCount);
    this.scene.add(trainGroup);

    const spawnPos = new THREE.Vector3(x * WorldMap.TILE_SIZE, baseHeight, z * WorldMap.TILE_SIZE);
    const exits = WorldMap.getTileExits(tile);
    let chosenDirIdx: number;
    if (initialDirIdx !== undefined) {
      chosenDirIdx = initialDirIdx;
    } else {
      chosenDirIdx = exits.length > 0 ? exits[0].idx : (tile.rotation === 1 ? 1 : 2);
    }
    const dirVec = WorldMap.DIRS[chosenDirIdx];
    const dir = new THREE.Vector3(dirVec.x, 0, dirVec.z).normalize();
    const nextTile = this.kinematics.findNextTrackTile(x, z, spawnLayer, dir, true, this.worldMap);

    const speedTilesPerSec = modelInfo.speedTilesPerMinute ?? 1.5;
    const initialYaw = Math.atan2(dir.x, dir.z);

    cars.forEach((car, i) => {
      car.rotation.order = 'YXZ';
      car.position.copy(spawnPos).addScaledVector(dir, -i * ModelFactory.CAR_SPACING);
      car.rotation.set(0, initialYaw, 0);
    });

    const initialHistory: PathSample[] = [];
    let accumDist = 0;
    for (let i = carCount - 1; i >= 0; i--) {
      const pos = spawnPos.clone().addScaledVector(dir, -i * ModelFactory.CAR_SPACING);
      if (initialHistory.length > 0) {
        accumDist += pos.distanceTo(initialHistory[initialHistory.length - 1].pos);
      }
      initialHistory.push({
        pos,
        yaw: initialYaw,
        pitch: 0,
        cant: 0,
        dist: accumDist,
        layer: spawnLayer
      });
    }

    const actualId = (overrideId !== undefined && overrideId > 0) ? overrideId : this.nextTrainId++;
    if (actualId >= this.nextTrainId) {
      this.nextTrainId = actualId + 1;
    }

    const nextLayer: GridLayer = (nextTile?.layer ?? spawnLayer) as GridLayer;
    const isFreight = modelInfo.category === 'freight';
    const cargoCapacity = isFreight ? Math.max(0, (carCount - 1) * 3) : 0;
    const actualCargoLoad = isFreight
      ? (initialCargoLoad !== undefined ? Math.min(cargoCapacity, initialCargoLoad) : 0)
      : undefined;

    const train: TrainInstance = {
      id: actualId,
      name: `${modelInfo.name} ${actualId}号`,
      model: modelInfo,
      carCount,
      mesh: trainGroup,
      frontPosition: spawnPos.clone(),
      currentTile: { x, z, layer: spawnLayer },
      targetTile: nextTile ? { x: nextTile.x, z: nextTile.z, layer: nextLayer } : { x, z, layer: spawnLayer },
      direction: dir,
      progress: 0,
      speed: speedTilesPerSec,
      isStopped: false,
      isAtsBraked: false,
      isSignalStopped: false,
      isTrapped: false,
      occupiedTiles: [{ x, z, layer: spawnLayer }],
      stopTimer: 0,
      passengers: initialPassengers,
      capacity: isFreight ? 0 : modelInfo.baseCapacity * carCount,
      isReversed: false,
      cars,
      heightY: baseHeight,
      pathHistory: initialHistory,
      totalPassengers: initialPassengers,
      totalRevenue: 0,
      totalCost: 0,
      monthlyProfit: 0,
      fleetId,
      lastStationGroupId: null,
      cargoLoad: actualCargoLoad,
      cargoCapacity,
      cargoPickup: null,
      cargoTraveledTiles: 0,
      stopMode: null,
      stopElapsedMinutes: 0,
      requiredStopMinutes: 0,
      overrideDepartureRule: null
    };

    this.kinematics.applyCarTransforms(train);
    train.occupiedTiles = this.collisionSystem.calculateOccupiedTiles(train, this.worldMap);

    if (isFreight) {
      VehicleMeshBuilder.updateTrainCargoVisual(train.cars, actualCargoLoad ?? 0);
    }

    this.trains.push(train);
    return train;
  }

  /**
   * メイン更新ループ（パイプライン化）
   */
  public update(
    deltaTime: number,
    speedMultiplier: number,
    onPassengerFare: (amount: number) => void,
    currentHour: number = 0,
    currentMinute: number = 0,
    _getDemandMultiplier?: (x: number, z: number, hour: number) => number,
    cargoHooks?: CargoHooks,
    onPassengerCost?: (amount: number) => void
  ): void {
    if (this.trains.length === 0 || speedMultiplier <= 0) return;

    // =========================================================================
    // ステップ 1: 時間進行・サブステップ幅の算出
    // =========================================================================
    const clampedDelta = Math.min(deltaTime, 0.05);
    const dt = clampedDelta * speedMultiplier;

    const MAX_SUB_STEP_PROGRESS = speedMultiplier >= 60 ? 0.85 : 0.25;
    let maxSpeed = 1.5;
    for (const t of this.trains) {
      if (t.speed > maxSpeed) maxSpeed = t.speed;
    }
    const maxProgressInFrame = maxSpeed * dt;
    const maxAllowedSteps = speedMultiplier >= 60 ? 12 : 6;
    const numSubSteps = Math.min(Math.max(1, Math.ceil(maxProgressInFrame / MAX_SUB_STEP_PROGRESS)), maxAllowedSteps);
    const subDt = dt / numSubSteps;

    const currentFrameTotalMin = ((currentHour % 24) * 60 + currentMinute) % 1440;
    const prevFrameTotalMin = this.lastUpdateHour >= 0
      ? ((this.lastUpdateHour % 24) * 60 + this.lastUpdateMinute) % 1440
      : currentFrameTotalMin;
    const frameElapsedMin = (currentFrameTotalMin - prevFrameTotalMin + 1440) % 1440;

    const trainsPendingRemoval: number[] = [];
    const trainsPendingAdd: TrainInstance[] = [];
    let hasOccupancyChanged = true;

    // =========================================================================
    // ステップ 2: サブステップループ
    // =========================================================================
    for (let step = 0; step < numSubSteps; step++) {
      const shouldRecordHistory = speedMultiplier < 60 || step === numSubSteps - 1;

      const stepStartTotalMin = (prevFrameTotalMin + (frameElapsedMin * step) / numSubSteps) % 1440;
      const stepEndTotalMin = (step === numSubSteps - 1)
        ? currentFrameTotalMin
        : (prevFrameTotalMin + (frameElapsedMin * (step + 1)) / numSubSteps) % 1440;

      const subStepPrevHour = Math.floor(stepStartTotalMin / 60) % 24;
      const subStepPrevMinute = Math.floor(stepStartTotalMin % 60);
      const subStepHour = Math.floor(stepEndTotalMin / 60) % 24;
      const subStepMinute = Math.floor(stepEndTotalMin % 60);

      // (2-A) 在線ロック更新 ＆ 閉塞更新
      const activeTrains = this.trains.filter(t => !trainsPendingRemoval.includes(t.id));
      for (const train of activeTrains) {
        const isStatic = !!(train.isStopped || train.isSignalStopped || train.isAtsBraked || train.isTrapped);
        if (isStatic && train.occupiedTiles && train.occupiedTiles.length > 0) {
          continue;
        }
        train.occupiedTiles = this.collisionSystem.calculateOccupiedTiles(train, this.worldMap);
        hasOccupancyChanged = true;
      }
      this.blockSignalManager.updateOccupancy(
        activeTrains.map(t => ({
          id: t.id,
          name: t.name,
          carCount: t.carCount,
          occupiedTiles: t.occupiedTiles,
          isStopped: !!(t.isStopped || t.isSignalStopped || t.isAtsBraked || t.isTrapped),
          isDeadlocked: !!((t.isSignalStopped || t.isAtsBraked || t.isTrapped) && !t.isStopped),
          speed: t.speed
        })),
        subDt,
        hasOccupancyChanged
      );
      hasOccupancyChanged = false;

      // (2-B) ATS 衝突防止チェック
      this.collisionSystem.checkAtsCollisionAvoidance(activeTrains, this.worldMap, speedMultiplier);

      // (2-C) 各編成の移動・停車・発車制御
      for (const train of this.trains) {
        if (trainsPendingRemoval.includes(train.id)) continue;

        // 孤立状態の復帰チェック
        if (train.isTrapped) {
          const forwardNext = this.kinematics.findNextTrackTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer, train.direction, false, this.worldMap);
          if (forwardNext) {
            train.isTrapped = false;
            train.speed = train.model.speedTilesPerMinute ?? 1.5;
            this.kinematics.resolveNextTileOrReverse(train, this.worldMap);
          } else {
            const reverseDir = train.direction.clone().negate();
            const lagDist = (train.carCount - 1) * ModelFactory.CAR_SPACING;
            const oldRearSample = this.kinematics.sampleHistoryAtLag(train.pathHistory, lagDist);
            const rearX = Math.round(oldRearSample.pos.x / WorldMap.TILE_SIZE);
            const rearZ = Math.round(oldRearSample.pos.z / WorldMap.TILE_SIZE);
            const reverseNext = this.kinematics.findNextTrackTile(rearX, rearZ, train.currentTile.layer, reverseDir, true, this.worldMap);
            if (reverseNext) {
              train.isTrapped = false;
              train.speed = train.model.speedTilesPerMinute ?? 1.5;
              this.kinematics.reverseTrainDirection(train, this.worldMap);
            } else {
              continue;
            }
          }
        }

        // 駅停車中判定 ＆ 発車評価
        if (train.isStopped) {
          train.stopElapsedMinutes = (train.stopElapsedMinutes ?? 0) + subDt;

          const stoppedTile = this.worldMap.getTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer);
          const liveSchedule = stoppedTile?.stationSchedule;
          const mode = train.stopMode ?? 'stop';
          const required = train.requiredStopMinutes ?? 0;

          let canDeparture = !!train.isSignalStopped;
          let shouldReverse = !!train.isReversingAtStation;

          const currentTotalMin = Math.floor(stepEndTotalMin);
          const isSameMinuteAsLastDep = train.lastDepartureMinute !== undefined &&
            Math.abs(((train.lastDepartureMinute % 1440) - (currentTotalMin % 1440) + 1440) % 1440) === 0;

          if (!canDeparture && !isSameMinuteAsLastDep) {
            if (train.overrideDepartureRule) {
              const rule = train.overrideDepartureRule;
              const prevTotal = Math.floor(stepStartTotalMin);

              if (rule.mode === 'timer') {
                canDeparture = (train.stopElapsedMinutes ?? 0) >= required;
              } else if (rule.mode === 'pattern') {
                const patMin = rule.patternMinute ?? 0;
                const interval = rule.patternIntervalMinutes ?? 60;
                canDeparture = ScheduleEngine.isPatternIntervalInRange(prevTotal, currentTotalMin, patMin, interval);
              } else if (rule.mode === 'specific') {
                const specMin = (((rule.specificHour ?? 0) % 24) * 60 + (rule.specificMinute ?? 0)) % 1440;
                canDeparture = ScheduleEngine.isMinuteInRange(prevTotal, currentTotalMin, specMin);
              }
            } else {
              const evalResult = ScheduleEngine.evaluateStationDeparture(
                liveSchedule,
                subStepHour,
                subStepMinute,
                train.stopElapsedMinutes ?? 0,
                mode,
                required,
                shouldReverse,
                subStepPrevHour,
                subStepPrevMinute
              );
              canDeparture = evalResult.canDepart;
              shouldReverse = evalResult.shouldReverse || !!train.isReversingAtStation;
            }
          }

          if (canDeparture) {
            if (!train.isSignalStopped) {
              if (shouldReverse) {
                train.isReversingAtStation = false;
                this.kinematics.reverseTrainDirection(train, this.worldMap);
              } else {
                this.kinematics.resolveNextTileOrReverse(train, this.worldMap);
              }
            }

            const toLayer = train.targetTile.layer;
            const canEnter = this.blockSignalManager.canEnterTile(train.id, train.targetTile.x, train.targetTile.z, toLayer);
            if (!canEnter) {
              train.isSignalStopped = true;
              continue;
            }

            // 乗車処理
            this.payloadSystem.processBoarding(train, stoppedTile ?? null, this.worldMap, onPassengerFare, onPassengerCost);

            train.lastDepartureMinute = currentTotalMin;
            train.isSignalStopped = false;
            train.isStopped = false;
            train.stopMode = null;
            train.stopElapsedMinutes = 0;
            train.overrideDepartureRule = null;
            this.audioManager.playStationBell();
          }
          continue;
        }

        // 閉塞信号による停止判定
        const toLayer = train.targetTile.layer;
        const canEnterBlock = this.blockSignalManager.canEnterTile(train.id, train.targetTile.x, train.targetTile.z, toLayer);
        if (!canEnterBlock) {
          train.isSignalStopped = true;
          continue;
        } else {
          train.isSignalStopped = false;
        }

        if (train.isAtsBraked) {
          continue;
        }

        // 前進
        train.progress += (train.speed * subDt);

        let tileLoopCount = 0;
        while (train.progress >= 1.0 && tileLoopCount++ < 10) {
          train.progress -= 1.0;
          train.currentTile = { ...train.targetTile };
          hasOccupancyChanged = true;
          if (shouldRecordHistory) {
            this.kinematics.recordCurrentHeadSample(train, this.worldMap);
          } else {
            this.kinematics.updateTrainFrontPosition(train, this.worldMap);
          }

          if ((train.cargoLoad ?? 0) > 0) {
            train.cargoTraveledTiles = (train.cargoTraveledTiles ?? 0) + 1;
          }

          const curTileData = this.worldMap.getTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer);
          const isStationOrYard = curTileData && WorldMap.isStationTileType(curTileData.type);
          let wasAbsorbedByCoupling = false;

          if (isStationOrYard && curTileData) {
            const isYard = curTileData.type === 'signal_yard';
            const isCargo = curTileData.type.startsWith('cargo_station') || !!curTileData.isCargoYard;
            const isFreight = train.model.category === 'freight';
            const stGroupId = curTileData.stationGroupId || (() => {
              const st = this.worldMap.getStationStartTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer);
              return st ? `st_${st.x}_${st.z}` : `st_${train.currentTile.x}_${train.currentTile.z}`;
            })();

            const peekNext = this.kinematics.findNextTrackTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer, train.direction, false, this.worldMap);
            const nextIsSameStation = !!(peekNext && WorldMap.isStationTileType(peekNext.type) && (
              peekNext.stationGroupId === stGroupId || (!peekNext.stationGroupId && !curTileData.stationGroupId)
            ));

            if (!nextIsSameStation && train.lastStationGroupId !== stGroupId) {
              train.lastStationGroupId = stGroupId;

              const effectiveLength = this.worldMap.getStationRunLength(train.currentTile.x, train.currentTile.z, train.currentTile.layer) || 1;
              let isTooLong = train.carCount > effectiveLength;

              if (!peekNext || isCargo || isYard) {
                isTooLong = false;
              }

              const schedule = curTileData.stationSchedule;
              const rawArrival = ScheduleEngine.resolveArrival(schedule, subStepHour, subStepMinute);
              if (isTooLong) {
                rawArrival.mode = 'pass';
                rawArrival.requiredStopMinutes = 0;
              }

              let arrival = rawArrival;
              if (rawArrival.mode !== 'pass') {
                if (isCargo && !isFreight) {
                  arrival = { ...rawArrival, mode: 'pass', requiredStopMinutes: 0 };
                } else if (!isCargo && !isYard && isFreight) {
                  arrival = { ...rawArrival, mode: 'pass', requiredStopMinutes: 0 };
                }
              }

              if (arrival.mode === 'pass') {
                if (arrival.isReverse) {
                  this.kinematics.reverseTrainDirection(train, this.worldMap);
                  train.progress = 0;
                  break;
                }
              } else {
                train.isStopped = true;
                train.progress = 0;
                if (shouldRecordHistory) {
                  this.kinematics.recordCurrentHeadSample(train, this.worldMap);
                } else {
                  this.kinematics.updateTrainFrontPosition(train, this.worldMap);
                }

                if (isCargo && isFreight && cargoHooks) {
                  const isCommercial = cargoHooks.isCommercialStation
                    ? cargoHooks.isCommercialStation(train.currentTile.x, train.currentTile.z, train.currentTile.layer)
                    : false;

                  if (isCommercial) {
                    this.payloadSystem.processCargoUnloading(train, cargoHooks, onPassengerFare, this.worldMap);
                  } else {
                    this.payloadSystem.processCargoLoading(train, cargoHooks, this.worldMap);
                  }
                } else if (!isYard && !isCargo && !isFreight) {
                  this.payloadSystem.processAlighting(train, arrival, !peekNext, this.worldMap);
                }

                // 分割判定
                let activeSplitConfig = arrival.splitConfig || schedule?.splitConfig;
                if (activeSplitConfig && activeSplitConfig.enabled && train.carCount >= 2) {
                  if (activeSplitConfig.frontCars + activeSplitConfig.rearCars !== train.carCount) {
                    const fCars = Math.max(1, Math.min(train.carCount - 1, activeSplitConfig.frontCars));
                    activeSplitConfig = {
                      ...activeSplitConfig,
                      frontCars: fCars,
                      rearCars: train.carCount - fCars
                    };
                  }
                }
                const splitCheck = (!isYard && !isTooLong && train.carCount >= 2)
                  ? validateSplitConfig(train.carCount, activeSplitConfig)
                  : { valid: false };

                if (splitCheck.valid && activeSplitConfig) {
                  const rearTrain = this.couplingManager.performSplit(
                    train,
                    activeSplitConfig,
                    curTileData,
                    () => this.nextTrainId++,
                    this.scene,
                    this.audioManager,
                    this.worldMap,
                    pos => this.getDistanceFactor(pos),
                    (id, count) => this.updateTrainCarCount(id, count),
                    this.onTrainSplit
                  );
                  trainsPendingAdd.push(rearTrain);
                } else {
                  // 併合（連結）判定
                  const leader = !isYard
                    ? this.trains.find(other =>
                        other.id !== train.id &&
                        other.isStopped &&
                        this.worldMap.getTile(other.currentTile.x, other.currentTile.z, other.currentTile.layer)?.stationGroupId === stGroupId
                      )
                    : undefined;

                  if (leader && checkCoupleEligibility(leader.carCount, train.carCount, effectiveLength).eligible) {
                    this.couplingManager.performCoupling(
                      leader,
                      train,
                      this.audioManager,
                      pos => this.getDistanceFactor(pos),
                      (id, count) => this.updateTrainCarCount(id, count),
                      t => this.disposeTrainMesh(t),
                      this.onTrainCoupled
                    );
                    wasAbsorbedByCoupling = true;
                  } else {
                    train.stopMode = arrival.mode;
                    train.stopElapsedMinutes = 0;
                    train.requiredStopMinutes = arrival.requiredStopMinutes;
                    train.isReversingAtStation = (arrival.mode === 'reverse') || !!arrival.isReverse;
                  }
                }
              }
            }
          } else {
            train.lastStationGroupId = null;
          }

          if (wasAbsorbedByCoupling) {
            this.disposeTrainMesh(train);
            train.occupiedTiles = [];
            train.speed = 0;
            train.isStopped = true;
            trainsPendingRemoval.push(train.id);
            train.progress = 0;
            break;
          }

          // 分岐器・シーサスクロッシング通過時のダイヤ制御
          if (curTileData && curTileData.type.startsWith('point_switch')) {
            const switchSched = curTileData.switchSchedule;
            if (switchSched) {
              if (switchSched.mode === 'alternate') {
                const nextState: SwitchState = curTileData.switchState === 'straight' ? 'diverge' : 'straight';
                this.worldMap.setSwitchState(train.currentTile.x, train.currentTile.z, nextState, train.currentTile.layer);
              } else if (switchSched.mode === 'timeline') {
                const targetDir = getSwitchDirectionAtTime(switchSched, currentHour, currentMinute);
                this.worldMap.setSwitchState(train.currentTile.x, train.currentTile.z, targetDir as SwitchState, train.currentTile.layer);
              }
            }
          } else if (curTileData && curTileData.type.startsWith('scissors_crossing')) {
            const origin = this.worldMap.resolveCrossingOrigin(train.currentTile.x, train.currentTile.z, train.currentTile.layer);
            const switchSched = origin?.switchSchedule;
            if (origin && switchSched && switchSched.mode === 'timeline') {
              const targetCrossing = getSwitchDirectionAtTime(switchSched, currentHour, currentMinute, true);
              this.worldMap.setCrossingState(origin.x, origin.z, targetCrossing as CrossingState, train.currentTile.layer);
            }
          }

          if (!train.isStopped) {
            this.kinematics.resolveNextTileOrReverse(train, this.worldMap);
          } else {
            train.progress = 0;
            break;
          }
        }

        if (train.progress >= 1.0) {
          train.progress = 0.999;
        }
      }

      // 次サブステップ用の先頭車位置更新
      for (const t of this.trains) {
        if (!trainsPendingRemoval.includes(t.id)) {
          if (shouldRecordHistory) {
            this.kinematics.recordCurrentHeadSample(t, this.worldMap);
          } else {
            this.kinematics.updateTrainFrontPosition(t, this.worldMap);
          }
        }
      }
    } // サブステップループ終了

    // =========================================================================
    // ステップ 3: 走行音（ジョイント音）の再生制御
    // =========================================================================
    // 実時間（リアルタイム秒）でタイマーを加算し、高倍速時のマシンガン発音やノード爆発を防止
    this.soundTimer += clampedDelta;

    const isCabActive = this.audioManager.getIsCabActive();

    let closestTrain: TrainInstance | null = null;
    let closestDistFactor = 0;
    for (const train of this.trains) {
      if (train.speed > 0.05 && !train.isStopped) {
        const factor = this.getDistanceFactor({
          x: train.frontPosition.x,
          z: train.frontPosition.z
        });
        if (factor > closestDistFactor) {
          closestDistFactor = factor;
          closestTrain = train;
        }
      }
    }

    // 距離事前カリング: カメラから遠く離れている（0.04未満）列車は発音処理自体をスキップ
    if (closestTrain && closestDistFactor >= 0.04) {
      // 走行速度に応じたピッチ・テンポ計算（安全な最小発音インターバル 0.12秒を保証）
      const trainSpeed = closestTrain.speed;
      const speedFactor = Math.min(2.5, Math.max(0.6, trainSpeed * (speedMultiplier >= 60 ? 1.8 : (speedMultiplier > 1 ? 1.3 : 1.0))));
      const intervalSec = Math.max(0.12, 1.2 / speedFactor);

      if (this.soundTimer >= intervalSec) {
        this.soundTimer = 0;

        // 前面展望中は車内モーター音・フロアノイズが主役のため、外部列車のジョイント音音量を抑えて歪みと多重干渉を防止
        const effectiveDistFactor = isCabActive ? closestDistFactor * 0.45 : closestDistFactor;

        if (effectiveDistFactor >= 0.04) {
          const cTile = this.worldMap.getTile(closestTrain.currentTile.x, closestTrain.currentTile.z, closestTrain.currentTile.layer);
          const tTile = this.worldMap.getTile(closestTrain.targetTile.x, closestTrain.targetTile.z, closestTrain.targetTile.layer);

          const isTunnel = (closestTrain.currentTile.layer !== undefined && closestTrain.currentTile.layer < 0) ||
            this.worldMap.isTunnelSection(closestTrain.currentTile.x, closestTrain.currentTile.z, closestTrain.currentTile.layer);

          const isWater = this.worldMap.gridManagerRef?.isWaterAtGroundLevel(closestTrain.currentTile.x, closestTrain.currentTile.z) ?? false;
          const isBridge = isWater || ((closestTrain.currentTile.layer ?? 1) >= 2);

          const env: 'normal' | 'bridge' | 'tunnel' = isTunnel ? 'tunnel' : (isBridge ? 'bridge' : 'normal');

          const isSwitch = (cTile?.type.includes('switch') || cTile?.type.includes('crossing') ||
                            tTile?.type.includes('switch') || tTile?.type.includes('crossing')) ?? false;

          const effectiveSpeed = Math.min(3.0, trainSpeed * (speedMultiplier > 1 ? 1.3 : 1.0));
          this.audioManager.playJointSound(effectiveSpeed, env, isSwitch, effectiveDistFactor);
        }
      }
    } else if (this.soundTimer >= 1.2) {
      this.soundTimer = 0;
    }

    // =========================================================================
    // ステップ 4: 車両メッシュ姿勢の確定（applyCarTransforms）
    // =========================================================================
    for (const train of this.trains) {
      if (trainsPendingRemoval.includes(train.id)) continue;
      this.kinematics.recordCurrentHeadSample(train, this.worldMap);
      this.kinematics.applyCarTransforms(train);
    }

    // =========================================================================
    // ステップ 5: 分割・併合に伴う編成リストの更新
    // =========================================================================
    if (trainsPendingRemoval.length > 0) {
      for (const remId of trainsPendingRemoval) {
        const remTrain = this.trains.find(t => t.id === remId);
        if (remTrain) {
          this.disposeTrainMesh(remTrain);
        }
        this.blockSignalManager.unregisterTrain(remId);
      }
      this.trains = this.trains.filter(t => !trainsPendingRemoval.includes(t.id));
    }
    if (trainsPendingAdd.length > 0) {
      this.trains.push(...trainsPendingAdd);
    }

    this.lastUpdateHour = currentHour;
    this.lastUpdateMinute = currentMinute;
  }

  public static getHourlyDemandMultiplier(hour: number): number {
    return TrainPayloadSystem.getHourlyDemandMultiplier(hour);
  }

  public calculateOccupiedTiles(train: TrainInstance): Array<{ x: number; z: number; layer: GridLayer }> {
    return this.collisionSystem.calculateOccupiedTiles(train, this.worldMap);
  }

  public updateOccupancyNow(): void {
    for (const train of this.trains) {
      train.occupiedTiles = this.collisionSystem.calculateOccupiedTiles(train, this.worldMap);
    }
  }

  public isTileOccupiedByTrain(x: number, z: number, layer: GridLayer): boolean {
    return this.collisionSystem.isTileOccupiedByTrain(x, z, layer, this.trains, this.worldMap);
  }

  public getFollowTarget(trainIndex: number = 0): FollowTarget | null {
    if (this.trains.length <= trainIndex) return null;
    const train = this.trains[trainIndex];
    return {
      position: train.frontPosition,
      direction: train.direction,
      speed: train.isStopped || train.isAtsBraked ? 0 : train.model.maxSpeed
    };
  }

  public getFollowTargetByTrainId(trainId: number): FollowTarget | null {
    const train = this.getTrainById(trainId);
    if (!train) return null;
    return {
      position: train.frontPosition,
      direction: train.direction,
      speed: train.isStopped || train.isAtsBraked ? 0 : train.model.maxSpeed
    };
  }

  private disposeTrainMesh(train: TrainInstance): void {
    for (const car of train.cars) {
      train.mesh.remove(car);
      disposeHierarchy(car);
    }
    this.scene.remove(train.mesh);
    disposeHierarchy(train.mesh);
  }

  public removeAllTrains(): void {
    for (const train of this.trains) {
      this.disposeTrainMesh(train);
      this.blockSignalManager.unregisterTrain(train.id);
    }
    this.trains = [];
  }

  public removeTrain(id: number): boolean {
    const idx = this.trains.findIndex(t => t.id === id);
    if (idx === -1) return false;
    const train = this.trains[idx];
    this.disposeTrainMesh(train);
    this.blockSignalManager.unregisterTrain(id);
    this.trains.splice(idx, 1);
    return true;
  }

  public updateTrainCarCount(trainId: number, newCarCount: number): boolean {
    const train = this.getTrainById(trainId);
    if (!train) return false;
    if (newCarCount < 1 || newCarCount > 10) return false;
    if (train.carCount === newCarCount) return true;

    for (const car of train.cars) {
      train.mesh.remove(car);
      disposeHierarchy(car);
    }

    const { cars: newCars } = ModelFactory.createTrainFormation(train.model, newCarCount);
    train.carCount = newCarCount;
    train.capacity = train.model.baseCapacity * newCarCount;
    train.passengers = Math.min(train.passengers, train.capacity);
    train.cars = newCars;

    for (const car of newCars) {
      train.mesh.add(car);
    }

    if (train.model.category === 'freight') {
      train.cargoCapacity = Math.max(0, (newCarCount - 1) * 3);
      train.cargoLoad = Math.min(train.cargoCapacity, train.cargoLoad ?? 0);
      VehicleMeshBuilder.updateTrainCargoVisual(train.cars, train.cargoLoad ?? 0);
    }

    const maxLag = (newCarCount - 1) * ModelFactory.CAR_SPACING + 15;
    const hist = train.pathHistory;
    if (hist.length > 0) {
      const newestDist = hist[hist.length - 1].dist;
      const oldestDist = hist[0].dist;
      const currentSpan = newestDist - oldestDist;

      if (currentSpan < maxLag) {
        const needed = maxLag - currentSpan;
        const oldest = hist[0];
        const second = hist.length > 1 ? hist[1] : null;
        const backDir = second
          ? new THREE.Vector3().subVectors(oldest.pos, second.pos).normalize()
          : train.direction.clone().negate();

        if (backDir.lengthSq() < 0.001) backDir.copy(train.direction).negate();

        const extSteps = Math.ceil(needed / 0.5);
        const prefix: PathSample[] = [];
        for (let i = extSteps; i >= 1; i--) {
          const stepDist = i * 0.5;
          prefix.push({
            pos: oldest.pos.clone().addScaledVector(backDir, stepDist),
            yaw: oldest.yaw,
            pitch: oldest.pitch,
            cant: oldest.cant,
            dist: oldest.dist - stepDist,
            layer: oldest.layer
          });
        }
        train.pathHistory = [...prefix, ...hist];
      }
    }

    this.kinematics.applyCarTransforms(train);
    train.occupiedTiles = this.collisionSystem.calculateOccupiedTiles(train, this.worldMap);
    return true;
  }

  public deductPeriodicOperatingCosts(): void {
    for (const train of this.trains) {
      const dailyCost = getRunningCostPerDay(train.model, train.carCount);
      train.totalCost += dailyCost;
      train.monthlyProfit = train.totalRevenue - train.totalCost;
    }
  }

  public serialize(): string {
    const data = this.trains.map(t => ({
      id: t.id,
      name: t.name,
      modelId: t.model.id,
      carCount: t.carCount,
      currentTile: t.currentTile,
      targetTile: t.targetTile,
      direction: { x: t.direction.x, y: t.direction.y, z: t.direction.z },
      progress: t.progress,
      speed: t.speed,
      isStopped: t.isStopped,
      passengers: t.passengers,
      totalPassengers: t.totalPassengers,
      totalRevenue: t.totalRevenue,
      totalCost: t.totalCost,
      monthlyProfit: t.monthlyProfit,
      fleetId: t.fleetId,
      isReversed: t.isReversed,
      isReversingAtStation: t.isReversingAtStation,
      scheduledDepartureMinute: t.scheduledDepartureMinute,
      cargoLoad: t.cargoLoad,
      cargoCapacity: t.cargoCapacity,
      cargoPickup: t.cargoPickup,
      cargoTraveledTiles: t.cargoTraveledTiles,
      stopMode: t.stopMode,
      stopElapsedMinutes: t.stopElapsedMinutes,
      requiredStopMinutes: t.requiredStopMinutes,
      overrideDepartureRule: t.overrideDepartureRule,
      lastDepartureMinute: t.lastDepartureMinute
    }));
    return JSON.stringify(data);
  }

  private getExitWorldPos(tile: TileData, exit: TileExit): THREE.Vector3 {
    const half = WorldMap.TILE_SIZE * 0.5;
    const elev = tile.elevationOffset ?? 0;
    const lyr = (tile.layer ?? 1) as GridLayer;
    const h = exit.worldHeight !== undefined
      ? exit.worldHeight
      : layerToHeight(lyr, elev);
    const d = WorldMap.DIRS[exit.idx];
    return new THREE.Vector3(
      tile.x * WorldMap.TILE_SIZE + d.x * half,
      h,
      tile.z * WorldMap.TILE_SIZE + d.z * half
    );
  }

  private sampleTileTrack(
    tile: TileData,
    entryExit: TileExit,
    exitExit: TileExit,
    stepSize: number = 0.25
  ): IntermediateSample[] {
    const pEntry = this.getExitWorldPos(tile, entryExit);
    const pExit = this.getExitWorldPos(tile, exitExit);
    const lyr = (tile.layer ?? 1) as GridLayer;
    const centerH = (pEntry.y + pExit.y) * 0.5;
    const pCenter = new THREE.Vector3(tile.x * WorldMap.TILE_SIZE, centerH, tile.z * WorldMap.TILE_SIZE);

    const isCurving = tile.type.includes('curve');
    const cant = isCurving ? 0.04 : 0;
    const heightDiff = pExit.y - pEntry.y;
    const pitch = Math.abs(heightDiff) > 0.05 ? -Math.atan2(heightDiff, WorldMap.TILE_SIZE) : 0;

    const samples: IntermediateSample[] = [];

    if (!isCurving) {
      const lineLen = pEntry.distanceTo(pExit);
      const numSteps = Math.max(2, Math.ceil(lineLen / stepSize));
      const fwd = new THREE.Vector3().subVectors(pExit, pEntry).normalize();
      const yaw = Math.atan2(fwd.x, fwd.z);

      for (let i = 0; i <= numSteps; i++) {
        const t = i / numSteps;
        const pos = new THREE.Vector3().lerpVectors(pEntry, pExit, t);
        samples.push({ pos, yaw, pitch, cant, layer: lyr });
      }
    } else {
      const numSteps = Math.max(4, Math.ceil((Math.PI * 0.25 * WorldMap.TILE_SIZE) / stepSize));
      for (let i = 0; i <= numSteps; i++) {
        const t = i / numSteps;
        const oneMinusT = 1 - t;
        const pos = new THREE.Vector3()
          .addScaledVector(pEntry, oneMinusT * oneMinusT)
          .addScaledVector(pCenter, 2 * oneMinusT * t)
          .addScaledVector(pExit, t * t);

        const tangent = new THREE.Vector3()
          .addScaledVector(new THREE.Vector3().subVectors(pCenter, pEntry), 2 * oneMinusT)
          .addScaledVector(new THREE.Vector3().subVectors(pExit, pCenter), 2 * t)
          .normalize();

        const yaw = Math.atan2(tangent.x, tangent.z);
        samples.push({ pos, yaw, pitch, cant, layer: lyr });
      }
    }

    return samples;
  }

  private findConnectedNeighborTile(
    tile: TileData,
    exit: TileExit
  ): { neighbor: TileData; matchedExit: TileExit } | null {
    const curLayer = (tile.layer ?? 1) as GridLayer;
    let nx: number;
    let nz: number;
    if (exit.targetOffset) {
      nx = tile.x + exit.targetOffset.dx;
      nz = tile.z + exit.targetOffset.dz;
    } else {
      const d = WorldMap.DIRS[exit.idx];
      nx = tile.x + d.x;
      nz = tile.z + d.z;
    }
    const backIdx = WorldMap.opposite(exit.idx);

    let neighbor = this.worldMap.getTile(nx, nz, curLayer);
    let nExits = neighbor && this.kinematics.isTrackTile(neighbor) ? WorldMap.getTileExits(neighbor) : [];
    let nExit = nExits.find(e => e.idx === backIdx);

    if (!nExit) {
      for (const candLayer of GRID_LAYERS) {
        if (candLayer === curLayer) continue;
        const candTile = this.worldMap.getTile(nx, nz, candLayer);
        if (!candTile || !this.kinematics.isTrackTile(candTile)) continue;
        const candExits = WorldMap.getTileExits(candTile);
        const candExit = candExits.find(e => e.idx === backIdx);
        if (candExit) {
          if (exit.worldHeight !== undefined && candExit.worldHeight !== undefined) {
            if (Math.abs(exit.worldHeight - candExit.worldHeight) <= 0.05) {
              neighbor = candTile;
              nExit = candExit;
              break;
            }
          } else if (exit.level === candExit.level) {
            neighbor = candTile;
            nExit = candExit;
            break;
          }
        }
      }
    }

    if (!neighbor || !nExit) return null;

    if (exit.worldHeight !== undefined && nExit.worldHeight !== undefined) {
      if (Math.abs(exit.worldHeight - nExit.worldHeight) > 0.05) return null;
    } else if (nExit.level !== exit.level) {
      return null;
    }

    return { neighbor, matchedExit: nExit };
  }

  private reconstructPathHistoryOnLoad(
    train: TrainInstance,
    currentTile: TileData,
    targetTile: TileData,
    fwdDir: THREE.Vector3,
    maxNeededDist: number
  ): PathSample[] {
    const rawSamples: IntermediateSample[] = [];

    const startH = this.kinematics.getTileInterpolatedHeight(currentTile, train.currentTile.layer);
    const endH = this.kinematics.getTileInterpolatedHeight(targetTile, train.targetTile.layer);
    const fromPos = new THREE.Vector3(currentTile.x * WorldMap.TILE_SIZE, startH, currentTile.z * WorldMap.TILE_SIZE);
    const toPos = new THREE.Vector3(targetTile.x * WorldMap.TILE_SIZE, endH, targetTile.z * WorldMap.TILE_SIZE);
    const currentFrontPos = new THREE.Vector3().lerpVectors(fromPos, toPos, train.progress);

    const fwdYaw = Math.atan2(fwdDir.x, fwdDir.z);
    const heightDiff = endH - startH;
    const fwdPitch = Math.abs(heightDiff) > 0.05 ? -Math.atan2(heightDiff, WorldMap.TILE_SIZE) : 0;
    const isCurving = currentTile.type.includes('curve') || targetTile.type.includes('curve');
    const fwdCant = isCurving ? 0.04 : 0;
    const currentLayer = (train.progress < 0.5 ? train.currentTile.layer : train.targetTile.layer) as GridLayer;

    rawSamples.push({
      pos: currentFrontPos.clone(),
      yaw: fwdYaw,
      pitch: fwdPitch,
      cant: fwdCant,
      layer: currentLayer
    });

    const headingIdx = this.kinematics.vecToDirIdx(fwdDir);
    const backToTileIdx = WorldMap.opposite(headingIdx);
    const curExits = WorldMap.getTileExits(currentTile);

    let rearExit: TileExit | undefined;
    let forwardExit: TileExit | undefined;

    if (currentTile.type.startsWith('point_switch')) {
      const forwardRot = ((currentTile.rotation % 4) + 4) % 4;
      const backRot = WorldMap.opposite(forwardRot);
      const branchRot = currentTile.switchBranchSide === 'left' ? WorldMap.rotateCCW(forwardRot) : WorldMap.rotateCW(forwardRot);

      if (backToTileIdx === forwardRot || backToTileIdx === branchRot) {
        forwardExit = curExits.find(e => e.idx === backToTileIdx);
        rearExit = curExits.find(e => e.idx === backRot);
      } else {
        forwardExit = curExits.find(e => e.idx === (currentTile.switchState === 'diverge' ? branchRot : forwardRot));
        rearExit = curExits.find(e => e.idx === backRot);
      }
    } else {
      rearExit = curExits.find(e => e.idx === backToTileIdx);
      forwardExit = curExits.find(e => e.idx !== backToTileIdx);
    }

    if (forwardExit && rearExit) {
      const tileSamples = this.sampleTileTrack(currentTile, rearExit, forwardExit, 0.25);
      let closestIdx = 0;
      let closestDistSq = Infinity;
      for (let i = 0; i < tileSamples.length; i++) {
        const dSq = tileSamples[i].pos.distanceToSquared(currentFrontPos);
        if (dSq < closestDistSq) {
          closestDistSq = dSq;
          closestIdx = i;
        }
      }
      for (let i = closestIdx - 1; i >= 0; i--) {
        rawSamples.push(tileSamples[i]);
      }
    }

    let traversedDist = 0;
    for (let i = 1; i < rawSamples.length; i++) {
      traversedDist += rawSamples[i].pos.distanceTo(rawSamples[i - 1].pos);
    }

    let activeTile = currentTile;
    let activeExit = rearExit;
    let loopGuard = 0;

    while (traversedDist < maxNeededDist && activeExit && loopGuard++ < 60) {
      const connected = this.findConnectedNeighborTile(activeTile, activeExit);
      if (!connected) break;

      const nextTile = connected.neighbor;
      const entryExit = connected.matchedExit;
      const nextExits = WorldMap.getTileExits(nextTile);

      let oppositeExit: TileExit | undefined;
      if (nextTile.type.startsWith('point_switch')) {
        const fRot = ((nextTile.rotation % 4) + 4) % 4;
        const bRot = WorldMap.opposite(fRot);
        const brRot = nextTile.switchBranchSide === 'left' ? WorldMap.rotateCCW(fRot) : WorldMap.rotateCW(fRot);

        if (entryExit.idx === bRot) {
          const targetExitIdx = nextTile.switchState === 'diverge' ? brRot : fRot;
          oppositeExit = nextExits.find(e => e.idx === targetExitIdx);
        } else {
          oppositeExit = nextExits.find(e => e.idx === bRot);
        }
      } else {
        oppositeExit = nextExits.find(e => e.idx !== entryExit.idx);
      }

      if (!oppositeExit) break;

      const tileSamples = this.sampleTileTrack(nextTile, oppositeExit, entryExit, 0.25);
      for (let i = tileSamples.length - 1; i >= 0; i--) {
        const s = tileSamples[i];
        if (rawSamples.length > 0) {
          traversedDist += s.pos.distanceTo(rawSamples[rawSamples.length - 1].pos);
        }
        rawSamples.push(s);
        if (traversedDist >= maxNeededDist) break;
      }

      activeTile = nextTile;
      activeExit = oppositeExit;
    }

    if (traversedDist < maxNeededDist && rawSamples.length > 0) {
      const oldest = rawSamples[rawSamples.length - 1];
      const secondOldest = rawSamples.length > 1 ? rawSamples[rawSamples.length - 2] : null;
      const tangent = secondOldest
        ? new THREE.Vector3().subVectors(secondOldest.pos, oldest.pos).normalize()
        : fwdDir.clone();

      const deficit = maxNeededDist - traversedDist;
      const steps = Math.ceil(deficit / 0.5);
      for (let i = 1; i <= steps; i++) {
        const d = i * 0.5;
        rawSamples.push({
          pos: oldest.pos.clone().sub(tangent.clone().multiplyScalar(d)),
          yaw: oldest.yaw,
          pitch: oldest.pitch,
          cant: oldest.cant,
          layer: oldest.layer
        });
      }
    }

    const pathHistory: PathSample[] = [];
    const ordered = rawSamples.slice().reverse();
    let accumDist = 0;
    for (let i = 0; i < ordered.length; i++) {
      const s = ordered[i];
      if (pathHistory.length > 0) {
        accumDist += s.pos.distanceTo(pathHistory[pathHistory.length - 1].pos);
      }
      pathHistory.push({
        pos: s.pos,
        yaw: s.yaw,
        pitch: s.pitch,
        cant: s.cant,
        dist: accumDist,
        layer: s.layer
      });
    }

    return pathHistory;
  }

  public deserialize(jsonString: string): boolean {
    try {
      const data = JSON.parse(jsonString);
      if (!Array.isArray(data)) return false;

      this.removeAllTrains();

      for (const item of data) {
        const model = getVehicleById(item.modelId);
        if (!model) continue;

        const tile = this.worldMap.getTile(item.currentTile.x, item.currentTile.z, item.currentTile.layer);
        if (!tile) continue;

        const targetTile = this.worldMap.getTile(item.targetTile.x, item.targetTile.z, item.targetTile.layer);
        if (!targetTile) continue;

        const { group, cars } = ModelFactory.createTrainFormation(model, item.carCount);
        this.scene.add(group);

        const dir = new THREE.Vector3(item.direction.x, item.direction.y, item.direction.z).normalize();
        const startH = this.kinematics.getTileInterpolatedHeight(tile, item.currentTile.layer);
        const endH = this.kinematics.getTileInterpolatedHeight(targetTile, item.targetTile.layer);
        const fromPos = new THREE.Vector3(item.currentTile.x * WorldMap.TILE_SIZE, startH, item.currentTile.z * WorldMap.TILE_SIZE);
        const toPos = new THREE.Vector3(item.targetTile.x * WorldMap.TILE_SIZE, endH, item.targetTile.z * WorldMap.TILE_SIZE);
        const frontPos = new THREE.Vector3().lerpVectors(fromPos, toPos, item.progress ?? 0);

        const maxNeededDist = (item.carCount - 1) * ModelFactory.CAR_SPACING + 15;
        const pathHistory = this.reconstructPathHistoryOnLoad(
          {
            id: item.id,
            name: item.name,
            model,
            carCount: item.carCount,
            mesh: group,
            frontPosition: frontPos,
            currentTile: item.currentTile,
            targetTile: item.targetTile,
            direction: dir,
            progress: item.progress ?? 0,
            speed: item.speed,
            isStopped: item.isStopped,
            isAtsBraked: false,
            occupiedTiles: [],
            stopTimer: 0,
            passengers: item.passengers ?? 0,
            capacity: model.baseCapacity * item.carCount,
            isReversed: item.isReversed ?? false,
            cars,
            heightY: startH,
            pathHistory: [],
            totalPassengers: item.totalPassengers ?? 0,
            totalRevenue: item.totalRevenue ?? 0,
            totalCost: item.totalCost ?? 0,
            monthlyProfit: item.monthlyProfit ?? 0,
            fleetId: item.fleetId,
            lastStationGroupId: null
          },
          tile,
          targetTile,
          dir,
          maxNeededDist
        );

        const isFreight = model.category === 'freight';
        const cargoCapacity = isFreight ? Math.max(0, (item.carCount - 1) * 3) : 0;
        const actualCargoLoad = isFreight
          ? (item.cargoLoad !== undefined ? Math.min(cargoCapacity, item.cargoLoad) : 0)
          : undefined;

        const train: TrainInstance = {
          id: item.id,
          name: item.name,
          model,
          carCount: item.carCount,
          mesh: group,
          frontPosition: frontPos,
          currentTile: item.currentTile,
          targetTile: item.targetTile,
          direction: dir,
          progress: item.progress ?? 0,
          speed: item.speed,
          isStopped: item.isStopped,
          isAtsBraked: false,
          isSignalStopped: false,
          isTrapped: false,
          occupiedTiles: [],
          stopTimer: 0,
          passengers: item.passengers ?? 0,
          capacity: model.baseCapacity * item.carCount,
          isReversed: item.isReversed ?? false,
          cars,
          heightY: THREE.MathUtils.lerp(startH, endH, item.progress ?? 0),
          pathHistory,
          totalPassengers: item.totalPassengers ?? 0,
          totalRevenue: item.totalRevenue ?? 0,
          totalCost: item.totalCost ?? 0,
          monthlyProfit: item.monthlyProfit ?? 0,
          fleetId: item.fleetId,
          lastStationGroupId: null,
          isReversingAtStation: item.isReversingAtStation ?? false,
          scheduledDepartureMinute: item.scheduledDepartureMinute ?? null,
          cargoLoad: actualCargoLoad,
          cargoCapacity,
          cargoPickup: item.cargoPickup ?? null,
          cargoTraveledTiles: item.cargoTraveledTiles ?? 0,
          stopMode: item.stopMode ?? null,
          stopElapsedMinutes: item.stopElapsedMinutes ?? 0,
          requiredStopMinutes: item.requiredStopMinutes ?? 0,
          overrideDepartureRule: item.overrideDepartureRule ?? null,
          lastDepartureMinute: item.lastDepartureMinute
        };

        this.kinematics.applyCarTransforms(train);

        if (isFreight) {
          VehicleMeshBuilder.updateTrainCargoVisual(train.cars, actualCargoLoad ?? 0);
        }

        train.occupiedTiles = this.collisionSystem.calculateOccupiedTiles(train, this.worldMap);

        if (train.id >= this.nextTrainId) {
          this.nextTrainId = train.id + 1;
        }

        this.trains.push(train);
      }

      return true;
    } catch {
      return false;
    }
  }

  public calculateStationPassengerDemand(
    centerX: number,
    centerZ: number,
    currentHour: number,
    getDemandMultiplier?: (x: number, z: number, hour: number) => number
  ): number {
    return this.payloadSystem.calculateStationPassengerDemand(centerX, centerZ, currentHour, this.worldMap, getDemandMultiplier);
  }

  public updateFiveMinuteStationPassengers(
    currentHour: number,
    getDemandMultiplier?: (x: number, z: number, hour: number) => number
  ): void {
    this.payloadSystem.updateFiveMinuteStationPassengers(currentHour, this.worldMap, getDemandMultiplier);
  }

  public updateHourlyStationPassengers(
    currentHour: number,
    getDemandMultiplier?: (x: number, z: number, hour: number) => number
  ): void {
    this.payloadSystem.updateHourlyStationPassengers(currentHour, this.worldMap, getDemandMultiplier);
  }
}
