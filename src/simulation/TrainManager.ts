import * as THREE from 'three';
import { WorldMap, TileData, TileExit, SwitchState, CrossingState, getSwitchDirectionAtTime } from './WorldMap';
import { ModelFactory } from '../models/ModelFactory';
import { AudioManager } from '../engine/AudioManager';
import { FollowTarget } from '../graphics/CameraManager';
import { VehicleModelInfo, getVehicleById, getRunningCostPerDay, getMaxCapacity } from './VehicleCatalog';
import { BlockSignalManager } from '../core/BlockSignal';
import { GridLayer, DeadlockEvent } from '../core/types';
import { GRID_LAYERS } from '../core/constants';
import { layerToHeight } from '../core/Grid3D';
import * as ScheduleEngine from '../core/ScheduleEngine';
import { checkCoupleEligibility, validateSplitConfig } from '../core/CouplingSystem';
import { disposeHierarchy } from '../graphics/materials';
import { VehicleMeshBuilder } from '../graphics/vehicles/VehicleMeshBuilder';

// 専門クラス群および共通型定義のインポート
import { TrainInstance, PathSample, IntermediateSample, CargoHooks, ExternalTravelState, CARGO_FARE_PER_CONTAINER_PER_TILE } from './trains/types';
import { TrainKinematics } from './trains/TrainKinematics';
import { TrainCollisionSystem } from './trains/TrainCollisionSystem';
import { TrainCouplingManager } from './trains/TrainCouplingManager';
import { TrainPayloadSystem } from './trains/TrainPayloadSystem';
import { ExternalConnectionManager } from './ExternalConnectionManager';

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
  public onExternalTravelStateChanged?: (train: TrainInstance, message: string) => void;
  private scene: THREE.Scene;
  private worldMap: WorldMap;
  private audioManager: AudioManager;
  public externalConnectionManager?: ExternalConnectionManager;
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

  public setExternalConnectionManager(mgr: ExternalConnectionManager): void {
    this.externalConnectionManager = mgr;
    this.payloadSystem.setExternalConnectionManager(mgr);
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
   * 境界線路タイルにおいて、進行方向がマップ外（外部都市方面）を向いているかを判定
   */
  public static isHeadingToOutside(
    tile: TileData,
    direction: THREE.Vector3,
    gridSize: number = WorldMap.GRID_SIZE
  ): boolean {
    const dir = ExternalConnectionManager.getExternalConnectionDirection(tile, gridSize);
    if (!dir) return false;

    if (dir === 'north' && direction.z < -0.3) return true;
    if (dir === 'south' && direction.z > 0.3) return true;
    if (dir === 'east' && direction.x > 0.3) return true;
    if (dir === 'west' && direction.x < -0.3) return true;

    return false;
  }

  /**
   * 外部接続線路からマップ外へ向かう列車を外部直通走行状態に遷移させる
   */
  public startExternalTravel(train: TrainInstance, borderTile: TileData): void {
    const cityId = borderTile.externalCityId || 'ext_city';
    const city = this.externalConnectionManager?.getCityById(cityId);
    const cityName = city?.name || borderTile.stationName || '隣町方面';
    const borderLayer = (borderTile.layer ?? train.currentTile.layer) as GridLayer;

    // 境界タイル座標に正規化して保持（セーブ＆ロード時の境界外参照エラーを防止）
    train.currentTile = { x: borderTile.x, z: borderTile.z, layer: borderLayer };
    train.targetTile = { x: borderTile.x, z: borderTile.z, layer: borderLayer };

    train.externalTravel = {
      cityId,
      cityName,
      entryTile: { x: borderTile.x, z: borderTile.z, layer: borderLayer },
      entryDirection: { x: train.direction.x, y: train.direction.y, z: train.direction.z },
      phase: 'outward',
      distanceTiles: 50, // 隣町は接続部から50マス先
      remainingTiles: 50,
      stopMinutesRemaining: 5
    };

    // マップ上から非表示にし、自都市線路の占有を解放
    train.mesh.visible = false;
    train.occupiedTiles = [];
    train.isStopped = false;
    train.isSignalStopped = false;
    train.isAtsBraked = false;
    train.progress = 0;
    train.lastStationGroupId = null;

    if (this.onExternalTravelStateChanged) {
      this.onExternalTravelStateChanged(train, `【${train.name}】が${cityName}へ向けてマップ外へ出発しました（片道50マス）`);
    }
  }

  /**
   * 50マス先の隣町に到着した際の旅客降車・乗車・貨物輸出・特産品積み込み処理
   */
  public handleNeighborCityArrival(
    train: TrainInstance,
    travel: ExternalTravelState,
    onPassengerFare?: (amount: number) => void,
    hour: number = 12,
    cargoHooks?: CargoHooks
  ): void {
    const isFreight = train.model.category === 'freight';

    if (isFreight) {
      // 貨物列車：輸出荷降ろし ＆ 輸入特産品積み込み
      const delivered = train.cargoLoad ?? 0;
      if (delivered > 0) {
        // 50マスの長距離輸出プレミアム売上（1.5倍）
        const revenue = Math.round(travel.distanceTiles * delivered * CARGO_FARE_PER_CONTAINER_PER_TILE * 1.5);
        train.totalPassengers += delivered;
        train.totalRevenue += revenue;
        train.monthlyProfit = train.totalRevenue - train.totalCost;
        // ★修正: 貨物売上として計上
        if (cargoHooks?.onCargoDelivered) {
          cargoHooks.onCargoDelivered(travel.entryTile.x, travel.entryTile.z, travel.entryTile.layer, delivered, revenue);
        } else if (onPassengerFare) {
          onPassengerFare(revenue);
        }
        this.externalConnectionManager?.recordCargoExported(travel.cityId, delivered);
        train.cargoLoad = 0;
      }

      // 隣町からの特産品積み込み（最大積載量）
      const cap = train.cargoCapacity ?? Math.max(0, (train.carCount - 1) * 3);
      train.cargoLoad = cap;
      train.cargoPickup = { x: travel.entryTile.x, z: travel.entryTile.z };
      train.cargoTraveledTiles = travel.distanceTiles;
      VehicleMeshBuilder.updateTrainCargoVisual(train.cars, train.cargoLoad);

    } else {
      // 旅客列車：全員降車（50マス分の長距離越境特別ボーナス運賃）
      const alighting = train.passengers;
      if (alighting > 0) {
        const bonusFare = Math.round(alighting * (train.model.farePerRide * 1.5 + travel.distanceTiles * 100));
        train.totalRevenue += bonusFare;
        train.monthlyProfit = train.totalRevenue - train.totalCost;
        if (onPassengerFare) {
          onPassengerFare(bonusFare);
        }
        this.externalConnectionManager?.recordPassengersTransported(travel.cityId, alighting);
        train.passengers = 0;
      }

      // 隣町から自都市への待機乗客の乗車（外部都市の時間帯需要係数を反映）
      const city = this.externalConnectionManager?.getCityById(travel.cityId);
      const mult = city ? ExternalConnectionManager.getCityPassengerDemandMultiplier(city, hour) : 1.0;
      const maxCap = getMaxCapacity(train.model, train.carCount);

      // 基本乗車率 60% に時間帯倍率（0.1〜2.8）を乗算
      // ラッシュ時は満員（100%）、昼間は 50〜70%、深夜は 10〜20% 程度
      const demandRatio = Math.max(0.12, Math.min(1.0, 0.60 * mult));
      const boarding = Math.min(maxCap, Math.max(5, Math.round(maxCap * demandRatio)));

      train.passengers = boarding;
      train.totalPassengers += boarding;
      const initialFare = Math.round(boarding * train.model.farePerRide * 1.5);
      train.totalRevenue += initialFare;
      train.monthlyProfit = train.totalRevenue - train.totalCost;
      if (onPassengerFare) {
        onPassengerFare(initialFare);
      }
    }

    if (this.onExternalTravelStateChanged) {
      this.onExternalTravelStateChanged(train, `【${train.name}】が${travel.cityName}に到着しました。折り返し準備中`);
    }
  }

  /**
   * 復路50マスを走り終えた列車が自都市の接続部タイルからマップ上に再登場・合流する
   */
  public returnFromExternalTravel(train: TrainInstance, travel: ExternalTravelState): void {
    const entry = travel.entryTile;
    const returnDir = new THREE.Vector3(-travel.entryDirection.x, 0, -travel.entryDirection.z).normalize();

    train.currentTile = { x: entry.x, z: entry.z, layer: entry.layer };
    train.direction = returnDir.clone();
    train.progress = 0;
    train.isStopped = false;
    train.isSignalStopped = false;
    train.isAtsBraked = false;

    const curTileData = this.worldMap.getTile(entry.x, entry.z, entry.layer);
    const nextTile = curTileData
      ? this.kinematics.findNextTrackTile(entry.x, entry.z, entry.layer, returnDir, true, this.worldMap)
      : null;

    if (nextTile) {
      train.targetTile = { x: nextTile.x, z: nextTile.z, layer: (nextTile.layer ?? entry.layer) as GridLayer };
    } else {
      train.targetTile = { ...train.currentTile };
    }

    // 先頭車および各車両のワールド位置と pathHistory を自都市向きに再構築
    const startH = curTileData ? this.kinematics.getTileInterpolatedHeight(curTileData, entry.layer) : 0;
    const spawnPos = new THREE.Vector3(entry.x * WorldMap.TILE_SIZE, startH, entry.z * WorldMap.TILE_SIZE);
    train.frontPosition.copy(spawnPos);
    train.heightY = startH;

    const initialYaw = Math.atan2(returnDir.x, returnDir.z);
    train.cars.forEach((car, i) => {
      car.rotation.order = 'YXZ';
      car.position.copy(spawnPos).addScaledVector(returnDir, -i * ModelFactory.CAR_SPACING);
      car.rotation.set(0, initialYaw, 0);
    });

    const initialHistory: PathSample[] = [];
    let accumDist = 0;
    for (let i = train.carCount - 1; i >= 0; i--) {
      const pos = spawnPos.clone().addScaledVector(returnDir, -i * ModelFactory.CAR_SPACING);
      if (initialHistory.length > 0) {
        accumDist += pos.distanceTo(initialHistory[initialHistory.length - 1].pos);
      }
      initialHistory.push({
        pos,
        yaw: initialYaw,
        pitch: 0,
        cant: 0,
        dist: accumDist,
        layer: entry.layer
      });
    }
    train.pathHistory = initialHistory;

    // メッシュを再表示し、状態をクリア
    train.mesh.visible = true;
    train.externalTravel = undefined;
    train.needsOccupancyUpdate = true;
    train.lastStationGroupId = null;

    this.audioManager.playStationBell();
    if (this.onExternalTravelStateChanged) {
      this.onExternalTravelStateChanged(train, `【${train.name}】が${travel.cityName}から帰還し、自都市路線へ復帰しました！`);
    }
  }

  /**
   * カメラ視錐台カリング（画面外の編成非表示）
   */
  public applyVisibility(camera: THREE.Camera, isLayerVisible: (layer: GridLayer) => boolean): void {
    camera.updateMatrixWorld();
    this.cullProjScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.cullFrustum.setFromProjectionMatrix(this.cullProjScreen);

    for (const train of this.trains) {
      if (train.externalTravel) {
        train.mesh.visible = false;
        continue;
      }

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
    // 高倍速（5速=720倍速等）でも1サブステップあたりの移動量が1タイルを超えないよう十分なサブステップ数を確保
    const maxAllowedSteps = speedMultiplier >= 60 ? 140 : 12;
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

    // 列車進路決定前に対象タイル（分岐器・シーサスクロッシング）のタイムライン開通状態を該当時刻で同期するヘルパー
    const syncSwitchOrCrossingTimelineAtTile = (x: number, z: number, layer: GridLayer, hr: number, min: number): void => {
      const t = this.worldMap.getTile(x, z, layer);
      if (!t) return;
      if (t.type.startsWith('point_switch')) {
        const sched = t.switchSchedule;
        if (sched && sched.mode === 'timeline') {
          const dir = getSwitchDirectionAtTime(sched, hr, min);
          this.worldMap.setSwitchState(x, z, dir as SwitchState, layer, true);
        }
      } else if (t.type.startsWith('scissors_crossing')) {
        const origin = this.worldMap.resolveCrossingOrigin(x, z, layer);
        const sched = origin?.switchSchedule;
        if (origin && sched && sched.mode === 'timeline') {
          const cross = getSwitchDirectionAtTime(sched, hr, min, true);
          this.worldMap.setCrossingState(origin.x, origin.z, cross as CrossingState, layer, true);
        }
      }
    };

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
          train.needsOccupancyUpdate = false;
          continue;
        }
        // タイル境界跨ぎ（progress >= 1.0）または初期化・反転時のみ calculateOccupiedTiles を再計算
        if (train.needsOccupancyUpdate !== false || !train.occupiedTiles || train.occupiedTiles.length === 0) {
          train.occupiedTiles = this.collisionSystem.calculateOccupiedTiles(train, this.worldMap);
          train.needsOccupancyUpdate = false;
          hasOccupancyChanged = true;
        }
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

      // 後続列車が先行列車の最後尾に接触した瞬間に併合を行うヘルパー
      const tryPerformCouplingOnContact = (follower: TrainInstance): boolean => {
        const leader = this.trains.find(other =>
          other.id !== follower.id &&
          other.isStopped &&
          !trainsPendingRemoval.includes(other.id) &&
          this.collisionSystem.canBypassAtsForCoupling(follower, other, this.worldMap)
        );
        if (leader && this.couplingManager.checkCouplingContact(follower, leader, this.worldMap)) {
          // 連結消滅前に後続列車の駅到着処理（乗客降車・貨物荷役）を先行列車の駅タイル基準で実行
          const leaderTile = this.worldMap.getTile(leader.currentTile.x, leader.currentTile.z, leader.currentTile.layer);
          if (leaderTile) {
            const isYard = leaderTile.type === 'signal_yard';
            const isCargo = leaderTile.type.startsWith('cargo_station') || !!leaderTile.isCargoYard;
            const isFreight = follower.model.category === 'freight';
            follower.currentTile = { ...leader.currentTile };
            if (isCargo && isFreight && cargoHooks) {
              const isCommercial = cargoHooks.isCommercialStation
                ? cargoHooks.isCommercialStation(leader.currentTile.x, leader.currentTile.z, leader.currentTile.layer)
                : false;
              if (isCommercial) {
                this.payloadSystem.processCargoUnloading(follower, cargoHooks, onPassengerFare, this.worldMap);
              } else {
                this.payloadSystem.processCargoLoading(follower, cargoHooks, this.worldMap);
              }
            } else if (!isYard && !isCargo && !isFreight) {
              const arrival = ScheduleEngine.resolveArrival(leaderTile.stationSchedule, subStepHour, subStepMinute);
              this.payloadSystem.processAlighting(follower, arrival, false, this.worldMap, onPassengerFare);
            }
          }

          this.couplingManager.performCoupling(
            leader,
            follower,
            this.audioManager,
            pos => this.getDistanceFactor(pos),
            (id, count) => this.updateTrainCarCount(id, count),
            t => this.disposeTrainMesh(t),
            this.onTrainCoupled
          );
          if (leaderTile && leaderTile.stationSchedule) {
            const arr = ScheduleEngine.resolveArrival(leaderTile.stationSchedule, subStepHour, subStepMinute);
            if (arr.mode !== 'pass') {
              leader.stopMode = arr.mode;
            }
            leader.isReversingAtStation = (arr.mode === 'reverse') || !!arr.isReverse;
          }
          follower.occupiedTiles = [];
          follower.speed = 0;
          follower.isStopped = true;
          trainsPendingRemoval.push(follower.id);
          hasOccupancyChanged = true;
          leader.needsOccupancyUpdate = true;
          return true;
        }
        return false;
      };

      // (2-C) 各編成の移動・停車・発車制御
      for (const train of this.trains) {
        if (trainsPendingRemoval.includes(train.id)) continue;

        // 外部都市直通走行中の処理（マップ外の仮想走行・隣町往来）
        if (train.externalTravel) {
          const travel = train.externalTravel;
          const speed = train.speed || (train.model.speedTilesPerMinute ?? 3.0);
          const deltaTiles = speed * subDt;

          if (travel.phase === 'outward') {
            travel.remainingTiles -= deltaTiles;
            if (travel.remainingTiles <= 0) {
              // 隣町（50マス先）に到着！
              travel.phase = 'at_neighbor';
              travel.remainingTiles = 0;
              travel.stopMinutesRemaining = 5;
              this.handleNeighborCityArrival(train, travel, onPassengerFare, subStepHour, cargoHooks);
            }
          } else if (travel.phase === 'at_neighbor') {
            travel.stopMinutesRemaining -= subDt;
            if (travel.stopMinutesRemaining <= 0) {
              // 隣町を出発して復路へ！
              travel.phase = 'homeward';
              travel.remainingTiles = travel.distanceTiles; // 50マス
            }
          } else if (travel.phase === 'homeward') {
            travel.remainingTiles -= deltaTiles;
            if (travel.remainingTiles <= 0) {
              // 自都市接続部まで帰還！
              travel.remainingTiles = 0;
              const entry = travel.entryTile;
              const entryTileData = this.worldMap.getTile(entry.x, entry.z, entry.layer);
              if (entryTileData && this.kinematics.isTrackTile(entryTileData)) {
                const returnDir = new THREE.Vector3(-travel.entryDirection.x, 0, -travel.entryDirection.z).normalize();
                const nextInMap = this.kinematics.findNextTrackTile(entry.x, entry.z, entry.layer, returnDir, true, this.worldMap);
                const isEntryOccupied = this.isTileOccupiedByTrain(entry.x, entry.z, entry.layer);
                const isNextOccupied = nextInMap
                  ? this.isTileOccupiedByTrain(nextInMap.x, nextInMap.z, (nextInMap.layer ?? entry.layer) as GridLayer)
                  : false;
                const canEnter = this.blockSignalManager.canEnterTile(train.id, entry.x, entry.z, entry.layer) && !isEntryOccupied && !isNextOccupied;
                if (canEnter) {
                  this.returnFromExternalTravel(train, travel);
                  hasOccupancyChanged = true;
                }
              }
            }
          }
          continue;
        }

        // 孤立状態の復帰チェック
        if (train.isTrapped) {
          syncSwitchOrCrossingTimelineAtTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer, subStepHour, subStepMinute);
          const forwardNext = this.kinematics.findNextTrackTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer, train.direction, false, this.worldMap);
          if (forwardNext) {
            train.isTrapped = false;
            train.speed = train.model.speedTilesPerMinute ?? 1.5;
            this.kinematics.resolveNextTileOrReverse(train, this.worldMap);
            train.needsOccupancyUpdate = true;
          } else {
            const reverseDir = train.direction.clone().negate();
            const lagDist = (train.carCount - 1) * ModelFactory.CAR_SPACING;
            const oldRearSample = this.kinematics.sampleHistoryAtLag(train.pathHistory, lagDist);
            const rearX = Math.round(oldRearSample.pos.x / WorldMap.TILE_SIZE);
            const rearZ = Math.round(oldRearSample.pos.z / WorldMap.TILE_SIZE);
            syncSwitchOrCrossingTimelineAtTile(rearX, rearZ, train.currentTile.layer, subStepHour, subStepMinute);
            const reverseNext = this.kinematics.findNextTrackTile(rearX, rearZ, train.currentTile.layer, reverseDir, true, this.worldMap);
            if (reverseNext) {
              train.isTrapped = false;
              train.speed = train.model.speedTilesPerMinute ?? 1.5;
              this.kinematics.reverseTrainDirection(train, this.worldMap);
              train.needsOccupancyUpdate = true;
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

          const prevTotal = Math.floor(stepStartTotalMin);
          const currentTotalMin = Math.floor(stepEndTotalMin);
          const shouldEvaluateSchedule = (prevTotal !== currentTotalMin) || (train.lastEvaluatedMinute !== currentTotalMin);
          const isSameMinuteAsLastDep = train.lastDepartureMinute !== undefined &&
            Math.abs(((train.lastDepartureMinute % 1440) - (currentTotalMin % 1440) + 1440) % 1440) === 0;

          // 同一ホームの前方に同方向の別列車がまだ停車中(分割直後の前編成など)の場合は、前編成が発車するまで待機させる
          const curPlatId = stoppedTile?.stationPlatformId || stoppedTile?.stationGroupId;
          const hasStoppedTrainAheadOnSamePlatform = curPlatId ? this.trains.some(other => {
            if (other.id === train.id || !other.isStopped || trainsPendingRemoval.includes(other.id)) return false;
            if (other.currentTile.layer !== train.currentTile.layer) return false;
            const otherTile = this.worldMap.getTile(other.currentTile.x, other.currentTile.z, other.currentTile.layer);
            const otherPlatId = otherTile?.stationPlatformId || otherTile?.stationGroupId;
            if (otherPlatId !== curPlatId) return false;
            if (other.direction.dot(train.direction) < 0.5) return false;
            const dx = other.frontPosition.x - train.frontPosition.x;
            const dz = other.frontPosition.z - train.frontPosition.z;
            return (dx * train.direction.x + dz * train.direction.z) > 0.1;
          }) : false;

          if (!canDeparture && !isSameMinuteAsLastDep) {
            if (hasStoppedTrainAheadOnSamePlatform) {
              // 前編成が同じホームから発車するまで待機し、発車後も最低1分間隔を空ける
              train.requiredStopMinutes = Math.max(train.requiredStopMinutes ?? 0, Math.floor(train.stopElapsedMinutes ?? 0) + 1);
              canDeparture = false;
            } else if (required > 0 && (train.stopElapsedMinutes ?? 0) < required) {
              // ★修正: 最低必要停車時間(分割・連結作業等)の待機中は lastEvaluatedMinute を更新せず、待機完了後に評価させる
              canDeparture = false;
            } else {
              train.lastEvaluatedMinute = currentTotalMin;
              if (train.overrideDepartureRule) {
                const rule = train.overrideDepartureRule;
                if (rule.mode === 'timer') {
                  canDeparture = (train.stopElapsedMinutes ?? 0) >= required;
                } else if (shouldEvaluateSchedule) {
                  if (rule.mode === 'pattern') {
                    const patMin = rule.patternMinute ?? 0;
                    const interval = rule.patternIntervalMinutes ?? 60;
                    canDeparture = ScheduleEngine.isPatternIntervalInRange(prevTotal, currentTotalMin, patMin, interval);
                  } else if (rule.mode === 'specific') {
                    const specMin = (((rule.specificHour ?? 0) % 24) * 60 + (rule.specificMinute ?? 0)) % 1440;
                    canDeparture = ScheduleEngine.isMinuteInRange(prevTotal, currentTotalMin, specMin);
                  }
                }
              } else if (mode === 'stop' || shouldEvaluateSchedule) {
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
                shouldReverse = evalResult.shouldReverse; // ★修正: evalResult の判定結果を正とする
              }
            }
          }

          if (canDeparture) {
            if (!train.isSignalStopped) {
              if (shouldReverse) {
                train.isReversingAtStation = false;
                this.kinematics.reverseTrainDirection(train, this.worldMap);
                train.needsOccupancyUpdate = true;
              } else {
                syncSwitchOrCrossingTimelineAtTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer, subStepHour, subStepMinute);
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

            train.isReversingAtStation = false; // ★発車確定時は常に確実に折り返しフラグを初期化
            train.lastDepartureMinute = currentTotalMin;
            train.isSignalStopped = false;
            train.isStopped = false;
            train.stopMode = null;
            train.stopElapsedMinutes = 0;
            train.overrideDepartureRule = null;
            train.needsOccupancyUpdate = true;
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
        const effectiveSpeed = train.isApproachingCouple ? Math.min(train.speed, 0.45) : train.speed;
        train.progress += (effectiveSpeed * subDt);
        this.kinematics.updateTrainFrontPosition(train, this.worldMap);

        // 併合（連結）接触判定: 先行列車の最後尾に接触した瞬間に併合
        if (tryPerformCouplingOnContact(train)) {
          continue;
        }

        let tileLoopCount = 0;
        while (train.progress >= 1.0 && tileLoopCount++ < 10) {
          // 複数タイルを跨ぐ場合でも、各タイル境界で閉塞信号を再確認して赤信号突破を防止
          if (tileLoopCount > 1) {
            const nextCanEnter = this.blockSignalManager.canEnterTile(train.id, train.targetTile.x, train.targetTile.z, train.targetTile.layer);
            if (!nextCanEnter) {
              train.progress = 0;
              train.isSignalStopped = true;
              break;
            }
          }

          train.progress -= 1.0;
          train.currentTile = { ...train.targetTile };
          train.needsOccupancyUpdate = true;
          hasOccupancyChanged = true;
          this.kinematics.updateTrainFrontPosition(train, this.worldMap);

          if (tryPerformCouplingOnContact(train)) {
            break;
          }

          // タイル境界到達時は倍速に関わらず必ず経路履歴（pathHistory）へ記録し、
          // 折り返し・分割・在線判定での曲線ショートカットや別線路へのワープを完全に防止する
          const savedProgress = train.progress;
          train.progress = 0;
          this.kinematics.recordCurrentHeadSample(train, this.worldMap);
          train.progress = savedProgress;

          if ((train.cargoLoad ?? 0) > 0) {
            train.cargoTraveledTiles = (train.cargoTraveledTiles ?? 0) + 1;
          }

          let curTileData = this.worldMap.getTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer);
          // マップ外（境界外）に踏み出した場合、1歩手前の境界線路タイルを取得して判定
          if (!curTileData) {
            const prevX = train.currentTile.x - Math.round(train.direction.x);
            const prevZ = train.currentTile.z - Math.round(train.direction.z);
            const prevTile = this.worldMap.getTile(prevX, prevZ, train.currentTile.layer);
            if (prevTile?.isExternalConnection && TrainManager.isHeadingToOutside(prevTile, train.direction, this.worldMap.gridSize)) {
              train.currentTile = { x: prevX, z: prevZ, layer: train.currentTile.layer };
              curTileData = prevTile;
            }
          }

          const isBorderExternal = !!curTileData?.isExternalConnection;

          // 外部直通線路において、進行方向がマップ外（外部都市方面）を向いている場合はマップ外へ出発！
          if (isBorderExternal && curTileData && TrainManager.isHeadingToOutside(curTileData, train.direction, this.worldMap.gridSize)) {
            this.startExternalTravel(train, curTileData);
            hasOccupancyChanged = true;
            break;
          }

          const isStationOrYard = curTileData && WorldMap.isStationTileType(curTileData.type);
          let wasAbsorbedByCoupling = false;

          if (isStationOrYard && curTileData) {
            const isYard = curTileData.type === 'signal_yard';
            const isCargo = curTileData.type.startsWith('cargo_station') || !!curTileData.isCargoYard;
            const isFreight = train.model.category === 'freight';
            const isExternal = false;

            // ★修正: 駅全体(stationGroupId)ではなく、番線(stationPlatformId)単位で識別する
            const stPlatformId = curTileData.stationPlatformId || curTileData.stationGroupId || (() => {
              const st = this.worldMap.getStationStartTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer);
              return st ? `plat_${st.x}_${st.z}_${st.layer ?? 1}` : `plat_${train.currentTile.x}_${train.currentTile.z}_${train.currentTile.layer}`;
            })();

            const peekNext = this.kinematics.findNextTrackTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer, train.direction, false, this.worldMap);
            const peekNextPlatId = peekNext ? (peekNext.stationPlatformId || peekNext.stationGroupId) : undefined;
            const nextIsSameStation = !!(peekNext && WorldMap.isStationTileType(peekNext.type) && (
              peekNextPlatId === stPlatformId || (!peekNextPlatId && !curTileData.stationPlatformId && !curTileData.stationGroupId)
            ));

            if (!nextIsSameStation && train.lastStationGroupId !== stPlatformId) {
              train.lastStationGroupId = stPlatformId;

              const effectiveLength = this.worldMap.getStationRunLength(train.currentTile.x, train.currentTile.z, train.currentTile.layer) || 1;
              let isTooLong = train.carCount > effectiveLength;

              if (!peekNext || isCargo || isYard || isExternal) {
                isTooLong = false;
              }

              const schedule = curTileData.stationSchedule;
              const rawArrival = ScheduleEngine.resolveArrival(schedule, subStepHour, subStepMinute);
              if (isTooLong) {
                rawArrival.mode = 'pass';
                rawArrival.requiredStopMinutes = 0;
              }

              let arrival = rawArrival;
              if (isExternal) {
                // 外部直通境界線路は旅客列車も貨物列車も両方停車・折り返し扱い（隣町ターミナル）
                arrival = {
                  ...rawArrival,
                  mode: 'reverse',
                  isReverse: true,
                  requiredStopMinutes: Math.max(3, rawArrival.requiredStopMinutes || 5)
                };
              } else if (rawArrival.mode !== 'pass') {
                if (isCargo && !isFreight) {
                  arrival = { ...rawArrival, mode: 'pass', requiredStopMinutes: 0 };
                } else if (!isCargo && !isYard && isFreight) {
                  arrival = { ...rawArrival, mode: 'pass', requiredStopMinutes: 0 };
                }
              }

              if (arrival.mode === 'pass') {
                if (arrival.isReverse) {
                  this.kinematics.reverseTrainDirection(train, this.worldMap);
                  train.needsOccupancyUpdate = true;
                  train.progress = 0;
                  break;
                }
              } else {
                train.isStopped = true;
                train.progress = 0;
                train.lastDepartureMinute = undefined; // ★追加: 前駅の発車分ロックを解除
                this.kinematics.recordCurrentHeadSample(train, this.worldMap);

                if (isExternal) {
                  if (isFreight) {
                    // 貨物列車：輸出荷降ろし → 輸入特産品積み込み
                    this.payloadSystem.processCargoUnloading(train, cargoHooks, onPassengerFare, this.worldMap);
                    this.payloadSystem.processCargoLoading(train, cargoHooks, this.worldMap);
                  } else {
                    // 旅客列車：全員降車（越境特別ボーナス運賃）
                    this.payloadSystem.processAlighting(train, arrival, true, this.worldMap, onPassengerFare);
                  }
                } else if (isCargo && isFreight && cargoHooks) {
                  const isCommercial = cargoHooks.isCommercialStation
                    ? cargoHooks.isCommercialStation(train.currentTile.x, train.currentTile.z, train.currentTile.layer)
                    : false;

                  if (isCommercial) {
                    this.payloadSystem.processCargoUnloading(train, cargoHooks, onPassengerFare, this.worldMap);
                  } else {
                    this.payloadSystem.processCargoLoading(train, cargoHooks, this.worldMap);
                  }
                } else if (!isYard && !isCargo && !isFreight) {
                  this.payloadSystem.processAlighting(train, arrival, !peekNext, this.worldMap, onPassengerFare);
                }

                // 分割判定（現在時刻のゾーンまたは発車ピンで有効な arrival.splitConfig のみを使用し、指定両数と一致する編成のみ分割）
                const activeSplitConfig = arrival.splitConfig;
                const splitCheck = (!isYard && !isTooLong && train.carCount >= 2)
                  ? validateSplitConfig(train.carCount, activeSplitConfig)
                  : { valid: false };

                if (splitCheck.valid && activeSplitConfig) {
                  train.stopMode = arrival.mode;
                  train.requiredStopMinutes = arrival.requiredStopMinutes;
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
                  // ★修正: 分割フレーム内の次サブステップから即座に閉塞・ATSが効くよう占有タイルを計算して即時追加
                  rearTrain.occupiedTiles = this.collisionSystem.calculateOccupiedTiles(rearTrain, this.worldMap);
                  train.occupiedTiles = this.collisionSystem.calculateOccupiedTiles(train, this.worldMap);
                  this.trains.push(rearTrain);
                  hasOccupancyChanged = true;
                } else {
                  // 併合（連結）判定: 必ず「同一番線（stationPlatformId）」かつ「同一階層・同一路線軸」の列車のみ対象とする
                  const leader = !isYard
                    ? this.trains.find(other => {
                        if (other.id === train.id || !other.isStopped) return false;
                        if (other.model.id !== train.model.id) return false; // 同一車種のみ併合可
                        if (other.currentTile.layer !== train.currentTile.layer) return false;
                        const otherTile = this.worldMap.getTile(other.currentTile.x, other.currentTile.z, other.currentTile.layer);
                        if (!otherTile) return false;
                        const otherPlatId = otherTile.stationPlatformId || otherTile.stationGroupId;
                        if (!otherPlatId || otherPlatId !== stPlatformId) return false;
                        // 同じ線路軸上にいるか確認
                        const isEW = curTileData.rotation % 2 === 1;
                        return isEW ? (other.currentTile.z === train.currentTile.z) : (other.currentTile.x === train.currentTile.x);
                      })
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
                    leader.stopMode = arrival.mode;
                    leader.isReversingAtStation = (arrival.mode === 'reverse') || !!arrival.isReverse;
                  } else {
                    train.stopMode = arrival.mode;
                    train.stopElapsedMinutes = 0;
                    train.requiredStopMinutes = arrival.requiredStopMinutes;
                    train.isReversingAtStation = (arrival.mode === 'reverse') || !!arrival.isReverse;
                    train.lastEvaluatedMinute = undefined; // 駅到着時にリセットし、現在分のダイヤ判定を確実に初回実行させる
                  }
                }
              }
            }
          } else {
            if (train.lastStationGroupId) {
              train.occupiedTiles = this.collisionSystem.calculateOccupiedTiles(train, this.worldMap);
              train.needsOccupancyUpdate = false;
              const targetTileData = this.worldMap.getTile(train.targetTile.x, train.targetTile.z, train.targetTile.layer);
              const targetPlatId = targetTileData ? (targetTileData.stationPlatformId || targetTileData.stationGroupId) : null;
              const stillOnSamePlatform =
                targetPlatId === train.lastStationGroupId ||
                train.occupiedTiles.some(ot => {
                  const t = this.worldMap.getTile(ot.x, ot.z, ot.layer);
                  return t && (t.stationPlatformId === train.lastStationGroupId || t.stationGroupId === train.lastStationGroupId);
                });
              if (!stillOnSamePlatform) {
                train.lastStationGroupId = null;
              }
            }
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

          // 分岐器・シーサスクロッシング通過時のダイヤ制御（サブステップ時刻基準）
          let toggleAlternateAfterResolve = false;
          let alternateNextState: SwitchState = 'straight';

          if (curTileData && curTileData.type.startsWith('point_switch')) {
            const switchSched = curTileData.switchSchedule;
            if (switchSched) {
              if (switchSched.mode === 'alternate') {
                // 対向側（根元＝back側）から分岐器へ進入した列車のみ交互切替の対象とし、
                // 今回の列車が現在の開通方向へ進んだ直後に次列車用へトグルする（背向合流時の誤反転を防止）
                const headingIdx = this.kinematics.vecToDirIdx(train.direction);
                const incomingSide = WorldMap.opposite(headingIdx);
                const forward = ((curTileData.rotation % 4) + 4) % 4;
                const back = WorldMap.opposite(forward);
                if (incomingSide === back) {
                  toggleAlternateAfterResolve = true;
                  alternateNextState = curTileData.switchState === 'straight' ? 'diverge' : 'straight';
                }
              } else if (switchSched.mode === 'timeline') {
                const targetDir = getSwitchDirectionAtTime(switchSched, subStepHour, subStepMinute);
                this.worldMap.setSwitchState(train.currentTile.x, train.currentTile.z, targetDir as SwitchState, train.currentTile.layer, true);
              }
            }
          } else if (curTileData && curTileData.type.startsWith('scissors_crossing')) {
            const origin = this.worldMap.resolveCrossingOrigin(train.currentTile.x, train.currentTile.z, train.currentTile.layer);
            const switchSched = origin?.switchSchedule;
            if (origin && switchSched) {
              if (switchSched.mode === 'timeline') {
                const targetCrossing = getSwitchDirectionAtTime(switchSched, subStepHour, subStepMinute, true);
                this.worldMap.setCrossingState(origin.x, origin.z, targetCrossing as CrossingState, train.currentTile.layer, true);
              } else if (switchSched.mode === 'alternate') {
                const order: CrossingState[] = ['straight', 'cross-a', 'cross-b'];
                const curState = origin.crossingState ?? 'straight';
                const nextState = order[(order.indexOf(curState) + 1) % order.length];
                // 進路解決後に次列車用へ切り替える
                this.kinematics.resolveNextTileOrReverse(train, this.worldMap);
                this.worldMap.setCrossingState(origin.x, origin.z, nextState, train.currentTile.layer, true);
                continue;
              }
            }
          }

          if (!train.isStopped) {
            this.kinematics.resolveNextTileOrReverse(train, this.worldMap);
            if (toggleAlternateAfterResolve) {
              this.worldMap.setSwitchState(train.currentTile.x, train.currentTile.z, alternateNextState, train.currentTile.layer, true);
            }
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
      if (train.externalTravel) continue; // マップ外走行中の列車はジョイント音を鳴らさない
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
      if (train.externalTravel) continue;
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
    if (train.externalTravel) return [];
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
    if (train.externalTravel) return null;
    return {
      position: train.frontPosition,
      direction: train.direction,
      speed: train.isStopped || train.isAtsBraked ? 0 : train.model.maxSpeed,
      trainId: train.id
    };
  }

  public getFollowTargetByTrainId(trainId: number): FollowTarget | null {
    const train = this.getTrainById(trainId);
    if (!train) return null;
    if (train.externalTravel) return null;
    return {
      position: train.frontPosition,
      direction: train.direction,
      speed: train.isStopped || train.isAtsBraked ? 0 : train.model.maxSpeed,
      trainId: train.id
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
    // ★修正: 100%定員(train.capacity)ではなく最大乗車率込みの上限(getMaxCapacity)でクランプする
    train.passengers = Math.min(train.passengers, getMaxCapacity(train.model, newCarCount));
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
    if (train.externalTravel) {
      train.mesh.visible = false;
      train.occupiedTiles = [];
    } else {
      train.occupiedTiles = this.collisionSystem.calculateOccupiedTiles(train, this.worldMap);
    }
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
      lastStationGroupId: t.lastStationGroupId, // ★追加
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
      lastDepartureMinute: t.lastDepartureMinute,
      externalTravel: t.externalTravel ? {
        cityId: t.externalTravel.cityId,
        cityName: t.externalTravel.cityName,
        entryTile: t.externalTravel.entryTile,
        entryDirection: t.externalTravel.entryDirection,
        phase: t.externalTravel.phase,
        distanceTiles: t.externalTravel.distanceTiles,
        remainingTiles: t.externalTravel.remainingTiles,
        stopMinutesRemaining: t.externalTravel.stopMinutesRemaining
      } : undefined
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

        const isExternal = !!item.externalTravel;
        const fallbackTilePos = isExternal && item.externalTravel.entryTile
          ? item.externalTravel.entryTile
          : item.currentTile;

        const tile = this.worldMap.getTile(item.currentTile.x, item.currentTile.z, item.currentTile.layer)
          || this.worldMap.getTile(fallbackTilePos.x, fallbackTilePos.z, fallbackTilePos.layer);
        if (!tile && !isExternal) continue;

        const targetTile = this.worldMap.getTile(item.targetTile.x, item.targetTile.z, item.targetTile.layer) || tile;
        if (!targetTile && !isExternal) continue;

        const { group, cars } = ModelFactory.createTrainFormation(model, item.carCount);
        this.scene.add(group);

        const dir = new THREE.Vector3(item.direction.x, item.direction.y, item.direction.z).normalize();
        const startH = tile ? this.kinematics.getTileInterpolatedHeight(tile, item.currentTile.layer) : 0;
        const endH = targetTile ? this.kinematics.getTileInterpolatedHeight(targetTile, item.targetTile.layer) : startH;
        const fromPos = new THREE.Vector3(fallbackTilePos.x * WorldMap.TILE_SIZE, startH, fallbackTilePos.z * WorldMap.TILE_SIZE);
        const toPos = new THREE.Vector3(item.targetTile.x * WorldMap.TILE_SIZE, endH, item.targetTile.z * WorldMap.TILE_SIZE);
        const frontPos = isExternal ? fromPos.clone() : new THREE.Vector3().lerpVectors(fromPos, toPos, item.progress ?? 0);

        const maxNeededDist = (item.carCount - 1) * ModelFactory.CAR_SPACING + 15;
        const pathHistory = (tile && targetTile && !isExternal)
          ? this.reconstructPathHistoryOnLoad(
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
                lastStationGroupId: item.lastStationGroupId ?? null
              },
              tile,
              targetTile,
              dir,
              maxNeededDist
            )
          : [{ pos: frontPos.clone(), yaw: Math.atan2(dir.x, dir.z), pitch: 0, cant: 0, dist: 0, layer: fallbackTilePos.layer ?? 1 }];

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
          currentTile: isExternal ? { x: fallbackTilePos.x, z: fallbackTilePos.z, layer: fallbackTilePos.layer ?? 1 } : item.currentTile,
          targetTile: isExternal ? { x: fallbackTilePos.x, z: fallbackTilePos.z, layer: fallbackTilePos.layer ?? 1 } : item.targetTile,
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
          lastStationGroupId: item.lastStationGroupId ?? null, // ★修正
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
          lastDepartureMinute: item.lastDepartureMinute,
          externalTravel: item.externalTravel ? {
            cityId: item.externalTravel.cityId,
            cityName: item.externalTravel.cityName,
            entryTile: item.externalTravel.entryTile,
            entryDirection: item.externalTravel.entryDirection,
            phase: item.externalTravel.phase,
            distanceTiles: item.externalTravel.distanceTiles ?? 50,
            remainingTiles: item.externalTravel.remainingTiles ?? 50,
            stopMinutesRemaining: item.externalTravel.stopMinutesRemaining ?? 5
          } : undefined
        };

        if (train.externalTravel) {
          train.mesh.visible = false;
          train.occupiedTiles = [];
        } else {
          train.occupiedTiles = this.collisionSystem.calculateOccupiedTiles(train, this.worldMap);
        }

        this.kinematics.applyCarTransforms(train);

        if (isFreight) {
          VehicleMeshBuilder.updateTrainCargoVisual(train.cars, actualCargoLoad ?? 0);
        }

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
