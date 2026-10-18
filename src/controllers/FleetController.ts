import * as THREE from 'three';
import { GridLayer } from '../core/types';
import { TrainManager } from '../simulation/TrainManager';
import { WorldMap } from '../simulation/WorldMap';
import { Economy } from '../simulation/Economy';
import { AudioManager } from '../engine/AudioManager';
import { UIManager, FleetItem } from '../ui/UIManager';
import { CameraManager } from '../graphics/CameraManager';
import { layerToHeight } from '../core/Grid3D';
import { VehicleModelInfo, getVehicleById } from '../simulation/VehicleCatalog';
import { ModelFactory } from '../models/ModelFactory';
import { disposeHierarchy } from '../graphics/materials';

export const DIR_LABEL = ['北', '東', '南', '西'];

export interface PendingTrainDeploy {
  fleetId: string;
  x: number;
  z: number;
  layer: GridLayer;
  directionIdx: number;
  ghost: THREE.Group;
}

export interface FleetControllerCallbacks {
  onExitCabView?: () => void;
  onCloseInspector?: () => void;
  onUpdateRotationHint?: () => void;
}

/**
 * 車両基地台帳・編成購入・増減車・売却・線路デプロイ管理コントローラー
 */
export class FleetController {
  private scene: THREE.Scene;
  private worldMap: WorldMap;
  private trainManager: TrainManager;
  private economy: Economy;
  private audioManager: AudioManager;
  private uiManager: UIManager;
  private cameraManager: CameraManager;
  private callbacks: FleetControllerCallbacks;

  private fleetRegistry: FleetItem[] = [];
  public nextFleetId: number = 1;
  private deployingFleetId: string | null = null;
  public deployDirectionIdx: number = 0;
  private pendingTrainDeploy: PendingTrainDeploy | null = null;
  private hoverTrainGhost: THREE.Group | null = null;

  constructor(
    scene: THREE.Scene,
    worldMap: WorldMap,
    trainManager: TrainManager,
    economy: Economy,
    audioManager: AudioManager,
    uiManager: UIManager,
    cameraManager: CameraManager,
    callbacks: FleetControllerCallbacks = {}
  ) {
    this.scene = scene;
    this.worldMap = worldMap;
    this.trainManager = trainManager;
    this.economy = economy;
    this.audioManager = audioManager;
    this.uiManager = uiManager;
    this.cameraManager = cameraManager;
    this.callbacks = callbacks;
  }

  public getFleetRegistry(): FleetItem[] {
    return this.fleetRegistry;
  }

  public setFleetRegistry(registry: FleetItem[], nextId?: number): void {
    this.fleetRegistry = registry;
    if (nextId !== undefined) {
      this.nextFleetId = nextId;
    }
  }

  public getDeployingFleetId(): string | null {
    return this.deployingFleetId;
  }

  public getDeployingFleetItem(): FleetItem | null {
    if (!this.deployingFleetId) return null;
    return this.fleetRegistry.find(f => f.id === this.deployingFleetId) || null;
  }

  public isDeploying(): boolean {
    return this.deployingFleetId !== null;
  }

  public hasPendingDeploy(): boolean {
    return this.pendingTrainDeploy !== null;
  }

  public getPendingDeploy(): PendingTrainDeploy | null {
    return this.pendingTrainDeploy;
  }

  public getPendingTrainDeploy(): PendingTrainDeploy | null {
    return this.pendingTrainDeploy;
  }

  public registerNewFleetItem(item: FleetItem): void {
    this.fleetRegistry.push(item);
  }

  public clearAllFleet(): void {
    this.cancelDeploy();
    this.fleetRegistry = [];
    this.nextFleetId = 1;
  }

  /**
   * 保有列車の累計乗客数・収支を運行中のインスタンスと同期
   */
  public syncFleetStats(): void {
    for (const item of this.fleetRegistry) {
      if (item.status === 'deployed' && item.activeTrainId !== undefined) {
        const train = this.trainManager.getTrainById(item.activeTrainId);
        if (train) {
          item.totalPassengers = train.totalPassengers;
          item.totalRevenue = train.totalRevenue;
        }
      }
    }
  }

  /**
   * 新規車両を購入して車両基地へ配属
   */
  public buyVehicle(model: VehicleModelInfo, cars: number): boolean {
    if (!this.economy.canInvest) {
      this.uiManager.showToast('追加投資制限中', '資金が赤字のため、新規車両の購入は行えません。（資金が黒字化すると自動解除されます）', 'warning');
      return false;
    }

    const clampedCars = Math.max(1, Math.min(10, cars));
    const totalPrice = model.basePrice * clampedCars;
    if (!this.economy.spendFunds(totalPrice, true, 'vehicle', `${model.name} (${clampedCars}両)`)) {
      this.uiManager.showToast('資金不足', `車両購入資金が不足しています。(必要: ¥${totalPrice.toLocaleString('ja-JP')})`, 'danger');
      return false;
    }

    const fleetId = `fleet-${this.nextFleetId++}`;
    const countOfModel = this.fleetRegistry.filter(f => f.model.id === model.id).length + 1;
    const fleetItem: FleetItem = {
      id: fleetId,
      name: `${model.name} ${countOfModel}号`,
      model,
      cars: clampedCars,
      status: 'in_depot'
    };
    this.fleetRegistry.push(fleetItem);
    this.audioManager.playStationBell();

    this.uiManager.showToast('車両購入完了', `🎉 ${fleetItem.name} を購入し、車両基地へ配属しました！`, 'success');
    this.syncFleetStats();
    this.uiManager.showFleetModal(this.fleetRegistry);
    return true;
  }

  /**
   * 保有列車の両数変更（増車 / 減車）
   */
  public changeCarCount(fleetId: string, delta: number): void {
    const item = this.fleetRegistry.find(f => f.id === fleetId);
    if (!item) return;

    if (delta > 0) {
      if (item.cars >= 10) {
        this.uiManager.showToast('増車制限', '編成両数は最大10両までです。', 'warning');
        return;
      }
      const cost = item.model?.basePrice ?? 12000000;
      if (!this.economy.spendFunds(cost, true, 'vehicle', `${item.name} 増車`)) {
        this.uiManager.showToast('資金不足', `増車（1両追加購入）には ¥${cost.toLocaleString()} が必要です。`, 'danger');
        return;
      }
      item.cars += 1;
      this.audioManager.playBuildSound();
    } else if (delta < 0) {
      if (item.cars <= 1) {
        this.uiManager.showToast('減車制限', '編成両数は1両より少なくできません。', 'warning');
        return;
      }
      const refund = Math.floor((item.model?.basePrice ?? 12000000) * 0.5);
      this.economy.refundFunds(refund);
      item.cars -= 1;
      this.audioManager.playDemolishSound();
    }

    if (item.status === 'deployed' && item.activeTrainId !== undefined) {
      this.trainManager.updateTrainCarCount(item.activeTrainId, item.cars);
    }

    this.syncFleetStats();
    this.uiManager.showFleetModal(this.fleetRegistry);
  }

  /**
   * 保有列車の売却（編成全体の廃車返金）
   */
  public sellFleetTrain(fleetId: string): void {
    const item = this.fleetRegistry.find(f => f.id === fleetId);
    if (!item) return;

    const basePrice = item.model?.basePrice ?? 12000000;
    const refund = Math.floor(basePrice * item.cars * 0.5);
    const isDeployed = item.status === 'deployed';

    if (isDeployed && item.activeTrainId !== undefined) {
      this.callbacks.onExitCabView?.();
      this.callbacks.onCloseInspector?.();
      this.cameraManager.stopTracking();
      this.trainManager.removeTrain(item.activeTrainId);
    }

    this.fleetRegistry = this.fleetRegistry.filter(f => f.id !== fleetId);
    this.economy.refundFunds(refund);
    this.audioManager.playDemolishSound();
    this.uiManager.showToast('車両売却完了', `${item.name} を売却し、¥${refund.toLocaleString()} を受領しました。`, 'success');

    this.syncFleetStats();
    this.uiManager.showFleetModal(this.fleetRegistry);
  }

  /**
   * 保有列車を線路に配置するモードを開始
   */
  public startDeploy(fleetId: string): void {
    const item = this.fleetRegistry.find(f => f.id === fleetId);
    if (!item) return;

    this.cancelDeploy();
    this.deployingFleetId = fleetId;
    this.deployDirectionIdx = 0;
    this.pendingTrainDeploy = null;
    this.clearHoverTrainGhost();
    this.callbacks.onUpdateRotationHint?.();
  }

  /**
   * 配置モードのキャンセル
   */
  public cancelDeploy(): void {
    if (this.pendingTrainDeploy) {
      this.scene.remove(this.pendingTrainDeploy.ghost);
      disposeHierarchy(this.pendingTrainDeploy.ghost);
      this.pendingTrainDeploy = null;
    }
    this.clearHoverTrainGhost();
    this.deployingFleetId = null;
  }

  /**
   * 営業中の列車を車庫へ回送（回収）
   */
  public recallFleetTrain(fleetId: string): void {
    const item = this.fleetRegistry.find(f => f.id === fleetId);
    if (!item || item.status !== 'deployed' || item.activeTrainId === undefined) return;

    const train = this.trainManager.getTrainById(item.activeTrainId);
    if (train) {
      item.totalPassengers = (item.totalPassengers ?? 0) + train.totalPassengers;
      item.totalRevenue = (item.totalRevenue ?? 0) + train.totalRevenue;
    }
    this.callbacks.onExitCabView?.();
    this.trainManager.removeTrain(item.activeTrainId);
    item.status = 'in_depot';
    item.activeTrainId = undefined;
    this.audioManager.playDemolishSound();
    this.syncFleetStats();
    this.uiManager.showFleetModal(this.fleetRegistry);
  }

  /**
   * 営業中の列車にカメラ追従
   */
  public trackFleetTrain(fleetId: string, onLayerSwitch: (layer: GridLayer) => void): void {
    const item = this.fleetRegistry.find(f => f.id === fleetId);
    if (!item || item.status !== 'deployed' || item.activeTrainId === undefined) return;
    const train = this.trainManager.getTrainById(item.activeTrainId);
    if (train) {
      if (train.currentTile.layer !== this.worldMap.activeLayer) {
        onLayerSwitch(train.currentTile.layer);
      }
      const target = this.trainManager.getFollowTargetByTrainId(train.id);
      if (target) {
        this.cameraManager.startTracking(target, true);
      }
      this.uiManager.showTrainInspector(train);
    }
  }

  /**
   * 編成分割時の台帳自動更新
   */
  public onTrainSplit(parentTrain: any, splitTrain: any): void {
    if (parentTrain.fleetId) {
      const parentFleet = this.fleetRegistry.find(f => f.id === parentTrain.fleetId);
      if (parentFleet) {
        parentFleet.cars = parentTrain.carCount;
      }
    }

    const splitFleetId = `fleet-${this.nextFleetId++}`;
    splitTrain.fleetId = splitFleetId;

    const splitFleetItem: FleetItem = {
      id: splitFleetId,
      name: splitTrain.name,
      model: splitTrain.model,
      cars: splitTrain.carCount,
      status: 'deployed',
      activeTrainId: splitTrain.id
    };
    this.fleetRegistry.push(splitFleetItem);
    this.syncFleetStats();
  }

  /**
   * 編成連結時の台帳自動更新
   */
  public onTrainCoupled(leaderTrain: any, followerTrain: any, getSelectedTrainId: () => number | null, setSelectedTrainId: (id: number | null) => void): void {
    if (leaderTrain.fleetId) {
      const leaderFleet = this.fleetRegistry.find(f => f.id === leaderTrain.fleetId);
      if (leaderFleet) {
        leaderFleet.cars = leaderTrain.carCount;
      }
    }

    this.fleetRegistry = this.fleetRegistry.filter(f => f.activeTrainId !== followerTrain.id);
    this.syncFleetStats();

    if (getSelectedTrainId() === followerTrain.id) {
      setSelectedTrainId(leaderTrain.id);
      this.uiManager.showTrainInspector(leaderTrain);
    }
  }

  /**
   * 運行中列車と車両基地台帳の整合性自動修復
   */
  public ensureIntegrityWithRunningTrains(): void {
    for (const t of this.trainManager.getTrains()) {
      const hasFleet = this.fleetRegistry.some(f => f.activeTrainId === t.id);
      if (!hasFleet) {
        const fleetItem: FleetItem = {
          id: t.fleetId || `fleet-${this.nextFleetId++}`,
          name: t.name,
          model: t.model,
          cars: t.carCount,
          status: 'deployed',
          activeTrainId: t.id,
          totalPassengers: t.totalPassengers,
          totalRevenue: t.totalRevenue
        };
        this.fleetRegistry.push(fleetItem);
      }
    }
    for (const f of this.fleetRegistry) {
      if (f.status === 'deployed' && f.activeTrainId !== undefined) {
        const exists = this.trainManager.getTrainById(f.activeTrainId);
        if (!exists) {
          f.status = 'in_depot';
          f.activeTrainId = undefined;
        }
      }
    }
    this.syncFleetStats();
  }

  /**
   * ゴーストメッシュ生成
   */
  public createTrainGhost(
    model: VehicleModelInfo,
    carCount: number,
    dirIdx: number,
    targetTileX: number,
    targetTileZ: number,
    layer?: GridLayer
  ): THREE.Group {
    const { group, cars } = ModelFactory.createTrainFormation(model, carCount);

    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        if (Array.isArray(mesh.material)) {
          mesh.material = mesh.material.map(m => {
            const clone = m.clone();
            clone.transparent = true;
            clone.opacity = 0.72;
            clone.userData.keepAlive = false;
            return clone;
          });
        } else if (mesh.material) {
          const clone = mesh.material.clone();
          clone.transparent = true;
          clone.opacity = 0.72;
          clone.userData.keepAlive = false;
          mesh.material = clone;
        }
      }
    });

    const currentLayer: GridLayer = layer ?? this.worldMap.activeLayer;
    const tile = this.worldMap.getTile(targetTileX, targetTileZ, currentLayer);
    const elevOffset = tile?.elevationOffset ?? 0;
    const baseHeight = layerToHeight(currentLayer, elevOffset);

    const dirVec = WorldMap.DIRS[dirIdx];
    const dir = new THREE.Vector3(dirVec.x, 0, dirVec.z).normalize();
    const yaw = Math.atan2(dir.x, dir.z);

    const headPos = new THREE.Vector3(
      targetTileX * WorldMap.TILE_SIZE,
      baseHeight,
      targetTileZ * WorldMap.TILE_SIZE
    );

    cars.forEach((car, i) => {
      car.rotation.order = 'YXZ';
      car.position.copy(headPos).addScaledVector(dir, -i * ModelFactory.CAR_SPACING);
      car.rotation.set(0, yaw, 0);
    });

    const arrowHelper = new THREE.ArrowHelper(
      dir,
      headPos.clone().add(new THREE.Vector3(0, 0.45, 0)),
      1.1,
      0x38bdf8,
      0.35,
      0.22
    );
    group.add(arrowHelper);

    return group;
  }

  /**
   * ホバー追従列車ゴーストの更新
   */
  public updateHoverTrainGhost(x: number, z: number, layer: GridLayer = this.worldMap.activeLayer): void {
    if (!this.deployingFleetId || this.pendingTrainDeploy) {
      this.clearHoverTrainGhost();
      return;
    }

    const tile = this.worldMap.getTile(x, z, layer);
    if (!tile || (!tile.type.includes('rail') && !tile.type.includes('station') && tile.type !== 'signal_yard' && !tile.type.includes('switch') && !tile.type.includes('scissors') && tile.type !== 'level_crossing')) {
      this.clearHoverTrainGhost();
      return;
    }

    const item = this.fleetRegistry.find(f => f.id === this.deployingFleetId);
    if (!item) {
      this.clearHoverTrainGhost();
      return;
    }

    this.clearHoverTrainGhost();

    const exits = WorldMap.getTileExits(tile);
    let dirIdx = this.deployDirectionIdx;
    if (exits.length > 0 && !exits.some(e => e.idx === dirIdx)) {
      dirIdx = exits[0].idx;
    }

    const ghost = this.createTrainGhost(item.model, item.cars, dirIdx, x, z, layer);
    this.scene.add(ghost);
    this.hoverTrainGhost = ghost;
  }

  /**
   * ホバー追従列車ゴーストの消去
   */
  public clearHoverTrainGhost(): void {
    if (this.hoverTrainGhost) {
      this.scene.remove(this.hoverTrainGhost);
      disposeHierarchy(this.hoverTrainGhost);
      this.hoverTrainGhost = null;
    }
  }

  /**
   * タイル上での仮配置プレビューを開始
   */
  public startDeployPreviewOnTile(x: number, z: number, layer: GridLayer, tile: any): boolean {
    if (!this.deployingFleetId) return false;
    const item = this.fleetRegistry.find(f => f.id === this.deployingFleetId);
    if (!item) return false;

    if (this.pendingTrainDeploy) {
      this.scene.remove(this.pendingTrainDeploy.ghost);
      disposeHierarchy(this.pendingTrainDeploy.ghost);
      this.pendingTrainDeploy = null;
    }
    this.clearHoverTrainGhost();

    const exits = WorldMap.getTileExits(tile);
    let dirIdx: number;
    if (exits.length > 0) {
      const hasCurrent = exits.some(e => e.idx === this.deployDirectionIdx);
      dirIdx = hasCurrent ? this.deployDirectionIdx : exits[0].idx;
    } else {
      dirIdx = tile.rotation === 1 ? 1 : 2;
    }
    this.deployDirectionIdx = dirIdx;

    const ghost = this.createTrainGhost(item.model, item.cars, dirIdx, x, z, layer);
    this.scene.add(ghost);

    this.pendingTrainDeploy = {
      fleetId: item.id,
      x,
      z,
      layer,
      directionIdx: dirIdx,
      ghost
    };

    return true;
  }

  /**
   * 配置向きの回転
   */
  public rotateDeployDirection(): void {
    if (!this.deployingFleetId) return;
    const item = this.fleetRegistry.find(f => f.id === this.deployingFleetId);
    if (!item) return;

    if (this.pendingTrainDeploy) {
      const tile = this.worldMap.getTile(this.pendingTrainDeploy.x, this.pendingTrainDeploy.z, this.pendingTrainDeploy.layer);
      const exits = tile ? WorldMap.getTileExits(tile) : [];
      if (exits.length > 0) {
        const curIdx = exits.findIndex(e => e.idx === this.pendingTrainDeploy!.directionIdx);
        const nextExit = exits[(curIdx + 1) % exits.length];
        this.pendingTrainDeploy.directionIdx = nextExit.idx;
        this.deployDirectionIdx = nextExit.idx;
      } else {
        this.pendingTrainDeploy.directionIdx = (this.pendingTrainDeploy.directionIdx + 1) % 4;
        this.deployDirectionIdx = this.pendingTrainDeploy.directionIdx;
      }

      this.scene.remove(this.pendingTrainDeploy.ghost);
      disposeHierarchy(this.pendingTrainDeploy.ghost);
      const newGhost = this.createTrainGhost(
        item.model,
        item.cars,
        this.pendingTrainDeploy.directionIdx,
        this.pendingTrainDeploy.x,
        this.pendingTrainDeploy.z,
        this.pendingTrainDeploy.layer
      );
      this.scene.add(newGhost);
      this.pendingTrainDeploy.ghost = newGhost;

      this.audioManager.playSelectSound();
      this.callbacks.onUpdateRotationHint?.();
    } else {
      this.deployDirectionIdx = (this.deployDirectionIdx + 1) % 4;
      this.callbacks.onUpdateRotationHint?.();
    }
  }

  /**
   * 仮配置列車の本設置（運行開始）確定
   */
  public confirmDeploy(): boolean {
    if (!this.pendingTrainDeploy) return false;
    const { fleetId, x, z, layer, directionIdx, ghost } = this.pendingTrainDeploy;
    this.scene.remove(ghost);
    disposeHierarchy(ghost);

    const item = this.fleetRegistry.find(f => f.id === fleetId);
    if (!item) return false;

    const train = this.trainManager.spawnTrain(
      x,
      z,
      item.model,
      item.cars,
      directionIdx,
      item.id,
      layer
    );

    if (train) {
      item.status = 'deployed';
      item.activeTrainId = train.id;
      this.audioManager.playStationBell();
      this.uiManager.showToast('運行開始', `🚅 【${item.name}】が線路に配置され、営業運行を開始しました！`, 'success');
    } else {
      this.uiManager.showToast('配置失敗', '線路の接続や方向をご確認ください。', 'danger');
      return false;
    }

    this.pendingTrainDeploy = null;
    this.deployingFleetId = null;
    this.uiManager.setPlacementButtonsVisible(false);
    this.uiManager.setRotationHint(false);
    this.callbacks.onUpdateRotationHint?.();
    return true;
  }

  public serializeFleetData(): any[] {
    this.syncFleetStats();
    return this.fleetRegistry.map(f => ({
      id: f.id,
      name: f.name,
      modelId: f.model.id,
      cars: f.cars,
      status: f.status,
      activeTrainId: f.activeTrainId,
      totalPassengers: f.totalPassengers ?? 0,
      totalRevenue: f.totalRevenue ?? 0
    }));
  }

  public deserializeFleetData(parsedFleet: any[]): void {
    this.fleetRegistry = parsedFleet.map((f: any) => {
      const model = getVehicleById(f.modelId) || getVehicleById('commuter-train')!;
      return {
        id: f.id,
        name: f.name,
        model,
        cars: f.cars,
        status: f.status,
        activeTrainId: f.activeTrainId,
        totalPassengers: f.totalPassengers,
        totalRevenue: f.totalRevenue
      };
    });
  }
}
