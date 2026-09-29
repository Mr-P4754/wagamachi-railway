import {
  TileType,
  TileData,
  createDefaultSwitchSchedule
} from '../simulation/WorldMap';
import { FinancialReportData } from '../simulation/Economy';
import { CameraMode } from '../graphics/CameraManager';
import { VEHICLE_CATALOG, VehicleModelInfo, getMaxCapacity } from '../simulation/VehicleCatalog';
import { TrainInstance } from '../simulation/TrainManager';
import { UI_ICONS } from './icons';
import { MapSize, TerrainType, GridLayer, DeadlockEvent } from '../core/types';
import { TimeLightingMode, TimeOfDay } from '../engine/Renderer';

export type ActiveTool =
  | 'select'
  | 'rail-straight'
  | 'rail-curve'
  | 'rail-curve-elevated'
  | 'point-switch'
  | 'point-switch-elevated'
  | 'scissors-crossing'
  | 'scissors-crossing-elevated'
  | 'rail-slope'
  | 'rail-slope-underground'
  | 'rail-tunnel'
  | 'rail-elevated'
  | 'station-small'
  | 'station-elevated'
  | 'signal-yard'
  | 'cargo-station'
  | 'train-buy'
  | 'road'
  | 'building-res'
  | 'building-com'
  | 'building-ind'
  | 'nature'
  // Phase2: RCIゾーニングブラシ ＆ 貨物ヤード指定
  | 'zone-residential'
  | 'zone-commercial'
  | 'zone-industrial'
  | 'zone-clear'
  | 'cargo-yard'
  // ② 撤去はカテゴリごとに分割し、該当カテゴリの物のみ削除できるようにする
  | 'demolish-track'
  | 'demolish-station'
  | 'demolish-city'
  | 'demolish-train';

export const TOOL_CONFIG: Record<ActiveTool, { cost: number; tileType: TileType | null; name: string; icon: string }> = {
  'select': { cost: 0, tileType: null, name: '選択', icon: UI_ICONS.select },
  'rail-straight': { cost: 500000, tileType: 'rail_ground', name: '直線線路', icon: UI_ICONS.railStraight },
  'rail-elevated': { cost: 1500000, tileType: 'rail_elevated', name: '高架線路', icon: UI_ICONS.railElevated },
  'rail-curve': { cost: 800000, tileType: null, name: '曲線線路', icon: UI_ICONS.railCurve },
  'rail-curve-elevated': { cost: 2400000, tileType: null, name: '高架曲線', icon: UI_ICONS.railCurve },
  'rail-slope': { cost: 1500000, tileType: 'rail_slope', name: '勾配線路', icon: UI_ICONS.railSlope },
  'rail-slope-underground': { cost: 2000000, tileType: 'rail_slope_underground', name: '地下勾配線路', icon: UI_ICONS.railSlopeUnderground },
  'rail-tunnel': { cost: 1200000, tileType: 'rail_ground', name: 'トンネル線路', icon: UI_ICONS.railTunnel },
  // ② 分岐器は1×1マス
  'point-switch': { cost: 1000000, tileType: null, name: '分岐器', icon: UI_ICONS.pointSwitch },
  'point-switch-elevated': { cost: 2000000, tileType: null, name: '高架分岐器', icon: UI_ICONS.pointSwitch },
  // ③ シーサスクロッシング（複線用交差分岐、2×2）
  'scissors-crossing': { cost: 3000000, tileType: null, name: 'シーサスクロッシング', icon: UI_ICONS.scissorsCrossing },
  'scissors-crossing-elevated': { cost: 5000000, tileType: null, name: '高架シーサス', icon: UI_ICONS.scissorsCrossing },
  'station-small': { cost: 8000000, tileType: 'station_ground', name: '駅', icon: UI_ICONS.station },
  'station-elevated': { cost: 18000000, tileType: 'station_elevated', name: '高架駅', icon: UI_ICONS.stationElevated },
  'signal-yard': { cost: 2000000, tileType: 'signal_yard', name: '信号場・留置線', icon: UI_ICONS.pointSwitch },
  'cargo-station': { cost: 6000000, tileType: 'cargo_station_ground', name: '貨物駅', icon: UI_ICONS.cargoYard },
  'train-buy': { cost: 0, tileType: null, name: '列車購入', icon: UI_ICONS.train },
  'road': { cost: 300000, tileType: 'road', name: '道路', icon: UI_ICONS.road },
  'building-res': { cost: 4000000, tileType: 'residence', name: '住宅区画', icon: UI_ICONS.buildingRes },
  'building-com': { cost: 12000000, tileType: 'commercial', name: '商業ビル', icon: UI_ICONS.buildingCom },
  'building-ind': { cost: 8000000, tileType: 'industrial', name: '工業施設', icon: UI_ICONS.zoneInd },
  'nature': { cost: 200000, tileType: 'nature', name: '植林', icon: UI_ICONS.nature },
  'zone-residential': { cost: 100000, tileType: null, name: '住宅ゾーン', icon: UI_ICONS.zoneRes },
  'zone-commercial': { cost: 100000, tileType: null, name: '商業ゾーン', icon: UI_ICONS.zoneCom },
  'zone-industrial': { cost: 100000, tileType: null, name: '工業ゾーン', icon: UI_ICONS.zoneInd },
  'zone-clear': { cost: 0, tileType: null, name: 'ゾーン解除', icon: UI_ICONS.zoneClear },
  'cargo-yard': { cost: 3000000, tileType: null, name: '貨物ヤード指定', icon: UI_ICONS.cargoYard },
  'demolish-track': { cost: 200000, tileType: 'empty', name: '線路撤去', icon: UI_ICONS.demolish },
  'demolish-station': { cost: 200000, tileType: 'empty', name: '駅撤去', icon: UI_ICONS.demolish },
  'demolish-city': { cost: 200000, tileType: 'empty', name: '構造物撤去', icon: UI_ICONS.demolish },
  'demolish-train': { cost: 0, tileType: 'empty', name: '列車撤去', icon: UI_ICONS.demolish }
};

// ⑤ ツールのカテゴリー分け（多層モーダル化してツールバーをすっきりさせる）
export interface ToolCategory {
  id: string;
  name: string;
  icon: string;
  tools: ActiveTool[];
  // ② このカテゴリ専用の撤去ツール（そのカテゴリに属する物だけ撤去できる）
  demolishTool: ActiveTool;
}

export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    id: 'track',
    name: '線路',
    icon: UI_ICONS.railStraight,
    tools: [
      'rail-straight', 'rail-curve', 'rail-slope', 'rail-slope-underground',
      'point-switch', 'scissors-crossing'
    ],
    demolishTool: 'demolish-track'
  },
  {
    id: 'station',
    name: '駅',
    icon: UI_ICONS.station,
    tools: ['station-small', 'signal-yard', 'cargo-station'],
    demolishTool: 'demolish-station'
  },
  {
    id: 'city',
    name: '街づくり',
    icon: UI_ICONS.buildingCom,
    tools: ['road', 'building-res', 'building-com', 'building-ind', 'nature'],
    demolishTool: 'demolish-city'
  },
  {
    id: 'zoning',
    name: 'ゾーニング',
    icon: UI_ICONS.zoneRes,
    tools: ['zone-residential', 'zone-commercial', 'zone-industrial'],
    demolishTool: 'zone-clear'
  },
  {
    id: 'train',
    name: '列車',
    icon: UI_ICONS.train,
    tools: ['train-buy'],
    demolishTool: 'demolish-train'
  }
];

export interface FleetItem {
  id: string;
  name: string;
  model: VehicleModelInfo;
  cars: number;
  status: 'in_depot' | 'deployed';
  activeTrainId?: number;
  totalPassengers?: number;
  totalRevenue?: number;
}

export class UIManager {
  private activeTool: ActiveTool = 'select';

  // DOM references
  private dateDisplay = document.getElementById('date-display')!;
  private fundsDisplay = document.getElementById('funds-display')!;
  private popDisplay = document.getElementById('population-display')!;
  private toastContainer = document.getElementById('toast-container');

  private speedButtons = {
    pause: document.getElementById('btn-speed-pause')!,
    s1: document.getElementById('btn-speed-1')!,
    s2: document.getElementById('btn-speed-2')!,
    s3: document.getElementById('btn-speed-3')!,
    s4: document.getElementById('btn-speed-4')!,
    s5: document.getElementById('btn-speed-5')!
  };

  private audioToggleBtn = document.getElementById('btn-audio-toggle')!;
  private guideToggleBtn = document.getElementById('btn-guide-toggle');
  private helpModal = document.getElementById('help-modal')!;
  private closeHelpBtn = document.getElementById('btn-close-help')!;

  // ⑦ 車両管理モーダル references
  private fleetToggleBtn = document.getElementById('btn-fleet-toggle');
  private fleetFromModalBtn = document.getElementById('btn-fleet-from-modal');
  private fleetModal = document.getElementById('fleet-modal')!;
  private closeFleetBtn = document.getElementById('btn-close-fleet')!;
  private fleetList = document.getElementById('fleet-list')!;

  private reportBtn = document.getElementById('btn-report')!;
  private reportModal = document.getElementById('report-modal')!;
  private closeReportBtn = document.getElementById('btn-close-report')!;

  private camViewBtn = document.getElementById('btn-cam-view')!;
  private camViewText = document.getElementById('cam-view-text');
  private timeToggleBtn = document.getElementById('btn-time-toggle')!;
  private timeIcon = document.getElementById('time-icon')!;
  private timeText = document.getElementById('time-text');
  private timeModeBadge = document.getElementById('time-mode-badge');
  private gridToggleBtn = document.getElementById('btn-grid-toggle')!;
  private slicerToggleBtn = document.getElementById('btn-slicer-toggle');
  private minimapToggleBtn = document.getElementById('btn-minimap-toggle');
  private floorSlicerEl = document.getElementById('floor-slicer');

  private cabOverlay = document.getElementById('cab-view-overlay')!;
  private cabTrainName = document.getElementById('cab-train-name');
  private cabSpeedVal = document.getElementById('cab-speed-val')!;
  private exitCabBtn = document.getElementById('btn-exit-cab')!;
  private btnCabPrev = document.getElementById('btn-cab-prev');
  private btnCabNext = document.getElementById('btn-cab-next');
  private btnCabChange = document.getElementById('btn-cab-change');

  private cabSelectModal = document.getElementById('cab-select-modal');
  private closeCabSelectBtn = document.getElementById('btn-close-cab-select');
  private cabTrainListEl = document.getElementById('cab-train-list');

  private clockDisplay = document.getElementById('clock-display')!;

  // ⑤ カテゴリー化された多層ツールバー
  private categoryBtns = document.querySelectorAll<HTMLElement>('.category-btn');
  private topLevelToolBtns = document.querySelectorAll<HTMLElement>('#build-toolbar .tool-btn');
  private toolSubmenu = document.getElementById('tool-submenu')!;
  private submenuTitle = document.getElementById('submenu-title')!;
  private submenuGrid = document.getElementById('submenu-grid')!;
  private closeSubmenuBtn = document.getElementById('btn-close-submenu')!;
  private activeCategoryId: string | null = null;

  // ⑧ 回転バー / ⑦ 設置決定・キャンセル / ② 分岐切替 / ① 駅ホーム左右切替
  private rotationHint = document.getElementById('rotation-hint')!;
  private rotationValueEl = document.getElementById('rotation-value')!;
  private confirmPlacementBtn = document.getElementById('btn-confirm-placement')!;
  private cancelPlacementBtn = document.getElementById('btn-cancel-placement')!;
  private rotatePlacementBtn = document.getElementById('btn-rotate-placement')!;
  private switchSideBtn = document.getElementById('btn-switch-side-toggle')!;
  private stationSideHintBtn = document.getElementById('btn-station-side-hint-toggle');

  // ④ 駅ホーム有効長セレクター & ① ホーム左右切替ボタン
  private stationLengthSelector = document.getElementById('station-length-selector')!;
  private btnStLenMinus = document.getElementById('btn-st-len-minus');
  private btnStLenPlus = document.getElementById('btn-st-len-plus');
  private stLenDisplay = document.getElementById('st-len-display');
  private stationSideBtn = document.getElementById('btn-station-side-toggle');
  private btnStationRotate = document.getElementById('btn-station-rotate-toggle');
  private selectedStationLength: number = 2; // 1〜10両対応

  // ② 開発テスト用: 資金無限モードトリガー
  private fundsCardBtn = document.getElementById('btn-funds-toggle');
  private infiniteFundsReportBtn = document.getElementById('btn-infinite-funds');

  private inspectorPanel = document.getElementById('inspector-panel')!;
  private inspectCoords = document.getElementById('inspect-coords')!;
  private inspectType = document.getElementById('inspect-type')!;
  private inspectExtraVal = document.getElementById('inspect-extra-val')!;
  private inspectFinancialBox = document.getElementById('inspect-financial-box')!;
  private inspectActions = document.getElementById('inspect-actions')!;
  private closeInspectBtn = document.getElementById('btn-close-inspect')!;

  // 駅名・列車名リネーム用DOM references
  private inspectRenameRow = document.getElementById('inspect-rename-row');
  private inspectRenameInput = document.getElementById('inspect-rename-input') as HTMLInputElement | null;
  private btnApplyRename = document.getElementById('btn-apply-rename');

  // ①② 分岐器ダイヤ設定モーダル（10分刻み）用プロパティ
  public getCurrentHour?: () => number;
  public getCurrentMinute?: () => number;
  private scheduleModal = document.getElementById('schedule-modal')!;
  private scheduleModalTitle = document.getElementById('schedule-modal-title')!;
  private scheduleModalBody = document.getElementById('schedule-modal-body')!;
  private closeScheduleBtn = document.getElementById('btn-close-schedule')!;
  private selectedScheduleHour: number = 8;
  private currentEditingSwitchHub: TileData | null = null;
  private switchPaletteDir: 'straight' | 'diverge' = 'straight';

  // ⑤ & ⑦ Vehicle Modal references
  private vehicleModal = document.getElementById('vehicle-modal')!;
  private vehicleGrid = document.getElementById('vehicle-grid')!;
  private closeVehicleBtn = document.getElementById('btn-close-vehicle')!;
  private vehTotalPrice = document.getElementById('veh-total-price')!;
  private confirmBuyTrainBtn = document.getElementById('btn-confirm-buy-train')!;
  private btnCarsMinus = document.getElementById('btn-cars-minus');
  private btnCarsPlus = document.getElementById('btn-cars-plus');
  private carsDisplay = document.getElementById('cars-display');

  private selectedVehicle: VehicleModelInfo = VEHICLE_CATALOG[0]; // Default: 通勤型列車
  private selectedCarCount: number = 3; // 1〜10両対応

  // タイトル画面 references
  private titleOverlay = document.getElementById('title-screen-overlay');
  private titleMainMenu = document.getElementById('title-main-menu');
  private titleNewGameSetup = document.getElementById('title-new-game-setup');
  private btnTitleNew = document.getElementById('btn-title-new');
  private btnTitleContinue = document.getElementById('btn-title-continue') as HTMLButtonElement | null;
  private btnTitleHelp = document.getElementById('btn-title-help');
  private btnTitleBack = document.getElementById('btn-title-back');
  private btnTitleStart = document.getElementById('btn-title-start');
  private btnTitleClose = document.getElementById('btn-title-close');
  private selectedMapSize: MapSize = 256;
  private selectedTerrainType: TerrainType = 'balanced';

  // カメラ・視点回転 ＆ 透過ボタン
  private btnRotateCCW = document.getElementById('btn-rotate-ccw');
  private btnRotateCW = document.getElementById('btn-rotate-cw');
  private btnXRayToggle = document.getElementById('btn-xray-toggle');

  // Callbacks
  public onToolChanged: (tool: ActiveTool) => void = () => {};
  // ⑤ speed: 0=一時停止, 1=通常速度, 2=高速, 3=超高速（実際のゲーム内時間換算は main.ts 側で行う）
  public onSpeedChanged: (speedLevel: number) => void = () => {};
  public onAudioToggled: () => void = () => {};
  public onTimeToggled: () => void = () => {};
  public onGridToggled: (visible: boolean) => void = () => {};
  public onCameraModeToggled: () => void = () => {};
  public onCabPrevRequested: () => void = () => {};
  public onCabNextRequested: () => void = () => {};
  public onCabSelectRequested: () => void = () => {};
  public onExitCab: () => void = () => {};
  public onSaveRequested: () => void = () => {};
  public onResetRequested: () => void = () => {};
  public onTogglePointSwitch: (x: number, z: number, layer?: GridLayer) => void = () => {};
  // ③ シーサスクロッシングの開通状態切替
  public onCycleCrossing: (x: number, z: number, layer?: GridLayer) => void = () => {};
  public onConfirmBuyTrain: (model: VehicleModelInfo, cars: number) => void = () => {};
  // ① 列車撤去
  public onRemoveTrain: (trainId: number) => void = () => {};
  // ⑦ 仮置き中プレースメントの決定・キャンセル
  public onConfirmPlacement: () => void = () => {};
  public onCancelPlacement: () => void = () => {};
  public onRotatePlacement: () => void = () => {};
  // ④ 駅有効長セレクター変更 / インスペクターからの変更
  public onStationLengthChanged: (length: number) => void = () => {};
  public onSetStationLength: (x: number, z: number, targetLength: number) => void = () => {};
  // 駅名・編成名自由リネームコールバック
  public onRenameStation?: (x: number, z: number, newName: string, layer?: GridLayer) => void;
  public onRenameTrain?: (trainId: number, newName: string) => void;
  // ⑦ 車両基地モーダル開閉・デプロイ・回送・追跡
  public onOpenFleetModal: () => void = () => {};
  public onDeployFleetTrain: (fleetId: string) => void = () => {};
  public onRecallFleetTrain: (fleetId: string) => void = () => {};
  public onTrackFleetTrain: (fleetId: string) => void = () => {};
  public onChangeFleetCarCount: (fleetId: string, delta: number) => void = () => {};
  public onSellFleetTrain: (fleetId: string) => void = () => {};
  // ② 分岐器の左右分岐切替
  public onToggleSwitchSide: () => void = () => {};
  // ① 駅舎ホーム左右切替
  public onToggleStationSide: () => void = () => {};
  // ② 開発テスト用: 資金無限モード切替
  public onToggleInfiniteFunds: () => void = () => {};
  // Phase3: 純粋ダイヤ編成UI（サイドパネル/ボトムシート）を開く要求
  public onOpenStationSchedule: (tile: TileData) => void = () => {};
  // 分岐器・シーサスクロッシング用ダイヤ設定UIを開く要求
  public onOpenSwitchSchedule: (tile: TileData) => void = () => {};
  // タイトル画面＆カメラ制御コールバック
  public onStartNewGame: (size: MapSize, terrain: TerrainType) => void = () => {};
  public onResumeGame: () => void = () => {};
  public onRotateCameraCCW: () => void = () => {};
  public onRotateCameraCW: () => void = () => {};
  public onToggleXRay: () => void = () => {};
  // 階層スライサー＆スマホ操作コールバック
  public onLayerChanged: (layer: GridLayer | 'all') => void = () => {};
  public onMobileAction: (action: 'start' | 'confirm' | 'cancel' | 'rotate') => void = () => {};

  private floorButtons: NodeListOf<HTMLButtonElement> | null = null;
  private crosshairReticle = document.getElementById('crosshair-reticle');
  private mobileActionDock = document.getElementById('mobile-action-dock');
  private btnMobileStart = document.getElementById('btn-mobile-start');
  private btnMobileConfirm = document.getElementById('btn-mobile-confirm');
  private btnMobileRotate = document.getElementById('btn-mobile-rotate');
  private btnMobileCancel = document.getElementById('btn-mobile-cancel');

  // インスペクター追跡と閉鎖コールバック
  private inspectedTileCoords: { x: number; z: number; layer: GridLayer } | null = null;
  private inspectedTrainId: number | null = null;
  public onInspectorClosed: () => void = () => {};

  constructor() {
    this.bindEvents();
    this.buildVehicleCatalogUI();
  }

  private bindEvents() {
    // タイトル画面イベント
    this.btnTitleNew?.addEventListener('click', () => {
      this.titleMainMenu?.classList.add('hidden');
      this.titleNewGameSetup?.classList.remove('hidden');
    });

    this.btnTitleBack?.addEventListener('click', () => {
      this.titleNewGameSetup?.classList.add('hidden');
      this.titleMainMenu?.classList.remove('hidden');
    });

    this.btnTitleContinue?.addEventListener('click', () => {
      this.hideTitleScreen();
      this.onResumeGame();
    });

    this.btnTitleClose?.addEventListener('click', () => {
      this.hideTitleScreen();
      this.onResumeGame();
    });

    this.btnTitleHelp?.addEventListener('click', () => {
      this.helpModal.classList.remove('hidden');
    });

    // 4×4 パラメータ選択 (サイズ)
    const sizeBtns = document.querySelectorAll<HTMLElement>('.size-grid .matrix-btn');
    sizeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        sizeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedMapSize = parseInt(btn.getAttribute('data-size') || '256') as MapSize;
      });
    });

    // 4×4 パラメータ選択 (地形)
    const terrainBtns = document.querySelectorAll<HTMLElement>('.terrain-grid .matrix-btn');
    terrainBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        terrainBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedTerrainType = (btn.getAttribute('data-terrain') || 'balanced') as TerrainType;
      });
    });

    // 新規作成開始ボタン
    this.btnTitleStart?.addEventListener('click', () => {
      this.hideTitleScreen();
      this.onStartNewGame(this.selectedMapSize, this.selectedTerrainType);
    });

    // カメラ 90度ステップ回転ボタン
    this.btnRotateCCW?.addEventListener('click', () => {
      this.onRotateCameraCCW();
    });
    this.btnRotateCW?.addEventListener('click', () => {
      this.onRotateCameraCW();
    });

    // 建物半透明透過（X-Ray）ボタン
    this.btnXRayToggle?.addEventListener('click', () => {
      this.onToggleXRay();
    });

    // ⑤ 最上段ツール（選択・列車購入・撤去）
    this.topLevelToolBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tool = btn.getAttribute('data-tool') as ActiveTool;
        this.selectTool(tool);
        this.closeSubmenu();
      });
    });

    // ④ 駅ホーム有効長セレクター（ステッパー操作 1〜10両）
    const updateStLenUI = (len: number) => {
      this.selectedStationLength = len;
      if (this.stLenDisplay) this.stLenDisplay.textContent = `${len}両`;
      this.onStationLengthChanged(len);
    };

    this.btnStLenMinus?.addEventListener('click', () => {
      if (this.selectedStationLength > 1) {
        updateStLenUI(this.selectedStationLength - 1);
      }
    });
    this.btnStLenPlus?.addEventListener('click', () => {
      if (this.selectedStationLength < 10) {
        updateStLenUI(this.selectedStationLength + 1);
      }
    });

    // ⑤ カテゴリーボタン → サブメニュー（多層モーダル）を開閉
    this.categoryBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const category = btn.getAttribute('data-category')!;
        if (this.activeCategoryId === category && !this.toolSubmenu.classList.contains('hidden')) {
          this.closeSubmenu();
        } else {
          // 前の設置作業（仮置き・ドラッグ・列車配置等）を完全にキャンセル
          this.onCancelPlacement();

          // ツールを一旦安全な未選択状態（select）にリセット（勝手に代表ツールを自動選択しない）
          this.selectTool('select');

          this.openSubmenu(category);
        }
      });
    });

    this.closeSubmenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeSubmenu();
      this.onCancelPlacement();
      this.selectTool('select');
    });

    // サブメニュー外クリック時にサブメニューを安全に閉じる
    window.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (!this.toolSubmenu.classList.contains('hidden')) {
        const isClickInsideSubmenu = target ? !!target.closest('#tool-submenu') : false;
        const isClickCategoryBtn = target ? !!target.closest('.category-btn') : false;
        if (!isClickInsideSubmenu && !isClickCategoryBtn) {
          this.closeSubmenu();
        }
      }
    });

    // ⑦ 設置決定・キャンセルボタン / ⑤ 回転ボタン / ② 分岐左右切替 / ① 駅ホーム左右切替
    this.confirmPlacementBtn.addEventListener('click', () => this.onConfirmPlacement());
    this.cancelPlacementBtn.addEventListener('click', () => this.onCancelPlacement());
    this.rotatePlacementBtn.addEventListener('click', () => this.onRotatePlacement());
    this.switchSideBtn.addEventListener('click', () => this.onToggleSwitchSide());
    this.stationSideBtn?.addEventListener('click', () => this.onToggleStationSide());
    this.stationSideHintBtn?.addEventListener('click', () => this.onToggleStationSide());
    this.btnStationRotate?.addEventListener('click', () => this.onRotatePlacement());

    // ② 開発テスト用 資金無限モード切替
    this.fundsCardBtn?.addEventListener('click', () => this.onToggleInfiniteFunds());
    this.infiniteFundsReportBtn?.addEventListener('click', () => this.onToggleInfiniteFunds());

    // 全7階層スライサーボタンイベント
    const floorBtns = document.querySelectorAll<HTMLButtonElement>('.floor-btn');
    floorBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onCancelPlacement();
        const rawLayer = btn.getAttribute('data-layer') || '1';
        const layer = rawLayer === 'all' ? 'all' : (parseInt(rawLayer, 10) as GridLayer);
        this.setFloorActive(layer);
        this.onLayerChanged(layer);
      });
    });

    // スマホアクションボタンイベント
    this.btnMobileStart?.addEventListener('click', () => this.onMobileAction('start'));
    this.btnMobileConfirm?.addEventListener('click', () => this.onMobileAction('confirm'));
    this.btnMobileRotate?.addEventListener('click', () => this.onMobileAction('rotate'));
    this.btnMobileCancel?.addEventListener('click', () => this.onMobileAction('cancel'));

    // Speed buttons
    const setSpeed = (speed: number, activeBtn: HTMLElement) => {
      Object.values(this.speedButtons).forEach(b => b.classList.remove('active'));
      activeBtn.classList.add('active');
      this.onSpeedChanged(speed);
    };

    this.speedButtons.pause.addEventListener('click', () => setSpeed(0, this.speedButtons.pause));
    this.speedButtons.s1.addEventListener('click', () => setSpeed(1, this.speedButtons.s1));
    this.speedButtons.s2.addEventListener('click', () => setSpeed(2, this.speedButtons.s2));
    this.speedButtons.s3.addEventListener('click', () => setSpeed(3, this.speedButtons.s3));
    this.speedButtons.s4?.addEventListener('click', () => setSpeed(4, this.speedButtons.s4));
    this.speedButtons.s5?.addEventListener('click', () => setSpeed(5, this.speedButtons.s5));

    // Audio
    this.audioToggleBtn.addEventListener('click', () => {
      this.onAudioToggled();
    });

    // ④ 操作ヘルプモーダル開閉
    this.guideToggleBtn?.addEventListener('click', () => {
      this.helpModal.classList.remove('hidden');
    });
    this.closeHelpBtn?.addEventListener('click', () => {
      this.helpModal.classList.add('hidden');
    });

    // ⑦ 車両管理モーダル開閉
    this.fleetToggleBtn?.addEventListener('click', () => {
      this.onCancelPlacement();
      this.onOpenFleetModal();
    });
    this.fleetFromModalBtn?.addEventListener('click', () => {
      this.vehicleModal.classList.add('hidden');
      this.onCancelPlacement();
      this.onOpenFleetModal();
    });
    this.closeFleetBtn?.addEventListener('click', () => {
      this.fleetModal.classList.add('hidden');
    });

    // ①② 大型ダイヤ設定モーダル開閉
    this.closeScheduleBtn?.addEventListener('click', () => {
      this.scheduleModal.classList.add('hidden');
    });

    // View controls
    this.camViewBtn.addEventListener('click', () => {
      this.onCameraModeToggled();
    });

    this.timeToggleBtn.addEventListener('click', () => {
      this.onTimeToggled();
    });

    let gridVisible = true;
    this.gridToggleBtn.addEventListener('click', () => {
      gridVisible = !gridVisible;
      this.gridToggleBtn.classList.toggle('active', gridVisible);
      this.onGridToggled(gridVisible);
    });

    // 階層スライサー表示切替
    let slicerVisible = true;
    this.slicerToggleBtn?.addEventListener('click', () => {
      slicerVisible = !slicerVisible;
      this.slicerToggleBtn?.classList.toggle('active', slicerVisible);
      this.floorSlicerEl?.classList.toggle('hidden', !slicerVisible);
    });

    // 路線図ミニマップ表示切替（スマホなど画面幅768px以下では画面専有を防ぐため初期状態を非表示にする）
    const isMobileScreen = window.innerWidth <= 768;
    let minimapVisible = !isMobileScreen;
    if (isMobileScreen) {
      this.minimapToggleBtn?.classList.remove('active');
      // DOMが作成された後に非表示クラスを付与
      setTimeout(() => {
        document.getElementById('minimap-container')?.classList.add('hidden');
      }, 50);
    }
    this.minimapToggleBtn?.addEventListener('click', () => {
      const minimap = document.getElementById('minimap-container');
      const currentHidden = minimap?.classList.contains('hidden') ?? !minimapVisible;
      minimapVisible = currentHidden;
      this.minimapToggleBtn?.classList.toggle('active', minimapVisible);
      minimap?.classList.toggle('hidden', !minimapVisible);
    });

    // Cab Exit & Navigation
    this.exitCabBtn.addEventListener('click', () => {
      this.onExitCab();
    });
    this.btnCabPrev?.addEventListener('click', () => {
      this.onCabPrevRequested();
    });
    this.btnCabNext?.addEventListener('click', () => {
      this.onCabNextRequested();
    });
    this.btnCabChange?.addEventListener('click', () => {
      this.onCabSelectRequested();
    });

    // 車窓列車選択モーダル
    this.closeCabSelectBtn?.addEventListener('click', () => {
      this.hideCabTrainSelectModal();
    });
    this.cabSelectModal?.addEventListener('click', (e) => {
      if (e.target === this.cabSelectModal) {
        this.hideCabTrainSelectModal();
      }
    });

    // Report modal
    this.reportBtn.addEventListener('click', () => {
      this.reportModal.classList.remove('hidden');
    });
    this.closeReportBtn.addEventListener('click', () => {
      this.reportModal.classList.add('hidden');
    });

    // Inspector
    this.closeInspectBtn.addEventListener('click', () => {
      this.closeInspector();
    });

    // インスペクターパネル内の操作が背後の3Dキャンバスに伝播して誤作動するのを防止
    this.inspectorPanel.addEventListener('mousedown', (e) => e.stopPropagation());
    this.inspectorPanel.addEventListener('click', (e) => e.stopPropagation());
    this.inspectorPanel.addEventListener('dblclick', (e) => e.stopPropagation());
    this.inspectorPanel.addEventListener('wheel', (e) => e.stopPropagation());

    // スケジュール設定モーダル内の操作伝播防止
    this.scheduleModal.addEventListener('mousedown', (e) => e.stopPropagation());
    this.scheduleModal.addEventListener('click', (e) => e.stopPropagation());
    this.scheduleModal.addEventListener('wheel', (e) => e.stopPropagation());

    // ⑤ & ⑦ Vehicle Modal Close & Confirm
    this.closeVehicleBtn.addEventListener('click', () => {
      this.vehicleModal.classList.add('hidden');
    });

    this.confirmBuyTrainBtn.addEventListener('click', () => {
      this.vehicleModal.classList.add('hidden');
      this.onConfirmBuyTrain(this.selectedVehicle, this.selectedCarCount);
    });

    // 車両購入 編成両数セレクター（ステッパー操作 1〜10両）
    const updateCarsUI = (count: number) => {
      this.selectedCarCount = count;
      if (this.carsDisplay) this.carsDisplay.textContent = `${count}両編成`;
      this.updateVehiclePriceDisplay();
    };

    this.btnCarsMinus?.addEventListener('click', () => {
      if (this.selectedCarCount > 1) {
        updateCarsUI(this.selectedCarCount - 1);
      }
    });
    this.btnCarsPlus?.addEventListener('click', () => {
      if (this.selectedCarCount < 10) {
        updateCarsUI(this.selectedCarCount + 1);
      }
    });

    // 駅名・列車名リネーム適用イベント
    const applyRename = () => {
      const newName = this.inspectRenameInput?.value.trim();
      if (!newName) return;

      if (this.inspectedTrainId !== null && this.onRenameTrain) {
        this.onRenameTrain(this.inspectedTrainId, newName);
        this.inspectType.textContent = newName;
      } else if (this.inspectedTileCoords && this.onRenameStation) {
        this.onRenameStation(this.inspectedTileCoords.x, this.inspectedTileCoords.z, newName, this.inspectedTileCoords.layer);
        this.inspectType.textContent = `駅 - ${newName}`;
      }
    };

    this.btnApplyRename?.addEventListener('click', () => applyRename());
    this.inspectRenameInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        applyRename();
      }
    });

    // Save & Reset
    document.getElementById('btn-save-game')?.addEventListener('click', () => {
      this.onSaveRequested();
      alert('ゲームデータを保存しました。');
    });

    // 都市を初期化: ブラウザのダイアログブロックに影響されないインライン2段階確認UI
    let resetConfirmTimer: any = null;
    const btnResetCity = document.getElementById('btn-reset-city');
    btnResetCity?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!btnResetCity.classList.contains('confirming')) {
        // 1回目のクリック: 確認待機モードへ
        btnResetCity.classList.add('confirming');
        btnResetCity.textContent = '⚠️ 本当に初期化？（再クリックで実行）';
        btnResetCity.style.backgroundColor = '#e11d48';
        btnResetCity.style.color = '#ffffff';
        btnResetCity.style.fontWeight = 'bold';

        if (resetConfirmTimer) clearTimeout(resetConfirmTimer);
        resetConfirmTimer = setTimeout(() => {
          btnResetCity.classList.remove('confirming');
          btnResetCity.textContent = '都市を初期化';
          btnResetCity.style.backgroundColor = '';
          btnResetCity.style.color = '';
          btnResetCity.style.fontWeight = '';
        }, 5000);
      } else {
        // 2回目のクリック: 初期化を即座に確定実行
        if (resetConfirmTimer) clearTimeout(resetConfirmTimer);
        btnResetCity.classList.remove('confirming');
        btnResetCity.textContent = '都市を初期化';
        btnResetCity.style.backgroundColor = '';
        btnResetCity.style.color = '';
        btnResetCity.style.fontWeight = '';

        this.reportModal.classList.add('hidden');
        this.closeInspector();
        this.onResetRequested();
      }
    });

    // ツールバーやサブメニューなどのUI操作が背後3Dキャンバスのドラッグやクリックに伝播するのを防止
    const uiContainers = [
      document.getElementById('build-toolbar'),
      this.toolSubmenu,
      this.rotationHint,
      this.stationLengthSelector,
      document.getElementById('floor-slicer'),
      document.getElementById('side-controls-dock')
    ];
    uiContainers.forEach(container => {
      if (container) {
        container.addEventListener('mousedown', (e) => e.stopPropagation());
        container.addEventListener('pointerdown', (e) => e.stopPropagation());
        container.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
      }
    });
  }

  /**
   * 速度ボタンの表示（active状態）を外部から同期
   */
  public setSpeedUI(speed: number): void {
    Object.values(this.speedButtons).forEach(b => b?.classList.remove('active'));
    if (speed === 0) this.speedButtons.pause?.classList.add('active');
    else if (speed === 1) this.speedButtons.s1?.classList.add('active');
    else if (speed === 2) this.speedButtons.s2?.classList.add('active');
    else if (speed === 3) this.speedButtons.s3?.classList.add('active');
    else if (speed === 4) this.speedButtons.s4?.classList.add('active');
    else if (speed === 5) this.speedButtons.s5?.classList.add('active');
  }

  /**
   * ⑤ カテゴリーサブメニュー（多層モーダル）を開く
   */
  private openSubmenu(categoryId: string) {
    const category = TOOL_CATEGORIES.find(c => c.id === categoryId);
    if (!category) return;

    this.activeCategoryId = categoryId;
    this.submenuTitle.textContent = category.name;
    this.submenuGrid.innerHTML = '';

    category.tools.forEach(tool => {
      const config = TOOL_CONFIG[tool];
      const btn = document.createElement('button');
      btn.className = `tool-btn submenu-tool-btn ${this.activeTool === tool ? 'active' : ''}`;
      btn.innerHTML = `
        <span class="tool-icon">${config.icon}</span>
        <span class="tool-name">${config.name}</span>
        <span class="tool-cost">¥${(config.cost / 10000).toLocaleString()}万</span>
      `;
      btn.addEventListener('click', () => {
        this.selectTool(tool);
        this.closeSubmenu();
      });
      this.submenuGrid.appendChild(btn);
    });

    // ② このカテゴリー専用の撤去ボタン（該当カテゴリの物のみ削除できる）
    const demoConfig = TOOL_CONFIG[category.demolishTool];
    const demoBtn = document.createElement('button');
    demoBtn.className = `tool-btn submenu-tool-btn delete-tool ${this.activeTool === category.demolishTool ? 'active' : ''}`;
    demoBtn.innerHTML = `
      <span class="tool-icon">${demoConfig.icon}</span>
      <span class="tool-name">${demoConfig.name}</span>
      <span class="tool-cost">${demoConfig.cost > 0 ? '¥' + (demoConfig.cost / 10000).toLocaleString() + '万' : '無料'}</span>
    `;
    demoBtn.addEventListener('click', () => {
      this.selectTool(category.demolishTool);
      this.closeSubmenu();
    });
    this.submenuGrid.appendChild(demoBtn);

    // ⑥ 列車カテゴリの場合は「車両基地・保有管理」ボタンも配置
    if (categoryId === 'train') {
      const fleetBtn = document.createElement('button');
      fleetBtn.className = 'tool-btn submenu-tool-btn fleet-btn';
      fleetBtn.innerHTML = `
        <span class="tool-icon">${UI_ICONS.train}</span>
        <span class="tool-name">保有車両・基地管理</span>
        <span class="tool-cost">一覧</span>
      `;
      fleetBtn.addEventListener('click', () => {
        this.closeSubmenu();
        this.onCancelPlacement();
        this.onOpenFleetModal();
      });
      this.submenuGrid.appendChild(fleetBtn);
    }

    this.closeInspector();
    this.toolSubmenu.classList.remove('hidden');
    this.categoryBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-category') === categoryId));

    // ③ サブメニューが開いている間は、ヒントやセレクターを一時非表示にしてボタンの操作性を確保
    this.rotationHint.classList.add('hidden');
    this.stationLengthSelector.classList.add('hidden');
  }

  /**
   * 駅・信号場・貨物駅など有効長を指定可能なツールか判定
   */
  private isStationTool(tool: ActiveTool): boolean {
    return tool === 'station-small' || tool === 'station-elevated' || tool === 'signal-yard' || tool === 'cargo-station';
  }

  private closeSubmenu() {
    this.toolSubmenu.classList.add('hidden');
    this.activeCategoryId = null;

    // カテゴリーボタンのハイライトを現在の選択ツールに合わせて再評価
    const ownerCategory = TOOL_CATEGORIES.find(c => c.tools.includes(this.activeTool) || c.demolishTool === this.activeTool);
    this.categoryBtns.forEach(b => b.classList.toggle('active', ownerCategory?.id === b.getAttribute('data-category')));

    // サブメニューを閉じた後、選択中のツールに応じてセレクターを再表示
    const isStationTool = this.isStationTool(this.activeTool);
    this.stationLengthSelector.classList.toggle('hidden', !isStationTool);
  }

  /**
   * ツール選択の共通処理（最上段ボタン／サブメニュー双方から呼ばれる）
   */
  private selectTool(tool: ActiveTool) {
    // ツール変更時は前の設置作業（仮置き・ドラッグ・列車配置等）を完全にキャンセル
    this.onCancelPlacement();

    if (tool !== 'select') {
      this.closeInspector();
    }

    this.activeTool = tool;

    // 最上段ボタンのハイライト更新
    this.topLevelToolBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-tool') === tool));

    // カテゴリーボタンのハイライト（選択中ツールが属するカテゴリー、またはそのカテゴリの撤去ツールであれば強調）
    const ownerCategory = TOOL_CATEGORIES.find(c => c.tools.includes(tool) || c.demolishTool === tool);
    this.categoryBtns.forEach(b => b.classList.toggle('active', ownerCategory?.id === b.getAttribute('data-category')));

    // ④ 駅・信号場・貨物駅ツールの場合はホーム有効長セレクターを表示
    const isStationTool = this.isStationTool(tool);
    this.stationLengthSelector.classList.toggle('hidden', !isStationTool);

    this.onToolChanged(tool);
  }

  /**
   * ⑤ 車両カタログUIの生成
   */
  private buildVehicleCatalogUI() {
    this.vehicleGrid.innerHTML = '';

    VEHICLE_CATALOG.forEach(veh => {
      const card = document.createElement('div');
      card.className = `veh-item-card ${veh.id === this.selectedVehicle.id ? 'selected' : ''}`;

      const stripeHex = '#' + veh.stripeColor.toString(16).padStart(6, '0');
      const maxOcc = Math.round((veh.maxOccupancyRate ?? 1.0) * 100);
      const capText = veh.category === 'freight' ? '貨物専用' : `1両定員: ${veh.baseCapacity}名 (最大${maxOcc}%)`;

      card.innerHTML = `
        <div class="veh-stripe-bar" style="background: ${stripeHex}"></div>
        <div class="veh-name">${veh.name}</div>
        <div class="veh-specs">
          <span>最高速度: ${veh.maxSpeed} km/h</span>
          <span>${capText}</span>
        </div>
        <div class="veh-price">¥${(veh.basePrice / 10000).toLocaleString()}万/両</div>
      `;

      card.addEventListener('click', () => {
        document.querySelectorAll('.veh-item-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        this.selectedVehicle = veh;
        this.updateVehiclePriceDisplay();
      });

      this.vehicleGrid.appendChild(card);
    });

    this.updateVehiclePriceDisplay();
  }

  private updateVehiclePriceDisplay() {
    const total = this.selectedVehicle.basePrice * this.selectedCarCount;
    this.vehTotalPrice.textContent = '¥' + total.toLocaleString();
  }

  public openVehicleModal() {
    if (this.carsDisplay) {
      this.carsDisplay.textContent = `${this.selectedCarCount}両編成`;
    }
    this.updateVehiclePriceDisplay();
    this.vehicleModal.classList.remove('hidden');
  }

  public getActiveTool(): ActiveTool {
    return this.activeTool;
  }

  public setAudioMuted(isMuted: boolean) {
    this.audioToggleBtn.innerHTML = isMuted ? UI_ICONS.volumeMute : UI_ICONS.volumeHigh;
  }

  /**
   * 昼夜切替モードおよび時間帯表示の更新
   * @param mode 'auto' (①OFF/時間連動) | 'day' (②昼間固定) | 'night' (③夜間固定)
   * @param effectiveTime 連動時の実際の時間帯 ('day' | 'sunset' | 'night')
   */
  public setTimeLightingMode(mode: TimeLightingMode, effectiveTime: TimeOfDay = 'day') {
    // スタイルクラスのリセット
    this.timeToggleBtn.classList.remove('mode-day', 'mode-night', 'active');

    if (mode === 'day') {
      this.timeToggleBtn.classList.add('mode-day');
      this.timeIcon.innerHTML = UI_ICONS.sun;
      if (this.timeModeBadge) this.timeModeBadge.textContent = '昼';
      this.timeToggleBtn.setAttribute('title', '昼夜切替: ②昼間固定 (時間帯に関係なく昼間に固定)');
      if (this.timeText) this.timeText.textContent = '昼間固定';
    } else if (mode === 'night') {
      this.timeToggleBtn.classList.add('mode-night');
      this.timeIcon.innerHTML = UI_ICONS.moon;
      if (this.timeModeBadge) this.timeModeBadge.textContent = '夜';
      this.timeToggleBtn.setAttribute('title', '昼夜切替: ③夜間固定 (時間帯に関係なく夜間に固定)');
      if (this.timeText) this.timeText.textContent = '夜間固定';
    } else {
      // mode === 'auto' (① 昼夜切替OFF / 時間連動)
      if (this.timeModeBadge) this.timeModeBadge.textContent = 'OFF';
      this.timeToggleBtn.setAttribute('title', '昼夜切替: ①OFF (時間連動)');

      if (effectiveTime === 'day') {
        this.timeIcon.innerHTML = UI_ICONS.sun;
        if (this.timeText) this.timeText.textContent = '昼間';
      } else if (effectiveTime === 'sunset') {
        this.timeIcon.innerHTML = UI_ICONS.sunset;
        if (this.timeText) this.timeText.textContent = '夕暮れ';
      } else {
        this.timeIcon.innerHTML = UI_ICONS.moon;
        if (this.timeText) this.timeText.textContent = '夜景';
      }
    }
  }

  public setTimeDisplay(time: 'day' | 'sunset' | 'night') {
    this.setTimeLightingMode('auto', time);
  }

  public updateHUD(dateStr: string, timeStr: string, fundsStr: string, popStr: string, isDeficit: boolean = false) {
    this.dateDisplay.textContent = dateStr;
    this.clockDisplay.textContent = timeStr;
    this.fundsDisplay.textContent = fundsStr;
    this.popDisplay.textContent = popStr;

    // 資金赤字（マイナス）時は資金カードを赤色にハイライト
    this.fundsDisplay.parentElement?.classList.toggle('deficit', isDeficit);
  }

  /**
   * トースト通知を表示する（画面右上にスライド表示・自動消去）
   */
  public showToast(title: string, message: string, type: 'info' | 'warning' | 'danger' | 'success' = 'info', durationMs: number = 7000): HTMLElement | null {
    if (!this.toastContainer) return null;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <div class="toast-header">
        <span class="toast-title">${title}</span>
      </div>
      <div class="toast-body">${message}</div>
    `;

    this.toastContainer.appendChild(toast);

    // アニメーション表示
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    // 一定時間後に消去
    const timeout = window.setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => {
        toast.remove();
      }, 400);
    }, durationMs);

    // クリックで即座に閉じる
    toast.addEventListener('click', () => {
      clearTimeout(timeout);
      toast.classList.remove('show');
      setTimeout(() => {
        toast.remove();
      }, 400);
    });

    return toast;
  }

  /**
   * ③ デッドロック（立ち往生）警告トーストを表示する
   * タップまたはクリックで該当列車の位置へカメラをジャンプさせる
   */
  public showDeadlockToast(event: DeadlockEvent, onJumpToTrain: () => void): void {
    if (!this.toastContainer) return;

    const toast = document.createElement('div');
    toast.className = 'toast toast-danger toast-item deadlock-toast';
    toast.innerHTML = `
      <div class="toast-header">
        <span class="toast-title">⚠️ 列車立ち往生検知</span>
      </div>
      <div class="toast-body">
        【${event.trainName}】が進行不能になっています（約${event.stuckDurationMinutes}分間停止）。タップでカメラジャンプ
      </div>
    `;

    toast.addEventListener('click', () => {
      onJumpToTrain();
      toast.classList.remove('show');
      setTimeout(() => {
        toast.remove();
      }, 400);
    });

    this.toastContainer.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => {
        toast.remove();
      }, 400);
    }, 15000);
  }


  /**
   * 3月31日 23:59 決算通知（5月30日納付予定額）トーストを表示する
   */
  public showFiscalReportToast(data: {
    fiscalYear: number;
    operatingProfit: number;
    constructionCost?: number;
    taxableIncome?: number;
    corporateTax: number;
    propertyTax: number;
    totalTax: number;
  }) {
    if (!this.toastContainer) return;

    const investRow = data.constructionCost !== undefined && data.constructionCost > 0
      ? `<div class="toast-row">
           <span>設備投資控除 (損金算入)</span>
           <span style="color: #22c55e;">-¥${data.constructionCost.toLocaleString('ja-JP')}</span>
         </div>`
      : '';

    const taxableRow = data.taxableIncome !== undefined
      ? `<div class="toast-row" style="font-weight: 600; color: #94a3b8;">
           <span>課税対象利益</span>
           <span>¥${Math.max(0, data.taxableIncome).toLocaleString('ja-JP')}</span>
         </div>`
      : '';

    const toast = document.createElement('div');
    toast.className = 'toast toast-warning';
    toast.innerHTML = `
      <div class="toast-header">
        <span class="toast-title">${data.fiscalYear}年度 決算通知</span>
      </div>
      <div class="toast-body">前年度実績に基づく税額が確定しました。5月30日に口座より自動引き落としされます。</div>
      <div class="toast-breakdown">
        <div class="toast-row">
          <span>営業純利益</span>
          <span>¥${data.operatingProfit.toLocaleString('ja-JP')}</span>
        </div>
        ${investRow}
        ${taxableRow}
        <div class="toast-row">
          <span>法人税 (30%)</span>
          <span>¥${data.corporateTax.toLocaleString('ja-JP')}</span>
        </div>
        <div class="toast-row">
          <span>固定資産税</span>
          <span>¥${data.propertyTax.toLocaleString('ja-JP')}</span>
        </div>
        <div class="toast-row total">
          <span>納付予定額合計</span>
          <span>¥${data.totalTax.toLocaleString('ja-JP')}</span>
        </div>
      </div>
    `;

    this.toastContainer.appendChild(toast);
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    // 決算通知は重要なので10秒間表示
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => {
        toast.remove();
      }, 400);
    }, 10000);
  }

  /**
   * 5月30日 00:00 納税執行通知トーストを表示する
   */
  public showTaxPaymentToast(data: { paidAmount: number; remainingFunds: number; isDeficit: boolean }) {
    if (!this.toastContainer) return;

    const toast = document.createElement('div');
    toast.className = data.isDeficit ? 'toast toast-danger' : 'toast toast-success';
    const deficitWarning = data.isDeficit
      ? '<br><strong style="color: #f87171;">【警告】資金が赤字となりました。新規投資（線路敷設・車両購入等）が一時ロックされます。</strong>'
      : '';

    toast.innerHTML = `
      <div class="toast-header">
        <span class="toast-title">納税執行完了</span>
      </div>
      <div class="toast-body">
        確定税金 ¥${data.paidAmount.toLocaleString('ja-JP')} を納付しました。${deficitWarning}
      </div>
      <div class="toast-breakdown">
        <div class="toast-row total">
          <span>納税後残高</span>
          <span style="color: ${data.isDeficit ? '#f87171' : '#34d399'};">
            ${data.remainingFunds < 0 ? `¥ -${Math.abs(data.remainingFunds).toLocaleString('ja-JP')}` : `¥${data.remainingFunds.toLocaleString('ja-JP')}`}
          </span>
        </div>
      </div>
    `;

    this.toastContainer.appendChild(toast);
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => {
        toast.remove();
      }, 400);
    }, 8000);
  }

  public getSelectedStationLength(): number {
    return this.selectedStationLength;
  }

  /**
   * ⑧ 現在選択中のツールの回転バーを表示/更新する
   */
  public setRotationHint(visible: boolean, label: string = '') {
    this.rotationHint.classList.toggle('hidden', !visible);
    if (visible) {
      this.rotationValueEl.textContent = label;
    }
  }

  /**
   * 設置向き回転ボタンの表示/非表示（街づくり施設など非回転ツールの仮置き時は非表示にする）
   */
  public setRotateButtonVisible(visible: boolean) {
    this.rotatePlacementBtn.classList.toggle('hidden', !visible);
  }

  /**
   * ② 分岐器の左右分岐切替ボタンの表示・テキスト更新
   */
  public setSwitchSideButtonVisible(visible: boolean, side: 'left' | 'right' = 'right') {
    this.switchSideBtn.classList.toggle('hidden', !visible);
    this.switchSideBtn.textContent = side === 'left' ? '分岐: 左' : '分岐: 右';
  }

  /**
   * ① 駅ホーム左右切替ボタンの表示・テキスト更新
   */
  public setStationSideButtonsVisible(visible: boolean, side: 'left' | 'right' = 'right') {
    const text = side === 'left' ? 'ホーム: 左側' : 'ホーム: 右側';
    if (this.stationSideBtn) {
      this.stationSideBtn.textContent = text;
    }
    if (this.stationSideHintBtn) {
      this.stationSideHintBtn.classList.toggle('hidden', !visible);
      this.stationSideHintBtn.textContent = text;
    }
  }

  /**
   * 駅設置用向き回転ボタンのテキスト表示を更新
   */
  public setStationRotationText(axisLabel: string) {
    if (this.btnStationRotate) {
      this.btnStationRotate.textContent = `🔄 向き: ${axisLabel}`;
    }
  }

  /**
   * 全7階層スライサーUIのアクティブボタン表示更新
   */
  public setFloorActive(layer: GridLayer | 'all') {
    if (!this.floorButtons) {
      this.floorButtons = document.querySelectorAll<HTMLButtonElement>('.floor-btn');
    }
    this.floorButtons.forEach(btn => {
      const raw = btn.getAttribute('data-layer') || '1';
      if (layer === 'all' ? raw === 'all' : raw === String(layer)) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  /**
   * スマホ用ターゲットレティクル＆アクションボタンの表示/非表示
   */
  public setMobileControlsVisible(visible: boolean) {
    if (this.crosshairReticle) {
      this.crosshairReticle.classList.toggle('hidden', !visible);
    }
    if (this.mobileActionDock) {
      this.mobileActionDock.classList.toggle('hidden', !visible);
    }
  }

  /**
   * スマホ用アクションボタンの状態切替（始点未設定/ドラッグ中/始点設定済み）
   */
  public setMobileActionState(state: 'idle' | 'started' | 'dragging') {
    if (this.btnMobileStart && this.btnMobileConfirm) {
      if (state === 'idle') {
        this.btnMobileStart.classList.remove('active');
        this.btnMobileConfirm.classList.remove('active');
      } else {
        this.btnMobileStart.classList.add('active');
        this.btnMobileConfirm.classList.add('active');
      }
    }
  }

  /**
   * ② 開発テスト用: 資金無限モードのUI表示更新
   */
  public updateInfiniteFundsUI(isInfinite: boolean) {
    this.fundsCardBtn?.classList.toggle('infinite-funds', isInfinite);
    if (this.infiniteFundsReportBtn) {
      this.infiniteFundsReportBtn.textContent = isInfinite ? '資金無限: ON' : '資金無限モード切替';
      this.infiniteFundsReportBtn.classList.toggle('active', isInfinite);
    }
  }

  /**
   * ⑦ 車両基地・保有列車管理モーダルの表示・一覧レンダリング
   */
  public showFleetModal(fleet: FleetItem[]) {
    this.fleetList.innerHTML = '';
    if (fleet.length === 0) {
      this.fleetList.innerHTML = `
        <div class="fleet-empty-hint">
          保有している列車はありません。<br>
          下部メニューの「列車」→「車両購入」から列車を購入すると、ここに配属されます。
        </div>
      `;
    } else {
      fleet.forEach(item => {
        const card = document.createElement('div');
        card.className = 'fleet-item-card';

        const isDeployed = item.status === 'deployed';
        const badgeClass = isDeployed ? 'deployed' : 'in-depot';
        const badgeText = isDeployed ? '営業運行中' : '車庫待機中';

        card.innerHTML = `
          <div class="fleet-item-info">
            <div class="fleet-item-header">
              <span class="fleet-item-name">${item.name}</span>
              <span class="fleet-badge ${badgeClass}">${badgeText}</span>
            </div>
            <div class="fleet-item-stats">
              <span>形式: ${item.model.name}</span>
              <div class="fleet-car-config-row">
                <span class="fleet-car-label">編成両数:</span>
                <span class="fleet-car-val"><strong>${item.cars}両編成</strong> (定員: ${(item.model.baseCapacity * item.cars).toLocaleString()}名 / 最大: ${getMaxCapacity(item.model, item.cars).toLocaleString()}名)</span>
                <div class="fleet-car-controls">
                  <button class="fleet-btn-car-minus" data-id="${item.id}" ${item.cars <= 1 ? 'disabled title="これ以上減らせません"' : 'title="1両減車（売却返金）"'}>-1両</button>
                  <button class="fleet-btn-car-plus" data-id="${item.id}" ${item.cars >= 10 ? 'disabled title="最大10両までです"' : 'title="追加車両を購入"'}>+1両 (購入: ¥${item.model.basePrice.toLocaleString()})</button>
                </div>
              </div>
              <span>最高速度: ${item.model.maxSpeed}km/h</span>
              <span>運行費: ¥${(item.model.dailyRunningCostPerCar * item.cars).toLocaleString()}/日</span>
            </div>
          </div>
          <div class="fleet-item-actions">
            ${isDeployed ? `
              <button class="fleet-btn-track" data-id="${item.id}">追跡</button>
              <button class="fleet-btn-recall" data-id="${item.id}">車庫へ回送</button>
            ` : `
              <button class="fleet-btn-deploy" data-id="${item.id}">線路に配置</button>
            `}
            <button class="fleet-btn-sell" data-id="${item.id}" title="列車を売却して資金を回収します">売却 (¥${Math.floor(item.model.basePrice * item.cars * 0.5).toLocaleString()})</button>
          </div>
        `;

        const minusBtn = card.querySelector('.fleet-btn-car-minus');
        minusBtn?.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onChangeFleetCarCount(item.id, -1);
        });

        const plusBtn = card.querySelector('.fleet-btn-car-plus');
        plusBtn?.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onChangeFleetCarCount(item.id, 1);
        });

        const deployBtn = card.querySelector('.fleet-btn-deploy');
        deployBtn?.addEventListener('click', () => {
          this.fleetModal.classList.add('hidden');
          this.onDeployFleetTrain(item.id);
        });

        const recallBtn = card.querySelector('.fleet-btn-recall');
        recallBtn?.addEventListener('click', () => {
          this.onRecallFleetTrain(item.id);
        });

        const trackBtn = card.querySelector('.fleet-btn-track');
        trackBtn?.addEventListener('click', () => {
          this.fleetModal.classList.add('hidden');
          this.onTrackFleetTrain(item.id);
        });

        const sellBtn = card.querySelector('.fleet-btn-sell');
        sellBtn?.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onSellFleetTrain(item.id);
        });

        this.fleetList.appendChild(card);
      });
    }

    this.fleetModal.classList.remove('hidden');
  }

  public closeFleetModal() {
    this.fleetModal.classList.add('hidden');
  }

  /**
   * ⑦ 仮置き中のみ「設置を決定」「キャンセル」ボタンを表示する
   */
  public setPlacementButtonsVisible(visible: boolean) {
    this.confirmPlacementBtn.classList.toggle('hidden', !visible);
    this.cancelPlacementBtn.classList.toggle('hidden', !visible);
  }

  /**
   * タイトル画面の表示
   */
  public showTitleScreen(hasSaveData: boolean): void {
    if (this.titleOverlay) {
      this.titleOverlay.classList.remove('fade-out');
      this.titleOverlay.classList.remove('hidden');
    }
    if (this.titleMainMenu) {
      this.titleMainMenu.classList.remove('hidden');
    }
    if (this.titleNewGameSetup) {
      this.titleNewGameSetup.classList.add('hidden');
    }
    if (this.btnTitleContinue) {
      this.btnTitleContinue.disabled = !hasSaveData;
    }
  }

  /**
   * タイトル画面の非表示（フェードアウト）
   */
  public hideTitleScreen(): void {
    if (this.titleOverlay) {
      this.titleOverlay.classList.add('fade-out');
      setTimeout(() => {
        this.titleOverlay?.classList.add('hidden');
      }, 400);
    }
  }

  /**
   * 建物半透明透過モード（X-Ray）ボタンのアクティブ表示切替
   */
  public setXRayActive(active: boolean): void {
    this.btnXRayToggle?.classList.toggle('active', active);
  }

  public setCameraModeUI(mode: CameraMode) {
    if (mode === 'cab') {
      this.cabOverlay.classList.remove('hidden');
      if (this.camViewText) this.camViewText.textContent = '前面展望';
      this.camViewBtn.classList.add('active');
    } else {
      this.cabOverlay.classList.add('hidden');
      if (this.camViewText) this.camViewText.textContent = '自由視点';
      this.camViewBtn.classList.remove('active');
    }
  }

  public updateCabSpeed(speed: number) {
    this.cabSpeedVal.textContent = String(Math.round(speed));
  }

  /**
   * 車窓モード表示中の列車名更新
   */
  public setCabTrainName(name: string) {
    if (this.cabTrainName) {
      this.cabTrainName.textContent = name;
    }
  }

  /**
   * 車窓モード用 列車選択モーダルの表示
   */
  public showCabTrainSelectModal(trains: any[], onSelect: (trainId: number) => void) {
    const modalEl = this.cabSelectModal;
    const listEl = this.cabTrainListEl;
    if (!modalEl || !listEl) return;
    listEl.innerHTML = '';

    if (trains.length === 0) {
      listEl.innerHTML = `
        <div style="text-align: center; padding: 24px 12px; color: var(--text-muted); font-size: 13px;">
          現在運行中の列車はありません。<br>先に列車を購入・配置してください。
        </div>
      `;
    } else {
      trains.forEach((train) => {
        const item = document.createElement('div');
        item.className = 'cab-train-item';

        const isFreight = train.model.category === 'freight';
        const badgeText = isFreight ? '貨物列車' : '旅客列車';
        const statusText = train.isStopped ? '停車中' : `${Math.round(train.speed || 0)} km/h`;
        const layerText = train.currentTile.layer >= 2
          ? `地上${train.currentTile.layer}F`
          : (train.currentTile.layer < 0 ? `地下B${Math.abs(train.currentTile.layer)}F` : '地上1F');

        item.innerHTML = `
          <div class="cab-train-info">
            <div class="cab-train-header">
              <span class="cab-train-title">${train.name}</span>
              <span class="cab-train-badge ${isFreight ? 'freight' : ''}">${badgeText}</span>
              <span style="font-size: 11px; color: ${train.isStopped ? '#f87171' : '#34d399'}; font-weight: 600;">● ${statusText}</span>
            </div>
            <div class="cab-train-detail">
              <span>形式: ${train.model.name}</span>
              <span>両数: ${train.carCount}両編成</span>
              <span>位置: ${layerText} (${train.currentTile.x}, ${train.currentTile.z})</span>
            </div>
          </div>
          <button class="cab-train-action-btn">運転席に乗車</button>
        `;

        item.addEventListener('click', () => {
          this.hideCabTrainSelectModal();
          onSelect(train.id);
        });

        listEl.appendChild(item);
      });
    }

    modalEl.classList.remove('hidden');
  }

  /**
   * 車窓モード用 列車選択モーダルを閉じる
   */
  public hideCabTrainSelectModal() {
    this.cabSelectModal?.classList.add('hidden');
  }

  /**
   * インスペクターパネルを閉じ、選択状態をリセット
   */
  public closeInspector() {
    this.inspectorPanel.classList.add('hidden');
    this.inspectedTileCoords = null;
    this.inspectedTrainId = null;
    if (this.inspectRenameRow) {
      this.inspectRenameRow.classList.add('hidden');
    }
    this.onInspectorClosed();
  }

  /**
   * ② ポイント切り替えボタン・④ 駅有効長設定・⑤ 詳細収支を含むインスペクター表示
   */
  public showInspector(
    tile: TileData,
    switchHub?: TileData,
    stationRunLength?: number,
    stationData?: {
      id?: string;
      name: string;
      platformNumber?: number;
      platformCount?: number;
      length: number;
      dailyPassengers: number;
      previousDayPassengers?: number;
      dailyLoadedCargo?: number;
      dailyUnloadedCargo?: number;
      totalPassengers: number;
      totalRevenue: number;
      maintenance: number;
      netProfit: number;
      isSignalYard?: boolean;
      isCargoYard?: boolean;
      cargoContainers?: number;
    } | null
  ) {
    this.closeSubmenu();
    this.inspectorPanel.classList.remove('hidden');
    this.inspectedTileCoords = { x: tile.x, z: tile.z, layer: (tile.layer ?? 1) as GridLayer };
    this.inspectedTrainId = null;
    this.inspectCoords.textContent = `(${tile.x}, ${tile.z})`;

    const residenceNames: Record<number, string> = {
      1: '戸建て住宅 (Lv.1)',
      2: '低層アパート (Lv.2)',
      3: '中層マンション (Lv.3)',
      4: 'タワーマンション (Lv.4)'
    };
    const commercialNames: Record<number, string> = {
      1: '個人商店・店舗 (Lv.1)',
      2: '中型オフィスビル (Lv.2)',
      3: '大型ビジネスビル (Lv.3)',
      4: '超高層ランドマークタワー (Lv.4)'
    };

    const typeNames: Record<TileType, string> = {
      empty: '更地',
      rail_ground: '線路 (地上)',
      rail_elevated: '高架線路',
      rail_curve_ground: '曲線レール (地上)',
      rail_curve_elevated: '曲線レール (高架)',
      point_switch_ground: '分岐器・ポイント (地上)',
      point_switch_elevated: '分岐器・ポイント (高架)',
      scissors_crossing_ground: 'シーサスクロッシング (地上・2×2)',
      scissors_crossing_elevated: 'シーサスクロッシング (高架・2×2)',
      rail_slope: '勾配線路',
      rail_slope_underground: '地下勾配線路',
      station_ground: '駅舎 (地上)',
      station_elevated: '高架駅',
      signal_yard: '信号場・留置線',
      cargo_station_ground: '貨物駅・コンテナヤード (地上)',
      cargo_station_elevated: '貨物駅・コンテナヤード (高架)',
      road: '道路',
      level_crossing: '踏切',
      residence: residenceNames[tile.level] || `住宅区画 (Lv.${tile.level})`,
      commercial: commercialNames[tile.level] || `商業オフィスビル (Lv.${tile.level})`,
      industrial: `工業施設 (Lv.${tile.level})`,
      nature: '森林・緑地'
    };
    this.inspectType.textContent = typeNames[tile.type] || tile.type;
    this.inspectActions.innerHTML = '';
    this.inspectFinancialBox.classList.add('hidden');
    this.inspectFinancialBox.innerHTML = '';
    if (this.inspectRenameRow) {
      this.inspectRenameRow.classList.add('hidden');
    }

    if (switchHub) {
      const isStraight = (switchHub.switchState !== 'diverge');
      const switchSched = switchHub.switchSchedule || { mode: 'timeline' };
      this.inspectExtraVal.textContent = `開通: ${isStraight ? '【直進】' : '【分岐】'} (動作: ${
        switchSched.mode === 'timeline' ? 'タイムライン指定' :
        switchSched.mode === 'alternate' ? '交互切替' : '手動'
      })`;

      const switchBtn = document.createElement('button');
      switchBtn.className = 'switch-toggle-btn';
      switchBtn.textContent = `手動進路切替: ${isStraight ? '分岐方向へ開通' : '直進方向へ開通'}`;
      switchBtn.addEventListener('click', () => {
        if (!switchHub.switchSchedule) switchHub.switchSchedule = createDefaultSwitchSchedule();
        // ③ 手動で切り替えた時はモードを manual にし、列車通過時に勝手に straight へ戻されないようにする
        switchHub.switchSchedule.mode = 'manual';
        this.onTogglePointSwitch(switchHub.x, switchHub.z, (switchHub.layer ?? 1) as GridLayer);
      });
      this.inspectActions.appendChild(switchBtn);

      // 分岐器ダイヤ設定UI（タイムラインモーダル）を開くボタン
      const openSchedBtn = document.createElement('button');
      openSchedBtn.id = 'btn-open-switch-schedule';
      openSchedBtn.className = 'sched-modal-open-btn';
      openSchedBtn.innerHTML = '<span>🔀 分岐ダイヤ設定</span>';
      openSchedBtn.addEventListener('click', () => {
        this.closeInspector();
        this.onOpenSwitchSchedule(switchHub);
      });
      this.inspectActions.appendChild(openSchedBtn);

      // 分岐器 ダイヤ設定サマリー表示
      this.renderSwitchScheduleUI(this.inspectActions, switchHub);

    } else if (tile.type.startsWith('scissors_crossing')) {
      const stateLabel: Record<string, string> = {
        straight: '【複線・直進】', 'cross-a': '【交差A（片方向）】', 'cross-b': '【交差B（もう片方向）】'
      };
      this.inspectExtraVal.textContent = `開通状態: ${stateLabel[tile.crossingState ?? 'straight']}`;

      const crossBtn = document.createElement('button');
      crossBtn.className = 'switch-toggle-btn';
      crossBtn.textContent = '手動開通切替（直進 / 交差A / 交差B）';
      crossBtn.addEventListener('click', () => {
        this.onCycleCrossing(tile.x, tile.z, (tile.layer ?? 1) as GridLayer);
      });
      this.inspectActions.appendChild(crossBtn);

      // シーサスクロッシング用ダイヤ設定UIを開くボタン
      const openCrossingSchedBtn = document.createElement('button');
      openCrossingSchedBtn.id = 'btn-open-crossing-schedule';
      openCrossingSchedBtn.className = 'sched-modal-open-btn';
      openCrossingSchedBtn.innerHTML = '<span>🔀 シーサスダイヤ設定</span>';
      openCrossingSchedBtn.addEventListener('click', () => {
        this.closeInspector();
        this.onOpenSwitchSchedule(tile);
      });
      this.inspectActions.appendChild(openCrossingSchedBtn);
    } else if (tile.type.startsWith('station') || tile.type === 'signal_yard' || tile.type.startsWith('cargo_station')) {
      const isYard = tile.type === 'signal_yard';
      const isCargo = tile.type.startsWith('cargo_station');
      const runLen = stationRunLength ?? (stationData ? stationData.length : 1);
      const defaultName = isYard ? '第1信号場' : (isCargo ? '貨物駅' : '駅');
      const stName = stationData?.name || tile.stationName || defaultName;
      const platformText = stationData?.platformNumber ? ` (${stationData.platformNumber}番線)` : '';
      this.inspectType.textContent = isYard
        ? `信号場・留置線 - ${stName}${platformText}`
        : (isCargo
          ? `貨物駅・コンテナヤード - ${stName}${platformText}`
          : `${typeNames[tile.type]} - ${stName}${platformText}`);
      this.inspectExtraVal.textContent = isYard
        ? `待避・留置専用（乗降客なし） / 有効長: ${runLen}両`
        : (isCargo
          ? `貨物取扱専用 / 有効長: ${runLen}両`
          : `待機乗客: ${tile.stationPassengers}人 / 有効長: ${runLen}両`);

      // 駅名リネーム欄を表示
      if (this.inspectRenameRow && this.inspectRenameInput) {
        this.inspectRenameRow.classList.remove('hidden');
        this.inspectRenameInput.value = stName;
      }

      // ⑤ 駅 財務・収支・利用状況ボックスの表示
      if (stationData) {
        this.inspectFinancialBox.classList.remove('hidden');
        const profitSign = stationData.netProfit >= 0 ? '+' : '';
        const profitClass = stationData.netProfit >= 0 ? 'positive' : 'negative';
        this.inspectFinancialBox.innerHTML = isYard ? `
          <div class="fin-title">信号場・留置線 管理状況</div>
          <div class="fin-row"><span class="fin-label">施設区分:</span><span class="fin-val">運行専用（低コスト）</span></div>
          <div class="fin-row"><span class="fin-label">ホーム数:</span><span class="fin-val">${stationData.platformCount ?? 1}番線</span></div>
          <div class="fin-row"><span class="fin-label">月額維持費:</span><span class="fin-val negative">-¥${stationData.maintenance.toLocaleString()}</span></div>
        ` : (isCargo ? `
          <div class="fin-title">貨物駅 管理状況</div>
          <div class="fin-row"><span class="fin-label">施設区分:</span><span class="fin-val">貨物取扱ヤード</span></div>
          <div class="fin-row"><span class="fin-label">ホーム数:</span><span class="fin-val">${stationData.platformCount ?? 1}番線</span></div>
          <div class="fin-row"><span class="fin-label">有効長:</span><span class="fin-val">${runLen}両</span></div>
          <div class="fin-row"><span class="fin-label">本日積込貨物:</span><span class="fin-val">${(stationData.dailyLoadedCargo ?? 0).toLocaleString()}個</span></div>
          <div class="fin-row"><span class="fin-label">本日荷下貨物:</span><span class="fin-val">${(stationData.dailyUnloadedCargo ?? 0).toLocaleString()}個</span></div>
          <div class="fin-row"><span class="fin-label">保管コンテナ:</span><span class="fin-val">${(stationData.cargoContainers ?? 0).toLocaleString()}個</span></div>
          <div class="fin-row"><span class="fin-label">月額維持費:</span><span class="fin-val negative">-¥${stationData.maintenance.toLocaleString()}</span></div>
        ` : `
          <div class="fin-title">駅 財務・利用状況</div>
          <div class="fin-row"><span class="fin-label">ホーム番線:</span><span class="fin-val">${stationData.platformNumber ?? 1}番線 (全${stationData.platformCount ?? 1}ホーム)</span></div>
          <div class="fin-row"><span class="fin-label">本日乗降客:</span><span class="fin-val">${stationData.dailyPassengers.toLocaleString()}人</span></div>
          <div class="fin-row"><span class="fin-label">前日乗降客:</span><span class="fin-val">${(stationData.previousDayPassengers ?? 0).toLocaleString()}人</span></div>
          <div class="fin-row"><span class="fin-label">累計運賃収入:</span><span class="fin-val positive">+¥${stationData.totalRevenue.toLocaleString()}</span></div>
          <div class="fin-row"><span class="fin-label">月額維持管理費:</span><span class="fin-val negative">-¥${stationData.maintenance.toLocaleString()}</span></div>
          <div class="fin-row"><span class="fin-label">駅純収支:</span><span class="fin-val ${profitClass}">${profitSign}¥${stationData.netProfit.toLocaleString()}</span></div>
        `);
      }

      // ④ ホーム有効長変更ボタン群（1両〜10両）
      const editBox = document.createElement('div');
      editBox.className = 'st-edit-len-box';
      editBox.innerHTML = `
        <span class="st-edit-len-label">有効長変更:</span>
        <div class="st-edit-len-btns">
          <button class="st-edit-btn ${runLen === 1 ? 'active' : ''}" data-target-len="1">1</button>
          <button class="st-edit-btn ${runLen === 2 ? 'active' : ''}" data-target-len="2">2</button>
          <button class="st-edit-btn ${runLen === 3 ? 'active' : ''}" data-target-len="3">3</button>
          <button class="st-edit-btn ${runLen === 4 ? 'active' : ''}" data-target-len="4">4</button>
          <button class="st-edit-btn ${runLen === 6 ? 'active' : ''}" data-target-len="6">6</button>
          <button class="st-edit-btn ${runLen === 8 ? 'active' : ''}" data-target-len="8">8</button>
          <button class="st-edit-btn ${runLen === 10 ? 'active' : ''}" data-target-len="10">10</button>
        </div>
      `;
      editBox.querySelectorAll<HTMLElement>('.st-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const targetLen = parseInt(btn.getAttribute('data-target-len') || '2');
          this.onSetStationLength(tile.x, tile.z, targetLen);
        });
      });
      this.inspectActions.appendChild(editBox);

      // Phase3: 純粋ダイヤ編成UI（サイドパネル/ボトムシート）を開くボタン
      const openSchedBtn = document.createElement('button');
      openSchedBtn.className = 'sched-modal-open-btn';
      const schedBtnLabel = isCargo ? '貨物駅ダイヤ設定' : (isYard ? '信号場ダイヤ設定' : '駅ダイヤ設定');
      openSchedBtn.innerHTML = `<span>${schedBtnLabel}</span>`;
      openSchedBtn.addEventListener('click', () => {
        this.onOpenStationSchedule(tile);
      });
      this.inspectActions.appendChild(openSchedBtn);

    } else if (tile.type === 'level_crossing') {
      this.inspectExtraVal.textContent = '道路と線路が交差する踏切です。';
    } else if (tile.type === 'residence') {
      const popEstimate = tile.level === 1 ? '15〜30人' : tile.level === 2 ? '40〜80人' : tile.level === 3 ? '90〜180人' : '200〜400人';
      this.inspectExtraVal.textContent = `地価: ¥${(tile.landValue * 10000).toLocaleString()} / 推定居住人口: 約${popEstimate}`;
    } else if (tile.type === 'commercial') {
      const commCap = tile.level === 1 ? '近隣型小型店舗' : tile.level === 2 ? '中規模オフィス・商業ビル' : tile.level === 3 ? '大型ビジネスオフィス' : '超高層ランドマーク複合施設';
      this.inspectExtraVal.textContent = `地価: ¥${(tile.landValue * 10000).toLocaleString()} / 施設規模: ${commCap}`;
    } else if (tile.type === 'industrial') {
      this.inspectExtraVal.textContent = `地価: ¥${(tile.landValue * 10000).toLocaleString()} / 工業生産・貨物需要拠点 (Lv.${tile.level})`;
    } else if (tile.type === 'nature') {
      this.inspectExtraVal.textContent = '自然の森林・緑地（景観向上・環境保全）';
    } else if (tile.type === 'road') {
      this.inspectExtraVal.textContent = '市民や物資が往来する舗装道路';
    } else if (tile.type.includes('rail')) {
      this.inspectExtraVal.textContent = '列車が走行可能な鉄道路線（開通中）';
    } else if (tile.type === 'empty') {
      this.inspectExtraVal.textContent = '未開発の空き地（開発・建設可能）';
    } else {
      this.inspectExtraVal.textContent = '良好';
    }
  }

  /**
   * ① ⑤ 列車（編成）詳細情報・収支・撤去インスペクター表示
   */
  public showTrainInspector(train: TrainInstance) {
    this.closeSubmenu();
    this.inspectorPanel.classList.remove('hidden');
    this.inspectedTrainId = train.id;
    this.inspectedTileCoords = null;
    this.inspectCoords.textContent = `編成 #${train.id}`;
    this.inspectType.textContent = train.name;
    const isFreight = train.model.category === 'freight';
    if (isFreight) {
      const cargoLoad = train.cargoLoad ?? 0;
      const cargoCap = train.cargoCapacity ?? Math.max(0, (train.carCount - 1) * 3);
      const cargoRate = Math.round((cargoLoad / Math.max(1, cargoCap)) * 100);
      this.inspectExtraVal.textContent = `${train.carCount}両編成 / 積載コンテナ ${cargoLoad}個 (積載率 ${cargoRate}%)`;
    } else {
      const occupancy = Math.round((train.passengers / Math.max(1, train.capacity)) * 100);
      this.inspectExtraVal.textContent = `${train.carCount}両編成 / 乗客 ${train.passengers}人 (乗車率 ${occupancy}%)`;
    }

    // 列車名リネーム欄を表示
    if (this.inspectRenameRow && this.inspectRenameInput) {
      this.inspectRenameRow.classList.remove('hidden');
      this.inspectRenameInput.value = train.name;
    }

    // ⑤ 列車財務・収支ボックス
    this.inspectFinancialBox.classList.remove('hidden');
    const profitSign = train.monthlyProfit >= 0 ? '+' : '';
    const profitClass = train.monthlyProfit >= 0 ? 'positive' : 'negative';
    if (isFreight) {
      const cargoLoad = train.cargoLoad ?? 0;
      const cargoCap = train.cargoCapacity ?? Math.max(0, (train.carCount - 1) * 3);
      const cargoRate = Math.round((cargoLoad / Math.max(1, cargoCap)) * 100);
      this.inspectFinancialBox.innerHTML = `
        <div class="fin-title">貨物列車 財務・運行状況</div>
        <div class="fin-row"><span class="fin-label">現在積載 / 定員:</span><span class="fin-val">${cargoLoad} / ${cargoCap}個 (${cargoRate}%)</span></div>
        <div class="fin-row"><span class="fin-label">累計貨物取扱量:</span><span class="fin-val">${(train.totalPassengers ?? 0).toLocaleString()}個</span></div>
        <div class="fin-row"><span class="fin-label">累計貨物運賃収入:</span><span class="fin-val positive">+¥${train.totalRevenue.toLocaleString()}</span></div>
        <div class="fin-row"><span class="fin-label">累計運行維持費:</span><span class="fin-val negative">-¥${train.totalCost.toLocaleString()}</span></div>
        <div class="fin-row"><span class="fin-label">列車純収支:</span><span class="fin-val ${profitClass}">${profitSign}¥${train.monthlyProfit.toLocaleString()}</span></div>
      `;
    } else {
      const occupancy = Math.round((train.passengers / Math.max(1, train.capacity)) * 100);
      const maxOcc = Math.round((train.model.maxOccupancyRate ?? 1.0) * 100);
      this.inspectFinancialBox.innerHTML = `
        <div class="fin-title">列車 財務・運行状況</div>
        <div class="fin-row"><span class="fin-label">現在乗客 / 定員:</span><span class="fin-val">${train.passengers} / ${train.capacity}人 (${occupancy}% / 最大${maxOcc}%)</span></div>
        <div class="fin-row"><span class="fin-label">累計乗客数:</span><span class="fin-val">${train.totalPassengers.toLocaleString()}人</span></div>
        <div class="fin-row"><span class="fin-label">累計運賃収入:</span><span class="fin-val positive">+¥${train.totalRevenue.toLocaleString()}</span></div>
        <div class="fin-row"><span class="fin-label">累計運行維持費:</span><span class="fin-val negative">-¥${train.totalCost.toLocaleString()}</span></div>
        <div class="fin-row"><span class="fin-label">列車純収支:</span><span class="fin-val ${profitClass}">${profitSign}¥${train.monthlyProfit.toLocaleString()}</span></div>
      `;
    }

    this.inspectActions.innerHTML = '';
    const removeBtn = document.createElement('button');
    removeBtn.className = 'switch-toggle-btn train-remove-btn';
    removeBtn.textContent = '列車を撤去';
    removeBtn.addEventListener('click', () => {
      this.onRemoveTrain(train.id);
      this.closeInspector();
    });
    this.inspectActions.appendChild(removeBtn);
  }

  /**
   * 駅インスペクターのリアルタイム動的数値（乗客数・収支・現在時刻表示）のみを更新
   * ※ ボタンやタイムラインバー等のDOM再構築は一切行わないため、クリックや操作を阻害しない
   */
  public updateStationInspectorDynamicValues(
    tile: TileData,
    stationRunLength?: number,
    stationData?: {
      id?: string;
      name: string;
      platformNumber?: number;
      platformCount?: number;
      length: number;
      dailyPassengers: number;
      previousDayPassengers?: number;
      dailyLoadedCargo?: number;
      dailyUnloadedCargo?: number;
      totalPassengers: number;
      totalRevenue: number;
      maintenance: number;
      netProfit: number;
      isSignalYard?: boolean;
      isCargoYard?: boolean;
      cargoContainers?: number;
    } | null
  ) {
    if (this.inspectorPanel.classList.contains('hidden')) return;
    const tileLayer = (tile.layer ?? 1) as GridLayer;
    if (!this.inspectedTileCoords || this.inspectedTileCoords.x !== tile.x || this.inspectedTileCoords.z !== tile.z || this.inspectedTileCoords.layer !== tileLayer) {
      return;
    }

    const runLen = stationRunLength ?? (stationData ? stationData.length : 1);
    const isYard = tile.type === 'signal_yard';
    const isCargo = tile.type.startsWith('cargo_station');
    this.inspectExtraVal.textContent = isYard
      ? `待避・留置専用（乗降客なし） / 有効長: ${runLen}両`
      : (isCargo
        ? `貨物取扱専用 / 有効長: ${runLen}両`
        : `待機乗客: ${tile.stationPassengers}人 / 有効長: ${runLen}両`);

    if (stationData) {
      this.inspectFinancialBox.classList.remove('hidden');
      const profitSign = stationData.netProfit >= 0 ? '+' : '';
      const profitClass = stationData.netProfit >= 0 ? 'positive' : 'negative';
      this.inspectFinancialBox.innerHTML = isYard ? `
        <div class="fin-title">信号場・留置線 管理状況</div>
        <div class="fin-row"><span class="fin-label">施設区分:</span><span class="fin-val">運行専用（低コスト）</span></div>
        <div class="fin-row"><span class="fin-label">ホーム数:</span><span class="fin-val">${stationData.platformCount ?? 1}番線</span></div>
        <div class="fin-row"><span class="fin-label">月額維持費:</span><span class="fin-val negative">-¥${stationData.maintenance.toLocaleString()}</span></div>
      ` : (isCargo ? `
        <div class="fin-title">貨物駅 管理状況</div>
        <div class="fin-row"><span class="fin-label">施設区分:</span><span class="fin-val">貨物取扱ヤード</span></div>
        <div class="fin-row"><span class="fin-label">ホーム数:</span><span class="fin-val">${stationData.platformCount ?? 1}番線</span></div>
        <div class="fin-row"><span class="fin-label">有効長:</span><span class="fin-val">${runLen}両</span></div>
        <div class="fin-row"><span class="fin-label">本日積込貨物:</span><span class="fin-val">${(stationData.dailyLoadedCargo ?? 0).toLocaleString()}個</span></div>
        <div class="fin-row"><span class="fin-label">本日荷下貨物:</span><span class="fin-val">${(stationData.dailyUnloadedCargo ?? 0).toLocaleString()}個</span></div>
        <div class="fin-row"><span class="fin-label">保管コンテナ:</span><span class="fin-val">${(stationData.cargoContainers ?? 0).toLocaleString()}個</span></div>
        <div class="fin-row"><span class="fin-label">月額維持費:</span><span class="fin-val negative">-¥${stationData.maintenance.toLocaleString()}</span></div>
      ` : `
        <div class="fin-title">駅 財務・利用状況</div>
        <div class="fin-row"><span class="fin-label">ホーム番線:</span><span class="fin-val">${stationData.platformNumber ?? 1}番線 (全${stationData.platformCount ?? 1}ホーム)</span></div>
        <div class="fin-row"><span class="fin-label">本日乗降客:</span><span class="fin-val">${stationData.dailyPassengers.toLocaleString()}人</span></div>
        <div class="fin-row"><span class="fin-label">前日乗降客:</span><span class="fin-val">${(stationData.previousDayPassengers ?? 0).toLocaleString()}人</span></div>
        <div class="fin-row"><span class="fin-label">累計運賃収入:</span><span class="fin-val positive">+¥${stationData.totalRevenue.toLocaleString()}</span></div>
        <div class="fin-row"><span class="fin-label">月額維持管理費:</span><span class="fin-val negative">-¥${stationData.maintenance.toLocaleString()}</span></div>
        <div class="fin-row"><span class="fin-label">駅純収支:</span><span class="fin-val ${profitClass}">${profitSign}¥${stationData.netProfit.toLocaleString()}</span></div>
      `);
    }

    // タイムラインバーの現在時刻テキストおよびカレントセルの更新
    const nowHourEl = this.inspectorPanel.querySelector<HTMLElement>('.timeline-bar-now-hour');
    if (nowHourEl && this.getCurrentHour) {
      const currentHour = this.getCurrentHour();
      nowHourEl.textContent = `現在: ${currentHour}時`;
      const cells = this.inspectorPanel.querySelectorAll<HTMLElement>('#station-timeline-cells .timeline-cell');
      cells.forEach((cell, h) => {
        if (h === currentHour) {
          cell.classList.add('current-hour');
        } else {
          cell.classList.remove('current-hour');
        }
      });
    }
  }

  /**
   * 列車インスペクターのリアルタイム動的数値（乗客数・収支）のみを更新
   * ※ 撤去ボタン等のDOM再構築は行わないため、クリックを阻害しない
   */
  public updateTrainInspectorDynamicValues(train: TrainInstance) {
    if (this.inspectorPanel.classList.contains('hidden')) return;
    if (this.inspectedTrainId !== train.id) return;

    const isFreight = train.model.category === 'freight';
    if (isFreight) {
      const cargoLoad = train.cargoLoad ?? 0;
      const cargoCap = train.cargoCapacity ?? Math.max(0, (train.carCount - 1) * 3);
      const cargoRate = Math.round((cargoLoad / Math.max(1, cargoCap)) * 100);
      this.inspectExtraVal.textContent = `${train.carCount}両編成 / 積載コンテナ ${cargoLoad}個 (積載率 ${cargoRate}%)`;
    } else {
      const occupancy = Math.round((train.passengers / Math.max(1, train.capacity)) * 100);
      this.inspectExtraVal.textContent = `${train.carCount}両編成 / 乗客 ${train.passengers}人 (乗車率 ${occupancy}%)`;
    }

    this.inspectFinancialBox.classList.remove('hidden');
    const profitSign = train.monthlyProfit >= 0 ? '+' : '';
    const profitClass = train.monthlyProfit >= 0 ? 'positive' : 'negative';
    if (isFreight) {
      const cargoLoad = train.cargoLoad ?? 0;
      const cargoCap = train.cargoCapacity ?? Math.max(0, (train.carCount - 1) * 3);
      const cargoRate = Math.round((cargoLoad / Math.max(1, cargoCap)) * 100);
      this.inspectFinancialBox.innerHTML = `
        <div class="fin-title">貨物列車 財務・運行状況</div>
        <div class="fin-row"><span class="fin-label">現在積載 / 定員:</span><span class="fin-val">${cargoLoad} / ${cargoCap}個 (${cargoRate}%)</span></div>
        <div class="fin-row"><span class="fin-label">累計貨物取扱量:</span><span class="fin-val">${(train.totalPassengers ?? 0).toLocaleString()}個</span></div>
        <div class="fin-row"><span class="fin-label">累計貨物運賃収入:</span><span class="fin-val positive">+¥${train.totalRevenue.toLocaleString()}</span></div>
        <div class="fin-row"><span class="fin-label">累計運行維持費:</span><span class="fin-val negative">-¥${train.totalCost.toLocaleString()}</span></div>
        <div class="fin-row"><span class="fin-label">列車純収支:</span><span class="fin-val ${profitClass}">${profitSign}¥${train.monthlyProfit.toLocaleString()}</span></div>
      `;
    } else {
      const occupancy = Math.round((train.passengers / Math.max(1, train.capacity)) * 100);
      const maxOcc = Math.round((train.model.maxOccupancyRate ?? 1.0) * 100);
      this.inspectFinancialBox.innerHTML = `
        <div class="fin-title">列車 財務・運行状況</div>
        <div class="fin-row"><span class="fin-label">現在乗客 / 定員:</span><span class="fin-val">${train.passengers} / ${train.capacity}人 (${occupancy}% / 最大${maxOcc}%)</span></div>
        <div class="fin-row"><span class="fin-label">累計乗客数:</span><span class="fin-val">${train.totalPassengers.toLocaleString()}人</span></div>
        <div class="fin-row"><span class="fin-label">累計運賃収入:</span><span class="fin-val positive">+¥${train.totalRevenue.toLocaleString()}</span></div>
        <div class="fin-row"><span class="fin-label">累計運行維持費:</span><span class="fin-val negative">-¥${train.totalCost.toLocaleString()}</span></div>
        <div class="fin-row"><span class="fin-label">列車純収支:</span><span class="fin-val ${profitClass}">${profitSign}¥${train.monthlyProfit.toLocaleString()}</span></div>
      `;
    }
  }

  public updateFinancialReport(rep: FinancialReportData) {
    document.getElementById('rep-fare-income')!.textContent = '¥' + rep.fareIncome.toLocaleString();
    document.getElementById('rep-land-value')!.textContent = '¥' + rep.landValue.toLocaleString();
    document.getElementById('rep-construction-cost')!.textContent = '-¥' + rep.constructionCost.toLocaleString();
    document.getElementById('rep-maintenance-cost')!.textContent = '-¥' + rep.maintenanceCost.toLocaleString();

    const netElem = document.getElementById('rep-net-profit')!;
    netElem.textContent = (rep.netProfit >= 0 ? '+' : '') + '¥' + rep.netProfit.toLocaleString();
    netElem.className = rep.netProfit >= 0 ? 'positive' : 'negative';

    document.getElementById('rep-total-pop')!.textContent = rep.totalPopulation.toLocaleString() + '人';
    document.getElementById('rep-track-length')!.textContent = rep.trackLength + ' km';
    document.getElementById('rep-train-count')!.textContent = rep.trainCount + ' 編成';
    document.getElementById('rep-station-count')!.textContent = rep.stationCount + ' 駅';
  }

  /**
   * ① 分岐器用 24時間タイムラインバー方式ダイヤ設定UIの描画
   */
  private renderSwitchScheduleUI(
    container: HTMLElement,
    switchHub: TileData
  ) {
    if (!switchHub.switchSchedule) {
      switchHub.switchSchedule = createDefaultSwitchSchedule();
    }
    const sched = switchHub.switchSchedule;
    if (!Array.isArray(sched.hourlyDirections) || sched.hourlyDirections.length !== 24) {
      sched.hourlyDirections = new Array(24).fill('straight');
    }

    const swSchedBox = document.createElement('div');
    swSchedBox.className = 'schedule-box';

    swSchedBox.innerHTML = `
      <div class="schedule-title">分岐ダイヤ設定</div>
      <div class="schedule-row">
        <span class="schedule-label">動作モード:</span>
        <div class="schedule-btn-group" id="sw-mode-btns">
          <button class="schedule-btn ${sched.mode === 'timeline' ? 'active' : ''}" data-mode="timeline">タイムライン</button>
          <button class="schedule-btn ${sched.mode === 'alternate' ? 'active' : ''}" data-mode="alternate">交互切替</button>
          <button class="schedule-btn ${sched.mode === 'manual' ? 'active' : ''}" data-mode="manual">手動</button>
        </div>
      </div>
    `;

    // 動作モード切替イベント
    swSchedBox.querySelectorAll<HTMLElement>('#sw-mode-btns .schedule-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-mode') as 'timeline' | 'alternate' | 'manual';
        sched.mode = mode;
        this.showInspector(switchHub, switchHub);
      });
    });

    if (sched.mode === 'timeline') {
      const summaryBox = document.createElement('div');
      summaryBox.style.cssText = 'background:rgba(0,0,0,0.3);padding:8px 10px;border-radius:6px;margin-top:6px;font-size:11px;color:#cbd5e1;line-height:1.6;border:1px solid rgba(245,158,11,0.25);';
      const ruleCount = (sched.rules || []).length;
      summaryBox.innerHTML = `
        <div style="font-weight:bold;color:#f59e0b;margin-bottom:3px;">⏱ タイムライン方式</div>
        <div>デフォルト開通: <b style="color:#94a3b8;">直進</b></div>
        <div>分岐設定ルール: <b style="color:#fbbf24;">${ruleCount} 件</b></div>
        <div style="font-size:10.5px;color:#94a3b8;margin-top:4px;">
          ※ 上の「🔀 分岐ダイヤ設定」から24時間バーで時間帯指定・毎時パターン指定を設定できます。
        </div>
      `;
      swSchedBox.appendChild(summaryBox);
    } else if (sched.mode === 'alternate') {
      const info = document.createElement('div');
      info.style.cssText = 'font-size:10.5px;color:#94a3b8;margin-top:6px;padding:6px 8px;background:rgba(0,0,0,0.2);border-radius:4px;';
      info.textContent = '※ 列車が通過するたびに直進と分岐を自動で交互に切り替えます。';
      swSchedBox.appendChild(info);
    } else {
      const info = document.createElement('div');
      info.style.cssText = 'font-size:10.5px;color:#94a3b8;margin-top:6px;padding:6px 8px;background:rgba(0,0,0,0.2);border-radius:4px;';
      info.textContent = '※ 上の手動進路切替ボタンからのみ開通方向を切り替えます。';
      swSchedBox.appendChild(info);
    }

    container.appendChild(swSchedBox);
  }

  /**
   * ①② 大型ダイヤ設定モーダルを開く（分岐器ダイヤ設定でのみ使用。駅ダイヤはPhase3のScheduleUIへ移行）
   */
  public openSwitchScheduleModal(switchHub: TileData) {
    this.currentEditingSwitchHub = switchHub;

    const currentHour = this.getCurrentHour ? this.getCurrentHour() : 8;
    this.selectedScheduleHour = currentHour;

    this.scheduleModal.classList.remove('hidden');
    this.renderScheduleModalContent();
  }

  /**
   * ①② 分岐器ダイヤ設定モーダルのコンテンツを描画
   */
  private renderScheduleModalContent() {
    if (!this.currentEditingSwitchHub) return;

    const currentHour = this.getCurrentHour ? this.getCurrentHour() : 0;
    const currentMinute = this.getCurrentMinute ? this.getCurrentMinute() : 0;
    const currentSlotMinute = Math.floor(currentMinute / 10) * 10;

    const container = this.scheduleModalBody;
    container.innerHTML = '';

    if (this.currentEditingSwitchHub) {
      // -------------------------------------------------------------
      // 分岐器ダイヤ設定（10分刻み）
      // -------------------------------------------------------------
      const hub = this.currentEditingSwitchHub;
      if (!hub.switchSchedule) {
        hub.switchSchedule = createDefaultSwitchSchedule();
      }
      const sched = hub.switchSchedule;
      if (!Array.isArray(sched.slots) || sched.slots.length !== 144) {
        sched.slots = new Array(144).fill('straight');
      }

      this.scheduleModalTitle.textContent = `分岐ダイヤ設定 - 座標 (${hub.x}, ${hub.z})`;

      const modeRow = document.createElement('div');
      modeRow.className = 'schedule-row';
      modeRow.innerHTML = `
        <span class="schedule-label" style="font-size:12px;font-weight:700;">動作モード:</span>
        <div class="schedule-btn-group" id="modal-sw-mode-btns">
          <button class="schedule-btn ${sched.mode === 'timeline' ? 'active' : ''}" data-mode="timeline">タイムライン</button>
          <button class="schedule-btn ${sched.mode === 'alternate' ? 'active' : ''}" data-mode="alternate">交互切替</button>
          <button class="schedule-btn ${sched.mode === 'manual' ? 'active' : ''}" data-mode="manual">手動開通</button>
        </div>
      `;
      modeRow.querySelectorAll<HTMLElement>('#modal-sw-mode-btns .schedule-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          sched.mode = btn.getAttribute('data-mode') as 'timeline' | 'alternate' | 'manual';
          this.renderScheduleModalContent();
        });
      });
      container.appendChild(modeRow);

      if (sched.mode === 'timeline') {
        // パレット ＆ 現在時刻
        const paletteBox = document.createElement('div');
        paletteBox.className = 'sched-modal-palette-box';
        paletteBox.innerHTML = `
          <div class="timeline-palette">
            <span style="font-size:11px;font-weight:700;color:#cbd5e1;">編集ペン:</span>
            <button class="palette-btn ${this.switchPaletteDir === 'straight' ? 'active' : ''}" data-dir="straight">
              <span class="palette-dot straight"></span>直進
            </button>
            <button class="palette-btn ${this.switchPaletteDir === 'diverge' ? 'active' : ''}" data-dir="diverge">
              <span class="palette-dot diverge"></span>分岐
            </button>
          </div>
          <div class="sched-modal-sub">
            現在ゲーム時刻: <span class="now-time">${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}</span>
          </div>
        `;
        paletteBox.querySelectorAll<HTMLElement>('.palette-btn').forEach(pBtn => {
          pBtn.addEventListener('click', () => {
            this.switchPaletteDir = pBtn.getAttribute('data-dir') as 'straight' | 'diverge';
            paletteBox.querySelectorAll<HTMLElement>('.palette-btn').forEach(b => b.classList.remove('active'));
            pBtn.classList.add('active');
          });
        });
        container.appendChild(paletteBox);

        // 24時間タブ（0〜23時）
        const hourSelector = document.createElement('div');
        hourSelector.className = 'sched-modal-hour-selector';
        hourSelector.innerHTML = `
          <div class="sched-modal-hour-label">
            <span>① 時間帯を選択（0〜23時）</span>
            <span style="color:#94a3b8;font-size:10px;">選択中: <b>${this.selectedScheduleHour}時</b></span>
          </div>
          <div class="sched-hour-tabs" id="modal-hour-tabs"></div>
        `;
        const tabsEl = hourSelector.querySelector<HTMLElement>('#modal-hour-tabs')!;
        for (let h = 0; h < 24; h++) {
          const tab = document.createElement('div');
          tab.className = `sched-hour-tab ${h === this.selectedScheduleHour ? 'active' : ''} ${h === currentHour ? 'now' : ''}`;
          tab.textContent = `${h}`;
          tab.title = `${h}時台を編集`;
          tab.addEventListener('click', () => {
            this.selectedScheduleHour = h;
            this.renderScheduleModalContent();
          });
          tabsEl.appendChild(tab);
        }
        container.appendChild(hourSelector);

        // メイン10分スロット（6枠: 00, 10, 20, 30, 40, 50分）
        const tenMinSection = document.createElement('div');
        tenMinSection.className = 'sched-ten-min-section';
        const selH = this.selectedScheduleHour;
        tenMinSection.innerHTML = `
          <div class="sched-ten-min-header">
            <span>② ${selH}時台の10分刻み設定（クリックで塗り替え）</span>
            <div style="display:flex;gap:4px;">
              <button class="preset-btn" id="btn-fill-hour-straight">この1時間をすべて直進</button>
              <button class="preset-btn" id="btn-fill-hour-diverge">この1時間をすべて分岐</button>
            </div>
          </div>
          <div class="sched-ten-min-grid" id="modal-ten-min-grid"></div>
        `;
        tenMinSection.querySelector<HTMLElement>('#btn-fill-hour-straight')!.addEventListener('click', () => {
          for (let m = 0; m < 6; m++) {
            sched.slots![selH * 6 + m] = 'straight';
          }
          this.renderScheduleModalContent();
        });
        tenMinSection.querySelector<HTMLElement>('#btn-fill-hour-diverge')!.addEventListener('click', () => {
          for (let m = 0; m < 6; m++) {
            sched.slots![selH * 6 + m] = 'diverge';
          }
          this.renderScheduleModalContent();
        });

        const gridEl = tenMinSection.querySelector<HTMLElement>('#modal-ten-min-grid')!;
        for (let m = 0; m < 6; m++) {
          const minVal = m * 10;
          const slotIdx = selH * 6 + m;
          const dir = sched.slots![slotIdx] || 'straight';
          const isCurrentSlot = (selH === currentHour && minVal === currentSlotMinute);

          const card = document.createElement('div');
          card.className = `sched-ten-min-card dir-${dir} ${isCurrentSlot ? 'current-slot' : ''}`;
          card.innerHTML = `
            <span class="time-text">${String(selH).padStart(2, '0')}:${String(minVal).padStart(2, '0')}</span>
            <span class="status-text">${dir === 'straight' ? '直進' : '分岐'}</span>
          `;
          card.addEventListener('click', () => {
            sched.slots![slotIdx] = this.switchPaletteDir;
            if (sched.hourlyDirections) {
              sched.hourlyDirections[selH] = sched.slots![selH * 6];
            }
            this.renderScheduleModalContent();
          });
          gridEl.appendChild(card);
        }
        container.appendChild(tenMinSection);

        // 24時間全体マップ（144スロット俯瞰）
        const overviewSec = document.createElement('div');
        overviewSec.className = 'sched-overview-container';
        overviewSec.innerHTML = `
          <div class="sched-overview-header">
            <span>③ 1日全体マップ（24時間 × 6スロット = 全144枠 / クリックでその時間にジャンプ）</span>
          </div>
          <div class="sched-overview-grid" id="modal-overview-grid"></div>
        `;
        const overGridEl = overviewSec.querySelector<HTMLElement>('#modal-overview-grid')!;
        for (let h = 0; h < 24; h++) {
          const col = document.createElement('div');
          col.className = 'sched-overview-col';
          col.title = `${h}時台`;
          for (let m = 0; m < 6; m++) {
            const slotIdx = h * 6 + m;
            const dir = sched.slots![slotIdx] || 'straight';
            const cell = document.createElement('div');
            cell.className = `sched-overview-cell dir-${dir}`;
            cell.addEventListener('click', () => {
              this.selectedScheduleHour = h;
              sched.slots![slotIdx] = this.switchPaletteDir;
              this.renderScheduleModalContent();
            });
            col.appendChild(cell);
          }
          overGridEl.appendChild(col);
        }
        container.appendChild(overviewSec);

        // 一括プリセット
        const presetBox = document.createElement('div');
        presetBox.className = 'timeline-presets';
        presetBox.style.marginTop = '4px';
        presetBox.innerHTML = `
          <span style="font-size:11px;font-weight:700;color:#cbd5e1;margin-right:4px;">一括プリセット:</span>
          <button class="preset-btn" data-preset="all-straight">全日直進</button>
          <button class="preset-btn" data-preset="all-diverge">全日分岐</button>
          <button class="preset-btn" data-preset="rush-diverge">朝夕のみ分岐(7-9,17-19)</button>
          <button class="preset-btn" data-preset="day-night">昼間直進/夜間分岐</button>
          <button class="preset-btn" data-preset="ten-min-alt">10分毎に交互(00直,10分...)</button>
        `;
        presetBox.querySelectorAll<HTMLElement>('.preset-btn').forEach(pBtn => {
          pBtn.addEventListener('click', () => {
            const p = pBtn.getAttribute('data-preset');
            if (p === 'all-straight') {
              sched.slots!.fill('straight');
            } else if (p === 'all-diverge') {
              sched.slots!.fill('diverge');
            } else if (p === 'rush-diverge') {
              sched.slots!.fill('straight');
              [7, 8, 9, 17, 18, 19].forEach(h => {
                for (let m = 0; m < 6; m++) sched.slots![h * 6 + m] = 'diverge';
              });
            } else if (p === 'day-night') {
              for (let h = 0; h < 24; h++) {
                const d = (h >= 6 && h < 18) ? 'straight' : 'diverge';
                for (let m = 0; m < 6; m++) sched.slots![h * 6 + m] = d;
              }
            } else if (p === 'ten-min-alt') {
              for (let i = 0; i < 144; i++) {
                sched.slots![i] = (i % 2 === 0) ? 'straight' : 'diverge';
              }
            }
            this.renderScheduleModalContent();
          });
        });
        container.appendChild(presetBox);

      } else if (sched.mode === 'alternate') {
        const info = document.createElement('div');
        info.style.cssText = 'padding:14px;background:rgba(0,0,0,0.3);border-radius:6px;font-size:12px;color:#cbd5e1;line-height:1.6;';
        info.innerHTML = `
          <b>交互切替モード</b><br>
          列車が通過するたびに、分岐器が【直進】と【分岐】を自動で交互に反転させます。<br>
          複線駅の進入ポイントや、2つのホームに交互に列車を振り分けたい場合に便利です。
        `;
        container.appendChild(info);
      } else {
        const isStraight = hub.switchState !== 'diverge';
        const manualBox = document.createElement('div');
        manualBox.style.cssText = 'padding:14px;background:rgba(0,0,0,0.3);border-radius:6px;display:flex;flex-direction:column;gap:10px;';
        manualBox.innerHTML = `
          <div style="font-size:12px;color:#cbd5e1;">
            <b>手動モード</b><br>
            列車の通過によって自動で切り替わらず、常に指定した方向へ固定開通します。
          </div>
          <button class="switch-toggle-btn" id="modal-btn-manual-toggle" style="margin-top:4px;">
            開通方向切替: ${isStraight ? '【直進中】→ 分岐方向へ開通' : '【分岐中】→ 直進方向へ開通'}
          </button>
        `;
        manualBox.querySelector<HTMLElement>('#modal-btn-manual-toggle')!.addEventListener('click', () => {
          this.onTogglePointSwitch(hub.x, hub.z);
          this.renderScheduleModalContent();
        });
        container.appendChild(manualBox);
      }
    }
  }
}
