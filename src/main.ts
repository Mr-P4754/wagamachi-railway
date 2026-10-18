import * as THREE from 'three';
import { EngineRenderer, TimeOfDay, GraphicsQuality } from './engine/Renderer';
import { CameraManager } from './graphics/CameraManager';
import { AudioManager } from './engine/AudioManager';
import { WorldMap } from './simulation/WorldMap';
import { TrainManager } from './simulation/TrainManager';
import { CityGrowth } from './simulation/CityGrowth';
import { Economy } from './simulation/Economy';
import { UIManager } from './ui/UIManager';
import { GameState } from './core/GameState';
import { GridManager } from './core/GridManager';
import { GridLayer } from './core/types';
import { GRID_LAYERS } from './core/constants';
import { layerToHeight } from './core/Grid3D';
import { TerrainRenderer } from './graphics/TerrainRenderer';
import { TimeManager, SpeedLevel } from './core/TimeManager';
import { InputController } from './ui/InputController';
import { ZoneManager } from './core/ZoneManager';
import { DemandEngine } from './core/DemandEngine';
import { CargoSystem } from './core/CargoSystem';
import { ChunkManager } from './core/ChunkManager';
import { MiniMap } from './ui/MiniMap';
import { ScheduleUI } from './ui/ScheduleUI';
import { SwitchScheduleUI } from './ui/SwitchScheduleUI';
import { WorldLabelManager } from './ui/WorldLabelManager';
import { GameMaterials } from './graphics/materials';
import { BuildingBakery } from './graphics/structures/BuildingBakery';
import { VisualEffectManager } from './graphics/VisualEffectManager';
import { FleetController } from './controllers/FleetController';
import { PlacementController, isTrackLikeType } from './controllers/PlacementController';
import { PersistenceService } from './services/PersistenceService';
import { InteractionController } from './controllers/InteractionController';
import { UndoManager } from './core/UndoManager';
import { ExternalConnectionManager } from './simulation/ExternalConnectionManager';

/**
 * ゲーム全体の初期化・オーケストレーションおよびメインループ進行を担当する Facade クラス
 */
export class GameApp {
  private renderer = new EngineRenderer('canvas-container');
  private cameraManager = new CameraManager(this.renderer.renderer.domElement);
  private terrainRenderer = new TerrainRenderer();
  private audioManager = new AudioManager();
  private gameState = GameState.getInstance();
  private gridManager = new GridManager(64, 'balanced');
  private worldMap: WorldMap;
  private trainManager: TrainManager;
  private cityGrowth: CityGrowth;
  private economy = new Economy();
  private externalConnectionManager = new ExternalConnectionManager();
  private timeManager: TimeManager;
  private uiManager = new UIManager();
  private inputController: InputController;
  private zoneManager = new ZoneManager();
  private demandEngine = new DemandEngine(this.zoneManager);
  private cargoSystem = new CargoSystem(this.zoneManager);
  private chunkManager: ChunkManager;
  private miniMap: MiniMap;
  private scheduleUI: ScheduleUI;
  private switchScheduleUI: SwitchScheduleUI;
  private worldLabelManager = new WorldLabelManager();

  // 専門コントローラーおよびサービス（責務分割モジュール）
  private visualEffectManager: VisualEffectManager;
  private fleetController: FleetController;
  private undoManager: UndoManager;
  private placementController: PlacementController;
  private persistenceService: PersistenceService;
  private interactionController: InteractionController;

  private currentDisplayLayer: GridLayer | 'all' = 1;
  private selectedTilePos: { x: number; z: number; layer: GridLayer } | null = null;
  private selectedTrainId: number | null = null;
  private cabTargetTrainId: number | null = null;
  private hiddenCabCar: THREE.Group | null = null;
  private lastTime = 0;
  private autoSaveTimer = 0;
  private lastEffectiveTime: TimeOfDay = 'day';

  // スライサー選択外階層の半透明ゴーストマテリアル用キャッシュ
  private ghostMaterialCache = new Map<THREE.Material, THREE.Material>();

  private static readonly LOD_SIMPLE_TILES = 44;
  private static readonly LOD_DETAIL_TILES = 38;

  constructor() {
    this.worldMap = new WorldMap(this.renderer.scene, 64);
    this.worldMap.setElevationProvider((x, z) => {
      const c = this.gridManager.getCell(x, 1, z);
      return c ? Math.max(0, (c.elevation - 1) * 3.0) : 0;
    });
    this.trainManager = new TrainManager(this.renderer.scene, this.worldMap, this.audioManager);
    this.trainManager.setExternalConnectionManager(this.externalConnectionManager);
    this.cityGrowth = new CityGrowth(this.worldMap, this.gridManager);
    this.cityGrowth.setZoneManager(this.zoneManager);
    this.timeManager = new TimeManager(this.economy.year, this.economy.month, this.economy.day, 6, 0);

    this.worldMap.gridManagerRef = this.gridManager;
    this.worldMap.groundHoleHandler = {
      add: (x, z, r) => this.renderer.addGroundHole(x, z, r),
      remove: (x, z) => this.renderer.removeGroundHole(x, z),
      clear: () => this.renderer.clearGroundHoles()
    };
    this.terrainRenderer.setTunnelChecker((x, z) => {
      const tunnelLayers: number[] = [];
      for (const layer of GRID_LAYERS) {
        if (layer >= 1 && this.worldMap.isTunnelSection(x, z, layer)) {
          const t = this.worldMap.getTile(x, z, layer);
          if (t && t.type !== 'empty') {
            tunnelLayers.push(layer);
          }
        }
      }
      return tunnelLayers;
    });

    this.inputController = new InputController(this.cameraManager, this.renderer.renderer.domElement);
    this.uiManager.setMobileControlsVisible(false);
    this.chunkManager = new ChunkManager(this.gridManager, this.terrainRenderer);

    this.miniMap = new MiniMap({ gridManager: this.gridManager, worldMap: this.worldMap, zoneManager: this.zoneManager, cameraManager: this.cameraManager, trainManager: this.trainManager });
    this.miniMap.onJumpWorld = (wx, wz) => { this.cameraManager.stopTracking(); this.cameraManager.jumpToPosition({ x: wx, z: wz }); };

    this.scheduleUI = new ScheduleUI(this.worldMap);
    this.scheduleUI.setUIManager(this.uiManager);
    this.scheduleUI.onScheduleChanged = (tile) => { for (const t of this.worldMap.getStationTiles(tile.x, tile.z)) t.stationSchedule = tile.stationSchedule; };
    this.switchScheduleUI = new SwitchScheduleUI(this.worldMap);
    this.switchScheduleUI.onScheduleChanged = (tile) => {
      if (tile.type.startsWith('scissors_crossing')) {
        const orig = this.worldMap.resolveCrossingOrigin(tile.x, tile.z, tile.layer);
        if (orig) {
          orig.switchSchedule = tile.switchSchedule;
          const along = (orig.rotation % 2 === 1) ? 1 : 2;
          const across = WorldMap.rotateCW(along);
          const alongVec = WorldMap.DIRS[along];
          const acrossVec = WorldMap.DIRS[across];
          const lyr = (orig.layer ?? 1) as GridLayer;
          const positions = [
            { x: orig.x, z: orig.z },
            { x: orig.x + alongVec.x, z: orig.z + alongVec.z },
            { x: orig.x + acrossVec.x, z: orig.z + acrossVec.z },
            { x: orig.x + alongVec.x + acrossVec.x, z: orig.z + alongVec.z + acrossVec.z }
          ];
          for (const p of positions) {
            const t = this.worldMap.getTile(p.x, p.z, lyr);
            if (t) t.switchSchedule = orig.switchSchedule;
          }
        }
      }
    };

    this.visualEffectManager = new VisualEffectManager(this.renderer.scene, this.worldMap, this.zoneManager, this.cargoSystem);
    this.fleetController = new FleetController(
      this.renderer.scene, this.worldMap, this.trainManager, this.economy, this.audioManager, this.uiManager, this.cameraManager,
      { onExitCabView: () => this.exitCabView(), onCloseInspector: () => this.uiManager.closeInspector(), onUpdateRotationHint: () => this.placementController.updateRotationHint(this.uiManager.getActiveTool()) }
    );
    this.undoManager = new UndoManager({
      worldMap: this.worldMap,
      trainManager: this.trainManager,
      economy: this.economy,
      audioManager: this.audioManager,
      uiManager: this.uiManager,
      miniMap: this.miniMap,
      terrainRenderer: this.terrainRenderer,
      getGridManager: () => this.gridManager,
      scene: this.renderer.scene,
      onCargoYardVisualUpdate: (x, z, l) => this.visualEffectManager.updateCargoYardVisual(x, z, l),
      removeCargoYardVisual: (x, z, l) => this.visualEffectManager.removeCargoYardVisual(x, z, l),
      onAfterUndo: () => {
        this.applyLayerSlicing(this.currentDisplayLayer);
        this.scheduleUI.refreshOrClose();
        this.switchScheduleUI.refreshOrClose();
        this.externalConnectionManager.checkConnections(this.worldMap);
      }
    });
    this.placementController = new PlacementController({
      scene: this.renderer.scene, worldMap: this.worldMap, gridManager: this.gridManager, trainManager: this.trainManager,
      economy: this.economy, audioManager: this.audioManager, uiManager: this.uiManager, inputController: this.inputController,
      getFleetController: () => this.fleetController,
      undoManager: this.undoManager,
      onPlacementExecuted: () => {
        this.applyLayerSlicing(this.currentDisplayLayer);
        this.miniMap.requestStaticUpdate();
        this.terrainRenderer.rebuildAll(this.gridManager, this.renderer.scene);
        this.externalConnectionManager.checkConnections(this.worldMap, (city) => {
          this.uiManager.showToast('祝・幹線開通！', `${city.name}との直通線路が開通しました！広域輸送が開始されます。`, 'info');
        });
      },
      onCargoYardVisualUpdate: (x, z, l) => this.visualEffectManager.updateCargoYardVisual(x, z, l)
    });
    this.persistenceService = new PersistenceService({
      gameState: this.gameState, worldMap: this.worldMap, getGridManager: () => this.gridManager,
      setGridManager: (gm) => { this.gridManager = gm; this.placementController.setGridManager(gm); },
      trainManager: this.trainManager, fleetController: this.fleetController, economy: this.economy,
      undoManager: this.undoManager, externalConnectionManager: this.externalConnectionManager,
      timeManager: this.timeManager, zoneManager: this.zoneManager, demandEngine: this.demandEngine,
      uiManager: this.uiManager, audioManager: this.audioManager, cameraManager: this.cameraManager,
      terrainRenderer: this.terrainRenderer, renderer: this.renderer, chunkManager: this.chunkManager,
      miniMap: this.miniMap, scheduleUI: this.scheduleUI, switchScheduleUI: this.switchScheduleUI,
      worldLabelManager: this.worldLabelManager, visualEffectManager: this.visualEffectManager, cityGrowth: this.cityGrowth,
      onClearPendingPlacements: () => this.placementController.cancelPendingPlacements(),
      onLayerSwitched: (l) => this.switchActiveLayer(l, false, true)
    });
    this.interactionController = new InteractionController({
      scene: this.renderer.scene, domElement: this.renderer.renderer.domElement, cameraManager: this.cameraManager,
      worldMap: this.worldMap, getGridManager: () => this.gridManager, trainManager: this.trainManager, economy: this.economy,
      undoManager: this.undoManager, externalConnectionManager: this.externalConnectionManager,
      timeManager: this.timeManager, zoneManager: this.zoneManager, demandEngine: this.demandEngine, uiManager: this.uiManager,
      audioManager: this.audioManager, inputController: this.inputController, miniMap: this.miniMap, terrainRenderer: this.terrainRenderer,
      scheduleUI: this.scheduleUI, switchScheduleUI: this.switchScheduleUI, placementController: this.placementController,
      fleetController: this.fleetController, visualEffectManager: this.visualEffectManager,
      onLayerSwitchRequested: (l, snd) => this.switchActiveLayer(l, snd), onToggleInfiniteFunds: () => this.toggleInfiniteFunds(),
      onExitCabView: () => this.exitCabView(), getCabTargetTrainId: () => this.cabTargetTrainId,
      getSelectedTilePos: () => this.selectedTilePos, setSelectedTilePos: (pos) => { this.selectedTilePos = pos; },
      getSelectedTrainId: () => this.selectedTrainId, setSelectedTrainId: (id) => {
        this.selectedTrainId = id;
        if (id !== null) {
          this.cabTargetTrainId = id;
        }
      }
    });
    this.setupUIHandlers();
    this.uiManager.updateUndoButton(false);
    this.applyCullingLayerFilters(this.currentDisplayLayer);

    // グラフィック設定の復元またはモバイル端末自動判定（初回描画前に適用）
    const initialQuality = PersistenceService.getSavedGraphicsQuality() || PersistenceService.detectDefaultGraphicsQuality();
    this.renderer.onResizeCallback = () => {
      this.cameraManager.updateFrustum(window.innerWidth, window.innerHeight);
    };
    this.renderer.setGraphicsQuality(initialQuality);
    this.cameraManager.updateFrustum(window.innerWidth, window.innerHeight);
    this.uiManager.setGraphicsQualityUI(initialQuality);
  }

  private setupUIHandlers(): void {
    const { uiManager: ui, timeManager: tm, fleetController: fc, placementController: pc, interactionController: ic } = this;
    ui.getCurrentHour = () => tm.hour;
    ui.getCurrentMinute = () => tm.minute;
    ui.getExternalCityNode = (id) => this.externalConnectionManager.getCityById(id);
    ui.onSpeedChanged = (lvl) => tm.setSpeedLevel(lvl as SpeedLevel);

    // グラフィック画質変更イベント
    ui.onGraphicsQualityChanged = (level: GraphicsQuality) => {
      this.renderer.setGraphicsQuality(level, () => {
        this.cameraManager.updateFrustum(window.innerWidth, window.innerHeight);
      });
      PersistenceService.saveGraphicsQuality(level);
    };

    ui.getFinancialReportData = () => {
      const all = this.worldMap.getAllTiles();
      const tracks = all.filter(t => isTrackLikeType(t.type)).length;
      return this.economy.getFinancialReport(tracks, this.trainManager.getTrains().length, this.worldMap.stationManager.getStations().length);
    };
    ui.getEconomy = () => this.economy;

    tm.events.onFiscalYearEnd = (fy) => {
      const all = this.worldMap.getAllTiles();
      const tracks = all.filter(t => isTrackLikeType(t.type)).length;
      const stations = all.filter(t => WorldMap.isStationTileType(t.type)).length;
      const reg = fc.getFleetRegistry();
      const cars = reg.length > 0 ? reg.reduce((s, f) => s + f.cars, 0) : this.trainManager.getTrains().reduce((s, t) => s + t.carCount, 0);

      // 年間リセット直前の累計収支を退避
      const yearFare = this.economy.fiscalYearFareIncome;
      const yearCargo = this.economy.fiscalYearCargoIncome;
      const yearMaint = this.economy.fiscalYearMaintenanceCost;
      const yearConstr = this.economy.fiscalYearConstructionCost;

      // 税額確定（内部で年間アキュムレータがリセットされる）
      const taxReport = this.economy.assessAnnualTax(tracks, stations, cars, fy);

      // 年間純利益（総運賃収入[旅客+貨物] - 運行維持費 - 当期減価償却費 - 税金）
      const yearlyNet = (yearFare + yearCargo) - (yearMaint + taxReport.depreciationCost + taxReport.totalTax);

      // 年次財務スナップショットを記録
      this.economy.recordYearlySnapshot({
        year: fy,
        month: 0, // 通年
        fareIncome: yearFare,
        cargoIncome: yearCargo,
        maintenanceCost: yearMaint,
        constructionCost: yearConstr,
        depreciationCost: taxReport.depreciationCost,
        bookValue: taxReport.totalBookValue,
        netProfit: yearlyNet,
        taxAmount: taxReport.totalTax,
        population: this.economy.population,
        trackLength: Math.round(tracks * 0.1 * 10) / 10,
        trainCount: this.trainManager.getTrains().length,
        stationCount: this.worldMap.stationManager.getStations().length
      });

      ui.showFiscalReportToast(taxReport);
    };
    tm.events.onTaxDueDay = () => ui.showTaxPaymentToast(this.economy.executeTaxPayment());
    tm.events.onMonthPassed = (y, m) => {
      this.economy.syncDate(y, m, tm.day);
      const allTiles = this.worldMap.getAllTiles();
      const tracks = allTiles.filter(t => isTrackLikeType(t.type)).length;
      const stMaint = this.worldMap.stationManager.getStations().reduce((s, st) => s + st.maintenance, 0);
      // 月末の線路・駅維持費を引き落とし
      this.economy.spendFunds(tracks * 10000 + stMaint, false);

      // 締め切った月を計算（例: 5月1日に切り替わった場合、確定したのは4月分）
      let closedMonth = m - 1;
      let closedYear = y;
      if (closedMonth < 1) {
        closedMonth = 12;
        closedYear = y - 1;
      }

      // 当期収支リセット直前に完全な集計値から月次スナップショットを記録
      const monthTotalIncome = this.economy.periodFareIncome + this.economy.periodCargoIncome;
      const monthNet = monthTotalIncome - (this.economy.periodMaintenanceCost + this.economy.periodConstructionCost);
      this.economy.recordMonthlySnapshot({
        year: closedYear,
        month: closedMonth,
        fareIncome: this.economy.periodFareIncome,
        cargoIncome: this.economy.periodCargoIncome,
        maintenanceCost: this.economy.periodMaintenanceCost,
        constructionCost: this.economy.periodConstructionCost,
        netProfit: monthNet,
        population: this.economy.population,
        trackLength: Math.round(tracks * 0.1 * 10) / 10,
        trainCount: this.trainManager.getTrains().length,
        stationCount: this.worldMap.stationManager.getStations().length
      });

      // 当期収支をリセット
      this.economy.resetPeriodStats();
    };
    tm.events.onDayPassed = (y, m, d) => { this.economy.syncDate(y, m, d); this.worldMap.resetDailyStationPassengers(); this.demandEngine.clearCache(); };
    tm.events.onFiveMinutesPassed = (h) => this.trainManager.updateFiveMinuteStationPassengers(h, (x, z, hr) => this.demandEngine.getDemandMultiplier(hr, x, z));
    tm.events.onHourPassed = (h) => {
      this.externalConnectionManager.checkConnections(this.worldMap, (city) => {
        this.uiManager.showToast('祝・幹線開通！', `${city.name}との直通線路が開通しました！広域輸送が開始されます。`, 'info');
      });
      this.externalConnectionManager.updateHourlySupply(this.worldMap, h);

      if (h === 17) for (const s of this.cargoSystem.processDailyIndustrialProduction(this.worldMap)) this.visualEffectManager.updateCargoYardVisual(s.x, s.z, s.layer);
    };

    ui.onAudioToggled = () => ui.setAudioMuted(this.audioManager.toggleMute());
    ui.onTimeToggled = () => {
      const mode = this.renderer.cycleLightingMode();
      this.renderer.updateLightingByTime(tm.hour, tm.minute);
      ui.setTimeLightingMode(mode, (this.lastEffectiveTime = this.renderer.getTimeOfDay()));
    };
    ui.onGridToggled = (v) => this.renderer.setGridVisible(v);
    ui.onStartNewGame = async (s, t) => { await this.persistenceService.startNewGame(s, t); };
    ui.onResumeGame = async () => { await this.persistenceService.resumeGame(); };
    ui.onRotateCameraCCW = () => this.cameraManager.rotateStepCCW();
    ui.onRotateCameraCW = () => this.cameraManager.rotateStepCW();
    ui.onResetCameraNorth = () => this.cameraManager.resetRotationToNorth();
    this.cameraManager.onThetaUpdated = (_rad, deg) => { ui.updateCompassRotation(deg); };
    ui.onToggleXRay = () => { const a = this.cameraManager.toggleXRayMode(); this.terrainRenderer.setTransparentMode(a); ui.setXRayActive(a); };
    ui.onCameraModeToggled = () => {
      const trs = this.trainManager.getTrains();
      if (trs.length === 0) {
        ui.showToast('列車未運行', '運行中の列車がありません。先に列車を購入・配置してください。', 'info');
        return;
      }
      const targetId = this.cabTargetTrainId ?? this.selectedTrainId ?? trs[0].id;
      const train = this.trainManager.getTrainById(targetId) ?? trs[0];
      if (train) {
        this.switchActiveLayer(train.currentTile.layer, false);
      }
      if (this.cameraManager.viewMode === 'quarter_view') {
        this.enterChaseView(train.id);
      } else if (this.cameraManager.viewMode === 'chase_view') {
        this.enterCabView(train.id);
      } else {
        this.exitCabView();
      }
    };
    ui.onCabToggleModeRequested = () => {
      const trs = this.trainManager.getTrains();
      if (trs.length === 0) return;
      const targetId = this.cabTargetTrainId ?? this.selectedTrainId ?? trs[0].id;
      if (this.cameraManager.viewMode === 'cab_view') {
        this.enterChaseView(targetId);
      } else if (this.cameraManager.viewMode === 'chase_view') {
        this.enterCabView(targetId);
      }
    };
    ui.onChaseTrainRequested = (trainId) => this.enterChaseView(trainId);
    ui.onCabTrainRequested = (trainId) => this.enterCabView(trainId);
    ui.onExitCab = () => this.exitCabView();
    ui.onCabPrevRequested = () => ic.cycleCabTrain(-1, (id) => {
      if (this.cameraManager.viewMode === 'chase_view') this.enterChaseView(id);
      else this.enterCabView(id);
    });
    ui.onCabNextRequested = () => ic.cycleCabTrain(1, (id) => {
      if (this.cameraManager.viewMode === 'chase_view') this.enterChaseView(id);
      else this.enterCabView(id);
    });
    ui.onCabSelectRequested = () => ui.showCabTrainSelectModal(this.trainManager.getTrains(), (id) => {
      if (this.cameraManager.viewMode === 'chase_view') this.enterChaseView(id);
      else this.enterCabView(id);
    });
    ui.onSaveRequested = () => {
      this.persistenceService.saveGame(true).catch(err => {
        console.error('手動セーブ処理中にエラーが発生しました:', err);
      });
    };
    ui.onResetRequested = () => this.persistenceService.resetGame();

    ui.onTogglePointSwitch = (x, z, l) => ic.handleToggleSwitch(x, z, l);
    ui.onCycleCrossing = (x, z, l) => ic.handleCycleCrossing(x, z, l);
    ui.onOpenStationSchedule = (tile) => { ui.closeInspector(); this.scheduleUI.open(tile); };
    ui.onOpenSwitchSchedule = (tile) => {
      ui.closeInspector();
      this.switchScheduleUI.open(tile.type.startsWith('scissors_crossing') ? (this.worldMap.resolveCrossingOrigin(tile.x, tile.z, tile.layer) ?? tile) : tile);
    };

    this.trainManager.onTrainSplit = (p, s) => fc.onTrainSplit(p, s);
    this.trainManager.onTrainCoupled = (l, f) => fc.onTrainCoupled(l, f, () => this.selectedTrainId, (id) => { this.selectedTrainId = id; });

    ui.onConfirmBuyTrain = (m, c) => fc.buyVehicle(m, c);
    ui.onOpenFleetModal = () => { fc.syncFleetStats(); ui.showFleetModal(fc.getFleetRegistry()); };
    ui.onChangeFleetCarCount = (id, d) => fc.changeCarCount(id, d);
    ui.onDeployFleetTrain = (id) => fc.startDeploy(id);
    ui.onRecallFleetTrain = (id) => fc.recallFleetTrain(id);
    ui.onSellFleetTrain = (id) => fc.sellFleetTrain(id);
    ui.onTrackFleetTrain = (id) => fc.trackFleetTrain(id, (l) => this.switchActiveLayer(l, false));

    ui.onToggleSwitchSide = () => pc.toggleSwitchSide();
    ui.onToggleStationSide = () => pc.toggleStationSide();
    ui.onToggleInfiniteFunds = () => this.toggleInfiniteFunds();
    ui.onRemoveTrain = (trainId) => {
      const fItem = fc.getFleetRegistry().find(f => f.activeTrainId === trainId);
      if (fItem) { fItem.status = 'in_depot'; fItem.activeTrainId = undefined; }
      if (this.cabTargetTrainId === trainId) this.exitCabView();
      if (this.trainManager.removeTrain(trainId)) this.audioManager.playDemolishSound();
    };

    ui.onToolChanged = (tool) => {
      pc.cancelPendingPlacements();
      pc.hoverPlane.scale.set(1, 1, 1);
      ui.closeInspector();
      if (tool === 'rail-slope') {
        if (this.worldMap.activeLayer >= 5) { ui.showToast('最上階', '5Fからは上り勾配線路を敷設できません。', 'warning'); this.switchActiveLayer(4, false); }
        else if (this.worldMap.activeLayer < 0) this.switchActiveLayer(1, false);
      } else if (tool === 'rail-slope-underground' && this.worldMap.activeLayer < 0) this.switchActiveLayer(1, false);
      if (tool === 'train-buy') ui.openVehicleModal();
      this.applyLayerSlicing(this.currentDisplayLayer);
      pc.updateRotationHint(tool);
    };

    ui.onConfirmPlacement = () => pc.confirmPendingPlacements();
    ui.onCancelPlacement = () => { pc.cancelPendingPlacements(); pc.updateRotationHint(ui.getActiveTool()); };
    ui.onRotatePlacement = () => pc.rotateCurrentPlacement();
    ui.onStationLengthChanged = (len) => pc.setStationLength(len);
    ui.onSetStationLength = (x, z, len) => ic.handleSetStationLength(x, z, len);
    ui.onRenameStation = (x, z, name, l) => {
      const targetL = l ?? this.selectedTilePos?.layer ?? this.worldMap.activeLayer;
      if (this.worldMap.renameStation(x, z, name, targetL)) {
        const tile = this.worldMap.getTile(x, z, targetL);
        if (tile) ui.showInspector(tile, undefined, this.worldMap.getStationRunLength(x, z, targetL), this.worldMap.getStationAggregateData(x, z, targetL));
      }
    };
    ui.onRenameTrain = (trainId, name) => {
      const train = this.trainManager.getTrains().find(t => t.id === trainId);
      if (train) {
        train.name = name;
        const fleet = fc.getFleetRegistry().find(f => f.activeTrainId === trainId);
        if (fleet) fleet.name = name;
        ui.setCabTrainName(name);
        ui.showTrainInspector(train);
      }
    };
    this.trainManager.onDeadlockDetected = (e) => ui.showDeadlockToast(e, () => this.cameraManager.jumpToPosition(e.position));
    ui.onInspectorClosed = () => {
      this.selectedTilePos = null;
      if (this.cameraManager.viewMode === 'quarter_view') {
        this.selectedTrainId = null;
        this.cameraManager.stopTracking();
      }
    };
    ui.onLayerChanged = (layer) => this.switchActiveLayer(layer);
    ui.onMobileAction = (action) => ic.handleMobileAction(action);
    ui.setTimeLightingMode(this.renderer.getLightingMode(), this.renderer.getTimeOfDay());
  }

  public switchActiveLayer(layer: GridLayer | 'all', playSound: boolean = true, force: boolean = false): void {
    const targetLayer: GridLayer = layer === 'all' ? 1 : layer;
    if (!force && this.worldMap.activeLayer === targetLayer && this.currentDisplayLayer === layer) return;
    this.worldMap.setActiveLayer(targetLayer);
    this.currentDisplayLayer = layer;
    this.inputController.setActiveLayer(targetLayer);
    this.uiManager.setFloorActive(layer);
    this.applyLayerSlicing(layer);
    this.placementController.updateRotationHint(this.uiManager.getActiveTool());
    this.placementController.clearHoverStationGhost();
    if (playSound) this.audioManager.playSelectSound();
  }

  public enterChaseView(trainId: number): void {
    const train = this.trainManager.getTrainById(trainId);
    const target = this.trainManager.getFollowTargetByTrainId(trainId);
    if (!train || !target) return;
    if (this.hiddenCabCar) { this.hiddenCabCar.visible = true; this.hiddenCabCar = null; }
    this.cabTargetTrainId = trainId;
    this.selectedTrainId = trainId;
    this.switchActiveLayer(train.currentTile.layer, false);
    this.uiManager.setCameraModeUI('chase');
    this.cameraManager.setChaseViewMode(target);
    const displayName = train.name.includes(train.model.name) ? train.name : `${train.name} — ${train.model.name}`;
    this.uiManager.setCabTrainName(displayName);
    this.audioManager.startCabMotorSound(target.speed ?? 0);
    this.renderer.setCabViewFog(true);
    this.renderer.disableCabHeadlight();
  }

  public enterCabView(trainId: number): void {
    const train = this.trainManager.getTrainById(trainId);
    const target = this.trainManager.getFollowTargetByTrainId(trainId);
    if (!train || !target) return;
    if (this.hiddenCabCar) { this.hiddenCabCar.visible = true; this.hiddenCabCar = null; }
    if (train.cars && train.cars[0]) { train.cars[0].visible = false; this.hiddenCabCar = train.cars[0]; }
    this.cabTargetTrainId = trainId;
    this.selectedTrainId = trainId;
    this.switchActiveLayer(train.currentTile.layer, false);
    this.uiManager.setCameraModeUI('cab');
    this.cameraManager.setCabViewMode(target);
    const displayName = train.name.includes(train.model.name) ? train.name : `${train.name} — ${train.model.name}`;
    this.uiManager.setCabTrainName(displayName);
    this.audioManager.startCabMotorSound(target.speed ?? 0);
    this.renderer.setCabViewFog(true);
    this.renderer.enableCabHeadlight();
  }

  public exitCabView(): void {
    const followId = this.cabTargetTrainId ?? this.selectedTrainId;
    if (this.hiddenCabCar) { this.hiddenCabCar.visible = true; this.hiddenCabCar = null; }
    this.cabTargetTrainId = null;
    this.cameraManager.setQuarterViewMode();
    this.uiManager.setCameraModeUI('orbit');
    this.audioManager.stopCabMotorSound();
    this.renderer.setCabViewFog(false);
    this.renderer.disableCabHeadlight();
    this.updateBuildingLod();

    // クォータービュー復帰時に対象列車を追従
    if (followId !== null && followId !== undefined) {
      this.selectedTrainId = followId;
      this.cabTargetTrainId = followId;
      const target = this.trainManager.getFollowTargetByTrainId(followId);
      const train = this.trainManager.getTrainById(followId);
      if (target && train) {
        this.switchActiveLayer(train.currentTile.layer, false);
        this.cameraManager.startTracking(target, false);
      }
    }
  }

  /**
   * ゴースト表示用の半透明マテリアルを取得（同一マテリアルはキャッシュして共有）
   */
  private getGhostMaterial(mat: THREE.Material): THREE.Material {
    let ghost = this.ghostMaterialCache.get(mat);
    if (!ghost) {
      ghost = mat.clone();
      ghost.transparent = true;
      ghost.opacity = 0.28;
      // 半透明同士が重なった際の描画順破綻を防ぐため深度バッファ書き込みをOFF
      ghost.depthWrite = false;
      this.ghostMaterialCache.set(mat, ghost);
    }
    return ghost;
  }

  /**
   * 階層スライス用の半透明ゴーストマテリアル適用 / 復元
   */
  private applyMeshGhost(root: THREE.Object3D, isGhost: boolean): void {
    root.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (!mesh.userData.originalMaterial) {
          mesh.userData.originalMaterial = mesh.material;
        }
        if (isGhost) {
          if (Array.isArray(mesh.userData.originalMaterial)) {
            mesh.material = mesh.userData.originalMaterial.map((m: THREE.Material) => this.getGhostMaterial(m));
          } else {
            mesh.material = this.getGhostMaterial(mesh.userData.originalMaterial);
          }
        } else {
          mesh.material = mesh.userData.originalMaterial;
        }
      }
    });
  }

  private applyLayerSlicing(displayLayer: GridLayer | 'all'): void {
    const isUnderground = displayLayer !== 'all' && displayLayer < 0;
    const isAll = displayLayer === 'all';
    const targetHeight = isAll ? layerToHeight(1) : layerToHeight(displayLayer);
    this.renderer.setGroundVisible(!isUnderground);
    this.terrainRenderer.setVisible(!isUnderground);
    if (!isUnderground) this.terrainRenderer.setTransparentMode(GameMaterials.isTransparentMode());
    this.renderer.setUndergroundFloor(isUnderground, targetHeight);
    this.renderer.setGridHeight(targetHeight);
    this.renderer.setUndergroundMode(isUnderground);
    this.renderer.updateLightingByTime(this.timeManager.hour, this.timeManager.minute);

    const activeTool = this.uiManager.getActiveTool();
    for (const tile of this.worldMap.getAllTiles()) {
      if (!tile.mesh) continue;
      const l = tile.layer ?? 1;

      if (isAll) {
        // All 表示: 地上階層（1F以上）をすべて通常表示
        const isVisible = l >= 1;
        tile.mesh.visible = isVisible;
        if (isVisible) {
          this.applyMeshGhost(tile.mesh, false);
        }
      } else {
        // 階層スライス時:
        // 地上スライス（displayLayer >= 1）: 地上全階層（l >= 1）を表示（選択階層は通常、他階層は半透明ゴースト）
        // 地下スライス（displayLayer < 0）: 地下全階層および地上階層を表示
        const isTarget = (l === displayLayer) ||
          (tile.type === 'rail_slope' && (l === displayLayer || l + 1 === displayLayer)) ||
          (tile.type === 'rail_slope_underground' && (l === displayLayer || displayLayer === -1)) ||
          (activeTool === 'rail-slope' && typeof displayLayer === 'number' && l === displayLayer + 1);

        const isVisible = isUnderground ? true : l >= 1;
        tile.mesh.visible = isVisible;

        if (isVisible) {
          this.applyMeshGhost(tile.mesh, !isTarget);
        }
      }
    }
    this.visualEffectManager.applyLayerVisibility(displayLayer);
    this.applyCullingLayerFilters(displayLayer);
  }

  private applyCullingLayerFilters(displayLayer: GridLayer | 'all'): void {
    this.worldMap.instancedMeshManager.setDisplayLayer(displayLayer);
    this.worldMap.renderBuckets.setDisplayLayer(displayLayer);
  }

  private updateBuildingLod(): void {
    if (this.cameraManager.viewMode === 'cab_view' || this.cameraManager.viewMode === 'chase_view') {
      const camPos = this.cameraManager.perspectiveCamera.position;
      const DETAIL_RADIUS_SQ = 45 * 45;
      for (const t of this.worldMap.getAllTiles()) {
        if (!t.mesh?.userData?.buildingLod) continue;
        const dSq = (t.x * WorldMap.TILE_SIZE - camPos.x) ** 2 + (t.z * WorldMap.TILE_SIZE - camPos.z) ** 2;
        BuildingBakery.applyTier(t.mesh, dSq < DETAIL_RADIUS_SQ ? 'detail' : 'simple');
      }
      return;
    }
    const current = BuildingBakery.getTier(), tiles = this.cameraManager.getShortSideTiles();
    let next = (current === 'detail' && tiles > GameApp.LOD_SIMPLE_TILES) ? 'simple' : (current === 'simple' && tiles < GameApp.LOD_DETAIL_TILES) ? 'detail' : current;
    if (BuildingBakery.setTier(next)) for (const t of this.worldMap.getAllTiles()) if (t.mesh) BuildingBakery.applyTier(t.mesh, next);
  }

  private toggleInfiniteFunds(): void {
    this.uiManager.updateInfiniteFundsUI(this.economy.toggleInfiniteFunds());
    this.audioManager.playSelectSound();
  }

  /**
   * メインゲームループ（整流化された1フレーム処理）
   */
  private gameLoop(time: number): void {
    requestAnimationFrame(this.gameLoop.bind(this));
    // フレームドロップ耐性: 一時的な高負荷時でも0.05秒（20fps相当）にクランプして飛び出しやワープを抑止
    const deltaTime = Math.min((time - this.lastTime) / 1000, 0.05);
    this.lastTime = time;

    if (this.gameState.phase === 'title') {
      this.trainManager.update(deltaTime, 1, () => {}, this.timeManager.hour, this.timeManager.minute);
      this.cameraManager.update(deltaTime);
      this.renderer.render(this.cameraManager.activeCamera);
      this.worldLabelManager.clear();
      return;
    }

    // 1. 時間・経済同期
    this.timeManager.update(deltaTime);
    this.economy.syncDate(this.timeManager.year, this.timeManager.month, this.timeManager.day);
    this.economy.setTime(this.timeManager.hour, this.timeManager.minute);
    this.trainManager.setListenerPosition(this.cameraManager.target);

    // 2. 列車・貨物・都市シミュレーション
    this.trainManager.update(
      deltaTime, this.timeManager.currentMultiplier, (fare) => this.economy.addFunds(fare),
      this.timeManager.hour, this.timeManager.minute, (x, z, h) => this.demandEngine.getDemandMultiplier(h, x, z),
      {
        tryLoad: (x, z, cap, lyr) => this.cargoSystem.tryLoadCargoFromStation(this.worldMap, x, z, cap, lyr),
        tryUnload: (x, z, cnt, lyr) => this.cargoSystem.tryUnloadCargoAtCommercialStation(this.worldMap, x, z, cnt, lyr),
        isCommercialStation: (x, z, lyr) => this.cargoSystem.isStationInArea(this.worldMap, x, z, 'commercial', lyr),
        onStationCargoChanged: (x, z, lyr) => this.visualEffectManager.updateCargoYardVisual(x, z, (lyr ?? 1) as GridLayer),
        onCargoDelivered: (x, z, lyr, containers, revenue) => {
          this.economy.addCargoIncome(revenue);
          this.worldLabelManager.spawnCargoFloatingBadge(this.worldMap, x, z, (lyr ?? 1) as GridLayer, containers, revenue);
        }
      },
      (cost) => this.economy.spendFunds(cost, false)
    );
    this.cargoSystem.update(deltaTime, this.timeManager.currentMultiplier);
    this.visualEffectManager.update(deltaTime);
    this.cityGrowth.update(this.timeManager.hour, this.timeManager.minute, this.timeManager.day, (newPop) => {
      this.economy.addPopulation(newPop);
      this.miniMap.requestStaticUpdate();
      this.demandEngine.clearCache();
    });

    // 3. カメラ注視点・追従ターゲット同期＆更新
    const activeFollowTrainId = (this.cameraManager.viewMode !== 'quarter_view')
      ? (this.cabTargetTrainId ?? this.selectedTrainId)
      : (this.selectedTrainId ?? this.cabTargetTrainId);

    if (this.cameraManager.viewMode === 'cab_view') {
      const train = activeFollowTrainId !== null && activeFollowTrainId !== undefined
        ? this.trainManager.getTrainById(activeFollowTrainId)
        : this.trainManager.getTrains()[0];
      const target = train ? this.trainManager.getFollowTargetByTrainId(train.id) : null;
      if (train && target) {
        this.cabTargetTrainId = train.id;
        this.selectedTrainId = train.id;

        // 先頭車両の非表示を毎フレーム確実に保証（反転や編成更新による新インスタンス生成に対応）
        const currentLeadCar = train.cars && train.cars[0] ? train.cars[0] : null;
        if (this.hiddenCabCar !== currentLeadCar) {
          if (this.hiddenCabCar) {
            this.hiddenCabCar.visible = true;
          }
          this.hiddenCabCar = currentLeadCar;
        }
        if (this.hiddenCabCar && this.hiddenCabCar.visible) {
          this.hiddenCabCar.visible = false;
        }

        this.cameraManager.setCabViewMode(target);
        this.uiManager.updateCabSpeed(target.speed ?? 0);
        this.audioManager.updateCabSpeed(target.speed ?? 0);
        this.renderer.updateCabHeadlight(this.cameraManager.perspectiveCamera.position, this.cameraManager.getCabForward());
        this.trainManager.setListenerPosition(this.cameraManager.perspectiveCamera.position);
      } else {
        this.exitCabView();
      }
    } else if (this.cameraManager.viewMode === 'chase_view') {
      const train = activeFollowTrainId !== null && activeFollowTrainId !== undefined
        ? this.trainManager.getTrainById(activeFollowTrainId)
        : this.trainManager.getTrains()[0];
      const target = train ? this.trainManager.getFollowTargetByTrainId(train.id) : null;
      if (train && target) {
        this.cabTargetTrainId = train.id;
        this.selectedTrainId = train.id;
        this.cameraManager.setChaseTarget(target);
        this.uiManager.updateCabSpeed(target.speed ?? 0);
        this.audioManager.updateCabSpeed(target.speed ?? 0);
        this.trainManager.setListenerPosition(this.cameraManager.target);
      } else {
        this.exitCabView();
      }
    } else if (this.cameraManager.isTracking && activeFollowTrainId !== null && activeFollowTrainId !== undefined) {
      // クォータービューでの列車追従同期
      const train = this.trainManager.getTrainById(activeFollowTrainId);
      const target = train ? this.trainManager.getFollowTargetByTrainId(train.id) : null;
      if (train && target) {
        this.cameraManager.startTracking(target, false);
        if (train.currentTile.layer !== this.worldMap.activeLayer) {
          this.switchActiveLayer(train.currentTile.layer, false);
        }
      } else {
        this.cameraManager.stopTracking();
      }
    }

    this.cameraManager.update(deltaTime);
    this.chunkManager.update(this.cameraManager, this.renderer.scene);
    this.miniMap.update();

    // 4. 動的LOD・ライティング
    this.renderer.updateLightingByTime(this.timeManager.hour, this.timeManager.minute);
    if (this.renderer.getLightingMode() === 'auto') {
      const effTime = this.renderer.getTimeOfDay();
      if (this.lastEffectiveTime !== effTime) {
        this.lastEffectiveTime = effTime;
        this.uiManager.setTimeLightingMode('auto', effTime);
      }
    }
    this.updateBuildingLod();

    // 5. HUD・UI・前面展望・インスペクター更新
    this.uiManager.updateHUD(
      this.timeManager.getFormattedDate(), this.timeManager.getFormattedTime(true),
      this.economy.getFormattedFunds(), this.economy.getFormattedPopulation(), !this.economy.canInvest
    );

    if (this.selectedTrainId !== null) {
      const train = this.trainManager.getTrains().find(t => t.id === this.selectedTrainId);
      if (train) {
        this.uiManager.updateTrainInspectorDynamicValues(train);
      } else {
        this.selectedTrainId = null;
      }
    } else if (this.selectedTilePos !== null) {
      const tile = this.worldMap.getTile(this.selectedTilePos.x, this.selectedTilePos.z, this.selectedTilePos.layer);
      if (tile && (tile.type.startsWith('station') || tile.type === 'signal_yard' || tile.type.startsWith('cargo_station'))) {
        this.uiManager.updateStationInspectorDynamicValues(tile, this.worldMap.getStationRunLength(tile.x, tile.z, this.selectedTilePos.layer), this.worldMap.getStationAggregateData(tile.x, tile.z, this.selectedTilePos.layer));
      }
    }

    // 6. オートセーブ判定（非同期・タスク分散実行によりメインループのブロッキングを根絶）
    this.autoSaveTimer += deltaTime;
    if (this.autoSaveTimer >= 30) {
      this.autoSaveTimer = 0;
      this.persistenceService.saveGame(false).catch(err => {
        console.error('オートセーブ処理中にエラーが発生しました:', err);
      });
    }

    // 7. 3D描画・カリング・ラベル更新
    const displayLayer = this.currentDisplayLayer, activeCam = this.cameraManager.activeCamera;
    const isAll = displayLayer === 'all';
    this.trainManager.applyVisibility(activeCam, (tl) => isAll ? tl >= 1 : (displayLayer < 0 ? true : tl >= 1));
    for (const train of this.trainManager.getTrains()) {
      if (!train.mesh.visible) continue;
      const curLyr = train.currentTile.layer;
      const tgtLyr = train.targetTile.layer;
      const isTarget = isAll || (curLyr === displayLayer || tgtLyr === displayLayer);
      const shouldGhost = !isTarget;
      if (train.mesh.userData.isGhost !== shouldGhost) {
        train.mesh.userData.isGhost = shouldGhost;
        this.applyMeshGhost(train.mesh, shouldGhost);
      }
    }
    this.worldMap.renderBuckets.update(activeCam);
    this.renderer.setShadowFocus(this.cameraManager.target, this.cameraManager.getShortSideTiles() * WorldMap.TILE_SIZE * 0.9);
    this.renderer.render(activeCam);
    if (this.cameraManager.viewMode === 'cab_view' || this.cameraManager.viewMode === 'chase_view') {
      this.worldLabelManager.clear();
    } else {
      this.worldLabelManager.update(activeCam, this.cameraManager.viewMode, displayLayer, this.worldMap, this.trainManager);
    }
  }

  /**
   * ゲームの非同期初期化処理（IndexedDBからのデータロード・初期都市生成）
   */
  public async init(): Promise<void> {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('test_cutouts')) {
      this.persistenceService.setupTestCutouts();
    } else {
      await this.persistenceService.initWorld();
      const hasSave = await this.persistenceService.hasSaveData();
      this.uiManager.showTitleScreen(hasSave);
    }
    this.applyLayerSlicing(this.currentDisplayLayer);

    this.lastTime = performance.now();
    requestAnimationFrame(this.gameLoop.bind(this));
  }

  public getGridManager(): GridManager { return this.gridManager; }
  public getCameraManager(): CameraManager { return this.cameraManager; }
}

window.addEventListener('DOMContentLoaded', async () => {
  (window as any).THREE = THREE;
  const app = new GameApp();
  (window as any).gameApp = app;
  (window as any).game = app;
  await app.init();
});
