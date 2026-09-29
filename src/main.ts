import * as THREE from 'three';
import { EngineRenderer, TimeOfDay } from './engine/Renderer';
import { CameraManager } from './graphics/CameraManager';
import { AudioManager } from './engine/AudioManager';
import { ModelFactory } from './models/ModelFactory';
import { WorldMap, CurveDirection, TileType, TileData, createDefaultStationSchedule } from './simulation/WorldMap';
import { TrainManager } from './simulation/TrainManager';
import { CityGrowth } from './simulation/CityGrowth';
import { Economy } from './simulation/Economy';
import { UIManager, TOOL_CONFIG, ActiveTool, FleetItem } from './ui/UIManager';
import { VehicleModelInfo, getVehicleById } from './simulation/VehicleCatalog';
import { GameState } from './core/GameState';
import { GridManager } from './core/GridManager';
import { MapSize, TerrainType, GridLayer } from './core/types';
import { layerToHeight } from './core/Grid3D';
import { TerrainRenderer } from './graphics/TerrainRenderer';
import { TimeManager, SpeedLevel } from './core/TimeManager';
import { InputController } from './ui/InputController';
import { TrackBuilder, DragTrackSegment } from './core/TrackBuilder';
import { ZoneManager, ZoneType } from './core/ZoneManager';
import { DemandEngine } from './core/DemandEngine';
import { CargoSystem } from './core/CargoSystem';
import { ChunkManager } from './core/ChunkManager';
import { MiniMap } from './ui/MiniMap';
import { ScheduleUI } from './ui/ScheduleUI';
import { SwitchScheduleUI } from './ui/SwitchScheduleUI';
import { WorldLabelManager } from './ui/WorldLabelManager';
import { disposeHierarchy, GameMaterials } from './graphics/materials';

const CURVE_DIR_ORDER: CurveDirection[] = ['N_E', 'E_S', 'S_W', 'W_N'];
const CURVE_DIR_LABEL: Record<CurveDirection, string> = {
  N_E: '北 → 東', E_S: '東 → 南', S_W: '南 → 西', W_N: '西 → 北'
};
const AXIS_LABEL = ['南北方向', '東西方向'];
const DIR_LABEL = ['北', '東', '南', '西'];

const ROTATABLE_TOOLS: ActiveTool[] = [
  'rail-straight', 'rail-elevated', 'rail-tunnel', 'rail-curve', 'rail-curve-elevated',
  'rail-slope', 'rail-slope-underground', 'point-switch', 'point-switch-elevated',
  'scissors-crossing', 'scissors-crossing-elevated',
  'station-small', 'station-elevated', 'signal-yard', 'cargo-station', 'road'
];
// ⑥ 「仮置き（複数マス可・回転可）→決定でまとめて本設置」の対象ツール（選択・撤去・列車購入は対象外）
const PLACEMENT_TOOLS: ActiveTool[] = [
  'rail-straight', 'rail-elevated', 'rail-tunnel', 'rail-curve', 'rail-curve-elevated', 'rail-slope', 'rail-slope-underground',
  'point-switch', 'point-switch-elevated', 'scissors-crossing', 'scissors-crossing-elevated',
  'station-small', 'station-elevated', 'signal-yard', 'cargo-station',
  'road', 'building-res', 'building-com', 'building-ind', 'nature'
];

// ② カテゴリ別撤去ツールが対象とするタイル種別
const TRACK_TILE_TYPES: TileType[] = [
  'rail_ground', 'rail_elevated', 'rail_curve_ground', 'rail_curve_elevated',
  'point_switch_ground', 'point_switch_elevated',
  'scissors_crossing_ground', 'scissors_crossing_elevated',
  'rail_slope', 'rail_slope_underground', 'level_crossing'
];
const STATION_TILE_TYPES: TileType[] = ['station_ground', 'station_elevated', 'signal_yard', 'cargo_station_ground', 'cargo_station_elevated'];
const CITY_TILE_TYPES: TileType[] = ['road', 'residence', 'commercial', 'industrial', 'nature', 'level_crossing'];
const DEMOLISH_SCOPE: Partial<Record<ActiveTool, TileType[]>> = {
  'demolish-track': TRACK_TILE_TYPES,
  'demolish-station': STATION_TILE_TYPES,
  'demolish-city': CITY_TILE_TYPES
};

// 線路・駅・信号場・分岐器・シーサスクロッシング・踏切など「列車が乗れる/敷設延長に数える」タイルかどうか
function isTrackLikeType(type: TileType): boolean {
  return (
    type.includes('rail') ||
    type.includes('station') ||
    type === 'signal_yard' ||
    type.includes('switch') ||
    type.includes('scissors_crossing') ||
    type === 'level_crossing'
  );
}

// ⑥ 仮置き中の1件（同じツールで複数件をまとめて保持し、最後にまとめて確定する）
interface PendingItem {
  tool: ActiveTool;
  x: number;
  z: number;
  layer?: GridLayer;
  rotation: number;
  ghost: THREE.Object3D | null;
  stationPart?: 'single' | 'start' | 'mid' | 'end';
  stationGroupId?: string; // ⑤ 駅グループ識別子
  switchBranchSide?: 'left' | 'right'; // ② 分岐器の左右分岐
  stationPlatformSide?: 'left' | 'right'; // ① 駅ホームの左右配置
}

class GameApp {
  private renderer: EngineRenderer;
  private cameraManager: CameraManager;
  private gameState: GameState;
  private gridManager: GridManager;
  private terrainRenderer: TerrainRenderer;
  private audioManager: AudioManager;
  private worldMap: WorldMap;
  private trainManager: TrainManager;
  private cityGrowth: CityGrowth;
  private economy: Economy;
  private uiManager: UIManager;
  private timeManager: TimeManager;
  private inputController: InputController;
  private zoneManager: ZoneManager;
  private demandEngine: DemandEngine;
  private cargoSystem: CargoSystem;
  private chunkManager: ChunkManager;
  private miniMap!: MiniMap;
  private scheduleUI!: ScheduleUI;
  private switchScheduleUI!: SwitchScheduleUI;
  private worldLabelManager: WorldLabelManager;
  // ゾーンブラシで塗った区画の3D表示（地面に重ねる半透明カラーマーカー）
  private zoneOverlayGroup: THREE.Group = new THREE.Group();
  private zoneOverlayMeshes: Map<string, THREE.Mesh> = new Map();

  // 線路一括敷設（ドラッグ延伸モード）状態管理
  private isDraggingTrack: boolean = false;
  private dragStartTile: { x: number; z: number } | null = null;
  private dragGhostGroup: THREE.Group | null = null;
  private dragCurrentSegments: DragTrackSegment[] = [];
  // ドラッグプレビュー用スロットリングキャッシュ（タイル座標が変わらない微小移動でのメッシュ再生成を抑止）
  private prevDragStartTile: { x: number; z: number; layer: GridLayer } | null = null;
  private prevDragEndTile: { x: number; z: number; layer: GridLayer } | null = null;

  // スマホ用ターゲットレティクル操作状態管理
  private mobileDragStartTile: { x: number; z: number } | null = null;

  private raycaster: THREE.Raycaster = new THREE.Raycaster();
  private mousePos: THREE.Vector2 = new THREE.Vector2();
  private hoverPlane: THREE.Mesh;
  private hoveredTile: { x: number; z: number } | null = null;

  // ② 階層変更時に対応する地表座標を示す破線ガイド（地表外周枠 ＋ 対象階層外周枠 ＋ 垂直ガイド破線）
  private groundDashedGuide: THREE.Group;
  private groundDashedLines: THREE.LineSegments;
  private targetDashedLines: THREE.LineSegments;
  private verticalDashedLines: THREE.LineSegments;

  // 階層スライサー表示状態（'all': 地上全階層表示、GridLayer: 単一階層表示）
  private currentDisplayLayer: GridLayer | 'all' = 1;

  // ⑧ 現在の設置向き（0-3）。ツールごとに軸・曲線方向・分岐通過方向として解釈される
  private currentRotation: number = 0;
  // ② 分岐器の左右分岐方向 ('right': 右分岐, 'left': 左分岐)
  private currentSwitchSide: 'left' | 'right' = 'right';
  // ① 駅舎ホームの配置方向 ('right': 右側, 'left': 左側)
  private currentStationSide: 'left' | 'right' = 'right';

  // ⑦ 車両基地・保有列車管理
  private fleetRegistry: FleetItem[] = [];
  private nextFleetId: number = 1;
  private deployingFleetId: string | null = null;
  private deployDirectionIdx: number = 0;
  // 列車仮配置データ（未確定の仮配置状態）
  private pendingTrainDeploy: {
    fleetId: string;
    x: number;
    z: number;
    layer: GridLayer;
    directionIdx: number;
    ghost: THREE.Group;
  } | null = null;
  // ホバー追従プレビュー用列車ゴースト
  private hoverTrainGhost: THREE.Group | null = null;
  // ホバー追従プレビュー用駅ゴースト
  private hoverStationGhost: THREE.Group | null = null;
  private hoverStationCacheKey: string = '';

  // ④ 現在選択されている駅ホーム有効長（1〜10両）
  private currentStationLength: number = 2;

  // ⑤ インスペクターで選択中のオブジェクト追跡
  private selectedTilePos: { x: number; z: number; layer: GridLayer } | null = null;
  private selectedTrainId: number | null = null;
  // 前面展望（車窓モード）で追従中の列車ID
  private cabTargetTrainId: number | null = null;

  // 貨物ヤードのコンテナ段数視覚演出管理
  private cargoYardMeshes: Map<string, THREE.Group> = new Map();
  private cargoVisualTimer: number = 0;

  // ⑥ 仮置き中のプレースメント一覧（同じツールで複数件をまとめて保持し、決定ボタンで一括確定する）
  private pendingItems: PendingItem[] = [];
  private ghostMaterial = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.5,
    depthWrite: false
  });
  // トンネル専用ゴーストマテリアル（地表越しでもクリアに視認できるよう depthTest を無効化）
  private tunnelGhostMaterial = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.72,
    depthTest: false,
    depthWrite: false
  });

  private lastTime: number = 0;
  private autoSaveTimer: number = 0;
  private lastEffectiveTime: TimeOfDay = 'day';

  constructor() {
    this.ghostMaterial.userData.keepAlive = true;
    // 【ゴーストマテリアル永久破壊防止】トンネル用ゴーストもdisposeHierarchyによる自動破棄から保護
    this.tunnelGhostMaterial.userData.keepAlive = true;

    // 1. Core Systems
    this.renderer = new EngineRenderer('canvas-container');
    this.cameraManager = new CameraManager(this.renderer.renderer.domElement);
    this.gameState = GameState.getInstance();
    this.gridManager = new GridManager(64, 'balanced');
    this.terrainRenderer = new TerrainRenderer();
    this.audioManager = new AudioManager();
    this.worldMap = new WorldMap(this.renderer.scene, 64);
    this.worldMap.setElevationProvider((x, z) => {
      const cell = this.gridManager.getCell(x, 1, z);
      return cell ? Math.max(0, (cell.elevation - 1) * 3.0) : 0;
    });
    this.trainManager = new TrainManager(this.renderer.scene, this.worldMap, this.audioManager);
    this.cityGrowth = new CityGrowth(this.worldMap, this.gridManager);
    this.economy = new Economy();
    this.timeManager = new TimeManager(this.economy.year, this.economy.month, this.economy.day, 6, 0);
    this.uiManager = new UIManager();
    this.worldLabelManager = new WorldLabelManager();
    this.worldMap.gridManagerRef = this.gridManager;
    this.worldMap.groundHoleHandler = {
      add: (x, z, rot) => this.renderer.addGroundHole(x, z, rot),
      remove: (x, z) => this.renderer.removeGroundHole(x, z),
      clear: () => this.renderer.clearGroundHoles()
    };
    this.terrainRenderer.setTunnelChecker((x, z) => {
      const tile = this.worldMap.getTile(x, z, 1);
      return !!tile && tile.type !== 'empty' && this.worldMap.isTunnelSection(x, z, 1);
    });
    this.inputController = new InputController(this.cameraManager, this.renderer.renderer.domElement);
    // 直接タップ操作方式とするため、中央十字レティクルおよび右下アクションボタンドックは非表示
    this.uiManager.setMobileControlsVisible(false);

    // Phase2: ゾーニング・時間帯需要・貨物経済循環・超広大マップ用チャンク管理・ミニマップ
    this.zoneManager = new ZoneManager();
    this.demandEngine = new DemandEngine(this.zoneManager);
    this.cargoSystem = new CargoSystem(this.zoneManager);
    this.cityGrowth.setZoneManager(this.zoneManager);
    this.chunkManager = new ChunkManager(this.gridManager, this.terrainRenderer);
    this.zoneOverlayGroup.name = 'ZoneOverlayGroup';
    this.renderer.scene.add(this.zoneOverlayGroup);
    this.miniMap = new MiniMap({
      gridManager: this.gridManager,
      worldMap: this.worldMap,
      zoneManager: this.zoneManager,
      cameraManager: this.cameraManager,
      trainManager: this.trainManager
    });
    this.miniMap.onJumpWorld = (worldX, worldZ) => {
      this.cameraManager.stopTracking();
      this.cameraManager.jumpToPosition({ x: worldX, z: worldZ });
    };

    // Phase3: 純粋ダイヤ編成UI（サイドパネル/ボトムシート）
    this.scheduleUI = new ScheduleUI(this.worldMap);
    this.scheduleUI.onScheduleChanged = (tile) => {
      // 同一駅グループの全タイルへ同期（複数マス駅は1つのダイヤを共有する）
      const tiles = this.worldMap.getStationTiles(tile.x, tile.z);
      for (const t of tiles) {
        t.stationSchedule = tile.stationSchedule;
      }
    };

    // 分岐器・シーサスクロッシング用ダイヤ編成UI
    this.switchScheduleUI = new SwitchScheduleUI(this.worldMap);
    this.switchScheduleUI.onScheduleChanged = (tile) => {
      if (tile.type.startsWith('scissors_crossing')) {
        const origin = this.worldMap.resolveCrossingOrigin(tile.x, tile.z, tile.layer);
        if (origin) {
          origin.switchSchedule = tile.switchSchedule;
        }
      }
    };

    (window as any).game = this;

    // 2. Tile Hover Cursor (Glowing box)
    const cursorGeo = new THREE.BoxGeometry(WorldMap.TILE_SIZE, 0.08, WorldMap.TILE_SIZE);
    const cursorMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      wireframe: true,
      transparent: true,
      opacity: 0.8
    });
    this.hoverPlane = new THREE.Mesh(cursorGeo, cursorMat);
    this.hoverPlane.position.y = 0.05;
    this.hoverPlane.visible = false;
    this.renderer.scene.add(this.hoverPlane);

    // ② 階層変更時に対応する地表座標を示す破線ガイド（地下や高架操作時に地表位置を明示）
    this.groundDashedGuide = new THREE.Group();
    this.groundDashedGuide.name = 'GroundDashedGuide';
    this.groundDashedGuide.visible = false;

    // 地表マスの外周枠（正方形）
    const half = WorldMap.TILE_SIZE / 2;
    const borderPoints = [
      new THREE.Vector3(-half, 0, -half), new THREE.Vector3(half, 0, -half),
      new THREE.Vector3(half, 0, -half), new THREE.Vector3(half, 0, half),
      new THREE.Vector3(half, 0, half), new THREE.Vector3(-half, 0, half),
      new THREE.Vector3(-half, 0, half), new THREE.Vector3(-half, 0, -half)
    ];
    const borderGeo = new THREE.BufferGeometry().setFromPoints(borderPoints);
    const dashedMat = new THREE.LineDashedMaterial({
      color: 0x38bdf8,
      dashSize: 0.25,
      gapSize: 0.15,
      transparent: true,
      opacity: 0.95,
      depthTest: false
    });
    this.groundDashedLines = new THREE.LineSegments(borderGeo, dashedMat);
    this.groundDashedLines.computeLineDistances();
    this.groundDashedGuide.add(this.groundDashedLines);

    // 対象階層（地下・高架）マスの外周枠（正方形）
    const targetBorderGeo = new THREE.BufferGeometry().setFromPoints(borderPoints);
    this.targetDashedLines = new THREE.LineSegments(targetBorderGeo, dashedMat);
    this.targetDashedLines.computeLineDistances();
    this.groundDashedGuide.add(this.targetDashedLines);

    // 地表と現在階層を結ぶ4隅の垂直破線
    const vertGeo = new THREE.BufferGeometry();
    const vertPositions = new Float32Array(8 * 3);
    vertGeo.setAttribute('position', new THREE.BufferAttribute(vertPositions, 3));
    const vertDashedMat = new THREE.LineDashedMaterial({
      color: 0x38bdf8,
      dashSize: 0.25,
      gapSize: 0.15,
      transparent: true,
      opacity: 0.75,
      depthTest: false
    });
    this.verticalDashedLines = new THREE.LineSegments(vertGeo, vertDashedMat);
    this.groundDashedGuide.add(this.verticalDashedLines);
    this.renderer.scene.add(this.groundDashedGuide);

    // 3. UI Event Listeners & Interaction
    this.setupUIHandlers();
    this.setupInteraction();

    // 4. Initial World Setup or Load (デモ都市・初期ワールドを構築)
    this.initWorld();
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('test_cutouts')) {
      this.setupTestCutouts();
    } else {
      const hasSave = this.gameState.hasSaveData();
      this.uiManager.showTitleScreen(hasSave);
    }

    // 5. Start Game Loop
    this.lastTime = performance.now();
    requestAnimationFrame(this.gameLoop.bind(this));
  }

  private setupUIHandlers() {
    this.uiManager.getCurrentHour = () => this.timeManager.hour;
    this.uiManager.getCurrentMinute = () => this.timeManager.minute;

    this.uiManager.onSpeedChanged = (level) => {
      this.timeManager.setSpeedLevel(level as SpeedLevel);
    };

    // 毎年3月31日 23:59 決算確定・税額通知イベント
    this.timeManager.events.onFiscalYearEnd = (fiscalYear) => {
      const allTiles = this.worldMap.getAllTiles();
      const trackCount = allTiles.filter(t => isTrackLikeType(t.type)).length;
      // 貨物駅や信号場を含むすべての駅施設を課税対象に集計
      const stationCount = allTiles.filter(t => WorldMap.isStationTileType(t.type)).length;
      // 【固定資産税脱税防止】線路上の列車だけでなく、車庫（in_depot）に保管中の全保有車両を課税対象に集計
      const totalCars = this.fleetRegistry.length > 0
        ? this.fleetRegistry.reduce((sum, f) => sum + f.cars, 0)
        : this.trainManager.getTrains().reduce((sum, t) => sum + t.carCount, 0);

      const report = this.economy.assessAnnualTax(trackCount, stationCount, totalCars, fiscalYear);
      this.uiManager.showFiscalReportToast(report);
    };

    // 毎年5月30日 00:00 納税執行（自動引き落とし）イベント
    this.timeManager.events.onTaxDueDay = () => {
      const result = this.economy.executeTaxPayment();
      this.uiManager.showTaxPaymentToast(result);
    };

    // 月次維持費・走行費用引き落としイベント
    this.timeManager.events.onMonthPassed = (year, month) => {
      this.economy.syncDate(year, month, this.timeManager.day);
      const allTiles = this.worldMap.getAllTiles();
      const trackCount = allTiles.filter(t => isTrackLikeType(t.type)).length;
      // 駅および信号場の月額維持管理費（ホーム数×5万円、信号場×1万円）を集計
      const stationMaintenance = this.worldMap.stationManager.getStations().reduce(
        (sum, s) => sum + s.maintenance,
        0
      );
      // 線路維持費（1マス月額1万円）＋駅維持費
      const maint = trackCount * 10000 + stationMaintenance;
      this.economy.spendFunds(maint, false);
      // 【今期収支インフレ解消】月替わりで当期収支アキュムレータをリセット
      this.economy.resetPeriodStats();
    };

    // 毎日 00:00: 日次更新（乗降客数リセット・需要エンジンキャッシュクリアによる都市発展追従・日付同期）
    this.timeManager.events.onDayPassed = (year, month, day) => {
      this.economy.syncDate(year, month, day);
      this.worldMap.resetDailyStationPassengers();
      this.demandEngine.clearCache();
    };

    // 5分毎更新: 旅客駅の待機乗客補充（1時間あたりの発生数を12等分し、5分に1回 1/12 ずつ自然に集客）
    this.timeManager.events.onFiveMinutesPassed = (hour) => {
      this.trainManager.updateFiveMinuteStationPassengers(
        hour,
        (x, z, h) => this.demandEngine.getDemandMultiplier(h, x, z)
      );
    };

    // 毎時更新: 17:00工業施設の商品コンテナ自動生産
    this.timeManager.events.onHourPassed = (hour) => {
      if (hour === 17) {
        const updatedStations = this.cargoSystem.processDailyIndustrialProduction(this.worldMap);
        for (const st of updatedStations) {
          this.updateCargoYardVisual(st.x, st.z, st.layer);
        }
      }
    };

    this.uiManager.onAudioToggled = () => {
      const muted = this.audioManager.toggleMute();
      this.uiManager.setAudioMuted(muted);
    };

    this.uiManager.onTimeToggled = () => {
      const mode = this.renderer.cycleLightingMode();
      this.renderer.updateLightingByTime(this.timeManager.hour, this.timeManager.minute);
      const effectiveTime = this.renderer.getTimeOfDay();
      this.lastEffectiveTime = effectiveTime;
      this.uiManager.setTimeLightingMode(mode, effectiveTime);

      if (mode === 'day') {
        this.uiManager.showToast('昼夜切替: ②昼間固定', '時間帯に関係なく昼間の明るさに固定しました。夜間や夕暮れでも快適に作業できます。', 'info', 3000);
      } else if (mode === 'night') {
        this.uiManager.showToast('昼夜切替: ③夜間固定', '時間帯に関係なく夜間の夜景に固定しました。駅や建物の発光を楽しめます。', 'info', 3000);
      } else {
        this.uiManager.showToast('昼夜切替: ①OFF (時間連動)', 'ゲーム内時刻に合わせて昼〜夕〜夜が自然に移り変わります。', 'info', 3000);
      }
    };

    this.uiManager.onGridToggled = (visible) => {
      this.renderer.setGridVisible(visible);
    };

    this.uiManager.onStartNewGame = (size: MapSize, terrain: TerrainType) => {
      this.startNewGame(size, terrain);
    };

    this.uiManager.onResumeGame = () => {
      this.resumeGame();
    };

    this.uiManager.onRotateCameraCCW = () => {
      this.cameraManager.rotateStepCCW();
    };

    this.uiManager.onRotateCameraCW = () => {
      this.cameraManager.rotateStepCW();
    };

    this.uiManager.onToggleXRay = () => {
      const active = this.cameraManager.toggleXRayMode();
      this.terrainRenderer.setTransparentMode(active);
      this.uiManager.setXRayActive(active);
    };

    this.uiManager.onCameraModeToggled = () => {
      if (this.cameraManager.viewMode === 'cab_view') {
        this.exitCabView();
      } else {
        const trains = this.trainManager.getTrains();
        if (trains.length === 0) {
          alert('運行中の列車がありません。先に列車を購入・配置してください。');
          return;
        }
        // 乗車対象列車の選択モーダルを表示
        this.uiManager.showCabTrainSelectModal(trains, (trainId) => {
          this.enterCabView(trainId);
        });
      }
    };

    this.uiManager.onExitCab = () => {
      this.exitCabView();
    };

    // 前面展望中: 前の列車に乗り換え
    this.uiManager.onCabPrevRequested = () => {
      const trains = this.trainManager.getTrains();
      if (trains.length === 0) return;
      const currentIdx = trains.findIndex(t => t.id === this.cabTargetTrainId);
      const prevIdx = currentIdx <= 0 ? trains.length - 1 : currentIdx - 1;
      this.enterCabView(trains[prevIdx].id);
    };

    // 前面展望中: 次の列車に乗り換え
    this.uiManager.onCabNextRequested = () => {
      const trains = this.trainManager.getTrains();
      if (trains.length === 0) return;
      const currentIdx = trains.findIndex(t => t.id === this.cabTargetTrainId);
      const nextIdx = (currentIdx === -1 || currentIdx >= trains.length - 1) ? 0 : currentIdx + 1;
      this.enterCabView(trains[nextIdx].id);
    };

    // 前面展望中: 列車選択モーダルを開く
    this.uiManager.onCabSelectRequested = () => {
      const trains = this.trainManager.getTrains();
      this.uiManager.showCabTrainSelectModal(trains, (trainId) => {
        this.enterCabView(trainId);
      });
    };

    this.uiManager.onSaveRequested = () => {
      this.saveGame();
    };

    this.uiManager.onResetRequested = () => {
      this.resetGame();
    };

    // ② ポイント切り替えハンドラ
    this.uiManager.onTogglePointSwitch = (x, z, layer) => {
      const targetLayer = layer ?? this.selectedTilePos?.layer ?? this.worldMap.activeLayer;
      const hub = this.worldMap.resolveSwitchHub(x, z, targetLayer);
      if (!hub) return;
      const hubLayer = (hub.layer ?? targetLayer) as GridLayer;
      // 【脱線防止安全ガード】列車が分岐器上を通過・在線中の強制切り替えを禁止
      if (this.trainManager.isTileOccupiedByTrain(hub.x, hub.z, hubLayer)) {
        alert('列車が分岐器上を通過・在線中のため、進路を切り替えできません。');
        return;
      }
      this.worldMap.togglePointSwitch(hub.x, hub.z, hubLayer);
      this.uiManager.showInspector(hub, hub);
      this.audioManager.playBuildSound();
    };

    // ③ シーサスクロッシング開通状態切り替えハンドラ
    this.uiManager.onCycleCrossing = (x, z, layer) => {
      const targetLayer = (layer ?? this.selectedTilePos?.layer ?? this.worldMap.activeLayer) as GridLayer;
      const clicked = this.worldMap.getTile(x, z, targetLayer) || this.worldMap.getTile(x, z);
      if (!clicked || !clicked.groupOrigin) return;
      const cLayer = (clicked.layer ?? targetLayer) as GridLayer;
      const origin = this.worldMap.getTile(clicked.groupOrigin.x, clicked.groupOrigin.z, cLayer) || this.worldMap.getTile(clicked.groupOrigin.x, clicked.groupOrigin.z);
      if (!origin) return;

      const along = origin.rotation === 1 ? 1 : 2;
      const across = WorldMap.rotateCW(along);
      const alongVec = WorldMap.DIRS[along];
      const acrossVec = WorldMap.DIRS[across];

      const positions = [
        { x: origin.x, z: origin.z },
        { x: origin.x + alongVec.x, z: origin.z + alongVec.z },
        { x: origin.x + acrossVec.x, z: origin.z + acrossVec.z },
        { x: origin.x + alongVec.x + acrossVec.x, z: origin.z + alongVec.z + acrossVec.z }
      ];

      // 【脱線防止安全ガード】列車がシーサスクロッシング（4マス）上を通過・在線中の強制切り替えを禁止
      for (const p of positions) {
        if (this.trainManager.isTileOccupiedByTrain(p.x, p.z, cLayer)) {
          alert('列車が交差点上を通過・在線中のため、開通方向を切り替えできません。');
          return;
        }
      }

      this.worldMap.cycleCrossingState(x, z, cLayer);
      const updatedTile = this.worldMap.getTile(x, z, cLayer) || this.worldMap.getTile(x, z);
      if (updatedTile) {
        this.uiManager.showInspector(updatedTile);
        this.audioManager.playBuildSound();
      }
    };


    // Phase3: 駅インスペクターから純粋ダイヤ編成UIを開く（インスペクターは閉じて画面を整理する）
    this.uiManager.onOpenStationSchedule = (tile) => {
      this.uiManager.closeInspector();
      this.scheduleUI.open(tile);
    };

    // 分岐器・シーサスクロッシング用ダイヤ設定UIを開く
    this.uiManager.onOpenSwitchSchedule = (tile) => {
      this.uiManager.closeInspector();
      let targetTile = tile;
      if (tile.type.startsWith('scissors_crossing')) {
        const origin = this.worldMap.resolveCrossingOrigin(tile.x, tile.z, tile.layer);
        if (origin) targetTile = origin;
      }
      this.switchScheduleUI.open(targetTile);
    };

    // Phase3: 途中駅での編成分割時、分割された新編成を車両台帳（fleetRegistry）に正式登録し幽霊化を防止
    this.trainManager.onTrainSplit = (parentTrain, splitTrain) => {
      // 親編成の車両数を更新
      if (parentTrain.fleetId) {
        const parentFleet = this.fleetRegistry.find(f => f.id === parentTrain.fleetId);
        if (parentFleet) {
          parentFleet.cars = parentTrain.carCount;
        }
      }

      // 分割編成に一意の保有IDを割り当て、fleetRegistryに登録
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
    };

    // Phase3: 途中駅での編成連結時、吸収された編成を車両台帳から除籍し、親編成の両数を更新
    this.trainManager.onTrainCoupled = (leaderTrain, followerTrain) => {
      // 親（統合）編成の両数を更新
      if (leaderTrain.fleetId) {
        const leaderFleet = this.fleetRegistry.find(f => f.id === leaderTrain.fleetId);
        if (leaderFleet) {
          leaderFleet.cars = leaderTrain.carCount;
        }
      }

      // 吸収された follower を fleetRegistry から除去
      this.fleetRegistry = this.fleetRegistry.filter(f => f.activeTrainId !== followerTrain.id);
      this.syncFleetStats();

      // 選択中列車が吸収された場合、統合先親編成（leader）に安全にフォーカスを引き継ぐ
      if (this.selectedTrainId === followerTrain.id) {
        this.selectedTrainId = leaderTrain.id;
        this.uiManager.showTrainInspector(leaderTrain);
      }
    };

    // ⑤ & ⑦ 車両購入確定ハンドラ: 購入後、車両基地（fleetRegistry）に配属（1〜10両対応）
    this.uiManager.onConfirmBuyTrain = (model: VehicleModelInfo, cars: number) => {
      // 資金赤字時の追加投資ガード
      if (!this.economy.canInvest) {
        this.uiManager.showToast('追加投資制限中', '資金が赤字のため、新規車両の購入は行えません。（資金が黒字化すると自動解除されます）', 'warning');
        return;
      }

      const clampedCars = Math.max(1, Math.min(10, cars));
      const totalPrice = model.basePrice * clampedCars;
      if (!this.economy.spendFunds(totalPrice, true)) {
        this.uiManager.showToast('資金不足', `車両購入資金が不足しています。(必要: ¥${totalPrice.toLocaleString('ja-JP')})`, 'danger');
        return;
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

      alert(`🎉 ${fleetItem.name} を購入し、車両基地へ配属しました！\n右上の「🚆 車両管理」からいつでも線路へ配置できます。`);
      this.syncFleetStats();
      this.uiManager.showFleetModal(this.fleetRegistry);
    };

    // ⑦ 車両管理モーダル開閉
    this.uiManager.onOpenFleetModal = () => {
      this.syncFleetStats();
      this.uiManager.showFleetModal(this.fleetRegistry);
    };

    // 保有列車の両数変更（追加購入 / 減車売却、最大10両まで対応）
    this.uiManager.onChangeFleetCarCount = (fleetId: string, delta: number) => {
      const item = this.fleetRegistry.find(f => f.id === fleetId);
      if (!item) return;

      if (delta > 0) {
        if (item.cars >= 10) {
          alert('編成両数は最大10両までです。');
          return;
        }
        const cost = item.model.basePrice;
        if (!this.economy.spendFunds(cost, true)) {
          alert(`資金が不足しています。\n増車（1両追加購入）には ¥${cost.toLocaleString()} が必要です。`);
          return;
        }
        item.cars += 1;
        this.audioManager.playBuildSound();
      } else if (delta < 0) {
        if (item.cars <= 1) {
          alert('編成両数は1両より少なくできません。');
          return;
        }
        const refund = Math.floor(item.model.basePrice * 0.5);
        this.economy.refundFunds(refund);
        item.cars -= 1;
        this.audioManager.playDemolishSound();
      }

      // 営業運行中の場合は実際の列車編成メッシュ・定員も即座に更新
      if (item.status === 'deployed' && item.activeTrainId !== undefined) {
        this.trainManager.updateTrainCarCount(item.activeTrainId, item.cars);
      }

      this.syncFleetStats();
      this.uiManager.showFleetModal(this.fleetRegistry);
    };

    // ⑦ 保有列車を線路に配置するモードに入る（仮配置フロー）
    this.uiManager.onDeployFleetTrain = (fleetId: string) => {
      const item = this.fleetRegistry.find(f => f.id === fleetId);
      if (!item) return;

      this.cancelPendingPlacements();
      this.deployingFleetId = fleetId;
      this.deployDirectionIdx = 0;
      this.pendingTrainDeploy = null;
      this.clearHoverTrainGhost();
      this.updateRotationHint(this.uiManager.getActiveTool());
    };

    // ⑦ 営業中の列車を車庫へ回送（回収）する
    this.uiManager.onRecallFleetTrain = (fleetId: string) => {
      const item = this.fleetRegistry.find(f => f.id === fleetId);
      if (!item || item.status !== 'deployed' || item.activeTrainId === undefined) return;

      const train = this.trainManager.getTrainById(item.activeTrainId);
      if (train) {
        item.totalPassengers = (item.totalPassengers ?? 0) + train.totalPassengers;
        item.totalRevenue = (item.totalRevenue ?? 0) + train.totalRevenue;
      }
      if (this.cabTargetTrainId === item.activeTrainId) {
        this.exitCabView();
      }
      this.trainManager.removeTrain(item.activeTrainId);
      item.status = 'in_depot';
      item.activeTrainId = undefined;
      this.audioManager.playDemolishSound();
      this.syncFleetStats();
      this.uiManager.showFleetModal(this.fleetRegistry);
    };

    // 保有列車の売却（編成全体の売却・廃車返金）
    this.uiManager.onSellFleetTrain = (fleetId: string) => {
      const item = this.fleetRegistry.find(f => f.id === fleetId);
      if (!item) return;

      const refund = Math.floor(item.model.basePrice * item.cars * 0.5);
      const isDeployed = item.status === 'deployed';
      const confirmMsg = isDeployed
        ? `【${item.name}】(${item.cars}両編成) は現在営業運行中です。\n運行を終了して線路から撤去し、売却しますか？\n\n売却受領額: ¥${refund.toLocaleString()}`
        : `【${item.name}】(${item.cars}両編成) を売却しますか？\n\n売却受領額: ¥${refund.toLocaleString()}`;

      if (!confirm(confirmMsg)) return;

      // 営業運行中の場合は前面展望・追従カメラを安全に解除し、線路から列車を撤去
      if (isDeployed && item.activeTrainId !== undefined) {
        if (this.cabTargetTrainId === item.activeTrainId) {
          this.exitCabView();
        }
        if (this.selectedTrainId === item.activeTrainId) {
          this.selectedTrainId = null;
          this.uiManager.closeInspector();
        }
        this.cameraManager.stopTracking();
        this.trainManager.removeTrain(item.activeTrainId);
      }

      // 保有リストから除籍
      this.fleetRegistry = this.fleetRegistry.filter(f => f.id !== fleetId);

      // 売却返金
      this.economy.refundFunds(refund);
      this.audioManager.playDemolishSound();
      this.uiManager.showToast('車両売却完了', `${item.name} を売却し、¥${refund.toLocaleString()} を受領しました。`, 'success');

      this.syncFleetStats();
      this.uiManager.showFleetModal(this.fleetRegistry);
    };

    // ⑦ 営業中の列車にカメラ追従（地下・高架の場合は自動で該当階層に切り替え）
    this.uiManager.onTrackFleetTrain = (fleetId: string) => {
      const item = this.fleetRegistry.find(f => f.id === fleetId);
      if (!item || item.status !== 'deployed' || item.activeTrainId === undefined) return;
      const train = this.trainManager.getTrainById(item.activeTrainId);
      if (train) {
        if (train.currentTile.layer !== this.worldMap.activeLayer) {
          this.switchActiveLayer(train.currentTile.layer, false);
        }
        const target = this.trainManager.getFollowTargetByTrainId(train.id);
        if (target) {
          this.cameraManager.startTracking(target, true);
        }
        this.uiManager.showTrainInspector(train);
      }
    };

    // ② 分岐器の左右分岐切替
    this.uiManager.onToggleSwitchSide = () => {
      this.currentSwitchSide = this.currentSwitchSide === 'right' ? 'left' : 'right';
      this.uiManager.setSwitchSideButtonVisible(true, this.currentSwitchSide);
      if (this.pendingItems.length > 0) {
        const lastItem = this.pendingItems[this.pendingItems.length - 1];
        if (lastItem.tool.startsWith('point-switch')) {
          lastItem.switchBranchSide = this.currentSwitchSide;
          this.refreshGhostFor(lastItem);
        }
      }
      this.updateRotationHint(this.uiManager.getActiveTool());
    };

    // ① 駅舎ホームの左右配置切替
    this.uiManager.onToggleStationSide = () => {
      this.toggleStationSide();
    };

    // ② 開発テスト用: 資金無限モード切替
    this.uiManager.onToggleInfiniteFunds = () => {
      this.toggleInfiniteFunds();
    };

    // ① 列車撤去ハンドラ
    this.uiManager.onRemoveTrain = (trainId: number) => {
      // fleetRegistry内のステータスも戻す
      const fleetItem = this.fleetRegistry.find(f => f.activeTrainId === trainId);
      if (fleetItem) {
        fleetItem.status = 'in_depot';
        fleetItem.activeTrainId = undefined;
      }
      if (this.cabTargetTrainId === trainId) {
        this.exitCabView();
      }
      if (this.trainManager.removeTrain(trainId)) {
        this.audioManager.playDemolishSound();
      }
    };

    this.uiManager.onToolChanged = (tool: ActiveTool) => {
      // ⑥ ツールを切り替えたら仮置き中のプレースメントは全て破棄する
      this.cancelPendingPlacements();
      this.deployingFleetId = null;
      this.hoverPlane.scale.set(1, 1, 1);

      // 【追加】ツールを切り替えたらインスペクター等も閉じてリセットする
      this.uiManager.closeInspector();

      // 勾配線路ツール選択時: 1F〜4Fからはその直上階層（2F〜5F）へ上るスロープを敷設可能
      if (tool === 'rail-slope') {
        if (this.worldMap.activeLayer >= 5) {
          this.uiManager.showToast('最上階', '5Fからは上り勾配線路を敷設できません（4F以下をご利用ください）。', 'warning');
          this.switchActiveLayer(4, false);
        } else if (this.worldMap.activeLayer < 0) {
          this.switchActiveLayer(1, false);
        }
      } else if (tool === 'rail-slope-underground' && this.worldMap.activeLayer < 0) {
        this.switchActiveLayer(1, false);
      }

      if (tool === 'train-buy') {
        this.uiManager.openVehicleModal();
      }

      // スライサー表示の可視性（勾配線路作業中の2Fインフラ透かし等）を更新
      this.applyLayerSlicing(this.currentDisplayLayer);

      this.updateRotationHint(tool);
    };

    // ⑦ 「設置を決定」ボタン
    this.uiManager.onConfirmPlacement = () => {
      this.confirmPendingPlacements();
    };

    // ⑦ 「キャンセル」ボタン
    this.uiManager.onCancelPlacement = () => {
      this.cancelPendingPlacements();
      this.updateRotationHint(this.uiManager.getActiveTool());
    };

    // ⑤ タッチデバイス用「回転」ボタン（右クリックの代替）
    this.uiManager.onRotatePlacement = () => {
      this.rotateCurrentPlacement();
    };

    // ④ 駅ホーム有効長セレクター変更コールバック
    this.uiManager.onStationLengthChanged = (len) => {
      this.currentStationLength = len;
      this.cancelPendingPlacements();
      this.updateRotationHint(this.uiManager.getActiveTool());
    };

    // ④ インスペクターからの駅有効長設定変更コールバック
    this.uiManager.onSetStationLength = (x, z, targetLen) => {
      const tile = this.worldMap.getTile(x, z, this.worldMap.activeLayer) || this.worldMap.getTile(x, z);
      const stLayer = (tile?.layer ?? this.worldMap.activeLayer) as GridLayer;
      const ok = this.worldMap.setStationLength(
        x,
        z,
        targetLen,
        stLayer,
        (tx, tz, lyr) => this.trainManager.isTileOccupiedByTrain(tx, tz, lyr)
      );
      if (ok) {
        this.audioManager.playBuildSound();
        const updatedTile = this.worldMap.getTile(x, z, stLayer) || this.worldMap.getTile(x, z);
        if (updatedTile) {
          const stData = this.worldMap.getStationAggregateData(x, z, stLayer);
          this.uiManager.showInspector(updatedTile, undefined, targetLen, stData);
          if (updatedTile.type.startsWith('cargo_station')) {
            const stationTiles = this.worldMap.getStationTiles(x, z, stLayer);
            for (const st of stationTiles) {
              this.updateCargoYardVisual(st.x, st.z, stLayer);
            }
          }
        }
      } else {
        alert('列車が在線・停車中であるか、ホームを延伸するためのスペース（更地または線路）が不足しています。');
      }
    };

    // 駅名・信号場名のリネームコールバック
    this.uiManager.onRenameStation = (x: number, z: number, newName: string, layer?: GridLayer) => {
      const targetLayer = layer ?? this.selectedTilePos?.layer ?? this.worldMap.activeLayer;
      const ok = this.worldMap.renameStation(x, z, newName, targetLayer);
      if (ok) {
        const tile = this.worldMap.getTile(x, z, targetLayer);
        if (tile) {
          const runLength = this.worldMap.getStationRunLength(x, z, targetLayer);
          const stData = this.worldMap.getStationAggregateData(x, z, targetLayer);
          this.uiManager.showInspector(tile, undefined, runLength, stData);
        }
      }
    };

    // 列車名（編成名）のリネームコールバック
    this.uiManager.onRenameTrain = (trainId: number, newName: string) => {
      const train = this.trainManager.getTrains().find(t => t.id === trainId);
      if (train) {
        train.name = newName;
        const fleet = this.fleetRegistry.find(f => f.activeTrainId === trainId);
        if (fleet) {
          fleet.name = newName;
        }
        this.uiManager.setCabTrainName(newName);
        this.uiManager.showTrainInspector(train);
      }
    };

    // 閉塞デッドロック（立ち往生）検知コールバック
    this.trainManager.onDeadlockDetected = (event) => {
      this.uiManager.showDeadlockToast(event, () => {
        this.cameraManager.jumpToPosition(event.position);
      });
    };

    // インスペクターが閉じられたときに選択状態を解除
    this.uiManager.onInspectorClosed = () => {
      this.selectedTilePos = null;
      this.selectedTrainId = null;
      this.cameraManager.stopTracking();
    };

    // 階層（フロア）切り替えスライサーUIコールバック
    this.uiManager.onLayerChanged = (layer: GridLayer | 'all') => {
      this.switchActiveLayer(layer);
    };

    // スマホ用モバイルアクションボタン操作コールバック
    this.uiManager.onMobileAction = (action: 'start' | 'confirm' | 'cancel' | 'rotate') => {
      this.handleMobileAction(action);
    };

    // 昼夜切替モードの初期状態同期
    this.uiManager.setTimeLightingMode(this.renderer.getLightingMode(), this.renderer.getTimeOfDay());
  }

  /**
   * ④ 階層（フロア）の切り替えを一元管理し、UI・ワールド・入力判定・スライサー表示を完全同期する
   */
  public switchActiveLayer(layer: GridLayer | 'all', playSound: boolean = true) {
    const targetLayer: GridLayer = layer === 'all' ? 1 : layer;
    if (this.worldMap.activeLayer === targetLayer && this.currentDisplayLayer === layer) return;
    this.worldMap.setActiveLayer(targetLayer);
    this.currentDisplayLayer = layer;
    this.inputController.setActiveLayer(targetLayer);
    this.uiManager.setFloorActive(layer);
    this.applyLayerSlicing(layer);
    this.updateRotationHint(this.uiManager.getActiveTool());
    this.clearHoverStationGhost();
    if (playSound) {
      this.audioManager.playSelectSound();
    }
  }

  /**
   * 指定した列車の運転席・前面展望（車窓モード）へ切り替える
   */
  public enterCabView(trainId: number) {
    const train = this.trainManager.getTrainById(trainId);
    if (!train) return;
    const target = this.trainManager.getFollowTargetByTrainId(trainId);
    if (!target) return;

    this.cabTargetTrainId = trainId;
    this.cameraManager.setCabViewMode(target);
    this.uiManager.setCameraModeUI('cab');
    this.uiManager.setCabTrainName(`${train.name} (${train.model.name})`);
    this.audioManager.startCabMotorSound(target.speed ?? 0);
  }

  /**
   * 前面展望モードを終了し、全体視点（クォータービュー）へ安全復帰する
   */
  public exitCabView() {
    this.cabTargetTrainId = null;
    this.cameraManager.setQuarterViewMode();
    this.uiManager.setCameraModeUI('orbit');
    this.audioManager.stopCabMotorSound();
  }

  /**
   * ② 階層スライサーに応じた該当階層のみの立体表示切替
   * - 'all': 地上階（1F〜5F）の線路・駅・建物・列車をすべて表示
   * - 地下（B1F, B2F）選択時:
   *   地表の地面と山岳・水面を完全に非表示にし、地下専用の作業床とグリッドを表示してトンネル線路をくっきり表示
   * - 地上各階選択時: 指定階層のみをクリアにスライス表示
   */
  private applyLayerSlicing(displayLayer: GridLayer | 'all') {
    const isUnderground = displayLayer !== 'all' && displayLayer < 0;
    const isAll = displayLayer === 'all';
    const targetHeight = isAll ? layerToHeight(1) : layerToHeight(displayLayer);

    // 1. 地面・地形・地下作業床・グリッドヘルパーの切り替え
    if (isUnderground) {
      // 地下フロア: 地上の地面と山・水面を完全に非表示にし、地下コンクリート床を表示
      this.renderer.setGroundVisible(false);
      this.terrainRenderer.setVisible(false);
      this.renderer.setUndergroundFloor(true, targetHeight);
      this.renderer.setGridHeight(targetHeight);
      this.renderer.setUndergroundMode(true);
    } else {
      // 地上・高架: 通常の地表面と地形を表示、地下床は非表示
      this.renderer.setGroundVisible(true);
      this.terrainRenderer.setVisible(true);
      this.terrainRenderer.setTransparentMode(GameMaterials.isTransparentMode());
      this.renderer.setUndergroundFloor(false);
      this.renderer.setGridHeight(targetHeight);
      this.renderer.setUndergroundMode(false);
    }

    // 地下/地上切り替え直後に太陽光（dirLight）と環境照明を即座に更新（ライティング破綻防止）
    this.renderer.updateLightingByTime(this.timeManager.hour, this.timeManager.minute);

    // 2. タイルの表示切替:
    const activeTool = this.uiManager.getActiveTool();
    const allTiles = this.worldMap.getAllTiles();
    for (const tile of allTiles) {
      if (!tile.mesh) continue;
      const tileLayer = tile.layer ?? 1;
      if (isAll) {
        tile.mesh.visible = tileLayer >= 1; // 地上階(1以上)はすべて表示
      } else {
        // 通常勾配線路（rail_slope）は下位階層と直上階層の両階層に跨るため、どちらの階層スライサー表示時でも可視化
        if (tile.type === 'rail_slope') {
          const upperLayer = (tileLayer + 1) as GridLayer;
          tile.mesh.visible = (tileLayer === displayLayer || upperLayer === displayLayer);
        } else if (tile.type === 'rail_slope_underground') {
          // 地下勾配線路は地上1Fと地下B1Fの両階層スライサーで可視化
          tile.mesh.visible = (tileLayer === displayLayer || displayLayer === -1);
        } else if (activeTool === 'rail-slope' && typeof displayLayer === 'number' && tileLayer === (displayLayer + 1)) {
          // 勾配線路設置作業中は、接続先となる直上階層インフラを可視化（接続先を直感的に把握可能にする）
          tile.mesh.visible = true;
        } else {
          tile.mesh.visible = tileLayer === displayLayer;
        }
      }
    }

    // 3. 貨物ヤードコンテナの表示切替
    for (const [key, mesh] of this.cargoYardMeshes) {
      const parts = key.split(',');
      const mLayer = parseInt(parts[2], 10) as GridLayer;
      if (isAll) {
        mesh.visible = mLayer >= 1;
      } else {
        mesh.visible = mLayer === displayLayer;
      }
    }
  }

  /**
   * ③ 現在の階層に応じて、ツールを自動的に適切な立体種別へ解決する
   * - 直線線路: 地下なら 'rail-tunnel'、空中(2F〜)なら 'rail-elevated'、地上1Fなら 'rail-straight'
   * - 曲線線路: 空中(2F〜)なら 'rail-curve-elevated'、地上・地下なら 'rail-curve'
   * - 分岐器: 空中(2F〜)なら 'point-switch-elevated'、地上・地下なら 'point-switch'
   * - シーサス: 空中(2F〜)なら 'scissors-crossing-elevated'、地上・地下なら 'scissors-crossing'
   * - 駅: 空中(2F〜)なら 'station-elevated'、地上・地下なら 'station-small'
   */
  private resolveAutoToolForLayer(tool: ActiveTool, layer: GridLayer = this.worldMap.activeLayer): ActiveTool {
    // 直線線路系
    if (tool === 'rail-straight' || tool === 'rail-elevated' || tool === 'rail-tunnel') {
      if (tool === 'rail-tunnel') return 'rail-tunnel';
      if (layer < 0) return 'rail-tunnel';
      if (layer >= 2) return 'rail-elevated';
      return 'rail-straight';
    }
    // 曲線線路系
    if (tool === 'rail-curve' || tool === 'rail-curve-elevated') {
      return layer >= 2 ? 'rail-curve-elevated' : 'rail-curve';
    }
    // 分岐器系
    if (tool === 'point-switch' || tool === 'point-switch-elevated') {
      return layer >= 2 ? 'point-switch-elevated' : 'point-switch';
    }
    // シーサスクロッシング系
    if (tool === 'scissors-crossing' || tool === 'scissors-crossing-elevated') {
      return layer >= 2 ? 'scissors-crossing-elevated' : 'scissors-crossing';
    }
    // 駅系
    if (tool === 'station-small' || tool === 'station-elevated') {
      if (tool === 'station-elevated') return 'station-elevated';
      return layer >= 2 ? 'station-elevated' : 'station-small';
    }
    return tool;
  }

  /**
   * 画面中央レティクルの下にある立体グリッドマスを取得
   */
  private getReticleTile(): { x: number; z: number } | null {
    const intersect = this.inputController.getGridIntersection(
      this.worldMap.gridSize,
      (x, z) => this.worldMap.getElevationOffset(x, z),
      true
    );
    return intersect && intersect.isValidTile ? { x: intersect.tileX, z: intersect.tileZ } : null;
  }

  /**
   * スマホ用ターゲットレティクル＋アクションボタンの操作ハンドラ
   */
  private handleMobileAction(action: 'start' | 'confirm' | 'cancel' | 'rotate') {
    const tile = this.getReticleTile();

    if (action === 'start') {
      if (!tile) return;
      this.mobileDragStartTile = { x: tile.x, z: tile.z };
      this.uiManager.setMobileActionState('dragging');
      this.uiManager.setRotationHint(
        true,
        `📍 始点(${tile.x}, ${tile.z})を設定しました。画面中央を終点に合わせて「終点決定」を押してください。`
      );
      this.audioManager.playSelectSound();
    } else if (action === 'confirm') {
      if (this.mobileDragStartTile && tile) {
        // 一括敷設の終点として確定
        this.updateDragPreview(this.mobileDragStartTile, tile);
        this.finishDragPlacement();
        this.mobileDragStartTile = null;
        this.uiManager.setMobileActionState('idle');
      } else if (tile) {
        // 単一マス設置
        this.hoveredTile = tile;
        this.handleTileClick();
      }
    } else if (action === 'cancel') {
      this.mobileDragStartTile = null;
      this.prevDragStartTile = null;
      this.prevDragEndTile = null;
      if (this.dragGhostGroup) {
        this.renderer.scene.remove(this.dragGhostGroup);
        disposeHierarchy(this.dragGhostGroup);
        this.dragGhostGroup = null;
      }
      this.cancelPendingPlacements();
      this.uiManager.setMobileActionState('idle');
      this.updateRotationHint(this.uiManager.getActiveTool());
    } else if (action === 'rotate') {
      this.rotateCurrentPlacement();
    }
  }

  /**
   * ドラッグ延伸による線路自動補間ゴーストプレビューを更新
   */
  private updateDragPreview(start: { x: number; z: number }, current: { x: number; z: number }) {
    const tool = this.uiManager.getActiveTool();
    const isTunnelTool = tool === 'rail-tunnel';
    const curLayer: GridLayer = this.worldMap.activeLayer;

    // 【VRAM即死バグ解消】始点・終点のタイル座標が前回と同じであれば無駄な再生成をスキップ
    if (
      this.prevDragStartTile &&
      this.prevDragEndTile &&
      this.prevDragStartTile.x === start.x &&
      this.prevDragStartTile.z === start.z &&
      this.prevDragStartTile.layer === curLayer &&
      this.prevDragEndTile.x === current.x &&
      this.prevDragEndTile.z === current.z &&
      this.prevDragEndTile.layer === curLayer
    ) {
      return;
    }

    this.prevDragStartTile = { x: start.x, z: start.z, layer: curLayer };
    this.prevDragEndTile = { x: current.x, z: current.z, layer: curLayer };

    if (this.dragGhostGroup) {
      this.renderer.scene.remove(this.dragGhostGroup);
      disposeHierarchy(this.dragGhostGroup);
      this.dragGhostGroup = null;
    }

    const segments = TrackBuilder.calculatePath(
      start.x,
      start.z,
      current.x,
      current.z,
      curLayer
    );
    this.dragCurrentSegments = segments;

    const ghost = TrackBuilder.createGhostGroup(
      segments,
      isTunnelTool ? this.tunnelGhostMaterial : this.ghostMaterial,
      (x, z) => this.worldMap.getTrackElevationOffset(x, z, curLayer)
    );
    if (isTunnelTool) {
      ghost.traverse(obj => {
        if ((obj as THREE.Mesh).isMesh) {
          (obj as THREE.Mesh).renderOrder = 999;
        }
      });
    }
    this.renderer.scene.add(ghost);
    this.dragGhostGroup = ghost;

    // 【プレビュー額と課金額の完全一致】
    // finishDragPlacement と同一ルールで、水辺・重複除外およびトンネル等すり替えツールを正確に判定して積算
    let totalCost = 0;
    let placeableCount = 0;
    for (const seg of segments) {
      const waterCheck = this.worldMap.canPlaceAtWater(seg.x, seg.z, seg.layer);
      if (!waterCheck.allowed) continue;
      if (this.pendingItems.some(p => p.x === seg.x && p.z === seg.z && (p.layer ?? 1) === seg.layer)) continue;
      if (this.worldMap.isPermanentTrackOrStation(seg.x, seg.z, seg.layer)) continue;

      let segTool = seg.tool;
      if (segTool === 'rail-straight' && this.worldMap.isTunnelSection(seg.x, seg.z, seg.layer)) {
        segTool = 'rail-tunnel';
      }
      totalCost += TOOL_CONFIG[segTool]?.cost || 100000;
      placeableCount++;
    }

    this.uiManager.setRotationHint(
      true,
      `🛤️ 線路一括敷設プレビュー: ${placeableCount}マス (費用: ¥${totalCost.toLocaleString('ja-JP')})`
    );
  }

  /**
   * ドラッグ延伸線路の仮置き登録を完了
   */
  private finishDragPlacement() {
    this.prevDragStartTile = null;
    this.prevDragEndTile = null;
    if (this.dragGhostGroup) {
      this.renderer.scene.remove(this.dragGhostGroup);
      disposeHierarchy(this.dragGhostGroup);
      this.dragGhostGroup = null;
    }

    if (this.dragCurrentSegments.length === 0) return;

    let addedCount = 0;
    for (const seg of this.dragCurrentSegments) {
      // 水辺制約チェック
      const waterCheck = this.worldMap.canPlaceAtWater(seg.x, seg.z, seg.layer);
      if (!waterCheck.allowed) continue;

      // 既存の仮置き・本設置インフラとの衝突チェック（同階層を対象）
      if (this.pendingItems.some(p => p.x === seg.x && p.z === seg.z && (p.layer ?? 1) === seg.layer)) continue;
      if (this.worldMap.isPermanentTrackOrStation(seg.x, seg.z, seg.layer)) continue;

      let segTool = seg.tool;
      if (segTool === 'rail-straight' && this.worldMap.isTunnelSection(seg.x, seg.z, seg.layer)) {
        segTool = 'rail-tunnel';
      }
      let segRotation = seg.rotation;
      if (seg.curveDir) {
        const curveIdx = CURVE_DIR_ORDER.indexOf(seg.curveDir);
        if (curveIdx !== -1) {
          segRotation = curveIdx;
        }
      }
      const item: PendingItem = {
        tool: segTool,
        x: seg.x,
        z: seg.z,
        layer: seg.layer,
        rotation: segRotation,
        ghost: null
      };
      this.pendingItems.push(item);
      this.refreshGhostFor(item);
      addedCount++;
    }

    this.dragCurrentSegments = [];
    if (addedCount > 0) {
      this.uiManager.setPlacementButtonsVisible(true);
      this.audioManager.playSelectSound();
    }
    this.updateRotationHint(this.uiManager.getActiveTool());
  }

  /**
   * ⑦ 保有列車の累計乗客数・収支を運行中のインスタンスと同期
   */
  private syncFleetStats() {
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
   * ⑥⑧ 現在のツール・回転状態、仮置き件数・合計金額に応じたヒント表示を更新（スッキリした要点表示）
   */
  private updateRotationHint(tool: ActiveTool) {
    if (this.deployingFleetId) {
      const item = this.fleetRegistry.find(f => f.id === this.deployingFleetId);
      this.uiManager.setSwitchSideButtonVisible(false);
      this.uiManager.setStationSideButtonsVisible(false);
      this.uiManager.setRotateButtonVisible(true);
      if (this.pendingTrainDeploy) {
        this.uiManager.setRotationHint(
          true,
          `🚆 【${item?.name}】仮配置中: 🔄回転(Rキー)で向き切替（進行方向: ${DIR_LABEL[this.pendingTrainDeploy.directionIdx]}）/「設置を決定」で運行開始`
        );
      } else {
        this.uiManager.setRotationHint(
          true,
          `🚆 【${item?.name}】配置先を選択: 線路をクリック（仮配置後に🔄回転で向き調整）`
        );
      }
      return;
    }

    const isRotatable = ROTATABLE_TOOLS.includes(tool);
    const hasPending = this.pendingItems.length > 0;

    // 回転可能でもなく、仮置きアイテムも存在しない場合はバーを閉じる
    if (!isRotatable && !hasPending) {
      this.uiManager.setRotationHint(false);
      this.uiManager.setRotateButtonVisible(false);
      this.uiManager.setSwitchSideButtonVisible(false);
      this.uiManager.setStationSideButtonsVisible(false);
      return;
    }

    this.uiManager.setRotateButtonVisible(isRotatable);

    const isSwitch = (tool === 'point-switch' || tool === 'point-switch-elevated');
    const isStation = tool.startsWith('station') || tool === 'signal-yard' || tool === 'cargo-station';
    this.uiManager.setSwitchSideButtonVisible(isSwitch, this.currentSwitchSide);
    this.uiManager.setStationSideButtonsVisible(isStation, this.currentStationSide);

    let label: string;
    if (isRotatable) {
      if (tool === 'rail-curve' || tool === 'rail-curve-elevated') {
        label = `向き: ${CURVE_DIR_LABEL[CURVE_DIR_ORDER[this.currentRotation]]}`;
      } else if (isSwitch) {
        label = `通過方向: ${DIR_LABEL[this.currentRotation]}（分岐: ${this.currentSwitchSide === 'left' ? '左' : '右'}）`;
      } else if (tool === 'scissors-crossing' || tool === 'scissors-crossing-elevated') {
        label = `並走方向: ${AXIS_LABEL[this.currentRotation % 2]}`;
      } else if (tool === 'rail-slope') {
        const axis = this.currentRotation % 2;
        const reversed = this.currentRotation >= 2;
        const axisDirs = axis === 1 ? ['西', '東'] : ['北', '南'];
        const [low, high] = reversed ? [axisDirs[1], axisDirs[0]] : axisDirs;
        const curL = this.worldMap.activeLayer;
        const lowL = curL <= 1 ? '地上1F' : `${curL}F`;
        const highL = `${curL + 1}F`;
        label = `上り方向: ${low} → ${high} (${lowL} → ${highL}へ上り)`;
      } else if (tool === 'rail-slope-underground') {
        const axis = this.currentRotation % 2;
        const reversed = this.currentRotation >= 2;
        const axisDirs = axis === 1 ? ['西', '東'] : ['北', '南'];
        const [entry, exit] = reversed ? [axisDirs[1], axisDirs[0]] : axisDirs;
        label = `潜入方向: ${entry} → ${exit} (地上→地下)`;
      } else if (isStation) {
        const sideText = this.currentStationSide === 'left' ? '左' : '右';
        const axisText = AXIS_LABEL[this.currentRotation % 2];
        label = `向き: ${axisText}（${this.currentStationLength}両・ホーム${sideText}側）`;
        this.uiManager.setStationRotationText(axisText);
      } else {
        label = `向き: ${AXIS_LABEL[this.currentRotation % 2]}`;
      }
    } else {
      const toolConfig = TOOL_CONFIG[tool];
      label = `選択中: ${toolConfig?.name || '施設'}`;
    }

    if (hasPending) {
      const total = this.pendingItems.reduce((sum, it) => sum + (TOOL_CONFIG[it.tool]?.cost || 0), 0);
      label = `🔶 仮置き ${this.pendingItems.length}件 (¥${total.toLocaleString()}) | ${label}`;
    }

    this.uiManager.setRotationHint(true, label);
  }

  /**
   * ① 駅舎ホームの配置方向（右側・左側）を切り替える
   */
  private toggleStationSide() {
    this.currentStationSide = this.currentStationSide === 'right' ? 'left' : 'right';
    const tool = this.uiManager.getActiveTool();
    if ((tool.startsWith('station') || tool === 'signal-yard' || tool === 'cargo-station') && this.pendingItems.length > 0) {
      for (const item of this.pendingItems) {
        if (item.tool.startsWith('station') || item.tool === 'signal-yard' || item.tool === 'cargo-station') {
          item.stationPlatformSide = this.currentStationSide;
          this.refreshGhostFor(item);
        }
      }
    }
    if (this.hoveredTile) {
      this.clearHoverStationGhost();
      this.updateHoverStationGhost(this.hoveredTile.x, this.hoveredTile.z);
    }
    this.audioManager.playSelectSound();
    this.updateRotationHint(tool);
  }

  /**
   * ② 開発テスト用: 資金無限モードのON/OFF切り替え
   */
  private toggleInfiniteFunds() {
    const isInf = this.economy.toggleInfiniteFunds();
    this.uiManager.updateInfiniteFundsUI(isInf);
    this.audioManager.playSelectSound();
    // メッセージ表示
    const msg = isInf
      ? '💰 【開発テスト用】資金無限モードを [ON] にしました。資金が減少しなくなります。'
      : '💰 資金無限モードを [OFF] に戻しました。通常の資金管理に戻ります。';
    console.log(msg);
  }

  /**
   * ① ⑤ 設置向きを回転。右クリック・タッチ用の回転ボタン両方から呼ばれる。
   * 仮置き中のマスが存在する場合は、直前に仮置きしたマス（線路等）の方角を即座に更新してゴーストを再描画する。
   */
  private rotateCurrentPlacement() {
    if (this.deployingFleetId) {
      const item = this.fleetRegistry.find(f => f.id === this.deployingFleetId);
      if (!item) return;

      if (this.pendingTrainDeploy) {
        // 仮配置済みタイルの線路出口に沿って向きを回転
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

        // ゴースト再生成
        this.renderer.scene.remove(this.pendingTrainDeploy.ghost);
        disposeHierarchy(this.pendingTrainDeploy.ghost);
        const newGhost = this.createTrainGhost(
          item.model,
          item.cars,
          this.pendingTrainDeploy.directionIdx,
          this.pendingTrainDeploy.x,
          this.pendingTrainDeploy.z,
          this.pendingTrainDeploy.layer
        );
        this.renderer.scene.add(newGhost);
        this.pendingTrainDeploy.ghost = newGhost;

        this.audioManager.playSelectSound();
        this.uiManager.setRotationHint(
          true,
          `🚆 【${item.name}】仮配置中: 🔄回転(Rキー)で向き切替（進行方向: ${DIR_LABEL[this.deployDirectionIdx]}）/「設置を決定」で運行開始`
        );
      } else {
        // まだクリックしておらずホバー中
        this.deployDirectionIdx = (this.deployDirectionIdx + 1) % 4;
        this.uiManager.setRotationHint(
          true,
          `🚆 【${item.name}】配置先を選択: 線路をクリック（進行方向: ${DIR_LABEL[this.deployDirectionIdx]}）`
        );
        if (this.hoveredTile) {
          this.updateHoverTrainGhost(this.hoveredTile.x, this.hoveredTile.z);
        }
      }
      return;
    }

    const tool = this.uiManager.getActiveTool();
    if (!ROTATABLE_TOOLS.includes(tool)) return;

    if (tool === 'point-switch' || tool === 'point-switch-elevated') {
      this.currentRotation = (this.currentRotation + 1) % 4;
      if (this.currentRotation === 0) {
        // 4方向一巡したら左右反転（北右→東右→南右→西右→北左→東左→南左→西左）
        this.currentSwitchSide = this.currentSwitchSide === 'right' ? 'left' : 'right';
      }
    } else {
      this.currentRotation = (this.currentRotation + 1) % 4;
    }

    // ① 直前に仮置きしたアイテムの方角を更新
    if (this.pendingItems.length > 0) {
      if (tool.startsWith('station') || tool === 'signal-yard' || tool === 'cargo-station') {
        // 駅の場合：直前の駅グループ（currentStationLengthマス分）を回転
        const stationItems = this.pendingItems.filter(p => p.tool === tool);
        if (stationItems.length > 0) {
          const groupCount = Math.min(stationItems.length, this.currentStationLength);
          const startIdx = stationItems.length - groupCount;
          const originX = stationItems[startIdx].x;
          const originZ = stationItems[startIdx].z;
          const axis = this.currentRotation % 2;
          const stepX = axis === 1 ? 1 : 0;
          const stepZ = axis === 1 ? 0 : 1;

          for (let i = 0; i < groupCount; i++) {
            const it = stationItems[startIdx + i];
            it.x = originX + stepX * i;
            it.z = originZ + stepZ * i;
            it.rotation = this.currentRotation;
            this.refreshGhostFor(it);
          }
        }
      } else {
        // 単一マスの線路・カーブ・スロープ・分岐器・シーサス等
        const lastItem = this.pendingItems[this.pendingItems.length - 1];
        if (ROTATABLE_TOOLS.includes(lastItem.tool)) {
          lastItem.rotation = this.currentRotation;
          if (lastItem.tool.startsWith('point-switch')) {
            lastItem.switchBranchSide = this.currentSwitchSide;
          }
          this.refreshGhostFor(lastItem);
        }
      }
    }
    if (this.hoveredTile) {
      this.clearHoverStationGhost();
      this.updateHoverStationGhost(this.hoveredTile.x, this.hoveredTile.z);
    }

    this.updateRotationHint(tool);
  }

  private setupInteraction() {
    const dom = this.renderer.renderer.domElement;
    let mouseDownPos = { x: 0, y: 0 };
    let hasDragged = false;
    let suppressNextMouseClick = false;

    // タッチ端末（スマホ）での直接タイルタップ検出
    let touchStartPos = { x: 0, y: 0 };
    let touchStartTime = 0;
    let isTouchDragging = false;

    dom.addEventListener('touchstart', (e: TouchEvent) => {
      if (e.touches.length === 1) {
        touchStartPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        touchStartTime = performance.now();
        isTouchDragging = false;
      } else {
        isTouchDragging = true;
      }
    }, { passive: true });

    dom.addEventListener('touchmove', (e: TouchEvent) => {
      if (e.touches.length === 1) {
        const dist = Math.hypot(e.touches[0].clientX - touchStartPos.x, e.touches[0].clientY - touchStartPos.y);
        if (dist > 8) {
          isTouchDragging = true;
        }
      } else {
        isTouchDragging = true;
      }
    }, { passive: true });

    dom.addEventListener('touchend', (e: TouchEvent) => {
      if (this.cameraManager.viewMode === 'cab_view') return;
      if (!isTouchDragging && e.changedTouches.length > 0) {
        const touch = e.changedTouches[0];
        const elapsed = performance.now() - touchStartTime;
        // 500ms以内の短時間タップかつ移動が微小な場合のみタップ処理を実行
        if (elapsed < 500) {
          const target = document.elementFromPoint(touch.clientX, touch.clientY);
          const isOverUI = target ? !!target.closest('#build-toolbar, #tool-submenu, #rotation-hint, #station-length-selector, #floor-slicer, header, aside, .modal, .modal-backdrop, #mobile-action-dock, #minimap-container') : false;
          if (!isOverUI) {
            // 合成マウスイベント（mousedown/click）の重複発火をブロック
            suppressNextMouseClick = true;
            setTimeout(() => { suppressNextMouseClick = false; }, 400);

            // タップした座標で正確にレイキャストしてタイル処理を実行
            this.inputController.updateMousePosition(touch.clientX, touch.clientY);
            this.updateHover();
            this.handleTileClick();
          }
        }
      }
      isTouchDragging = false;
    }, { passive: true });

    dom.addEventListener('mousedown', (e) => {
      if (suppressNextMouseClick) return;
      mouseDownPos = { x: e.clientX, y: e.clientY };
      hasDragged = false;

      if (e.button === 0 && this.cameraManager.viewMode !== 'cab_view') {
        this.inputController.updateMousePosition(e.clientX, e.clientY);
        const intersect = this.inputController.getGridIntersection(
          this.worldMap.gridSize,
          (x, z) => this.worldMap.getElevationOffset(x, z)
        );
        const tool = this.uiManager.getActiveTool();
        const isTrackTool = tool.startsWith('rail') || tool === 'road';
        if (intersect && intersect.isValidTile && isTrackTool) {
          this.dragStartTile = { x: intersect.tileX, z: intersect.tileZ };
        } else {
          this.dragStartTile = null;
        }
      }
    });

    // Mouse move for hover cursor and track drag extension
    dom.addEventListener('mousemove', (e) => {
      if (suppressNextMouseClick) return;
      this.inputController.updateMousePosition(e.clientX, e.clientY);

      const dragDist = Math.hypot(e.clientX - mouseDownPos.x, e.clientY - mouseDownPos.y);
      if (!hasDragged && dragDist > 6) {
        hasDragged = true;
      }

      const tool = this.uiManager.getActiveTool();
      const isTrackTool = tool.startsWith('rail') || tool === 'road';
      if (this.dragStartTile && isTrackTool && dragDist > 12) {
        this.isDraggingTrack = true;
      }

      this.updateHover();
    });

    // マウスアップで一括敷設ドラッグ確定（UI要素上で離された場合はドラッグを安全にキャンセル）
    window.addEventListener('mouseup', (e: MouseEvent) => {
      if (suppressNextMouseClick) return;
      const target = e.target as HTMLElement | null;
      const isOverUI = target ? !!target.closest('#build-toolbar, #tool-submenu, #rotation-hint, #station-length-selector, #floor-slicer, header, aside, .modal, .modal-backdrop, #mobile-action-dock, #minimap-container') : false;

      if (this.isDraggingTrack) {
        if (isOverUI) {
          // UIボタンやパネル上でマウスを離した場合はドラッグ確定を行わず破棄
          this.cancelPendingPlacements();
        } else {
          this.finishDragPlacement();
        }
        this.isDraggingTrack = false;
        this.dragStartTile = null;
        return;
      }
      this.dragStartTile = null;
    });

    // ⑤ 左クリックで設置・選択・撤去（単一クリックアクション）
    dom.addEventListener('click', (e) => {
      if (suppressNextMouseClick) return;
      if (hasDragged || this.isDraggingTrack) return;
      if (e.button !== 0) return;
      if (this.cameraManager.viewMode === 'cab_view') return;

      // クリック位置で確実に最新座標を更新してから処理
      this.inputController.updateMousePosition(e.clientX, e.clientY);
      this.updateHover();
      this.handleTileClick();
    });

    // ⑤ 右クリックで設置向きを回転（0-3を循環）
    dom.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (hasDragged || this.isDraggingTrack) return;
      if (this.cameraManager.viewMode === 'cab_view') return;

      const tool = this.uiManager.getActiveTool();
      if (this.deployingFleetId || ROTATABLE_TOOLS.includes(tool)) {
        this.rotateCurrentPlacement();
      }
    });

    // Escape で仮置き中のプレースメントを全てキャンセル / Enter で確定 / M で資金無限モード切替 / R で回転
    window.addEventListener('keydown', (e) => {
      // ① テキスト入力中（input/textarea等）のショートカット暴発を完全防止
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable)) {
        return;
      }

      if (e.key === 'r' || e.key === 'R') {
        const tool = this.uiManager.getActiveTool();
        if (this.deployingFleetId || ROTATABLE_TOOLS.includes(tool)) {
          this.rotateCurrentPlacement();
        }
      } else if (e.key === 'Escape') {
        if (this.dragGhostGroup) {
          this.renderer.scene.remove(this.dragGhostGroup);
          this.dragGhostGroup = null;
        }
        this.isDraggingTrack = false;
        this.dragStartTile = null;
        const hadPending = this.pendingItems.length > 0 || !!this.pendingTrainDeploy;
        this.cancelPendingPlacements();
        this.updateRotationHint(this.uiManager.getActiveTool());
        if (!hadPending) {
          this.uiManager.closeInspector();
        }
      } else if (e.key === 'Enter') {
        if (this.pendingTrainDeploy || this.pendingItems.length > 0) {
          this.confirmPendingPlacements();
        }
      } else if (e.key === 'm' || e.key === 'M') {
        this.toggleInfiniteFunds();
      } else if (e.key >= '0' && e.key <= '5') {
        // 数字キー 0〜5 で時間進行速度を即座に切り替え (0:停止, 1:等速, 2:3倍, 3:10倍, 4:超高速, 5:極超高速 12時間/秒)
        const speed = parseInt(e.key, 10);
        this.timeManager.setSpeedLevel(speed as SpeedLevel);
        this.uiManager.setSpeedUI(speed);
      } else if (e.key === 'd' || e.key === 'D') {
        // Shift+D: 分岐器・シーサスクロッシングダイヤ設定を即座に開く
        if (e.shiftKey) {
          const switchTile = this.worldMap.getAllTiles().find(t => t.type.startsWith('point_switch') || t.type.startsWith('scissors_crossing'));
          if (switchTile) {
            let target = switchTile;
            if (switchTile.type.startsWith('scissors_crossing')) {
              const orig = this.worldMap.resolveCrossingOrigin(switchTile.x, switchTile.z, switchTile.layer);
              if (orig) target = orig;
            }
            this.switchScheduleUI.open(target);
            return;
          }
        }

        // ダイヤ設定UIを開くショートカット（駅、分岐器、シーサスクロッシングに対応）
        if (this.selectedTilePos) {
          const t = this.worldMap.getTile(this.selectedTilePos.x, this.selectedTilePos.z, this.selectedTilePos.layer);
          if (t) {
            if (WorldMap.isStationTileType(t.type)) {
              this.scheduleUI.open(t);
              return;
            } else if (t.type.startsWith('point_switch')) {
              this.switchScheduleUI.open(t);
              return;
            } else if (t.type.startsWith('scissors_crossing')) {
              const orig = this.worldMap.resolveCrossingOrigin(t.x, t.z, this.selectedTilePos.layer);
              this.switchScheduleUI.open(orig || t);
              return;
            }
          }
        }
        // 未選択時はデフォルトの駅を開く
        const defaultStation = this.worldMap.getTile(-6, 0) || this.worldMap.getTile(5, 0);
        if (defaultStation) {
          this.scheduleUI.open(defaultStation);
        }
      }
    });
  }

  /**
   * ② 階層操作中に対応する地表座標・垂直関係を示す破線ガイドを更新
   */
  private updateGroundDashedGuide(tx: number, tz: number, groundY: number, currentY: number) {
    const half = WorldMap.TILE_SIZE / 2;
    const worldX = tx * WorldMap.TILE_SIZE;
    const worldZ = tz * WorldMap.TILE_SIZE;

    // 地表枠の位置設定（地表表面のわずか上）
    this.groundDashedLines.position.set(worldX, groundY + 0.04, worldZ);
    this.groundDashedLines.computeLineDistances();

    // 対象階層（地下・高架）枠の位置設定（対象階層表面のわずか上）
    this.targetDashedLines.position.set(worldX, currentY + 0.04, worldZ);
    this.targetDashedLines.computeLineDistances();

    // 4隅の垂直破線の頂点バッファを更新
    const dy = currentY - groundY;
    const posAttr = this.verticalDashedLines.geometry.getAttribute('position') as THREE.BufferAttribute;
    const array = posAttr.array as Float32Array;

    const corners = [
      [-half, -half],
      [half, -half],
      [half, half],
      [-half, half]
    ];

    let idx = 0;
    for (const [cx, cz] of corners) {
      // 地表側の点
      array[idx++] = worldX + cx;
      array[idx++] = groundY + 0.04;
      array[idx++] = worldZ + cz;
      // 現在階層側の点
      array[idx++] = worldX + cx;
      array[idx++] = groundY + 0.04 + dy;
      array[idx++] = worldZ + cz;
    }
    posAttr.needsUpdate = true;
    this.verticalDashedLines.computeLineDistances();
  }

  /**
   * 勾配線路（スロープ）設置時の立体ガイド:
   * 起点マス（下位階層）と終点マス（上位階層、4マス先）の接続位置を破線で明示
   */
  private updateSlopeDashedGuide(
    startTx: number,
    startTz: number,
    startY: number,
    endTx: number,
    endTz: number,
    endGroundY: number,
    endTargetY: number
  ) {
    const half = WorldMap.TILE_SIZE / 2;
    const startWorldX = startTx * WorldMap.TILE_SIZE;
    const startWorldZ = startTz * WorldMap.TILE_SIZE;
    const endWorldX = endTx * WorldMap.TILE_SIZE;
    const endWorldZ = endTz * WorldMap.TILE_SIZE;

    // 起点マス（地上側）の外周枠
    this.groundDashedLines.position.set(startWorldX, startY + 0.04, startWorldZ);
    this.groundDashedLines.computeLineDistances();

    // 終点マス（高架側、4マス先）の外周枠
    this.targetDashedLines.position.set(endWorldX, endTargetY + 0.04, endWorldZ);
    this.targetDashedLines.computeLineDistances();

    // 終点マスの4隅に、地表面から高架レベル（2F）まで立ち上がる垂直破線柱
    const dy = endTargetY - endGroundY;
    const posAttr = this.verticalDashedLines.geometry.getAttribute('position') as THREE.BufferAttribute;
    const array = posAttr.array as Float32Array;

    const corners = [
      [-half, -half],
      [half, -half],
      [half, half],
      [-half, half]
    ];

    let idx = 0;
    for (const [cx, cz] of corners) {
      // 終点の地表側の点
      array[idx++] = endWorldX + cx;
      array[idx++] = endGroundY + 0.04;
      array[idx++] = endWorldZ + cz;
      // 終点の高架側の点
      array[idx++] = endWorldX + cx;
      array[idx++] = endGroundY + 0.04 + dy;
      array[idx++] = endWorldZ + cz;
    }
    posAttr.needsUpdate = true;
    this.verticalDashedLines.computeLineDistances();
  }

  private updateHover() {
    const intersect = this.inputController.getGridIntersection(
      this.worldMap.gridSize,
      (x, z) => this.worldMap.getElevationOffset(x, z)
    );

    if (intersect && intersect.isValidTile) {
      const tx = intersect.tileX;
      const tz = intersect.tileZ;
      this.hoveredTile = { x: tx, z: tz };
      const tool = this.uiManager.getActiveTool();

      // 地表面の実際の標高高さ
      const groundElevY = this.worldMap.getElevationOffset(tx, tz);

      // アクティブ階層の基準高さ
      const activeLayer = this.worldMap.activeLayer;
      const baseHeight = layerToHeight(activeLayer);

      // トンネル区間判定: 地下階層、または山岳地表より下の階層、またはトンネルツール
      // ※ 駅・信号場・貨物駅は山岳トンネル地中埋没の対象外とし、地上1Fなら山岳地表高さを反映
      const isStationTool = tool === 'station-small' || tool === 'station-elevated' || tool === 'signal-yard' || tool === 'cargo-station';
      const isTunnelSection = !isStationTool && (this.worldMap.isTunnelSection(tx, tz, activeLayer) || tool === 'rail-tunnel');

      // スライサー階層の操作面高さ:
      // 高架駅ツール選択時にスライサー1Fの場合は2F高さ(3m)に合わせる
      let effectiveBaseHeight = baseHeight;
      if (tool === 'station-elevated' && activeLayer === 1) {
        effectiveBaseHeight = layerToHeight(2);
      }
      const elevOffset = (activeLayer === 1 && !isTunnelSection && tool !== 'station-elevated') ? groundElevY : 0;
      const finalY = effectiveBaseHeight + elevOffset;

      this.hoverPlane.position.set(tx * WorldMap.TILE_SIZE, finalY + 0.05, tz * WorldMap.TILE_SIZE);
      this.hoverPlane.visible = true;
      const mat = this.hoverPlane.material as THREE.MeshBasicMaterial;
      mat.color.set(tool.startsWith('demolish') ? 0xf43f5e : 0x38bdf8);

      // ② 破線ガイドの表示条件:
      if (tool === 'rail-slope') {
        // 通常勾配線路（4マス上り）: 起点と終点（直上階層接続端）の双方に立体破線ガイド枠を表示し、上り先の位置関係を明示
        const axisVal = this.currentRotation % 2;
        const reversed = this.currentRotation >= 2;
        const axisDirs: [number, number] = axisVal === 1 ? [1, 3] : [0, 2];
        const [, highIdx] = reversed ? [axisDirs[1], axisDirs[0]] : [axisDirs[0], axisDirs[1]];
        const stepDir = WorldMap.DIRS[highIdx];
        const endTx = tx + stepDir.x * 3;
        const endTz = tz + stepDir.z * 3;
        const endGroundElevY = this.worldMap.getElevationOffset(endTx, endTz);
        const endUpperLayer = (activeLayer + 1) as GridLayer;
        const endUpperHeight = layerToHeight(endUpperLayer, groundElevY);

        this.updateSlopeDashedGuide(tx, tz, finalY, endTx, endTz, endGroundElevY, endUpperHeight);
        this.groundDashedGuide.visible = true;
      } else if (Math.abs(groundElevY - finalY) > 0.05) {
        this.updateGroundDashedGuide(tx, tz, groundElevY, finalY);
        this.groundDashedGuide.visible = true;
      } else {
        this.groundDashedGuide.visible = false;
      }

      // 駅ツール選択中のホバーゴースト追従
      if (isStationTool) {
        this.updateHoverStationGhost(tx, tz);
      } else {
        this.clearHoverStationGhost();
      }

      // 列車配置モード中のホバーゴースト追従
      if (this.deployingFleetId && !this.pendingTrainDeploy) {
        this.updateHoverTrainGhost(tx, tz);
      }

      // ドラッグ延伸中ならプレビューゴーストを動的生成・更新
      if (this.isDraggingTrack && this.dragStartTile) {
        this.updateDragPreview(this.dragStartTile, { x: tx, z: tz });
      }

      return;
    }

    this.hoverPlane.visible = false;
    this.groundDashedGuide.visible = false;
    this.hoveredTile = null;
    this.clearHoverStationGhost();
    if (this.deployingFleetId && !this.pendingTrainDeploy) {
      this.clearHoverTrainGhost();
    }
  }

  /**
   * ① マウス位置にある列車編成をレイキャストで検出する（select / demolish で使用）
   */
  private raycastTrain() {
    this.raycaster.setFromCamera(this.mousePos, this.cameraManager.activeCamera);
    let closest: { train: ReturnType<TrainManager['getTrains']>[number]; dist: number } | null = null;
    for (const train of this.trainManager.getTrains()) {
      const hits = this.raycaster.intersectObject(train.mesh, true);
      if (hits.length > 0 && (!closest || hits[0].distance < closest.dist)) {
        closest = { train, dist: hits[0].distance };
      }
    }
    return closest ? closest.train : null;
  }

  // ---------------------------------------------------------------------
  // ⑥ 仮置き（プレースメント・ゴースト）フロー：複数マスをまとめて仮置きし、最後に一括確定する
  // ---------------------------------------------------------------------

  /**
   * 現在のツール・向きに応じたプレビュー用メッシュ（半透明ゴースト）を生成する。
   * 分岐器・シーサスクロッシング・勾配は複数マスにまたがるため、実際の設置と同じレイアウトを
   * 起点タイルからの相対オフセットで組み立てたグループとして返す。
   */
  private createGhostMesh(
    tool: ActiveTool,
    rotation: number,
    stationPart: 'single' | 'start' | 'mid' | 'end' = 'single',
    branchSide: 'left' | 'right' = this.currentSwitchSide,
    platformSide: 'left' | 'right' = this.currentStationSide,
    layer: GridLayer = this.worldMap.activeLayer,
    x?: number,
    z?: number
  ): THREE.Object3D | null {
    let effectiveTool = this.resolveAutoToolForLayer(tool, layer);
    const isTunnelSec = (x !== undefined && z !== undefined)
      ? this.worldMap.isTunnelSection(x, z, layer)
      : (layer < 0 || tool === 'rail-tunnel');

    if (isTunnelSec && (tool === 'rail-straight' || tool === 'rail-tunnel')) {
      effectiveTool = 'rail-tunnel';
    }
    const axis = rotation % 2;
    const baseH = layerToHeight(layer);
    let mesh: THREE.Group | null = null;

    switch (effectiveTool) {
      case 'rail-straight':
        mesh = ModelFactory.createGroundTrack(axis, false);
        break;
      case 'rail-tunnel':
        mesh = ModelFactory.createTunnelTrack(axis);
        break;
      case 'rail-elevated':
        mesh = ModelFactory.createElevatedTrack(axis, true, baseH);
        break;
      case 'rail-curve':
        mesh = ModelFactory.createCurveTrackSegment(CURVE_DIR_ORDER[rotation], false, 3.0, isTunnelSec);
        break;
      case 'rail-curve-elevated':
        mesh = ModelFactory.createCurveTrackSegment(CURVE_DIR_ORDER[rotation], true, baseH, false);
        break;
      case 'rail-slope':
        mesh = this.createSlopeGhostGroup(axis, rotation >= 2);
        break;
      case 'rail-slope-underground':
        mesh = this.createUndergroundSlopeGhostGroup(axis, rotation >= 2);
        break;
      case 'point-switch':
        mesh = ModelFactory.createSwitchHub(rotation, false, false, branchSide, 3.0, isTunnelSec);
        break;
      case 'point-switch-elevated':
        mesh = ModelFactory.createSwitchHub(rotation, false, true, branchSide, baseH, false);
        break;
      case 'scissors-crossing':
        mesh = this.createScissorsGhostGroup(rotation, false, 3.0, isTunnelSec);
        break;
      case 'scissors-crossing-elevated':
        mesh = this.createScissorsGhostGroup(rotation, true, baseH, false);
        break;
      case 'station-small':
        mesh = ModelFactory.createStation(axis, false, stationPart, platformSide);
        break;
      case 'station-elevated':
        mesh = ModelFactory.createStation(axis, true, stationPart, platformSide, '駅', baseH);
        break;
      case 'signal-yard':
        mesh = ModelFactory.createSignalYard(axis, layer >= 2, platformSide, baseH);
        break;
      case 'cargo-station':
        mesh = ModelFactory.createCargoStation(axis, layer >= 2, platformSide, baseH);
        break;
      case 'road':
        mesh = ModelFactory.createRoad(axis);
        break;
      case 'building-res':
        mesh = ModelFactory.createHouse(0);
        break;
      case 'building-com':
        mesh = ModelFactory.createCommercialBuilding(3);
        break;
      case 'building-ind':
        mesh = ModelFactory.createIndustrialBuilding(1);
        break;
      case 'nature':
        mesh = ModelFactory.createTree();
        break;
      default:
        return null;
    }

    if (!mesh) return null;

    const isTunnel = isTunnelSec || effectiveTool === 'rail-tunnel' || effectiveTool === 'rail-slope-underground' || layer < 0;
    mesh.traverse(obj => {
      const m = obj as THREE.Mesh;
      if ((m as any).isMesh) {
        m.material = isTunnel ? this.tunnelGhostMaterial : this.ghostMaterial;
        m.castShadow = false;
        m.receiveShadow = false;
        if (isTunnel) {
          m.renderOrder = 999;
        }
      }
    });

    return mesh;
  }

  /**
   * 勾配(4×1)ゴースト。WorldMap.placeSlope と同じレイアウト計算で4パーツを並べる。
   */
  private createSlopeGhostGroup(rotation: number, reversed: boolean): THREE.Group {
    const group = new THREE.Group();
    const axis: [number, number] = rotation === 1 ? [1, 3] : [0, 2];
    const [, highIdx] = reversed ? [axis[1], axis[0]] : [axis[0], axis[1]];
    const stepDir = WorldMap.DIRS[highIdx];

    for (let i = 0; i < 4; i++) {
      const part = ModelFactory.createSlopeTrackPart(rotation, reversed, i);
      part.position.set(stepDir.x * i * WorldMap.TILE_SIZE, 0, stepDir.z * i * WorldMap.TILE_SIZE);
      group.add(part);
    }
    return group;
  }

  /**
   * 地下勾配(4×1)ゴースト。WorldMap.placeUndergroundSlope と同じレイアウト計算で4パーツを並べる。
   */
  private createUndergroundSlopeGhostGroup(rotation: number, reversed: boolean): THREE.Group {
    const group = new THREE.Group();
    const axis: [number, number] = rotation === 1 ? [1, 3] : [0, 2];
    const [, downIdx] = reversed ? [axis[1], axis[0]] : [axis[0], axis[1]];
    const stepDir = WorldMap.DIRS[downIdx];

    for (let i = 0; i < 4; i++) {
      const part = ModelFactory.createUndergroundSlopeTrackPart(rotation, reversed, i);
      part.position.set(stepDir.x * i * WorldMap.TILE_SIZE, 0, stepDir.z * i * WorldMap.TILE_SIZE);
      group.add(part);
    }
    return group;
  }

  /**
   * ③ シーサスクロッシング(2×2)ゴースト。WorldMap.placeScissorsCrossing と同じレイアウトで4パーツを並べる。
   */
  private createScissorsGhostGroup(rotation: number, isElevated: boolean, pierHeight: number = 3.0, isTunnel: boolean = false): THREE.Group {
    const group = new THREE.Group();
    const along = rotation === 1 ? 1 : 2;
    const across = WorldMap.rotateCW(along);
    const alongVec = WorldMap.DIRS[along];
    const acrossVec = WorldMap.DIRS[across];

    const offsets: { x: number; z: number; role: 0 | 1 | 2 | 3 }[] = [
      { x: 0, z: 0, role: 0 },
      { x: alongVec.x, z: alongVec.z, role: 1 },
      { x: acrossVec.x, z: acrossVec.z, role: 2 },
      { x: alongVec.x + acrossVec.x, z: alongVec.z + acrossVec.z, role: 3 }
    ];

    for (const o of offsets) {
      const part = ModelFactory.createScissorsCrossingTile(along, o.role, isElevated, 'straight', pierHeight, isTunnel);
      part.position.set(o.x * WorldMap.TILE_SIZE, 0, o.z * WorldMap.TILE_SIZE);
      group.add(part);
    }
    return group;
  }

  /**
   * ⑥ 指定した仮置きアイテムのゴーストを（再）生成する
   */
  private refreshGhostFor(item: PendingItem) {
    if (item.ghost) {
      this.renderer.scene.remove(item.ghost);
      disposeHierarchy(item.ghost);
      item.ghost = null;
    }
    const targetLayer = item.layer ?? this.worldMap.activeLayer;
    const branchSide = item.switchBranchSide ?? this.currentSwitchSide;
    const platformSide = item.stationPlatformSide ?? this.currentStationSide;
    const ghost = this.createGhostMesh(item.tool, item.rotation, item.stationPart ?? 'single', branchSide, platformSide, targetLayer, item.x, item.z);
    if (ghost) {
      const baseHeight = layerToHeight(targetLayer);
      const isStationOrYard = item.tool === 'station-small' || item.tool === 'station-elevated' || item.tool === 'signal-yard' || item.tool === 'cargo-station';
      const isTunnel = !isStationOrYard && (this.worldMap.isTunnelSection(item.x, item.z, targetLayer) || item.tool === 'rail-tunnel');
      const elevY = (targetLayer === 1 && !isTunnel) ? this.worldMap.getElevationOffset(item.x, item.z) : 0;
      ghost.position.set(item.x * WorldMap.TILE_SIZE, baseHeight + elevY, item.z * WorldMap.TILE_SIZE);
      this.renderer.scene.add(ghost);
    }
    item.ghost = ghost;
  }

  /**
   * 列車仮配置・ホバープレビュー用ゴーストメッシュの生成
   */
  private createTrainGhost(
    model: VehicleModelInfo,
    carCount: number,
    dirIdx: number,
    targetTileX: number,
    targetTileZ: number,
    layer?: GridLayer
  ): THREE.Group {
    const { group, cars } = ModelFactory.createTrainFormation(model, carCount);

    // マテリアルを半透明化（実車のディテールや前後・コンテナ色を保持しつつ透明表示）
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        if (Array.isArray(mesh.material)) {
          mesh.material = mesh.material.map(m => {
            const clone = m.clone();
            clone.transparent = true;
            clone.opacity = 0.72;
            return clone;
          });
        } else if (mesh.material) {
          const clone = mesh.material.clone();
          clone.transparent = true;
          clone.opacity = 0.72;
          mesh.material = clone;
        }
      }
    });

    // タイルの標高・高さ
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

    // 先頭車から後方へ各車両を配置
    cars.forEach((car, i) => {
      car.rotation.order = 'YXZ';
      car.position.copy(headPos).addScaledVector(dir, -i * ModelFactory.CAR_SPACING);
      car.rotation.set(0, yaw, 0);
    });

    // 進行方向を示すガイド矢印（先頭車前方上部に表示）
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
   * 列車配置モード中のホバーカーソル追従プレビューゴースト更新
   */
  private updateHoverTrainGhost(x: number, z: number) {
    if (!this.deployingFleetId || this.pendingTrainDeploy) {
      this.clearHoverTrainGhost();
      return;
    }

    const layer = this.worldMap.activeLayer;
    const tile = this.worldMap.getTile(x, z, layer);
    if (!tile || !isTrackLikeType(tile.type)) {
      this.clearHoverTrainGhost();
      return;
    }

    const item = this.fleetRegistry.find(f => f.id === this.deployingFleetId);
    if (!item) {
      this.clearHoverTrainGhost();
      return;
    }

    this.clearHoverTrainGhost();

    // タイルの出口に合わせた向き決定
    const exits = WorldMap.getTileExits(tile);
    let dirIdx = this.deployDirectionIdx;
    if (exits.length > 0 && !exits.some(e => e.idx === dirIdx)) {
      dirIdx = exits[0].idx;
    }

    const ghost = this.createTrainGhost(item.model, item.cars, dirIdx, x, z, layer);
    this.renderer.scene.add(ghost);
    this.hoverTrainGhost = ghost;
  }

  /**
   * ホバー追従列車ゴーストの消去
   */
  private clearHoverTrainGhost() {
    if (this.hoverTrainGhost) {
      this.renderer.scene.remove(this.hoverTrainGhost);
      disposeHierarchy(this.hoverTrainGhost);
      this.hoverTrainGhost = null;
    }
  }

  /**
   * 駅・信号場・貨物駅のホバー追従プレビューゴースト更新
   */
  private updateHoverStationGhost(x: number, z: number) {
    const tool = this.uiManager.getActiveTool();
    const isStationOrYard = tool === 'station-small' || tool === 'station-elevated' || tool === 'signal-yard' || tool === 'cargo-station';
    if (!isStationOrYard || this.pendingItems.length > 0) {
      this.clearHoverStationGhost();
      return;
    }

    let targetLayer: GridLayer = this.worldMap.activeLayer;
    if (tool === 'station-elevated' && targetLayer === 1) {
      targetLayer = 2;
    }

    // マウス直下のマスに直線線路があれば、その線路の向きを引き継ぐ
    const hoverTile = this.worldMap.getTile(x, z, targetLayer);
    let rot = this.currentRotation;
    if (hoverTile && (hoverTile.type === 'rail_ground' || hoverTile.type === 'rail_elevated')) {
      rot = hoverTile.rotation;
    }

    const len = this.currentStationLength;
    const side = this.currentStationSide;
    const cacheKey = `${tool}_${x}_${z}_${len}_${rot}_${side}_${targetLayer}`;
    if (this.hoverStationGhost && this.hoverStationCacheKey === cacheKey) {
      return;
    }

    this.clearHoverStationGhost();

    const group = new THREE.Group();
    const axis = rot % 2;
    const stepX = axis === 1 ? 1 : 0;
    const stepZ = axis === 1 ? 0 : 1;
    const baseHeight = layerToHeight(targetLayer);

    for (let i = 0; i < len; i++) {
      const tx = x + stepX * i;
      const tz = z + stepZ * i;
      const part = (len === 1) ? 'single' : (i === 0 ? 'start' : (i === len - 1 ? 'end' : 'mid'));
      const mesh = this.createGhostMesh(tool, rot, part, this.currentSwitchSide, side, targetLayer, tx, tz);
      if (mesh) {
        const elevY = (targetLayer === 1) ? this.worldMap.getElevationOffset(tx, tz) : 0;
        mesh.position.set(stepX * i * WorldMap.TILE_SIZE, elevY, stepZ * i * WorldMap.TILE_SIZE);
        group.add(mesh);
      }
    }

    group.position.set(x * WorldMap.TILE_SIZE, baseHeight, z * WorldMap.TILE_SIZE);
    this.renderer.scene.add(group);
    this.hoverStationGhost = group;
    this.hoverStationCacheKey = cacheKey;
  }

  /**
   * ホバー追従駅ゴーストの消去
   */
  private clearHoverStationGhost() {
    if (this.hoverStationGhost) {
      this.renderer.scene.remove(this.hoverStationGhost);
      disposeHierarchy(this.hoverStationGhost);
      this.hoverStationGhost = null;
      this.hoverStationCacheKey = '';
    }
  }

  private cancelPendingPlacements() {
    for (const item of this.pendingItems) {
      if (item.ghost) {
        this.renderer.scene.remove(item.ghost);
        disposeHierarchy(item.ghost);
      }
    }
    this.pendingItems = [];

    if (this.pendingTrainDeploy) {
      this.renderer.scene.remove(this.pendingTrainDeploy.ghost);
      disposeHierarchy(this.pendingTrainDeploy.ghost);
      this.pendingTrainDeploy = null;
    }
    this.clearHoverTrainGhost();
    this.clearHoverStationGhost();

    if (this.dragGhostGroup) {
      this.renderer.scene.remove(this.dragGhostGroup);
      disposeHierarchy(this.dragGhostGroup);
      this.dragGhostGroup = null;
    }
    this.dragCurrentSegments = [];
    this.isDraggingTrack = false;
    this.dragStartTile = null;
    this.mobileDragStartTile = null;

    if (this.deployingFleetId) {
      this.deployingFleetId = null;
    }

    this.hoverPlane.visible = false;
    this.groundDashedGuide.visible = false;
    this.hoveredTile = null;
    this.uiManager.setRotationHint(false);
    this.uiManager.setPlacementButtonsVisible(false);
  }

  /**
   * ⑥ 仮置きを追加する（まだワールドには反映しない・課金しない）。
   * 駅ツールの場合は、選択された有効長（1〜4両）に応じて複数マスを一括して仮置きする。
   * 既に同じ位置に仮置き済みなら、その1件（または駅グループ）を取り消す（トグル）。
   */
  private stagePendingPlacement(tool: ActiveTool, x: number, z: number) {
    // 最新の在線情報をポーズ中であっても同期
    this.trainManager.updateOccupancyNow();

    // 資金赤字時の追加投資ガード
    if (!this.economy.canInvest) {
      this.uiManager.showToast('追加投資制限中', '資金が赤字のため、新規の線路敷設・建築は行えません。（資金が黒字化すると自動解除されます）', 'warning');
      return;
    }

    // 鉄道・駅・道路インフラツール判定（線路・分岐器・クロス・駅・貨物駅・信号場・道路）
    const isInfrastructureTool = (t: ActiveTool | string) => {
      return (
        t.startsWith('rail') ||
        t.startsWith('point-switch') ||
        t.startsWith('scissors-crossing') ||
        t.startsWith('station') ||
        t.startsWith('cargo-station') ||
        t === 'signal-yard' ||
        t === 'road'
      );
    };

    let curLayer: GridLayer = this.worldMap.activeLayer;
    // 高架駅ツール選択時にスライサーが地上1Fの場合、自動的に地上2F（高架階層）として扱う
    if (tool === 'station-elevated' && curLayer === 1) {
      curLayer = 2;
    }
    // 通常勾配線路は下位階層から直上階層へ上るスロープ（1F〜4Fから敷設可能、最上階5Fのみ不可）
    if (tool === 'rail-slope') {
      if (curLayer >= 5) {
        this.uiManager.showToast('敷設不可', '5Fからは上り勾配線路を敷設できません（4F以下をご利用ください）。', 'warning');
        return;
      }
      if (curLayer < 0) {
        curLayer = 1;
      }
    }
    // 地下勾配線路は地上1Fから地下B1Fへの下りスロープ専用（地上1Fからのみ敷設可能）
    if (tool === 'rail-slope-underground') {
      if (curLayer !== 1) {
        this.uiManager.showToast('敷設不可', '地下勾配線路は地上1Fから地下B1Fへの接続専用です。地上1Fでご利用ください。', 'warning');
        return;
      }
    }
    let effectiveTool = this.resolveAutoToolForLayer(tool, curLayer);
    // 山岳地帯などで地表標高より低い階層の場合、直線線路は自動的にトンネルとして扱う
    if ((tool === 'rail-straight' || tool === 'rail-tunnel') && this.worldMap.isTunnelSection(x, z, curLayer)) {
      effectiveTool = 'rail-tunnel';
    }

    const isStationOrYard = effectiveTool === 'station-small' || effectiveTool === 'station-elevated' || effectiveTool === 'signal-yard' || effectiveTool === 'cargo-station';
    if (isStationOrYard) {
      // マウス直下のマスに直線線路があれば、その線路の向きを引き継ぐ（オプションパーツとして設置）
      const baseTrackTile = this.worldMap.getTile(x, z, curLayer);
      let stationRot = this.currentRotation;
      if (baseTrackTile && (baseTrackTile.type === 'rail_ground' || baseTrackTile.type === 'rail_elevated')) {
        stationRot = baseTrackTile.rotation;
      }
      const len = this.currentStationLength;
      const axis = stationRot % 2;
      const stepX = axis === 1 ? 1 : 0;
      const stepZ = axis === 1 ? 0 : 1;

      // 水辺敷設制約: 地上1Fは水面のため敷設不可、2F以上高架駅または地下駅は敷設可
      for (let i = 0; i < len; i++) {
        const tx = x + stepX * i;
        const tz = z + stepZ * i;
        const waterCheck = this.worldMap.canPlaceAtWater(tx, tz, curLayer);
        if (!waterCheck.allowed) {
          alert(waterCheck.reason || '水上（地上1F）には駅・信号場を設置できません。地上2F以上の高架、または地下をご利用ください。');
          return;
        }
      }

      // 既存グループ（x, z 付近）があればトグル解除
      const existingIdx = this.pendingItems.findIndex(p => p.tool === effectiveTool && p.x === x && p.z === z && (p.layer ?? 1) === curLayer);
      if (existingIdx !== -1) {
        // 同じ駅・信号場グループ（連続するアイテム）をまとめて解除
        const originItem = this.pendingItems[existingIdx];
        const toRemove = this.pendingItems.filter(p => {
          return p.tool === effectiveTool && (
            (originItem.stationGroupId && p.stationGroupId === originItem.stationGroupId) ||
            (Math.abs(p.x - originItem.x) <= 10 && Math.abs(p.z - originItem.z) <= 10)
          ) && (p.layer ?? 1) === curLayer;
        });
        for (const rem of toRemove) {
          if (rem.ghost) this.renderer.scene.remove(rem.ghost);
        }
        this.pendingItems = this.pendingItems.filter(p => !toRemove.includes(p));
        this.uiManager.setPlacementButtonsVisible(this.pendingItems.length > 0);
        this.updateRotationHint(tool);
        if (this.pendingItems.length === 0 && this.hoveredTile) {
          this.updateHoverStationGhost(this.hoveredTile.x, this.hoveredTile.z);
        }
        return;
      }

      // ① 本設置済みの線路・駅・障害物、および仮置き中インフラへの誤上書きを防止
      for (let i = 0; i < len; i++) {
        const tx = x + stepX * i;
        const tz = z + stepZ * i;
        if (!this.worldMap.isInBounds(tx, tz)) {
          this.uiManager.showToast('設置不可', 'マップ外には設置できません。', 'warning');
          return;
        }
        const existingTile = this.worldMap.getTile(tx, tz, curLayer);
        // 【要件③】直線線路が存在する場合は、駅舎・ホーム・コンテナをオプションパーツとしてアタッチ可能
        const isCompatibleTrack = existingTile && (existingTile.type === 'rail_ground' || existingTile.type === 'rail_elevated') && (existingTile.rotation === axis);
        if (existingTile && existingTile.type !== 'empty' && !isCompatibleTrack) {
          this.uiManager.showToast('設置不可', '既存の施設や曲線・分岐レールと重なる位置には駅を設置できません。', 'warning');
          return;
        }
        if (this.pendingItems.some(p => p.x === tx && p.z === tz && (p.layer ?? 1) === curLayer)) {
          this.uiManager.showToast('設置不可', 'すでに仮置きされている線路や施設と重なる位置には設置できません。', 'warning');
          return; // 仮置き済みインフラがあるため仮置き不可
        }
        if (this.trainManager.isTileOccupiedByTrain(tx, tz, curLayer)) {
          this.uiManager.showToast('設置不可', '列車が走行・停車中の位置には設置できません。', 'warning');
          return;
        }
        const waterCheck = this.worldMap.canPlaceAtWater(tx, tz, curLayer);
        if (!waterCheck.allowed) {
          this.uiManager.showToast('設置不可', waterCheck.reason || '水上には駅を設置できません。', 'warning');
          return;
        }
      }

      // ④ 指定有効長分（1〜10マス）のホーム・信号場・貨物駅をまとめて仮置き
      const groupId = effectiveTool === 'cargo-station'
        ? `cargo_${Date.now()}_${x}_${z}`
        : (effectiveTool === 'signal-yard' ? `yard_${Date.now()}_${x}_${z}` : `st_${Date.now()}_${x}_${z}`);
      for (let i = 0; i < len; i++) {
        const tx = x + stepX * i;
        const tz = z + stepZ * i;
        const part = (len === 1) ? 'single' : (i === 0 ? 'start' : (i === len - 1 ? 'end' : 'mid'));
        const item: PendingItem = {
          tool: effectiveTool,
          x: tx,
          z: tz,
          layer: curLayer,
          rotation: stationRot,
          ghost: null,
          stationPart: part,
          stationGroupId: groupId,
          stationPlatformSide: this.currentStationSide
        };
        this.pendingItems.push(item);
        this.refreshGhostFor(item);
      }
      this.clearHoverStationGhost();
      this.uiManager.setPlacementButtonsVisible(true);
      this.updateRotationHint(tool);
      return;
    }

    const existingIdx = this.pendingItems.findIndex(p => p.tool === effectiveTool && p.x === x && p.z === z && (p.layer ?? 1) === curLayer);
    if (existingIdx !== -1) {
      const [removed] = this.pendingItems.splice(existingIdx, 1);
      if (removed.ghost) this.renderer.scene.remove(removed.ghost);
      this.uiManager.setPlacementButtonsVisible(this.pendingItems.length > 0);
      this.updateRotationHint(tool);
      return;
    }

    // 水辺敷設制約: 地上1Fは水面のため敷設不可、2F以上高架または地下トンネルは敷設可
    const waterCheck = this.worldMap.canPlaceAtWater(x, z, curLayer);
    if (!waterCheck.allowed) {
      alert(waterCheck.reason || '水上（地上1F）には敷設できません。地上2F以上の高架橋梁、または地下トンネルをご利用ください。');
      return;
    }

    // 建物（住宅・商業・自然などの一般建築物）は水上には全階層で敷設不可（高架駅・地下駅・橋梁線路は水上可能）
    if (this.gridManager.isWaterAtGroundLevel(x, z) && !isInfrastructureTool(effectiveTool)) {
      alert('水上には建物を設置できません。');
      return;
    }

    // 山岳・丘陵地（標高差のある場所）への地下潜入スロープ敷設禁止（高度ギャップ防止）
    if (curLayer === 1 && effectiveTool === 'rail-slope-underground') {
      const axisVal = this.currentRotation % 2;
      const reversed = this.currentRotation >= 2;
      const axisDirs: [number, number] = axisVal === 1 ? [1, 3] : [0, 2];
      const [, stepIdx] = reversed ? [axisDirs[1], axisDirs[0]] : [axisDirs[0], axisDirs[1]];
      const stepDir = WorldMap.DIRS[stepIdx];
      for (let i = 0; i < 4; i++) {
        const tx = x + stepDir.x * i;
        const tz = z + stepDir.z * i;
        if (this.worldMap.getElevationOffset(tx, tz) > 0) {
          alert('山岳・丘陵地帯（標高の高い場所）には地下潜入スロープを敷設できません。平坦な平地（地上1F）をご利用ください。');
          return;
        }
      }
    }

    // ① 既に仮置き中のアイテム（別ツール）との重複を防止
    const pendingConflict = this.pendingItems.find(p => p.x === x && p.z === z && (p.layer ?? 1) === curLayer);
    if (pendingConflict) {
      this.uiManager.showToast('仮置き不可', 'すでに別の線路や施設が仮置きされています。', 'warning');
      return;
    }

    // ② 本設置済みの線路・駅への誤上書きを防止
    if (this.worldMap.isPermanentTrackOrStation(x, z, curLayer)) {
      this.uiManager.showToast('設置不可', '線路や駅が存在する位置には設置できません。', 'warning');
      return; // 本設置済みインフラがあるため仮置き不可
    }

    // ③ 建物や自然などの施設は既存タイル（道路や既存建物など）の上には仮置き不可
    const existingTile = this.worldMap.getTile(x, z, curLayer);
    if (existingTile && existingTile.type !== 'empty' && !isInfrastructureTool(effectiveTool)) {
      this.uiManager.showToast('設置不可', '既存の施設や道路が存在する位置には設置できません。', 'warning');
      return;
    }

    // 【工業ゾーン限定】工業建物は工業エリアにゾーニングされた区画にのみ配置可能
    if (effectiveTool === 'building-ind') {
      const zoneHere = this.zoneManager.getZone(x, z);
      if (!zoneHere || zoneHere.type !== 'industrial') {
        alert('工業施設は、工業ゾーン（黄色）に指定された区画にのみ建設できます。');
        return;
      }
    }

    const item: PendingItem = {
      tool: effectiveTool,
      x,
      z,
      layer: curLayer,
      rotation: this.currentRotation,
      ghost: null,
      switchBranchSide: effectiveTool.startsWith('point-switch') ? this.currentSwitchSide : undefined
    };
    this.pendingItems.push(item);
    this.refreshGhostFor(item);
    this.uiManager.setPlacementButtonsVisible(true);
    this.updateRotationHint(tool);
  }

  /**
   * ⑥⑦ 仮置き中の全アイテムを「設置を決定」ボタンでまとめて確定する。
   * 所持金の判定はここで一括して行い（合計金額が足りなければ何も設置しない）、
   * 足りていれば全アイテムを一括で本設置する。
   */
  private confirmPendingPlacements() {
    // 列車仮配置の確定
    if (this.pendingTrainDeploy) {
      const { fleetId, x, z, layer, directionIdx, ghost } = this.pendingTrainDeploy;
      this.renderer.scene.remove(ghost);
      disposeHierarchy(ghost);
      const item = this.fleetRegistry.find(f => f.id === fleetId);
      if (item) {
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
          alert(`🚅 【${item.name}】が線路に配置され、営業運行を開始しました！`);
        } else {
          alert('配置に失敗しました。線路の接続や方向をご確認ください。');
        }
      }
      this.pendingTrainDeploy = null;
      this.deployingFleetId = null;
      this.uiManager.setPlacementButtonsVisible(false);
      this.uiManager.setRotationHint(false);
      this.updateRotationHint(this.uiManager.getActiveTool());
      return;
    }

    if (this.pendingItems.length === 0) return;

    // 最新の在線情報を同期
    this.trainManager.updateOccupancyNow();

    const items = this.pendingItems;
    const total = items.reduce((sum, it) => sum + TOOL_CONFIG[it.tool].cost, 0);

    if (!this.economy.spendFunds(total, true)) {
      alert(`資金が不足しています！(必要: ¥${total.toLocaleString()})`);
      return;
    }

    // 駅・信号場・貨物駅グループの All-or-Nothing 事前一括検証
    const invalidStationGroupIds = new Set<string>();
    const stationGroupsInPending = new Map<string, PendingItem[]>();

    for (const item of items) {
      if (item.stationGroupId) {
        if (!stationGroupsInPending.has(item.stationGroupId)) {
          stationGroupsInPending.set(item.stationGroupId, []);
        }
        stationGroupsInPending.get(item.stationGroupId)!.push(item);
      }
    }

    for (const [groupId, groupItems] of stationGroupsInPending.entries()) {
      for (const it of groupItems) {
        const lyr = (it.layer ?? this.worldMap.activeLayer) as GridLayer;
        if (!this.worldMap.isInBounds(it.x, it.z)) {
          invalidStationGroupIds.add(groupId);
          break;
        }
        const existingTile = this.worldMap.getTile(it.x, it.z, lyr);
        const isCompatibleTrack = existingTile && (existingTile.type === 'rail_ground' || existingTile.type === 'rail_elevated') && (existingTile.rotation === (it.rotation % 2));
        if (existingTile && existingTile.type !== 'empty' && !isCompatibleTrack) {
          invalidStationGroupIds.add(groupId);
          break;
        }
        if (this.trainManager.isTileOccupiedByTrain(it.x, it.z, lyr)) {
          invalidStationGroupIds.add(groupId);
          break;
        }
        const waterCheck = this.worldMap.canPlaceAtWater(it.x, it.z, lyr);
        if (!waterCheck.allowed) {
          invalidStationGroupIds.add(groupId);
          break;
        }
      }
    }

    let placedCount = 0;
    let refund = 0;
    const successfullyPlacedItems: PendingItem[] = [];

    for (const item of items) {
      // 事前検証で弾かれた駅グループは1マスも配置せず全額返金（All-or-Nothing）
      if (item.stationGroupId && invalidStationGroupIds.has(item.stationGroupId)) {
        refund += TOOL_CONFIG[item.tool].cost;
        continue;
      }

      const ok = this.executePlacement(
        item.tool,
        item.x,
        item.z,
        item.rotation,
        item.switchBranchSide,
        item.stationPart,
        item.stationGroupId,
        item.stationPlatformSide,
        item.layer ?? this.worldMap.activeLayer
      );
      if (ok) {
        placedCount++;
        successfullyPlacedItems.push(item);
      } else {
        refund += TOOL_CONFIG[item.tool].cost;
        // 駅グループの途中で万が一失敗した場合は、既に置かれた同グループのマスをロールバック
        if (item.stationGroupId) {
          const groupId = item.stationGroupId;
          const placedInGroup = successfullyPlacedItems.filter(p => p.stationGroupId === groupId);
          for (const p of placedInGroup) {
            const pLyr = (p.layer ?? this.worldMap.activeLayer) as GridLayer;
            this.worldMap.setTile(p.x, p.z, 'empty', 0, 1, 'right', pLyr);
            refund += TOOL_CONFIG[p.tool].cost;
            placedCount--;
          }
          for (let i = successfullyPlacedItems.length - 1; i >= 0; i--) {
            if (successfullyPlacedItems[i].stationGroupId === groupId) {
              successfullyPlacedItems.splice(i, 1);
            }
          }
          invalidStationGroupIds.add(groupId);
        }
      }
    }

    if (invalidStationGroupIds.size > 0) {
      this.uiManager.showToast('駅設置不可', '線路や他の駅・障害物と重なっているため、駅の設置を中止しました（全額返金）。', 'danger');
    }

    if (refund > 0) {
      this.economy.spendFunds(-refund, true); // 設置に失敗した分だけ返金
    }
    if (placedCount > 0) {
      this.audioManager.playBuildSound();
    }
    if (placedCount < items.length && invalidStationGroupIds.size === 0) {
      alert(`${items.length - placedCount}件はスペース不足等のため設置できませんでした（その分は返金されます）。`);
    }

    // 設置成功した駅・信号場グループを StationManager にホーム（番線）として登録
    const stationGroups = new Map<string, { tool: ActiveTool; rotation: number; tiles: Array<{ x: number; z: number; layer: GridLayer }> }>();
    for (const item of successfullyPlacedItems) {
      const isStationOrYard = item.tool === 'station-small' || item.tool === 'station-elevated' || item.tool === 'signal-yard' || item.tool === 'cargo-station';
      if (isStationOrYard && item.stationGroupId) {
        const lyr = (item.layer ?? this.worldMap.activeLayer) as GridLayer;
        const tile = this.worldMap.getTile(item.x, item.z, lyr);
        if (tile && (tile.type.startsWith('station') || tile.type === 'signal_yard' || tile.type.startsWith('cargo_station'))) {
          if (!stationGroups.has(item.stationGroupId)) {
            stationGroups.set(item.stationGroupId, {
              tool: item.tool,
              rotation: item.rotation,
              tiles: []
            });
          }
          stationGroups.get(item.stationGroupId)!.tiles.push({
            x: item.x,
            z: item.z,
            layer: lyr
          });
        }
      }
    }

    for (const [stGroupId, gData] of stationGroups) {
      if (gData.tiles.length > 0) {
        const isYard = gData.tool === 'signal-yard';
        const isCargo = gData.tool === 'cargo-station';
        const axis = gData.rotation % 2;
        const firstTile = this.worldMap.getTile(gData.tiles[0].x, gData.tiles[0].z, gData.tiles[0].layer);
        const defaultCargoName = isCargo ? (firstTile?.stationName || '貨物駅') : undefined;
        const reg = this.worldMap.stationManager.registerPlatform({
          tiles: gData.tiles,
          length: gData.tiles.length,
          trackAxis: axis,
          isSignalYard: isYard,
          isCargoStation: isCargo,
          existingStationId: stGroupId,
          customName: firstTile?.stationName || defaultCargoName
        });
        // 登録された駅名をタイルおよび看板メッシュに反映
        for (const tCoord of gData.tiles) {
          const t = this.worldMap.getTile(tCoord.x, tCoord.z, tCoord.layer);
          if (t) {
            t.stationName = reg.station.name;
            if (t.mesh) {
              ModelFactory.updateStationSign(t.mesh, reg.station.name);
            }
            if (isCargo) {
              this.updateCargoYardVisual(tCoord.x, tCoord.z, tCoord.layer);
            }
          }
        }
      }
    }

    this.cancelPendingPlacements();
    this.applyLayerSlicing(this.currentDisplayLayer);
    this.updateRotationHint(this.uiManager.getActiveTool());
    this.miniMap.requestStaticUpdate();
    this.terrainRenderer.rebuildAll(this.gridManager, this.renderer.scene);
  }

  /**
   * 実際の設置処理（WorldMap 反映のみ。課金は呼び出し側で一括して行う）。成否を返す。
   */
  private executePlacement(
    tool: ActiveTool,
    x: number,
    z: number,
    rotation: number,
    branchSide: 'left' | 'right' = 'right',
    stationPart?: 'single' | 'start' | 'mid' | 'end',
    stationGroupId?: string,
    stationPlatformSide: 'left' | 'right' = 'right',
    layer: GridLayer = this.worldMap.activeLayer
  ): boolean {
    if (tool === 'rail-slope') {
      if (layer >= 5) return false;
      if (layer < 0) layer = 1;
    }
    if (tool === 'rail-slope-underground') {
      if (layer !== 1) layer = 1;
    }
    // 階層に応じたツールの自動切り替え解決
    tool = this.resolveAutoToolForLayer(tool, layer);
    // 山岳地帯などで地表標高より低い階層の場合、直線線路は自動的にトンネルとして扱う
    if ((tool === 'rail-straight' || tool === 'rail-tunnel') && this.worldMap.isTunnelSection(x, z, layer)) {
      tool = 'rail-tunnel';
    }

    // 水上は線路・駅・道路などのインフラ以外は敷設不可
    const isInfrastructureTool =
      tool.startsWith('rail') ||
      tool.startsWith('point-switch') ||
      tool.startsWith('scissors-crossing') ||
      tool.startsWith('station') ||
      tool.startsWith('cargo-station') ||
      tool === 'signal-yard' ||
      tool === 'road';

    // 複数マス建築物（スロープ、地下スロープ、シーサスクロッシング等）の全占有マスを算出
    const targetPositions: { x: number; z: number; layer: GridLayer }[] = [];

    if (tool === 'rail-slope') {
      const axisVal = rotation % 2;
      const reversed = rotation >= 2;
      const axisDirs: [number, number] = axisVal === 1 ? [1, 3] : [0, 2];
      const [, highIdx] = reversed ? [axisDirs[1], axisDirs[0]] : [axisDirs[0], axisDirs[1]];
      const stepDir = WorldMap.DIRS[highIdx];
      for (let i = 0; i < 4; i++) {
        const tx = x + stepDir.x * i;
        const tz = z + stepDir.z * i;
        targetPositions.push({ x: tx, z: tz, layer });
        if (i === 3) {
          const upperLayer: GridLayer = (layer + 1) as GridLayer;
          targetPositions.push({ x: tx, z: tz, layer: upperLayer });
        }
      }
    } else if (tool === 'rail-slope-underground') {
      const axisVal = rotation % 2;
      const reversed = rotation >= 2;
      const axisDirs: [number, number] = axisVal === 1 ? [1, 3] : [0, 2];
      const [, downIdx] = reversed ? [axisDirs[1], axisDirs[0]] : [axisDirs[0], axisDirs[1]];
      const stepDir = WorldMap.DIRS[downIdx];
      for (let i = 0; i < 4; i++) {
        const tx = x + stepDir.x * i;
        const tz = z + stepDir.z * i;
        targetPositions.push({ x: tx, z: tz, layer });
        if (i === 3) {
          const lowerLayer: GridLayer = -1;
          targetPositions.push({ x: tx, z: tz, layer: lowerLayer });
        }
      }
    } else if (tool === 'scissors-crossing' || tool === 'scissors-crossing-elevated') {
      const along = rotation === 1 ? 1 : 2;
      const across = WorldMap.rotateCW(along);
      const alongVec = WorldMap.DIRS[along];
      const acrossVec = WorldMap.DIRS[across];
      targetPositions.push(
        { x, z, layer },
        { x: x + alongVec.x, z: z + alongVec.z, layer },
        { x: x + acrossVec.x, z: z + acrossVec.z, layer },
        { x: x + alongVec.x + acrossVec.x, z: z + alongVec.z + acrossVec.z, layer }
      );
    } else {
      // 1マス建築物
      targetPositions.push({ x, z, layer });
    }

    // 全占有予定マスの事前空き地・衝突判定（境界外、既存本設置、走行中列車、水辺制約）
    const isStationTool = tool.startsWith('station') || tool.startsWith('cargo-station') || tool === 'signal-yard';
    for (const pos of targetPositions) {
      if (!this.worldMap.isInBounds(pos.x, pos.z)) {
        return false;
      }
      const existingTile = this.worldMap.getTile(pos.x, pos.z, pos.layer);
      const isCompatibleTrack = isStationTool && existingTile &&
        (existingTile.type === 'rail_ground' || existingTile.type === 'rail_elevated') &&
        (existingTile.rotation === (rotation % 2));

      if (!isCompatibleTrack) {
        if (this.worldMap.isPermanentTrackOrStation(pos.x, pos.z, pos.layer)) {
          return false;
        }
        if (existingTile && existingTile.type !== 'empty') {
          return false;
        }
      }
      if (this.trainManager.isTileOccupiedByTrain(pos.x, pos.z, pos.layer)) {
        return false;
      }
      const waterCheck = this.worldMap.canPlaceAtWater(pos.x, pos.z, pos.layer);
      if (!waterCheck.allowed) {
        return false;
      }
      if (this.gridManager.isWaterAtGroundLevel(pos.x, pos.z) && !isInfrastructureTool) {
        return false;
      }
    }

    // ② ③ 曲線レール敷設（地上/高架、1マス斜め接続）
    if (tool === 'rail-curve' || tool === 'rail-curve-elevated') {
      const isElevated = tool === 'rail-curve-elevated';
      const curveDir = CURVE_DIR_ORDER[rotation];
      return this.worldMap.placeCurve(x, z, curveDir, isElevated, layer);
    }

    // ② 分岐器敷設（地上/高架、1マス、左右分岐対応）
    if (tool === 'point-switch' || tool === 'point-switch-elevated') {
      const isElevated = tool === 'point-switch-elevated';
      return this.worldMap.placeSwitch(x, z, rotation, isElevated, branchSide, layer);
    }

    // ③ シーサスクロッシング敷設（地上/高架、2×2）
    if (tool === 'scissors-crossing' || tool === 'scissors-crossing-elevated') {
      const isElevated = tool === 'scissors-crossing-elevated';
      return this.worldMap.placeScissorsCrossing(x, z, rotation, isElevated, layer);
    }

    // ① 勾配レール敷設（4マス直線、地上⇔高架を緩やかに接続）
    if (tool === 'rail-slope') {
      const axis = rotation % 2;
      const reversed = rotation >= 2;
      return this.worldMap.placeSlope(x, z, axis, reversed, layer);
    }

    // 地下勾配レール敷設（4マス直線、地上⇔地下を緩やかに接続）
    if (tool === 'rail-slope-underground') {
      const axis = rotation % 2;
      const reversed = rotation >= 2;
      return this.worldMap.placeUndergroundSlope(x, z, axis, reversed, layer);
    }

    // トンネル線路敷設
    if (tool === 'rail-tunnel') {
      const tileRotation = rotation % 2;
      return this.worldMap.setTile(x, z, 'rail_ground', tileRotation, 1, stationPlatformSide, layer);
    }

    // ⑧ 通常の建設（向きは rotation の軸成分を使用）
    const config = TOOL_CONFIG[tool];
    if (config.tileType) {
      // 【工業ゾーン限定】工業建物は工業エリアにゾーニングされた区画にのみ配置可能
      if (tool === 'building-ind') {
        const zone = this.zoneManager.getZone(x, z);
        if (!zone || zone.type !== 'industrial') {
          return false;
        }
      }
      const tileRotation = ROTATABLE_TOOLS.includes(tool) ? rotation % 2 : 0;
      let targetTileType = config.tileType as TileType;
      if (tool === 'cargo-station' && layer >= 2) {
        targetTileType = 'cargo_station_elevated';
      }
      const ok = this.worldMap.setTile(x, z, targetTileType, tileRotation, 1, stationPlatformSide, layer);
      if (ok) {
        const isStationOrYard = tool === 'station-small' || tool === 'station-elevated' || tool === 'signal-yard' || tool === 'cargo-station';
        if (isStationOrYard) {
          const tile = this.worldMap.getTile(x, z, layer);
          if (tile) {
            tile.stationPlatformSide = stationPlatformSide;
            tile.stationTargetLength = this.currentStationLength;
            tile.stationSchedule = tile.stationSchedule || createDefaultStationSchedule();
            if (tool === 'cargo-station') {
              tile.isCargoYard = true;
            }
            if (stationGroupId) tile.stationGroupId = stationGroupId;
            if (stationPart) {
              tile.stationPart = stationPart;
              if (tile.mesh) {
                this.renderer.scene.remove(tile.mesh);
                disposeHierarchy(tile.mesh);
                const baseH = layerToHeight(layer);
                const isElevated = tool === 'station-elevated' || ((tool === 'signal-yard' || tool === 'cargo-station') && layer >= 2);
                const newMesh = tool === 'signal-yard'
                  ? ModelFactory.createSignalYard(tileRotation, isElevated, stationPlatformSide, baseH)
                  : (tool === 'cargo-station'
                      ? ModelFactory.createCargoStation(tileRotation, isElevated, stationPlatformSide, baseH)
                      : ModelFactory.createStation(tileRotation, isElevated, stationPart, stationPlatformSide, tile.stationName || '駅', baseH));
                const elevY = (layer === 1) ? this.worldMap.getElevationOffset(x, z) : 0;
                newMesh.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
                newMesh.visible = (this.currentDisplayLayer === 'all' ? layer >= 1 : layer === this.currentDisplayLayer);
                this.renderer.scene.add(newMesh);
                tile.mesh = newMesh;
              }
            }
          }
        }
        if (config.tileType === 'residence') {
          this.economy.addPopulation(30);
        } else if (config.tileType === 'commercial') {
          this.economy.addPopulation(100);
        } else if (config.tileType === 'industrial') {
          this.economy.addPopulation(50);
        }
      }
      return ok;
    }

    return false;
  }

  private handleTileClick() {
    if (!this.hoveredTile) return;
    const { x, z } = this.hoveredTile;
    const tool = this.uiManager.getActiveTool();

    // ⑦ 保有列車の線路配置モード中（仮配置）
    if (this.deployingFleetId) {
      const deployLayer = this.worldMap.activeLayer;
      const tile = this.worldMap.getTile(x, z, deployLayer);
      if (!tile || !isTrackLikeType(tile.type)) {
        alert('列車は線路または駅の上に配置してください。');
        return;
      }
      const item = this.fleetRegistry.find(f => f.id === this.deployingFleetId);
      if (!item) return;

      // すでに仮配置中なら古いゴーストを撤去
      if (this.pendingTrainDeploy) {
        this.renderer.scene.remove(this.pendingTrainDeploy.ghost);
        this.pendingTrainDeploy = null;
      }
      this.clearHoverTrainGhost();

      // タイルの線路出口を取得し、初期進行方向を決定
      const exits = WorldMap.getTileExits(tile);
      let dirIdx: number;
      if (exits.length > 0) {
        const hasCurrent = exits.some(e => e.idx === this.deployDirectionIdx);
        dirIdx = hasCurrent ? this.deployDirectionIdx : exits[0].idx;
      } else {
        dirIdx = tile.rotation === 1 ? 1 : 2;
      }
      this.deployDirectionIdx = dirIdx;

      // 新しい仮配置ゴーストを生成
      const ghost = this.createTrainGhost(item.model, item.cars, dirIdx, x, z, deployLayer);
      this.renderer.scene.add(ghost);

      this.pendingTrainDeploy = {
        fleetId: item.id,
        x,
        z,
        layer: deployLayer,
        directionIdx: dirIdx,
        ghost
      };

      this.uiManager.setPlacementButtonsVisible(true);
      this.uiManager.setRotateButtonVisible(true);
      this.audioManager.playBuildSound();
      this.updateRotationHint(tool);
      return;
    }

    // Select mode（① 列車を優先的にレイキャスト）
    if (tool === 'select') {
      const train = this.raycastTrain();
      if (train) {
        this.selectedTrainId = train.id;
        this.selectedTilePos = null;
        if (train.currentTile.layer !== this.worldMap.activeLayer) {
          this.switchActiveLayer(train.currentTile.layer, false);
        }
        const target = this.trainManager.getFollowTargetByTrainId(train.id);
        if (target) {
          this.cameraManager.startTracking(target, true);
        }
        this.uiManager.showTrainInspector(train);
        return;
      }
      const curLayer = this.worldMap.activeLayer;
      const existingTile = this.worldMap.getTile(x, z, curLayer);
      const tile: TileData = existingTile || {
        x,
        z,
        type: 'empty',
        level: 1,
        rotation: 0,
        layer: curLayer,
        landValue: 10,
        stationPassengers: 0
      };
      this.selectedTrainId = null;
      this.selectedTilePos = { x, z, layer: curLayer };
      this.cameraManager.stopTracking();
      const hub = this.worldMap.resolveSwitchHub(x, z, curLayer);
      const isStationOrYard = tile.type.startsWith('station') || tile.type === 'signal_yard' || tile.type.startsWith('cargo_station');
      const runLength = isStationOrYard ? this.worldMap.getStationRunLength(x, z, curLayer) : undefined;
      const stData = isStationOrYard ? this.worldMap.getStationAggregateData(x, z, curLayer) : undefined;
      this.uiManager.showInspector(tile, hub, runLength, stData);
      return;
    }

    // ①② カテゴリ別撤去モード（該当カテゴリの物のみ撤去できる）
    if (tool === 'demolish-train') {
      const train = this.raycastTrain();
      if (train) {
        // fleetRegistry内のステータスも戻す
        const fleetItem = this.fleetRegistry.find(f => f.activeTrainId === train.id);
        if (fleetItem) {
          fleetItem.status = 'in_depot';
          fleetItem.activeTrainId = undefined;
        }
        // 前面展望中に対象列車が撤去された場合は自由視点に安全復帰
        if (this.cabTargetTrainId === train.id) {
          this.exitCabView();
        }
        // カメラ追尾も解除
        this.cameraManager.stopTracking();
        this.trainManager.removeTrain(train.id);
        this.audioManager.playDemolishSound();
        if (this.selectedTrainId === train.id) {
          this.selectedTrainId = null;
          this.uiManager.closeInspector();
        }
      } else {
        alert('この位置に列車がありません。撤去したい列車をクリックしてください。');
      }
      return;
    }

    const demolishScope = DEMOLISH_SCOPE[tool];
    if (demolishScope) {
      const curLayer = this.worldMap.activeLayer;
      const tile = this.worldMap.getTile(x, z, curLayer);
      if (tile && tile.type !== 'empty') {
        if (!demolishScope.includes(tile.type)) {
          alert('このカテゴリーの撤去ツールでは撤去できない物です。');
          return;
        }
        // ⑤ 駅・信号場等の複数マス施設の場合、撤去対象となる全タイルのコンテナ描写を漏れなく破棄
        const tilesToClean: Array<{ x: number; z: number; layer: GridLayer }> = [];
        if (tile.type.includes('station') || tile.type === 'signal_yard') {
          const stTiles = this.worldMap.getStationTiles(x, z, curLayer);
          if (stTiles.length > 0) {
            for (const st of stTiles) {
              tilesToClean.push({ x: st.x, z: st.z, layer: (st.layer ?? curLayer) as GridLayer });
            }
          } else {
            tilesToClean.push({ x, z, layer: curLayer });
          }
        } else {
          tilesToClean.push({ x, z, layer: curLayer });
        }

        // ⑤ 列車走行中・停車中線路の撤去安全ガード（撤去対象全マスを検証）
        this.trainManager.updateOccupancyNow();
        for (const t of tilesToClean) {
          if (this.trainManager.isTileOccupiedByTrain(t.x, t.z, t.layer)) {
            alert('⚠️ 列車が走行中・停車中の線路や駅は撤去できません！\n列車が通過するのを待つか、車両管理から車庫へ回送してください。');
            return;
          }
        }

        const config = TOOL_CONFIG[tool];
        if (this.economy.spendFunds(config.cost, true)) {
          this.worldMap.demolishTile(x, z, curLayer);
          for (const t of tilesToClean) {
            this.removeCargoYardVisual(t.x, t.z, t.layer);
          }
          this.audioManager.playDemolishSound();
          if (this.selectedTilePos && tilesToClean.some(t => t.x === this.selectedTilePos!.x && t.z === this.selectedTilePos!.z && t.layer === this.selectedTilePos!.layer)) {
            this.selectedTilePos = null;
            this.uiManager.closeInspector();
          }
          this.scheduleUI.refreshOrClose();
          this.switchScheduleUI.refreshOrClose();
          this.miniMap.requestStaticUpdate();
          this.terrainRenderer.rebuildAll(this.gridManager, this.renderer.scene);

          // 【不具合②解消】撤去直後に在線情報を最新化し、ホバー駅ゴーストキャッシュをクリア
          this.trainManager.updateOccupancyNow();
          this.clearHoverStationGhost();
          this.hoverStationCacheKey = '';
        } else {
          alert('資金が不足しています！');
        }
      }
      return;
    }

    // ⑤ & ⑦ 列車購入モード（クリックで車両購入モーダルを開く）
    if (tool === 'train-buy') {
      this.uiManager.openVehicleModal();
      return;
    }

    // Phase2: RCIゾーニングブラシ（即時ペイント。仮置き→決定の対象外で、その場で塗る/消す）
    const ZONE_TOOL_TYPE: Partial<Record<ActiveTool, ZoneType>> = {
      'zone-residential': 'residential',
      'zone-commercial': 'commercial',
      'zone-industrial': 'industrial'
    };
    if (ZONE_TOOL_TYPE[tool]) {
      const config = TOOL_CONFIG[tool];
      if (!this.economy.spendFunds(config.cost, true)) {
        alert('資金が不足しています！');
        return;
      }
      const painted = this.zoneManager.paintZone(x, z, ZONE_TOOL_TYPE[tool]!, 2);
      this.refreshZoneOverlay(painted.map(c => ({ x: c.x, z: c.z })));
      this.demandEngine.clearCache();
      this.audioManager.playBuildSound();
      this.miniMap.requestStaticUpdate();
      return;
    }
    if (tool === 'zone-clear') {
      this.zoneManager.clearZone(x, z, 2);
      this.refreshZoneOverlayClear(x, z, 2);
      this.demandEngine.clearCache();
      this.audioManager.playDemolishSound();
      this.miniMap.requestStaticUpdate();
      return;
    }

    // Phase2: 貨物ヤード指定（既存の駅・信号場タイルを貨物専用ヤードとして指定するタグ付けツール）
    if (tool === 'cargo-yard') {
      const curLayer = this.worldMap.activeLayer;
      const tile = this.worldMap.getTile(x, z, curLayer);
      const isStationOrYard = tile && (tile.type.startsWith('station') || tile.type === 'signal_yard');
      if (!tile || !isStationOrYard) {
        alert('貨物ヤードに指定するには、先に駅または信号場をこのマスに設置してください。');
        return;
      }
      if (tile.isCargoYard) {
        alert('このマスはすでに貨物ヤードに指定されています。');
        return;
      }
      const config = TOOL_CONFIG[tool];
      if (!this.economy.spendFunds(config.cost, true)) {
        alert('資金が不足しています！');
        return;
      }
      tile.isCargoYard = true;
      this.addCargoYardMarker(tile.x, tile.z, curLayer);
      this.audioManager.playBuildSound();
      return;
    }

    // ⑥⑦ 仮置き（回転可・複数マス可）。本設置は「設置を決定」ボタンでまとめて行う。
    if (PLACEMENT_TOOLS.includes(tool)) {
      this.stagePendingPlacement(tool, x, z);
    }
  }

  /** ゾーンブラシで塗った区画の3D半透明マーカーを更新（追加・色変更） */
  private refreshZoneOverlay(cells: { x: number; z: number }[]): void {
    for (const { x, z } of cells) {
      const key = `${x},${z}`;
      const zone = this.zoneManager.getZone(x, z);
      let mesh = this.zoneOverlayMeshes.get(key);
      if (!zone) {
        if (mesh) {
          this.zoneOverlayGroup.remove(mesh);
          this.zoneOverlayMeshes.delete(key);
        }
        continue;
      }
      const color = zone.type === 'residential' ? 0x22c55e : zone.type === 'commercial' ? 0x3b82f6 : 0xeab308;
      if (!mesh) {
        const geo = new THREE.PlaneGeometry(WorldMap.TILE_SIZE * 0.94, WorldMap.TILE_SIZE * 0.94);
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.32, depthWrite: false });
        mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(x * WorldMap.TILE_SIZE, 0.04, z * WorldMap.TILE_SIZE);
        this.zoneOverlayGroup.add(mesh);
        this.zoneOverlayMeshes.set(key, mesh);
      } else {
        (mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
      }
    }
  }

  /** ゾーン解除ブラシの範囲内にある3Dマーカーを撤去 */
  private refreshZoneOverlayClear(x: number, z: number, radius: number): void {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.hypot(dx, dz) > radius + 0.4) continue;
        const key = `${x + dx},${z + dz}`;
        const mesh = this.zoneOverlayMeshes.get(key);
        if (mesh) {
          this.zoneOverlayGroup.remove(mesh);
          this.zoneOverlayMeshes.delete(key);
        }
      }
    }
  }

  /** 貨物駅グループのコンテナ描写（1個単位のリアルタイム増減・最大3段）視覚演出の更新 */
  private updateCargoYardVisual(x: number, z: number, layer: GridLayer): void {
    const tile = this.worldMap.getTile(x, z, layer);
    if (!tile || (!tile.type.startsWith('cargo_station') && !tile.isCargoYard)) {
      this.removeCargoYardVisual(x, z, layer);
      return;
    }

    // 駅グループ全体のタイル群と合計コンテナ数を取得
    const stTiles = this.worldMap.getStationTiles(x, z, layer);
    const stationTiles = stTiles.length > 0 ? stTiles : [tile];
    
    // 商業エリアの駅はコンテナを蓄積せず即時販売するため、描写は0個
    const isCommercial = this.cargoSystem.isStationInArea(this.worldMap, x, z, 'commercial', layer);
    const totalContainers = isCommercial ? 0 : this.worldMap.getStationCargoContainers(x, z, layer);

    let remainingToPlace = totalContainers;
    const containerColors = [0x831843, 0x1d4ed8, 0x15803d, 0xd97706]; // JR貨物19Dエンジ, 18D青, 通風緑, JOT黄
    const cGeo = new THREE.BoxGeometry(0.55, 0.42, 0.85);

    // 駅グループの各タイルごとに最大6個（2列×3段）ずつコンテナを配置
    for (let tIdx = 0; tIdx < stationTiles.length; tIdx++) {
      const curT = stationTiles[tIdx];
      const curKey = `${curT.x},${curT.z},${(curT.layer ?? layer)}`;
      this.removeCargoYardVisual(curT.x, curT.z, (curT.layer ?? layer) as GridLayer);

      if (remainingToPlace <= 0) continue;

      const group = new THREE.Group();
      const elevOffset = curT.elevationOffset ?? 0;
      const isElevated = curT.type.includes('elevated');
      const baseHeight = (isElevated ? 3.0 : 0) + elevOffset;
      const railBaseHeight = isElevated ? 0.2 : 0;
      const sideMult = curT.stationPlatformSide === 'left' ? -1 : 1;

      group.position.set(curT.x * WorldMap.TILE_SIZE, baseHeight, curT.z * WorldMap.TILE_SIZE);
      if ((curT.rotation % 2) === 1) {
        group.rotation.y = Math.PI / 2;
      }

      // 1マスあたり最大6個のスロット: 列(z=-0.48, +0.48) × 段(0, 1, 2)
      // 順番: 1段目の前後2個 -> 2段目の前後2個 -> 3段目の前後2個
      const slotPositions: Array<{ z: number; tier: number }> = [
        { z: -0.48, tier: 0 },
        { z: 0.48, tier: 0 },
        { z: -0.48, tier: 1 },
        { z: 0.48, tier: 1 },
        { z: -0.48, tier: 2 },
        { z: 0.48, tier: 2 }
      ];

      for (let s = 0; s < slotPositions.length && remainingToPlace > 0; s++) {
        const slot = slotPositions[s];
        const color = containerColors[(Math.abs(curT.x * 3 + curT.z * 5) + s) % containerColors.length];
        const mat = new THREE.MeshStandardMaterial({
          color,
          roughness: 0.5,
          metalness: 0.2
        });
        const container = new THREE.Mesh(cGeo, mat);
        container.position.set(
          1.0 * sideMult,
          railBaseHeight + 0.31 + slot.tier * 0.44,
          slot.z
        );
        container.castShadow = true;
        container.receiveShadow = true;
        group.add(container);
        remainingToPlace--;
      }

      if (group.children.length > 0) {
        const tLayer = (curT.layer ?? layer) as GridLayer;
        group.visible = (this.currentDisplayLayer === 'all' ? tLayer >= 1 : tLayer === this.currentDisplayLayer);
        this.renderer.scene.add(group);
        this.cargoYardMeshes.set(curKey, group);
      }
    }
  }

  private removeCargoYardVisual(x: number, z: number, layer: GridLayer): void {
    const key = `${x},${z},${layer}`;
    const existing = this.cargoYardMeshes.get(key);
    if (existing) {
      this.renderer.scene.remove(existing);
      disposeHierarchy(existing);
      this.cargoYardMeshes.delete(key);
    }
  }

  private clearAllCargoYardVisuals(): void {
    for (const mesh of this.cargoYardMeshes.values()) {
      this.renderer.scene.remove(mesh);
      disposeHierarchy(mesh);
    }
    this.cargoYardMeshes.clear();
  }

  /** 後方互換用エイリアス */
  private addCargoYardMarker(x: number, z: number, layer: GridLayer): void {
    this.updateCargoYardVisual(x, z, layer);
  }

  /**
   * 新規作成によるゲーム開始
   */
  private startNewGame(mapSize: MapSize, terrainType: TerrainType) {
    this.gameState.startNewGame(mapSize, terrainType);
    this.gridManager = new GridManager(mapSize, terrainType);
    this.renderer.updateGroundAndGridSize(mapSize);
    this.worldMap.setGridSize(mapSize);
    this.worldMap.setElevationProvider((x, z) => {
      const cell = this.gridManager.getCell(x, 1, z);
      return cell ? Math.max(0, (cell.elevation - 1) * 3.0) : 0;
    });
    this.cityGrowth.setGridManager(this.gridManager);
    this.worldMap.gridManagerRef = this.gridManager;
    this.worldMap.setActiveLayer(1);
    this.inputController.setActiveLayer(1);
    this.uiManager.setFloorActive(1);

    this.cancelPendingPlacements();
    this.worldMap.clearAll();
    this.trainManager.removeAllTrains();
    this.fleetRegistry = [];
    this.economy.resetAll();
    this.timeManager.deserialize({ year: 2026, month: 4, day: 1, hour: 6, minute: 0, speedLevel: 1 });
    this.uiManager.setSpeedUI(1);
    this.scheduleUI.close();

    // Phase2: ゾーニング・貨物データ・チャンク管理・ミニマップをリセット
    this.zoneManager.clearAll();
    for (const mesh of this.zoneOverlayMeshes.values()) {
      this.zoneOverlayGroup.remove(mesh);
    }
    this.zoneOverlayMeshes.clear();
    this.clearAllCargoYardVisuals();
    this.chunkManager.setGridManager(this.gridManager);
    this.miniMap.setGridManager(this.gridManager);

    this.buildInitialCity();
    this.terrainRenderer.build(this.gridManager, this.renderer.scene);

    this.cameraManager.target.set(0, 0, 0);
    this.cameraManager.stopTracking();
    this.cameraManager.setQuarterViewMode();
    this.uiManager.setCameraModeUI('orbit');
  }

  /**
   * セーブデータからのゲーム再開
   */
  private resumeGame() {
    this.gameState.resumeGame();
    this.initWorld();
    this.cameraManager.target.set(0, 0, 0);
    this.cameraManager.stopTracking();
    this.cameraManager.setQuarterViewMode();
    this.uiManager.setCameraModeUI('orbit');
  }

  /**
   * 初期都市の構築（新規ゲーム・初期配置用）
   */
  private buildInitialCity() {
    // ⑧ 複数マス駅ホーム（東西線: 西駅2マス、東駅2マス、すべて地上）
    // 西側駅（2マスホーム: X=-6, X=-5）
    this.worldMap.placeStationGroup(-6, 0, 2, 1, false, '西中央駅');

    // 中間地上線路
    for (let x = -4; x <= 4; x++) {
      this.worldMap.setTile(x, 0, 'rail_ground', 1);
    }

    // 東側駅（2マスホーム: X=5, X=6、すべて地上に変更）
    this.worldMap.placeStationGroup(5, 0, 2, 1, false, '東中央駅');

    // ② 分岐器（ポイント、1マス）を西側駅の手前に設置。forward=1(東)で通過、分岐は南側(+Z)へ。
    this.worldMap.placeSwitch(-3, 0, 1, false);

    // 道路（線路と交差する箇所は自動で踏切になる）
    for (let x = -7; x <= 7; x++) {
      this.worldMap.setTile(x, 2, 'road', 1);
    }

    // ⑤ 踏切のデモ: 地上線路(X=-2, Z=0, 南北軸なし=東西軸)と直交する道路を重ねて自動生成させる
    this.worldMap.setTile(-2, -1, 'road', 0);
    this.worldMap.setTile(-2, 0, 'road', 0);
    this.worldMap.setTile(-2, 1, 'road', 0);

    // 住宅・商業・緑地
    this.worldMap.setTile(-6, 3, 'residence', 0, 2);
    this.worldMap.setTile(-5, 3, 'commercial', 0, 3);
    this.worldMap.setTile(-4, 3, 'residence', 0, 1);
    this.worldMap.setTile(5, 3, 'commercial', 0, 4);
    this.worldMap.setTile(6, 3, 'residence', 0, 2);

    this.worldMap.setTile(-7, 1, 'nature');
    this.worldMap.setTile(7, 1, 'nature');

    // Phase2: 初期デモゾーニング（西=住宅、東=商業、北=工業）。プレイヤーが貨物駅を設置すれば
    // すぐに「工業→商業→旅客需要増」の経済循環を体験できる状態にしておく。
    const westZone = this.zoneManager.paintZone(-6, 3, 'residential', 3);
    const eastZone = this.zoneManager.paintZone(5, 3, 'commercial', 3);
    const industrialZone = this.zoneManager.paintZone(-6, -6, 'industrial', 3);
    this.refreshZoneOverlay([...westZone, ...eastZone, ...industrialZone].map(c => ({ x: c.x, z: c.z })));

    this.economy.addPopulation(820);

    // ⑤ & ⑦ ⑨ 初期列車（通勤型電車 2両編成: 初期駅の有効長2両に合わせる）
    const vehicle = getVehicleById('commuter-train');
    const train = this.trainManager.spawnTrain(-5, 0, vehicle, 2);
    if (train) {
      const fleetItem: FleetItem = {
        id: `fleet-${this.nextFleetId++}`,
        name: `${vehicle.name} 1号`,
        model: vehicle,
        cars: 2,
        status: 'deployed',
        activeTrainId: train.id
      };
      this.fleetRegistry.push(fleetItem);
    }

    // 3次元地形（山岳段丘・河川/水域）のレンダリング構築
    this.terrainRenderer.build(this.gridManager, this.renderer.scene);

    // 初期配置された旅客駅の待機乗客数を周囲5マスの建物から算出・セット
    this.trainManager.updateHourlyStationPassengers(
      this.timeManager.hour,
      (x, z, h) => this.demandEngine.getDemandMultiplier(h, x, z)
    );
  }

  /**
   * 都市データの初期ロード
   */
  private initWorld() {
    const saved = localStorage.getItem('wagamachi_save_data') || localStorage.getItem('saikyo_save_data') || localStorage.getItem('stk_3d_world');
    if (saved) {
      this.worldMap.deserialize(saved);
      const savedZones = localStorage.getItem('wagamachi_zone_data') || localStorage.getItem('saikyo_zone_data');
      if (savedZones) {
        this.zoneManager.deserialize(savedZones);
        this.refreshZoneOverlay(this.zoneManager.getAllZones().map(c => ({ x: c.x, z: c.z })));
      }
      for (const t of this.worldMap.getAllTiles()) {
        if (t.isCargoYard) {
          this.addCargoYardMarker(t.x, t.z, (t.layer ?? 1) as GridLayer);
        }
        if (t.isCargoYard || t.type.startsWith('cargo_station')) {
          this.updateCargoYardVisual(t.x, t.z, (t.layer ?? 1) as GridLayer);
        }
      }
      // ゲーム内日時の復元
      const savedTime = localStorage.getItem('wagamachi_time_data') || localStorage.getItem('saikyo_time_data');
      if (savedTime) {
        try {
          const t = JSON.parse(savedTime);
          if (t && typeof t.hour === 'number' && typeof t.minute === 'number') {
            this.timeManager.year = t.year ?? this.timeManager.year;
            this.timeManager.month = t.month ?? this.timeManager.month;
            this.timeManager.day = t.day ?? this.timeManager.day;
            this.timeManager.hour = t.hour;
            this.timeManager.minute = t.minute;
            if (typeof t.speedLevel === 'number') {
              this.timeManager.setSpeedLevel(t.speedLevel as SpeedLevel);
              this.uiManager.setSpeedUI(t.speedLevel);
            }
            this.economy.syncDate(this.timeManager.year, this.timeManager.month, this.timeManager.day);
          }
        } catch (e) {
          console.warn('Failed to restore time data:', e);
        }
      }

      // ① 運行中列車および車両基地保有リストの復元
      const savedTrains = localStorage.getItem('wagamachi_trains_data') || localStorage.getItem('saikyo_trains_data');
      const savedFleet = localStorage.getItem('wagamachi_fleet_data') || localStorage.getItem('saikyo_fleet_data');
      const savedNextFleetId = localStorage.getItem('wagamachi_next_fleet_id') || localStorage.getItem('saikyo_next_fleet_id');
      if (savedNextFleetId) {
        this.nextFleetId = parseInt(savedNextFleetId, 10) || this.nextFleetId;
      }

      let trainsLoaded = false;
      if (savedTrains) {
        trainsLoaded = this.trainManager.deserialize(savedTrains);
      }

      if (savedFleet) {
        try {
          const parsedFleet = JSON.parse(savedFleet);
          if (Array.isArray(parsedFleet)) {
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
        } catch (e) {
          console.error('Failed to restore fleetRegistry:', e);
        }
      }

      // 【データ整合性修復】運行中の列車が車両基地台帳（fleetRegistry）に未登録の場合、自動補完登録
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
      // 逆に台帳で deployed なのに列車が存在しない場合は in_depot に是正
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

      // レガシーセーブデータ等で列車データがなかった場合のみフォールバックで初期列車を生成
      if (!trainsLoaded && this.fleetRegistry.length === 0) {
        const track = this.worldMap.getAllTiles().find(t => t.type.includes('station') || t.type.includes('rail'));
        if (track) {
          const vehicle = getVehicleById('commuter-train');
          const train = this.trainManager.spawnTrain(track.x, track.z, vehicle, 2);
          if (train) {
            const fleetItem: FleetItem = {
              id: `fleet-${this.nextFleetId++}`,
              name: `${vehicle.name} 1号`,
              model: vehicle,
              cars: 2,
              status: 'deployed',
              activeTrainId: train.id
            };
            this.fleetRegistry.push(fleetItem);
          }
        }
      }
      this.terrainRenderer.build(this.gridManager, this.renderer.scene);
      return;
    }

    this.buildInitialCity();
  }

  private saveGame() {
    const worldData = this.worldMap.serialize();
    localStorage.setItem('wagamachi_save_data', worldData);
    localStorage.setItem('wagamachi_zone_data', this.zoneManager.serialize());
    this.economy.saveToStorage();

    // ① 運行中列車と保有フリートの完全永続化
    localStorage.setItem('wagamachi_trains_data', this.trainManager.serialize());
    const fleetData = this.fleetRegistry.map(f => ({
      id: f.id,
      name: f.name,
      modelId: f.model.id,
      cars: f.cars,
      status: f.status,
      activeTrainId: f.activeTrainId,
      totalPassengers: f.totalPassengers,
      totalRevenue: f.totalRevenue
    }));
    localStorage.setItem('wagamachi_fleet_data', JSON.stringify(fleetData));
    localStorage.setItem('wagamachi_next_fleet_id', String(this.nextFleetId));

    // ゲーム内日時の保存
    const timeData = {
      year: this.timeManager.year,
      month: this.timeManager.month,
      day: this.timeManager.day,
      hour: this.timeManager.hour,
      minute: this.timeManager.minute,
      speedLevel: this.timeManager.speedLevel
    };
    localStorage.setItem('wagamachi_time_data', JSON.stringify(timeData));
  }

  private resetGame() {
    localStorage.removeItem('wagamachi_save_data');
    localStorage.removeItem('wagamachi_zone_data');
    localStorage.removeItem('wagamachi_trains_data');
    localStorage.removeItem('wagamachi_fleet_data');
    localStorage.removeItem('wagamachi_next_fleet_id');
    localStorage.removeItem('wagamachi_time_data');
    // 旧キーの完全クリーンアップ
    localStorage.removeItem('stk_3d_world');
    localStorage.removeItem('saikyo_save_data');
    localStorage.removeItem('saikyo_zone_data');
    localStorage.removeItem('saikyo_trains_data');
    localStorage.removeItem('saikyo_fleet_data');
    localStorage.removeItem('saikyo_next_fleet_id');
    localStorage.removeItem('saikyo_time_data');
    this.cancelPendingPlacements();
    this.scheduleUI.close();
    this.switchScheduleUI.close();
    this.uiManager.closeInspector();
    const reportModal = document.getElementById('report-modal');
    if (reportModal) reportModal.classList.add('hidden');
    const vehicleModal = document.getElementById('vehicle-modal');
    if (vehicleModal) vehicleModal.classList.add('hidden');
    const fleetModal = document.getElementById('fleet-modal');
    if (fleetModal) fleetModal.classList.add('hidden');
    const helpModal = document.getElementById('help-modal');
    if (helpModal) helpModal.classList.add('hidden');

    this.gridManager = new GridManager(64, 'balanced');
    this.worldMap.setGridSize(64);
    this.worldMap.setElevationProvider((x, z) => {
      const cell = this.gridManager.getCell(x, 1, z);
      return cell ? Math.max(0, (cell.elevation - 1) * 3.0) : 0;
    });
    this.cityGrowth.setGridManager(this.gridManager);
    this.worldMap.gridManagerRef = this.gridManager;
    this.worldMap.setActiveLayer(1);
    this.inputController.setActiveLayer(1);
    this.uiManager.setFloorActive(1);
    this.renderer.updateGroundAndGridSize(64);
    this.renderer.clearGroundHoles();
    this.worldMap.clearAll();
    this.terrainRenderer.clear(this.renderer.scene);
    this.trainManager.removeAllTrains();
    this.fleetRegistry = [];
    this.worldLabelManager.clear();
    this.economy.resetAll();
    this.timeManager.deserialize({ year: 2026, month: 4, day: 1, hour: 6, minute: 0, speedLevel: 1 });
    this.uiManager.setSpeedUI(1);
    this.economy.syncDate(2026, 4, 1);
    this.zoneManager.clearAll();
    this.demandEngine.clearCache();
    for (const mesh of this.zoneOverlayMeshes.values()) {
      this.zoneOverlayGroup.remove(mesh);
    }
    this.zoneOverlayMeshes.clear();
    this.chunkManager.setGridManager(this.gridManager);
    this.miniMap.setGridManager(this.gridManager);
    this.buildInitialCity();
    this.terrainRenderer.build(this.gridManager, this.renderer.scene);
    this.cameraManager.stopTracking();
    this.cameraManager.setQuarterViewMode();
    this.uiManager.setCameraModeUI('orbit');
    this.audioManager.stopCabMotorSound();

    // 財務レポートの数値を初期化
    const allTiles = this.worldMap.getAllTiles();
    const trackCount = allTiles.filter(t => isTrackLikeType(t.type)).length;
    const stationCount = allTiles.filter(t => WorldMap.isStationTileType(t.type)).length;
    const reportData = this.economy.getFinancialReport(trackCount, this.trainManager.getTrains().length, stationCount);
    this.uiManager.updateFinancialReport(reportData);

    this.gameState.returnToTitle();
    this.uiManager.showTitleScreen(false);
  }

  private gameLoop(time: number) {
    requestAnimationFrame(this.gameLoop.bind(this));

    const deltaTime = Math.min((time - this.lastTime) / 1000, 0.1);
    this.lastTime = time;

    // タイトル画面表示中は背景デモ（列車走行・カメラ・描画）を更新
    if (this.gameState.phase === 'title') {
      this.trainManager.update(deltaTime, 1, () => {}, this.timeManager.hour, this.timeManager.minute);
      this.cameraManager.update(deltaTime);
      this.renderer.render(this.cameraManager.activeCamera);
      this.worldLabelManager.clear();
      return;
    }

    // 1. Time Synchronization System (1秒＝1分スケーリング、0/1/3/10倍速制御、税金イベント判定)
    this.timeManager.update(deltaTime);
    const gameplayMult = this.timeManager.currentMultiplier;

    // 経済カレンダー日時・時刻をTimeManagerと同期
    this.economy.year = this.timeManager.year;
    this.economy.month = this.timeManager.month;
    this.economy.day = this.timeManager.day;
    this.economy.setTime(this.timeManager.hour, this.timeManager.minute);

    // 3D空間音響のリスナー位置（カメラ注視点）を更新
    this.trainManager.setListenerPosition(this.cameraManager.target);

    // 2. Train Simulation (フレームレート非依存補間移動・駅停車ダイヤ)
    this.trainManager.update(
      deltaTime,
      gameplayMult,
      (fare) => {
        this.economy.addFunds(fare);
      },
      this.timeManager.hour,
      this.timeManager.minute,
      (x, z, hour) => this.demandEngine.getDemandMultiplier(hour, x, z),
      {
        tryLoad: (x, z, capacity, layer) => this.cargoSystem.tryLoadCargoFromStation(this.worldMap, x, z, capacity, layer),
        tryUnload: (x, z, containers, layer) => this.cargoSystem.tryUnloadCargoAtCommercialStation(this.worldMap, x, z, containers, layer),
        isCommercialStation: (x, z, layer) => this.cargoSystem.isStationInArea(this.worldMap, x, z, 'commercial', layer),
        onStationCargoChanged: (x, z, layer) => {
          this.updateCargoYardVisual(x, z, (layer ?? 1) as GridLayer);
        }
      },
      (cost) => {
        this.economy.spendFunds(cost, false);
      }
    );

    // 2b. 貨物経済循環（工業ゾーンのコンテナ自動生産・商業魅力度の自然減衰）
    this.cargoSystem.update(deltaTime, gameplayMult);

    // 貨物ヤードのコンテナ段数（1個単位）視覚演出の定期同期
    this.cargoVisualTimer += deltaTime;
    if (this.cargoVisualTimer >= 1.5) {
      this.cargoVisualTimer = 0;
      for (const tile of this.worldMap.getAllTiles()) {
        if (tile.isCargoYard || tile.type.startsWith('cargo_station')) {
          this.updateCargoYardVisual(tile.x, tile.z, (tile.layer ?? 1) as GridLayer);
        }
      }
    }

    // 3. City Growth
    // 1日1回正午以降に都市を発展させ、人口加算・ミニマップ更新・需要キャッシュ更新を連動
    this.cityGrowth.update(this.timeManager.hour, this.timeManager.minute, this.timeManager.day, (newPop) => {
      this.economy.addPopulation(newPop);
      this.miniMap.requestStaticUpdate();
      this.demandEngine.clearCache();
    });

    // 4. Camera (列車追従・クォータービュー補間)
    this.cameraManager.update(deltaTime);

    // 4b. 超広大マップ用チャンクカリング ＆ ミニマップ更新
    this.chunkManager.update(this.cameraManager, this.renderer.scene);
    this.miniMap.update();

    // 時刻に応じた昼夜・夕暮れ照明の連続スムーズ遷移およびビル・駅の発光演出
    this.renderer.updateLightingByTime(this.timeManager.hour, this.timeManager.minute);
    if (this.renderer.getLightingMode() === 'auto') {
      const effTime = this.renderer.getTimeOfDay();
      if (this.lastEffectiveTime !== effTime) {
        this.lastEffectiveTime = effTime;
        this.uiManager.setTimeLightingMode('auto', effTime);
      }
    }

    // 5. UI Updates (コロン点滅対応の日時・時刻表示、資金赤字ハイライト)
    this.uiManager.updateHUD(
      this.timeManager.getFormattedDate(),
      this.timeManager.getFormattedTime(true),
      this.economy.getFormattedFunds(),
      this.economy.getFormattedPopulation(),
      !this.economy.canInvest
    );

    if (this.cameraManager.viewMode === 'cab_view') {
      const target = this.cabTargetTrainId !== null
        ? this.trainManager.getFollowTargetByTrainId(this.cabTargetTrainId)
        : this.trainManager.getFollowTarget(0);
      if (target) {
        this.cameraManager.setCabViewMode(target);
        this.uiManager.updateCabSpeed(target.speed ?? 0);
        this.audioManager.updateCabSpeed(target.speed ?? 0);
      } else {
        // 追従対象列車が撤去または消滅した場合は自由視点に安全復帰
        this.exitCabView();
      }
    }

    // ⑤ 選択中オブジェクトのインスペクターリアルタイム更新（DOM再構築を行わず動的数値のみ更新）
    if (this.selectedTrainId !== null) {
      const train = this.trainManager.getTrains().find(t => t.id === this.selectedTrainId);
      if (train) {
        this.uiManager.updateTrainInspectorDynamicValues(train);
        // カメラ追尾中、列車が地下や高架へ階層移動した場合はカメラ階層も自動追従
        if (this.cameraManager.isTracking && train.currentTile.layer !== this.worldMap.activeLayer) {
          this.switchActiveLayer(train.currentTile.layer, false);
        }
      } else {
        this.selectedTrainId = null;
      }
    } else if (this.selectedTilePos !== null) {
      const tile = this.worldMap.getTile(this.selectedTilePos.x, this.selectedTilePos.z, this.selectedTilePos.layer);
      if (tile && (tile.type.startsWith('station') || tile.type === 'signal_yard' || tile.type.startsWith('cargo_station'))) {
        const runLength = this.worldMap.getStationRunLength(tile.x, tile.z, this.selectedTilePos.layer);
        const stData = this.worldMap.getStationAggregateData(tile.x, tile.z, this.selectedTilePos.layer);
        this.uiManager.updateStationInspectorDynamicValues(tile, runLength, stData);
      }
    }

    // スマホ用ドラッグ延伸プレビューの動的追従（カメラ移動連動）
    if (this.mobileDragStartTile) {
      const reticleTile = this.getReticleTile();
      if (reticleTile) {
        this.updateDragPreview(this.mobileDragStartTile, reticleTile);
      }
    }

    // 財務レポートモーダルが開いている場合のみ動的数値を更新（非表示時の全タイル走査・DOM負荷を遮断）
    const reportModal = document.getElementById('report-modal');
    if (reportModal && !reportModal.classList.contains('hidden')) {
      const allTiles = this.worldMap.getAllTiles();
      const trackCount = allTiles.filter(t => isTrackLikeType(t.type)).length;
      const stationCount = allTiles.filter(t => WorldMap.isStationTileType(t.type)).length;
      const reportData = this.economy.getFinancialReport(trackCount, this.trainManager.getTrains().length, stationCount);
      this.uiManager.updateFinancialReport(reportData);
    }

    // Auto-save
    this.autoSaveTimer += deltaTime;
    if (this.autoSaveTimer >= 30) {
      this.autoSaveTimer = 0;
      this.saveGame();
    }

    // 6. 列車表示の階層スライス同期（'all' の時は地上階 layer>=1 の列車をすべて表示）
    for (const train of this.trainManager.getTrains()) {
      const tLayer = train.currentTile.layer;
      if (this.currentDisplayLayer === 'all') {
        train.mesh.visible = tLayer >= 1;
      } else {
        train.mesh.visible = tLayer === this.currentDisplayLayer;
      }
    }

    // 7. Render
    this.renderer.render(this.cameraManager.activeCamera);

    // 8. 全体視点時の駅待機乗客数および旅客列車乗客数の数字追従表示更新
    this.worldLabelManager.update(
      this.cameraManager.activeCamera,
      this.cameraManager.viewMode,
      this.currentDisplayLayer,
      this.worldMap,
      this.trainManager
    );
  }

  /**
   * トンネル出入口および地下勾配スロープの開口表示検証用テストセットアップ
   */
  private setupTestCutouts(): void {
    this.uiManager.hideTitleScreen();

    // 1. 地下スロープの配置 (地上1F -> 地下B1, 西->東)
    // 平地エリア (x: 0, z: 6) 付近
    this.worldMap.placeUndergroundSlope(0, 6, 1, true, 1);

    // 2. 山岳トンネルの自動配置
    // 山岳境界（標高2以上かつ隣接が標高1）を探索
    let mountainBorder: { x: number; z: number } | null = null;
    for (let r = 5; r <= 35 && !mountainBorder; r++) {
      for (let dx = -r; dx <= r && !mountainBorder; dx++) {
        for (let dz = -r; dz <= r && !mountainBorder; dz++) {
          const c0 = this.gridManager.getCell(dx, 1, dz);
          const cLeft = this.gridManager.getCell(dx - 1, 1, dz);
          if (c0 && cLeft && c0.elevation >= 2 && cLeft.elevation === 1 && !c0.isWater && !cLeft.isWater) {
            mountainBorder = { x: dx, z: dz };
            break;
          }
        }
      }
    }

    if (mountainBorder) {
      const { x, z } = mountainBorder;
      // 平地アプローチ線路
      this.worldMap.setTile(x - 2, z, 'rail_ground', 1, 1);
      this.worldMap.setTile(x - 1, z, 'rail_ground', 1, 1);
      // 山岳トンネル線路
      this.worldMap.setTile(x, z, 'rail_ground', 1, 1);
      this.worldMap.setTile(x + 1, z, 'rail_ground', 1, 1);
      this.worldMap.setTile(x + 2, z, 'rail_ground', 1, 1);
      // 山岳メッシュを再構築してトンネル開口部を反映
      this.terrainRenderer.rebuildAll(this.gridManager, this.renderer.scene);

      // カメラを注視
      const midX = (x + 1.5) / 2;
      const midZ = (z + 6) / 2;
      this.cameraManager.jumpToPosition({ x: midX * 2.0, z: midZ * 2.0 });
    }
  }

  /**
   * 3次元グリッド管理マネージャーを取得
   */
  public getGridManager(): GridManager {
    return this.gridManager;
  }

  /**
   * クォータービューカメラマネージャーを取得
   */
  public getCameraManager(): CameraManager {
    return this.cameraManager;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  (window as any).gameApp = new GameApp();
});
