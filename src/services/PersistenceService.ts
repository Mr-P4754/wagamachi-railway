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

export interface PersistenceServiceDependencies {
  gameState: GameState;
  worldMap: WorldMap;
  getGridManager: () => GridManager;
  setGridManager: (gm: GridManager) => void;
  trainManager: TrainManager;
  fleetController: FleetController;
  economy: Economy;
  undoManager?: UndoManager;
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
 * ゲームデータの永続化（セーブ・ロード・リセット）および初期都市生成を担当するサービス
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

  constructor(deps: PersistenceServiceDependencies) {
    this.deps = deps;
  }

  private isSaving: boolean = false;

  /**
   * メインスレッドの描画（requestAnimationFrame）や入力処理を阻害しないよう、
   * 次のマクロタスクへ処理を一時譲渡するヘルパー
   */
  private yieldToMain(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  /**
   * 現在のゲーム状態を localStorage へ非同期・分割保存
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

      // 【ステップA: 経済・時間・列車・ゾーン・系統テンプレートデータの収集とシリアライズ】
      const timeData = {
        year: timeManager.year,
        month: timeManager.month,
        day: timeManager.day,
        hour: timeManager.hour,
        minute: timeManager.minute,
        speedLevel: timeManager.speedLevel
      };
      const timeDataStr = JSON.stringify(timeData);
      const fleetDataStr = JSON.stringify(fleetController.serializeFleetData());
      const nextFleetIdStr = String(fleetController.nextFleetId);
      const trainsDataStr = trainManager.serialize();
      const zoneDataStr = zoneManager.serialize();
      const templatesStr = scheduleUI.serializeTemplates();

      // 描画フレームを阻害しないよう一度イベントループへ譲渡
      await this.yieldToMain();

      // 【ステップB: ワールドマップデータの取得（ダーティフラグ＆キャッシュ活用）】
      const worldDataStr = worldMap.serialize();

      // 描画フレームを阻害しないよう再度イベントループへ譲渡
      await this.yieldToMain();

      // 【ステップC: localStorage への分割書き込み（個別 try-catch と容量超過ハンドリング）】
      let hasQuotaError = false;

      // 軽量メタデータの書き込み
      const metadataItems: Array<{ key: string; value: string }> = [
        { key: 'wagamachi_time_data', value: timeDataStr },
        { key: 'wagamachi_fleet_data', value: fleetDataStr },
        { key: 'wagamachi_next_fleet_id', value: nextFleetIdStr },
        { key: 'wagamachi_trains_data', value: trainsDataStr },
        { key: 'wagamachi_zone_data', value: zoneDataStr },
        { key: 'wagamachi_route_templates', value: templatesStr }
      ];

      for (const item of metadataItems) {
        try {
          localStorage.setItem(item.key, item.value);
        } catch (e: any) {
          if (e?.name === 'QuotaExceededError' || e?.code === 22 || e?.code === 1014) {
            hasQuotaError = true;
            console.warn(`[PersistenceService] localStorage 容量上限超過: ${item.key}`, e);
          } else {
            console.error(`[PersistenceService] 保存エラー: ${item.key}`, e);
          }
        }
      }

      // 経済データの保存
      try {
        economy.saveToStorage();
      } catch (e: any) {
        if (e?.name === 'QuotaExceededError' || e?.code === 22 || e?.code === 1014) {
          hasQuotaError = true;
          console.warn('[PersistenceService] localStorage 容量上限超過: wagamachi_economy_data', e);
        } else {
          console.error('[PersistenceService] 経済データ保存エラー', e);
        }
      }

      // 最もサイズの大きいワールドマップデータの書き込み前に再度フレーム譲渡
      await this.yieldToMain();

      try {
        localStorage.setItem('wagamachi_save_data', worldDataStr);
      } catch (e: any) {
        if (e?.name === 'QuotaExceededError' || e?.code === 22 || e?.code === 1014) {
          hasQuotaError = true;
          console.warn('[PersistenceService] localStorage 容量上限超過: wagamachi_save_data', e);
        } else {
          console.error('[PersistenceService] ワールドマップ保存エラー', e);
        }
      }

      // 手動セーブ完了時のトースト通知
      if (isManual) {
        if (hasQuotaError) {
          uiManager.showToast(
            '保存容量上限',
            'ブラウザの保存容量上限（約5MB）に達したため、一部のデータが保存できませんでした。<br>不要な路線やセーブデータを整理してください。',
            'warning'
          );
        } else {
          uiManager.showToast('セーブ完了', 'ゲームデータを保存しました。', 'success');
        }
      }
    } catch (err) {
      console.error('[PersistenceService] セーブ処理中に予期せぬエラーが発生しました:', err);
      if (isManual) {
        this.deps.uiManager.showToast('セーブ失敗', 'セーブデータの保存中にエラーが発生しました。', 'danger');
      }
    } finally {
      this.isSaving = false;
    }
  }

  /**
   * 都市データの初期ロードまたは初期都市生成
   */
  public initWorld(): void {
    if (!this.loadGame()) {
      this.buildInitialCity();
    }
  }

  /**
   * セーブデータの読み込み、パース、バージョン検証、各サブシステムへのデシリアライズ委譲
   */
  public loadGame(): boolean {
    const {
      worldMap,
      zoneManager,
      timeManager,
      economy,
      trainManager,
      fleetController,
      terrainRenderer,
      visualEffectManager,
      renderer
    } = this.deps;

    const saved = localStorage.getItem('wagamachi_save_data') || localStorage.getItem('saikyo_save_data') || localStorage.getItem('stk_3d_world');
    if (!saved) return false;

    economy.loadFromStorage();
    worldMap.deserialize(saved);

    // 運行系統ダイヤテンプレートの復元
    const savedTemplates = localStorage.getItem('wagamachi_route_templates');
    if (savedTemplates) {
      this.deps.scheduleUI.deserializeTemplates(savedTemplates);
    }

    const savedZones = localStorage.getItem('wagamachi_zone_data') || localStorage.getItem('saikyo_zone_data');
    if (savedZones) {
      zoneManager.deserialize(savedZones);
      visualEffectManager.refreshZoneOverlay(zoneManager.getAllZones().map(c => ({ x: c.x, z: c.z })));
    }
    for (const t of worldMap.getAllTiles()) {
      if (t.isCargoYard || t.type.startsWith('cargo_station')) {
        visualEffectManager.updateCargoYardVisual(t.x, t.z, (t.layer ?? 1) as GridLayer);
      }
    }

    // ゲーム内日時の復元
    const savedTime = localStorage.getItem('wagamachi_time_data') || localStorage.getItem('saikyo_time_data');
    if (savedTime) {
      try {
        const t = JSON.parse(savedTime);
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
        console.warn('Failed to restore time data:', e);
      }
    }

    // 運行中列車および車両基地保有リストの復元
    const savedTrains = localStorage.getItem('wagamachi_trains_data') || localStorage.getItem('saikyo_trains_data');
    const savedFleet = localStorage.getItem('wagamachi_fleet_data') || localStorage.getItem('saikyo_fleet_data');
    const savedNextFleetId = localStorage.getItem('wagamachi_next_fleet_id') || localStorage.getItem('saikyo_next_fleet_id');
    if (savedNextFleetId) {
      fleetController.nextFleetId = parseInt(savedNextFleetId, 10) || fleetController.nextFleetId;
    }

    let trainsLoaded = false;
    if (savedTrains) {
      trainsLoaded = trainManager.deserialize(savedTrains);
    }

    if (savedFleet) {
      try {
        const parsedFleet = JSON.parse(savedFleet);
        if (Array.isArray(parsedFleet)) {
          fleetController.deserializeFleetData(parsedFleet);
        }
      } catch (e) {
        console.error('Failed to restore fleetRegistry:', e);
      }
    }

    // データの整合性修復
    fleetController.ensureIntegrityWithRunningTrains();

    // レガシーセーブデータ等で列車データがなかった場合のみフォールバックで初期列車を生成
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
    terrainRenderer.build(this.deps.getGridManager(), renderer.scene);
    return true;
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

    trainManager.updateHourlyStationPassengers(
      timeManager.hour,
      (x, z, h) => demandEngine.getDemandMultiplier(h, x, z)
    );
  }

  /**
   * 新規作成によるゲーム開始
   */
  public startNewGame(mapSize: MapSize, terrainType: TerrainType): void {
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

    this.buildInitialCity();
    terrainRenderer.build(newGrid, renderer.scene);

    cameraManager.target.set(0, 0, 0);
    cameraManager.stopTracking();
    cameraManager.setQuarterViewMode();
    uiManager.setCameraModeUI('orbit');
  }

  /**
   * セーブデータからのゲーム再開
   */
  public resumeGame(): void {
    const { gameState, cameraManager, uiManager } = this.deps;
    gameState.resumeGame();
    this.initWorld();
    cameraManager.target.set(0, 0, 0);
    cameraManager.stopTracking();
    cameraManager.setQuarterViewMode();
    uiManager.setCameraModeUI('orbit');
  }

  /**
   * ゲームデータのリセット（初期化してタイトルへ復帰）
   */
  public resetGame(): void {
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

    // ストレージキーの完全クリーンアップ
    localStorage.removeItem('wagamachi_save_data');
    localStorage.removeItem('wagamachi_zone_data');
    localStorage.removeItem('wagamachi_trains_data');
    localStorage.removeItem('wagamachi_fleet_data');
    localStorage.removeItem('wagamachi_next_fleet_id');
    localStorage.removeItem('wagamachi_time_data');
    localStorage.removeItem('stk_3d_world');
    localStorage.removeItem('saikyo_save_data');
    localStorage.removeItem('saikyo_zone_data');
    localStorage.removeItem('saikyo_trains_data');
    localStorage.removeItem('saikyo_fleet_data');
    localStorage.removeItem('saikyo_next_fleet_id');
    localStorage.removeItem('saikyo_time_data');
    localStorage.removeItem('wagamachi_route_templates');

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
