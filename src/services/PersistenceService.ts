import { WorldMap } from '../simulation/WorldMap';
import { GridManager } from '../core/GridManager';
import { GridLayer, MapSize, TerrainType } from '../core/types';
import { TrainManager } from '../simulation/TrainManager';
import { FleetController } from '../controllers/FleetController';
import { Economy } from '../simulation/Economy';
import { TimeManager, SpeedLevel } from '../core/TimeManager';
import { ZoneManager } from '../core/ZoneManager';
import { DemandEngine } from '../core/DemandEngine';
import { UIManager } from '../ui/UIManager';
import { AudioManager } from '../engine/AudioManager';
import { CameraManager } from '../graphics/CameraManager';
import { TerrainRenderer } from '../graphics/TerrainRenderer';
import { EngineRenderer, GraphicsQuality } from '../engine/Renderer';
import { ChunkManager } from '../core/ChunkManager';
import { MiniMap } from '../ui/MiniMap';
import { ScheduleUI } from '../ui/ScheduleUI';
import { SwitchScheduleUI } from '../ui/SwitchScheduleUI';
import { WorldLabelManager } from '../ui/WorldLabelManager';
import { GameState } from '../core/GameState';
import { getVehicleById } from '../simulation/VehicleCatalog';
import { CityGrowth } from '../simulation/CityGrowth';
import { VisualEffectManager } from '../graphics/VisualEffectManager';
import { isTrackLikeType } from '../controllers/PlacementController';
import { BuildingBakery } from '../graphics/structures/BuildingBakery';
import { UndoManager } from '../core/UndoManager';
import { db, SavedTileRecord, SavedTrainRecord, SavedEconomyRecord, SavedSystemRecord } from './Database';
import { ExternalConnectionManager } from '../simulation/ExternalConnectionManager';

export interface PersistenceServiceDependencies {
  gameState: GameState;
  worldMap: WorldMap;
  getGridManager: () => GridManager;
  setGridManager: (gm: GridManager) => void;
  trainManager: TrainManager;
  fleetController: FleetController;
  economy: Economy;
  undoManager?: UndoManager;
  externalConnectionManager?: ExternalConnectionManager;
  timeManager: TimeManager;
  zoneManager: ZoneManager;
  demandEngine: DemandEngine;
  uiManager: UIManager;
  audioManager: AudioManager;
  cameraManager: CameraManager;
  terrainRenderer: TerrainRenderer;
  renderer: EngineRenderer;
  chunkManager: ChunkManager;
  miniMap: MiniMap;
  scheduleUI: ScheduleUI;
  switchScheduleUI: SwitchScheduleUI;
  worldLabelManager: WorldLabelManager;
  visualEffectManager: VisualEffectManager;
  cityGrowth: CityGrowth;
  onClearPendingPlacements: () => void;
  onLayerSwitched: (layer: GridLayer) => void;
}

/**
 * ゲームデータの永続化（IndexedDB セーブ・ロード・リセット）および初期都市生成を担当するサービス
 */
export class PersistenceService {
  public static readonly GRAPHICS_QUALITY_KEY = 'wagamachi_graphics_quality';

  /**
   * localStorage から保存されたグラフィック画質設定を読み出す（未保存または無効値は null）
   */
  public static getSavedGraphicsQuality(): GraphicsQuality | null {
    try {
      const val = localStorage.getItem(PersistenceService.GRAPHICS_QUALITY_KEY);
      if (val === 'high' || val === 'medium' || val === 'low') {
        return val as GraphicsQuality;
      }
    } catch (e) {
      console.warn('Failed to load graphics quality from localStorage', e);
    }
    return null;
  }

  /**
   * 端末性能・画面サイズに応じた推奨初期画質を判定
   * 画面幅 768px 以下のタッチ端末である場合、デフォルト設定を 'medium'（低〜中スペック向け）に選定
   */
  public static detectDefaultGraphicsQuality(): GraphicsQuality {
    const isSmallScreen = window.innerWidth <= 768;
    const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    if (isSmallScreen && isTouchDevice) {
      return 'medium';
    }
    return 'high';
  }

  /**
   * グラフィック画質設定を localStorage に永続化
   */
  public static saveGraphicsQuality(quality: GraphicsQuality): void {
    try {
      localStorage.setItem(PersistenceService.GRAPHICS_QUALITY_KEY, quality);
    } catch (e) {
      console.warn('Failed to save graphics quality to localStorage', e);
    }
  }

  private deps: PersistenceServiceDependencies;
  private isSaving: boolean = false;

  constructor(deps: PersistenceServiceDependencies) {
    this.deps = deps;
  }

  /**
   * メインスレッドの描画（requestAnimationFrame）や入力処理を阻害しないよう、
   * 次のマクロタスクへ処理を一時譲渡するヘルパー
   */
  private yieldToMain(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  /**
   * セーブデータが存在するか確認（IndexedDB またはレガシー localStorage）
   */
  public async hasSaveData(): Promise<boolean> {
    try {
      const tileCount = await db.tiles.count();
      if (tileCount > 0) return true;
      const legacy = localStorage.getItem('wagamachi_save_data') ||
                     localStorage.getItem('saikyo_save_data') ||
                     localStorage.getItem('stk_3d_world');
      return !!legacy;
    } catch {
      return false;
    }
  }

  /**
   * 現在のゲーム状態を IndexedDB (Dexie) へ非同期・原子的トランザクション保存
   * @param isManual 手動セーブ（ユーザー操作）か定期オートセーブか
   */
  public async saveGame(isManual: boolean = false): Promise<void> {
    // 多重実行ガード: 保存処理が既に実行中の場合は重複実行を防止
    if (this.isSaving) {
      if (isManual) {
        this.deps.uiManager.showToast('セーブ実行中', '現在データの保存処理を実行中です。完了までしばらくお待ちください。', 'info');
      }
      return;
    }

    this.isSaving = true;

    try {
      const { worldMap, zoneManager, economy, trainManager, fleetController, timeManager, uiManager, scheduleUI } = this.deps;

      // 【ステップA: タイルデータの抽出】
      const tileRecords: SavedTileRecord[] = [];
      for (const t of worldMap.getAllTiles()) {
        // シーサスクロッシングの従属マス(B/C/D)は起点(A)から復元されるため重複登録を除外
        if (t.groupOrigin && t.crossingRole !== 0) continue;
        if (t.type !== 'empty') {
          tileRecords.push({
            id: `${t.x},${t.z},${t.layer ?? 1}`,
            x: t.x,
            z: t.z,
            layer: (t.layer ?? 1) as GridLayer,
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
            // 互換キー
            rot: t.rotation,
            lvl: t.level,
            sw: t.switchState,
            branchSide: t.switchBranchSide,
            crossState: t.crossingState,
            roadAxis: t.crossingRoadAxis,
            slopeRev: t.slopeReversed,
            cargoYard: t.isCargoYard
          });
        }
      }

      // 【ステップB: 列車・経済・システム設定データの抽出】
      const rawTrains = trainManager.serialize();
      const trainsList: any[] = rawTrains ? JSON.parse(rawTrains) : [];
      const trainRecords: SavedTrainRecord[] = trainsList.map((t: any) => ({
        id: t.id,
        data: t,
        fleetId: t.fleetId
      }));

      const economyRecord: SavedEconomyRecord = {
        id: 'current',
        ...economy.serialize()
      };

      const systemRecords: SavedSystemRecord[] = [
        {
          key: 'time',
          value: {
            year: timeManager.year,
            month: timeManager.month,
            day: timeManager.day,
            hour: timeManager.hour,
            minute: timeManager.minute,
            speedLevel: timeManager.speedLevel
          }
        },
        { key: 'fleet', value: fleetController.serializeFleetData() },
        { key: 'next_fleet_id', value: fleetController.nextFleetId },
        { key: 'zones', value: zoneManager.serialize() },
        { key: 'route_templates', value: scheduleUI.serializeTemplates() },
        { key: 'stations', value: worldMap.stationManager.serialize() },
        { key: 'world_meta', value: { gridSize: worldMap.gridSize } },
        { key: 'external_connections', value: this.deps.externalConnectionManager?.toSnapshot() }
      ];

      // メインスレッドのフレームドロップを回避するため非同期タスク譲渡
      await this.yieldToMain();

      // 【ステップC: IndexedDB への一括トランザクション書き込み】
      await db.transaction('rw', [db.tiles, db.trains, db.economy, db.system], async () => {
        await db.tiles.clear();
        await db.tiles.bulkPut(tileRecords);

        await db.trains.clear();
        if (trainRecords.length > 0) {
          await db.trains.bulkPut(trainRecords);
        }

        await db.economy.put(economyRecord);

        await db.system.bulkPut(systemRecords);
      });

      if (isManual) {
        uiManager.showToast('セーブ完了', 'ゲームデータを IndexedDB に安全に保存しました。', 'success');
      }
    } catch (err: any) {
      console.error('[PersistenceService] セーブ処理中にエラーが発生しました:', err);
      const isQuota = err?.name === 'QuotaExceededError';
      const message = isQuota
        ? 'ブラウザのストレージ容量上限に達したため、一部のデータが保存できませんでした。'
        : 'データベースへの書き込み中にエラーが発生しました。プライベートブラウズ設定をご確認ください。';
      this.deps.uiManager.showToast('セーブ失敗', message, 'danger');
    } finally {
      this.isSaving = false;
    }
  }

  /**
   * 都市データの初期ロードまたは初期都市生成（非同期）
   */
  public async initWorld(): Promise<void> {
    const loaded = await this.loadGame();
    if (!loaded) {
      this.buildInitialCity();
    }
  }

  /**
   * セーブデータの読み込み、各サブシステムへのデシリアライズ委譲（非同期）
   */
  public async loadGame(): Promise<boolean> {
    const {
      worldMap,
      zoneManager,
      timeManager,
      economy,
      trainManager,
      fleetController,
      visualEffectManager,
      scheduleUI,
      terrainRenderer,
      renderer,
      getGridManager
    } = this.deps;

    try {
      const tileCount = await db.tiles.count();

      // 【ステップA: IndexedDB が空の場合の後方互換マイグレーション判定】
      if (tileCount === 0) {
        const legacySave = localStorage.getItem('wagamachi_save_data') ||
                           localStorage.getItem('saikyo_save_data') ||
                           localStorage.getItem('stk_3d_world');
        if (legacySave) {
          return await this.migrateFromLocalStorage(legacySave);
        }
        return false;
      }

      // 【ステップB: IndexedDB からのデータ復元】
      // 1. システムメタデータ
      const systemEntries = await db.system.toArray();
      const systemMap = new Map<string, any>(systemEntries.map(e => [e.key, e.value]));

      // 2. 経済データ
      const savedEconomy = await db.economy.get('current');
      if (savedEconomy) {
        economy.deserialize(savedEconomy);
      }

      // 3. タイルデータおよび駅構成
      const savedTiles = await db.tiles.toArray();
      const stationData = systemMap.get('stations');
      worldMap.deserialize({ tiles: savedTiles, stations: stationData });

      // 4. 運行系統ダイヤテンプレート
      const savedTemplates = systemMap.get('route_templates');
      if (savedTemplates) {
        scheduleUI.deserializeTemplates(typeof savedTemplates === 'string' ? savedTemplates : JSON.stringify(savedTemplates));
      }

      // 5. ゾーンデータ
      const savedZones = systemMap.get('zones');
      if (savedZones) {
        zoneManager.deserialize(typeof savedZones === 'string' ? savedZones : JSON.stringify(savedZones));
        visualEffectManager.refreshZoneOverlay(zoneManager.getAllZones().map(c => ({ x: c.x, z: c.z })));
      }
      for (const t of worldMap.getAllTiles()) {
        if (t.isCargoYard || t.type.startsWith('cargo_station')) {
          visualEffectManager.updateCargoYardVisual(t.x, t.z, (t.layer ?? 1) as GridLayer);
        }
      }

      // 6. 日時・スピード設定
      const savedTime = systemMap.get('time');
      if (savedTime && typeof savedTime.hour === 'number' && typeof savedTime.minute === 'number') {
        timeManager.year = savedTime.year ?? timeManager.year;
        timeManager.month = savedTime.month ?? timeManager.month;
        timeManager.day = savedTime.day ?? timeManager.day;
        timeManager.hour = savedTime.hour;
        timeManager.minute = savedTime.minute;
        if (typeof savedTime.speedLevel === 'number') {
          timeManager.setSpeedLevel(savedTime.speedLevel as SpeedLevel);
          this.deps.uiManager.setSpeedUI(savedTime.speedLevel);
        }
        economy.syncDate(timeManager.year, timeManager.month, timeManager.day);
      }

      // 7. 運行中列車および車両基地保有リスト
      const savedNextFleetId = systemMap.get('next_fleet_id');
      if (savedNextFleetId) {
        fleetController.nextFleetId = parseInt(savedNextFleetId, 10) || fleetController.nextFleetId;
      }

      const savedTrains = await db.trains.toArray();
      let trainsLoaded = false;
      if (savedTrains.length > 0) {
        const trainArray = savedTrains.map(t => t.data);
        trainsLoaded = trainManager.deserialize(JSON.stringify(trainArray));
      }

      const savedFleet = systemMap.get('fleet');
      if (savedFleet) {
        const fleetArray = typeof savedFleet === 'string' ? JSON.parse(savedFleet) : savedFleet;
        if (Array.isArray(fleetArray)) {
          fleetController.deserializeFleetData(fleetArray);
        }
      }

      fleetController.ensureIntegrityWithRunningTrains();

      // フォールバック初期列車
      if (!trainsLoaded && fleetController.getFleetRegistry().length === 0) {
        const track = worldMap.getAllTiles().find(t => t.type.includes('station') || t.type.includes('rail'));
        if (track) {
          const vehicle = getVehicleById('commuter-train');
          if (vehicle) {
            const train = trainManager.spawnTrain(track.x, track.z, vehicle, 2);
            if (train) {
              fleetController.registerNewFleetItem({
                id: `fleet-${fleetController.nextFleetId++}`,
                name: `${vehicle.name} 1号`,
                model: vehicle,
                cars: 2,
                status: 'deployed',
                activeTrainId: train.id
              });
            }
          }
        }
      }

      // 8. 外部接続都市データ復元・同期
      const extConnData = systemMap.get('external_connections');
      if (extConnData && this.deps.externalConnectionManager) {
        this.deps.externalConnectionManager.loadFromSnapshot(extConnData);
      }
      this.deps.externalConnectionManager?.checkConnections(worldMap);

      terrainRenderer.build(getGridManager(), renderer.scene);
      return true;
    } catch (err) {
      console.error('[PersistenceService] ロード処理中にエラーが発生しました:', err);
      this.deps.uiManager.showToast('ロード失敗', 'セーブデータの読み込み中にエラーが発生しました。', 'danger');
      return false;
    }
  }

  /**
   * レガシー localStorage からの自動マイグレーション処理
   */
  private async migrateFromLocalStorage(legacyWorldJson: string): Promise<boolean> {
    const {
      worldMap,
      zoneManager,
      timeManager,
      economy,
      trainManager,
      fleetController,
      visualEffectManager,
      scheduleUI,
      terrainRenderer,
      renderer,
      getGridManager
    } = this.deps;

    try {
      console.info('[PersistenceService] localStorage から IndexedDB へのマイグレーションを開始します...');

      // 1. 旧ワールドマップ復元
      worldMap.deserialize(legacyWorldJson);

      // 2. 旧経済データ復元
      const legacyEconomy = localStorage.getItem('wagamachi_economy_data') || localStorage.getItem('stk_3d_economy');
      if (legacyEconomy) {
        try {
          economy.deserialize(JSON.parse(legacyEconomy));
        } catch (e) {
          console.warn('[PersistenceService] 旧経済データパース失敗:', e);
        }
      }

      // 3. 旧ダイヤテンプレート
      const legacyTemplates = localStorage.getItem('wagamachi_route_templates');
      if (legacyTemplates) {
        scheduleUI.deserializeTemplates(legacyTemplates);
      }

      // 4. 旧ゾーンデータ
      const legacyZones = localStorage.getItem('wagamachi_zone_data') || localStorage.getItem('saikyo_zone_data');
      if (legacyZones) {
        zoneManager.deserialize(legacyZones);
        visualEffectManager.refreshZoneOverlay(zoneManager.getAllZones().map(c => ({ x: c.x, z: c.z })));
      }

      // 5. 旧日時データ
      const legacyTime = localStorage.getItem('wagamachi_time_data') || localStorage.getItem('saikyo_time_data');
      if (legacyTime) {
        try {
          const t = JSON.parse(legacyTime);
          if (t && typeof t.hour === 'number' && typeof t.minute === 'number') {
            timeManager.year = t.year ?? timeManager.year;
            timeManager.month = t.month ?? timeManager.month;
            timeManager.day = t.day ?? timeManager.day;
            timeManager.hour = t.hour;
            timeManager.minute = t.minute;
            if (typeof t.speedLevel === 'number') {
              timeManager.setSpeedLevel(t.speedLevel as SpeedLevel);
              this.deps.uiManager.setSpeedUI(t.speedLevel);
            }
            economy.syncDate(timeManager.year, timeManager.month, timeManager.day);
          }
        } catch (e) {
          console.warn('[PersistenceService] 旧日時データパース失敗:', e);
        }
      }

      // 6. 旧列車およびFleetデータ
      const legacyNextFleetId = localStorage.getItem('wagamachi_next_fleet_id') || localStorage.getItem('saikyo_next_fleet_id');
      if (legacyNextFleetId) {
        fleetController.nextFleetId = parseInt(legacyNextFleetId, 10) || fleetController.nextFleetId;
      }
      const legacyTrains = localStorage.getItem('wagamachi_trains_data') || localStorage.getItem('saikyo_trains_data');
      if (legacyTrains) {
        trainManager.deserialize(legacyTrains);
      }
      const legacyFleet = localStorage.getItem('wagamachi_fleet_data') || localStorage.getItem('saikyo_fleet_data');
      if (legacyFleet) {
        try {
          const parsedFleet = JSON.parse(legacyFleet);
          if (Array.isArray(parsedFleet)) {
            fleetController.deserializeFleetData(parsedFleet);
          }
        } catch (e) {
          console.warn('[PersistenceService] 旧Fleetデータパース失敗:', e);
        }
      }
      fleetController.ensureIntegrityWithRunningTrains();

      // 7. IndexedDB へ新規保存
      await this.saveGame(false);

      // 8. マイグレーション完了後、localStorage の旧キーを安全に全削除
      const legacyKeys = [
        'wagamachi_save_data', 'wagamachi_economy_data', 'wagamachi_zone_data',
        'wagamachi_trains_data', 'wagamachi_fleet_data', 'wagamachi_next_fleet_id',
        'wagamachi_time_data', 'wagamachi_route_templates', 'stk_3d_world',
        'stk_3d_economy', 'saikyo_save_data', 'saikyo_zone_data',
        'saikyo_trains_data', 'saikyo_fleet_data', 'saikyo_next_fleet_id',
        'saikyo_time_data'
      ];
      for (const k of legacyKeys) {
        try {
          localStorage.removeItem(k);
        } catch {}
      }

      terrainRenderer.build(getGridManager(), renderer.scene);
      console.info('[PersistenceService] localStorage から IndexedDB への移行が正常に完了しました！');
      return true;
    } catch (err) {
      console.error('[PersistenceService] マイグレーション処理中にエラーが発生しました:', err);
      return false;
    }
  }

  /**
   * 初期都市の構築（新規ゲーム・初期配置用）
   */
  public buildInitialCity(): void {
    const {
      worldMap,
      zoneManager,
      economy,
      trainManager,
      fleetController,
      terrainRenderer,
      demandEngine,
      timeManager,
      visualEffectManager,
      renderer
    } = this.deps;

    // 西側駅（2マスホーム: X=-6, X=-5）
    worldMap.placeStationGroup(-6, 0, 2, 1, false, '西中央駅');

    // 中間地上線路
    for (let x = -4; x <= 4; x++) {
      worldMap.setTile(x, 0, 'rail_ground', 1);
    }

    // 東側駅（2マスホーム: X=5, X=6、すべて地上）
    worldMap.placeStationGroup(5, 0, 2, 1, false, '東中央駅');

    // 分岐器（ポイント、1マス）を西側駅の手前に設置
    worldMap.placeSwitch(-3, 0, 1, false);

    // 道路
    for (let x = -7; x <= 7; x++) {
      worldMap.setTile(x, 2, 'road', 1);
    }

    // 踏切のデモ
    worldMap.setTile(-2, -1, 'road', 0);
    worldMap.setTile(-2, 0, 'road', 0);
    worldMap.setTile(-2, 1, 'road', 0);

    // 住宅・商業・緑地
    worldMap.setTile(-6, 3, 'residence', 0, 2);
    worldMap.setTile(-5, 3, 'commercial', 0, 3);
    worldMap.setTile(-4, 3, 'residence', 0, 1);
    worldMap.setTile(5, 3, 'commercial', 0, 4);
    worldMap.setTile(6, 3, 'residence', 0, 2);

    worldMap.setTile(-7, 1, 'nature');
    worldMap.setTile(7, 1, 'nature');

    // 初期デモゾーニング
    const westZone = zoneManager.paintZone(-6, 3, 'residential', 3);
    const eastZone = zoneManager.paintZone(5, 3, 'commercial', 3);
    const industrialZone = zoneManager.paintZone(-6, -6, 'industrial', 3);
    visualEffectManager.refreshZoneOverlay([...westZone, ...eastZone, ...industrialZone].map(c => ({ x: c.x, z: c.z })));

    economy.addPopulation(820);

    // 初期列車（通勤型電車 2両編成）
    const vehicle = getVehicleById('commuter-train');
    if (vehicle) {
      const train = trainManager.spawnTrain(-5, 0, vehicle, 2);
      if (train) {
        fleetController.registerNewFleetItem({
          id: `fleet-${fleetController.nextFleetId++}`,
          name: `${vehicle.name} 1号`,
          model: vehicle,
          cars: 2,
          status: 'deployed',
          activeTrainId: train.id
        });
      }
    }

    terrainRenderer.build(this.deps.getGridManager(), renderer.scene);

    // 外部接続都市への延伸線路をスキャン
    this.deps.externalConnectionManager?.checkConnections(worldMap);

    trainManager.updateHourlyStationPassengers(
      timeManager.hour,
      (x, z, h) => demandEngine.getDemandMultiplier(h, x, z)
    );
  }

  /**
   * 新規作成によるゲーム開始（非同期）
   */
  public async startNewGame(mapSize: MapSize, terrainType: TerrainType): Promise<void> {
    const {
      gameState,
      renderer,
      worldMap,
      cityGrowth,
      uiManager,
      trainManager,
      fleetController,
      economy,
      timeManager,
      scheduleUI,
      zoneManager,
      visualEffectManager,
      chunkManager,
      miniMap,
      terrainRenderer,
      cameraManager,
      onClearPendingPlacements,
      onLayerSwitched
    } = this.deps;

    gameState.startNewGame(mapSize, terrainType);
    const newGrid = new GridManager(mapSize, terrainType);
    this.deps.setGridManager(newGrid);

    renderer.updateGroundAndGridSize(mapSize);
    worldMap.setGridSize(mapSize);
    worldMap.setElevationProvider((x, z) => {
      const cell = newGrid.getCell(x, 1, z);
      return cell ? Math.max(0, (cell.elevation - 1) * 3.0) : 0;
    });
    cityGrowth.setGridManager(newGrid);
    worldMap.gridManagerRef = newGrid;

    onLayerSwitched(1);

    onClearPendingPlacements();
    worldMap.clearAll();
    this.deps.undoManager?.clear();
    BuildingBakery.clearCache();
    trainManager.removeAllTrains();
    fleetController.clearAllFleet();
    economy.resetAll();
    timeManager.deserialize({ year: 2026, month: 4, day: 1, hour: 6, minute: 0, speedLevel: 1 });
    uiManager.setSpeedUI(1);
    scheduleUI.close();

    zoneManager.clearAll();
    visualEffectManager.clearAllZoneOverlays();
    visualEffectManager.clearAllCargoYardVisuals();
    chunkManager.setGridManager(newGrid);
    miniMap.setGridManager(newGrid);

    this.deps.externalConnectionManager?.initDefaultCities(mapSize);
    this.buildInitialCity();
    terrainRenderer.build(newGrid, renderer.scene);

    cameraManager.target.set(0, 0, 0);
    cameraManager.stopTracking();
    cameraManager.setQuarterViewMode();
    uiManager.setCameraModeUI('orbit');
  }

  /**
   * セーブデータからのゲーム再開（非同期）
   */
  public async resumeGame(): Promise<void> {
    const { gameState, cameraManager, uiManager, onLayerSwitched } = this.deps;
    gameState.resumeGame();
    await this.initWorld();
    onLayerSwitched(1);
    cameraManager.target.set(0, 0, 0);
    cameraManager.stopTracking();
    cameraManager.setQuarterViewMode();
    uiManager.setCameraModeUI('orbit');
  }

  /**
   * ゲームデータのリセット（IndexedDB クリア・初期化してタイトルへ復帰）
   */
  public async resetGame(): Promise<void> {
    const {
      renderer,
      worldMap,
      terrainRenderer,
      trainManager,
      fleetController,
      worldLabelManager,
      economy,
      timeManager,
      uiManager,
      zoneManager,
      demandEngine,
      visualEffectManager,
      chunkManager,
      miniMap,
      cameraManager,
      audioManager,
      scheduleUI,
      switchScheduleUI,
      gameState,
      onClearPendingPlacements,
      onLayerSwitched,
      cityGrowth
    } = this.deps;

    // IndexedDB テーブルの全消去
    try {
      await db.transaction('rw', [db.tiles, db.trains, db.economy, db.system], async () => {
        await db.tiles.clear();
        await db.trains.clear();
        await db.economy.clear();
        await db.system.clear();
      });
    } catch (e) {
      console.warn('[PersistenceService] IndexedDB クリア時の警告:', e);
    }

    // レガシー localStorage キーの残骸も完全クリーンアップ
    const legacyKeys = [
      'wagamachi_save_data', 'wagamachi_economy_data', 'wagamachi_zone_data',
      'wagamachi_trains_data', 'wagamachi_fleet_data', 'wagamachi_next_fleet_id',
      'wagamachi_time_data', 'wagamachi_route_templates', 'stk_3d_world',
      'stk_3d_economy', 'saikyo_save_data', 'saikyo_zone_data',
      'saikyo_trains_data', 'saikyo_fleet_data', 'saikyo_next_fleet_id',
      'saikyo_time_data'
    ];
    for (const k of legacyKeys) {
      try {
        localStorage.removeItem(k);
      } catch {}
    }

    scheduleUI.resetTemplates();

    onClearPendingPlacements();
    scheduleUI.close();
    switchScheduleUI.close();
    uiManager.closeInspector();

    const reportModal = document.getElementById('report-modal');
    if (reportModal) reportModal.classList.add('hidden');
    const vehicleModal = document.getElementById('vehicle-modal');
    if (vehicleModal) vehicleModal.classList.add('hidden');
    const fleetModal = document.getElementById('fleet-modal');
    if (fleetModal) fleetModal.classList.add('hidden');
    const helpModal = document.getElementById('help-modal');
    if (helpModal) helpModal.classList.add('hidden');

    const newGrid = new GridManager(64, 'balanced');
    this.deps.setGridManager(newGrid);
    worldMap.setGridSize(64);
    worldMap.setElevationProvider((x, z) => {
      const cell = newGrid.getCell(x, 1, z);
      return cell ? Math.max(0, (cell.elevation - 1) * 3.0) : 0;
    });
    cityGrowth.setGridManager(newGrid);
    worldMap.gridManagerRef = newGrid;

    onLayerSwitched(1);

    renderer.updateGroundAndGridSize(64);
    renderer.clearGroundHoles();
    worldMap.clearAll();
    this.deps.undoManager?.clear();
    terrainRenderer.clear(renderer.scene);
    BuildingBakery.clearCache();
    trainManager.removeAllTrains();
    fleetController.clearAllFleet();
    worldLabelManager.clear();
    economy.resetAll();
    timeManager.deserialize({ year: 2026, month: 4, day: 1, hour: 6, minute: 0, speedLevel: 1 });
    uiManager.setSpeedUI(1);
    economy.syncDate(2026, 4, 1);
    zoneManager.clearAll();
    demandEngine.clearCache();
    visualEffectManager.clearAllZoneOverlays();
    visualEffectManager.clearAllCargoYardVisuals();
    chunkManager.setGridManager(newGrid);
    miniMap.setGridManager(newGrid);

    this.deps.externalConnectionManager?.initDefaultCities(64);
    this.buildInitialCity();
    terrainRenderer.build(newGrid, renderer.scene);
    cameraManager.stopTracking();
    cameraManager.setQuarterViewMode();
    uiManager.setCameraModeUI('orbit');
    audioManager.stopCabMotorSound();

    const allTiles = worldMap.getAllTiles();
    const trackCount = allTiles.filter(t => isTrackLikeType(t.type)).length;
    const stationCount = allTiles.filter(t => WorldMap.isStationTileType(t.type)).length;
    const reportData = economy.getFinancialReport(trackCount, trainManager.getTrains().length, stationCount);
    uiManager.updateFinancialReport(reportData);

    gameState.returnToTitle();
    uiManager.showTitleScreen(false);
  }

  /**
   * トンネル出入口および地下勾配スロープの開口表示検証用テストセットアップ
   */
  public setupTestCutouts(): void {
    const { uiManager, worldMap, getGridManager, terrainRenderer, renderer, cameraManager } = this.deps;
    uiManager.hideTitleScreen();

    // 1. 地下スロープの配置 (地上1F -> 地下B1, 西->東)
    worldMap.placeUndergroundSlope(0, 6, 1, true, 1);

    // 2. 山岳トンネルの自動配置
    const grid = getGridManager();
    let mountainBorder: { x: number; z: number } | null = null;
    for (let r = 5; r <= 35 && !mountainBorder; r++) {
      for (let dx = -r; dx <= r && !mountainBorder; dx++) {
        for (let dz = -r; dz <= r && !mountainBorder; dz++) {
          const c0 = grid.getCell(dx, 1, dz);
          const cLeft = grid.getCell(dx - 1, 1, dz);
          if (c0 && cLeft && c0.elevation >= 2 && cLeft.elevation === 1 && !c0.isWater && !cLeft.isWater) {
            mountainBorder = { x: dx, z: dz };
            break;
          }
        }
      }
    }

    if (mountainBorder) {
      const { x, z } = mountainBorder;
      worldMap.setTile(x - 2, z, 'rail_ground', 1, 1);
      worldMap.setTile(x - 1, z, 'rail_ground', 1, 1);
      worldMap.setTile(x, z, 'rail_ground', 1, 1);
      worldMap.setTile(x + 1, z, 'rail_ground', 1, 1);
      worldMap.setTile(x + 2, z, 'rail_ground', 1, 1);
      terrainRenderer.rebuildAll(grid, renderer.scene);

      const midX = (x + 1.5) / 2;
      const midZ = (z + 6) / 2;
      cameraManager.jumpToPosition({ x: midX * 2.0, z: midZ * 2.0 });
    }
  }
}
