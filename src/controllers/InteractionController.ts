import * as THREE from 'three';
import { WorldMap, TileData, cloneTileSnapshot } from '../simulation/WorldMap';
import { TrainManager } from '../simulation/TrainManager';
import { Economy } from '../simulation/Economy';
import { AudioManager } from '../engine/AudioManager';
import { UIManager, TOOL_CONFIG, ActiveTool } from '../ui/UIManager';
import { CameraManager } from '../graphics/CameraManager';
import { InputController } from '../ui/InputController';
import { ZoneManager, ZoneType } from '../core/ZoneManager';
import { DemandEngine } from '../core/DemandEngine';
import { MiniMap } from '../ui/MiniMap';
import { TerrainRenderer } from '../graphics/TerrainRenderer';
import { GridManager } from '../core/GridManager';
import { GridLayer } from '../core/types';
import { GRID_LAYERS } from '../core/constants';
import { ScheduleUI } from '../ui/ScheduleUI';
import { SwitchScheduleUI } from '../ui/SwitchScheduleUI';
import { TimeManager, SpeedLevel } from '../core/TimeManager';
import { PlacementController, PLACEMENT_TOOLS, ROTATABLE_TOOLS } from './PlacementController';
import { FleetController } from './FleetController';
import { VisualEffectManager } from '../graphics/VisualEffectManager';
import { UndoManager, TileSnapshot } from '../core/UndoManager';
import { ExternalConnectionManager } from '../simulation/ExternalConnectionManager';

const DEMOLISH_SCOPE: Partial<Record<ActiveTool, string[]>> = {
  'demolish-track': [
    'rail_ground', 'rail_elevated', 'rail_curve_ground', 'rail_curve_elevated',
    'point_switch_ground', 'point_switch_elevated',
    'scissors_crossing_ground', 'scissors_crossing_elevated',
    'rail_slope', 'rail_slope_underground', 'level_crossing',
    'external_connection'
  ],
  'demolish-station': ['station_ground', 'station_elevated', 'signal_yard', 'cargo_station_ground', 'cargo_station_elevated'],
  'demolish-city': ['road', 'residence', 'commercial', 'industrial', 'nature', 'farmland', 'level_crossing']
};

export interface InteractionControllerDependencies {
  scene: THREE.Scene;
  domElement: HTMLElement;
  cameraManager: CameraManager;
  worldMap: WorldMap;
  getGridManager: () => GridManager;
  trainManager: TrainManager;
  economy: Economy;
  timeManager: TimeManager;
  zoneManager: ZoneManager;
  demandEngine: DemandEngine;
  uiManager: UIManager;
  audioManager: AudioManager;
  inputController: InputController;
  miniMap: MiniMap;
  terrainRenderer: TerrainRenderer;
  scheduleUI: ScheduleUI;
  switchScheduleUI: SwitchScheduleUI;
  placementController: PlacementController;
  fleetController: FleetController;
  visualEffectManager: VisualEffectManager;
  undoManager?: UndoManager;
  externalConnectionManager?: ExternalConnectionManager;
  onLayerSwitchRequested: (layer: GridLayer, playSound?: boolean) => void;
  onToggleInfiniteFunds: () => void;
  onExitCabView: () => void;
  getCabTargetTrainId: () => number | null;
  getSelectedTilePos: () => { x: number; z: number; layer: GridLayer } | null;
  setSelectedTilePos: (pos: { x: number; z: number; layer: GridLayer } | null) => void;
  getSelectedTrainId: () => number | null;
  setSelectedTrainId: (id: number | null) => void;
}

/**
 * ユーザー入力（Pointer Events, キーボード, タッチ, クリック調停）をカプセル化するコントローラー
 */
export class InteractionController {
  private deps: InteractionControllerDependencies;
  private raycaster: THREE.Raycaster = new THREE.Raycaster();
  private mousePos: THREE.Vector2 = new THREE.Vector2();
  private undoManager?: UndoManager;

  constructor(deps: InteractionControllerDependencies) {
    this.deps = deps;
    this.undoManager = deps.undoManager;
    if (this.undoManager && this.deps.uiManager) {
      this.deps.uiManager.setUndoHandler(() => this.undoManager?.undo());
    }
    this.setupPointerEvents();
    this.setupKeyboardEvents();
  }

  public setUndoManager(undoManager: UndoManager): void {
    this.undoManager = undoManager;
    if (this.undoManager && this.deps.uiManager) {
      this.deps.uiManager.setUndoHandler(() => this.undoManager?.undo());
    }
  }

  /**
   * マウス位置にある列車編成をレイキャストで検出
   */
  public raycastTrain() {
    this.raycaster.setFromCamera(this.mousePos, this.deps.cameraManager.activeCamera);
    let closest: { train: ReturnType<TrainManager['getTrains']>[number]; dist: number } | null = null;
    for (const train of this.deps.trainManager.getTrains()) {
      const hits = this.raycaster.intersectObject(train.mesh, true);
      if (hits.length > 0 && (!closest || hits[0].distance < closest.dist)) {
        closest = { train, dist: hits[0].distance };
      }
    }
    return closest ? closest.train : null;
  }

  /**
   * 画面上の可視タイルメッシュ（駅、分岐器、シーサス、建物など）を優先的にレイキャスト
   */
  public raycastTile(): TileData | null {
    this.raycaster.setFromCamera(this.mousePos, this.deps.cameraManager.activeCamera);
    let closest: { tile: TileData; dist: number } | null = null;

    for (const tile of this.deps.worldMap.getAllTiles()) {
      if (tile.mesh && tile.mesh.visible) {
        const hits = this.raycaster.intersectObject(tile.mesh, true);
        if (hits.length > 0 && (!closest || hits[0].distance < closest.dist)) {
          closest = { tile, dist: hits[0].distance };
        }
      }
    }

    return closest ? closest.tile : null;
  }

  /**
   * 画面中央レティクルの下にある立体グリッドマスを取得
   */
  public getReticleTile(): { x: number; z: number } | null {
    const intersect = this.deps.inputController.getGridIntersection(
      this.deps.worldMap.gridSize,
      (x, z) => this.deps.worldMap.getElevationOffset(x, z),
      true
    );
    return intersect && intersect.isValidTile ? { x: intersect.tileX, z: intersect.tileZ } : null;
  }

  /**
   * スマホ用ターゲットレティクル＋アクションボタンの操作ハンドラ
   */
  public handleMobileAction(action: 'start' | 'confirm' | 'cancel' | 'rotate'): void {
    const tile = this.getReticleTile();
    const pc = this.deps.placementController;
    const ui = this.deps.uiManager;
    const audio = this.deps.audioManager;

    if (action === 'start') {
      if (!tile) return;
      pc.mobileDragStartTile = { x: tile.x, z: tile.z };
      ui.setMobileActionState('dragging');
      ui.setRotationHint(
        true,
        `📍 始点(${tile.x}, ${tile.z})を設定しました。画面中央を終点に合わせて「終点決定」を押してください。`
      );
      audio.playSelectSound();
    } else if (action === 'confirm') {
      if (pc.mobileDragStartTile && tile) {
        pc.updateDragPreview(pc.mobileDragStartTile, tile);
        pc.finishDragPlacement();
        pc.mobileDragStartTile = null;
        ui.setMobileActionState('idle');
      } else if (tile) {
        pc.hoveredTile = tile;
        this.handleTileClick();
      }
    } else if (action === 'cancel') {
      pc.mobileDragStartTile = null;
      pc.cancelPendingPlacements();
      ui.setMobileActionState('idle');
      pc.updateRotationHint(ui.getActiveTool());
    } else if (action === 'rotate') {
      pc.rotateCurrentPlacement();
    }
  }

  /**
   * タイルクリック時の処理ディスパッチ
   */
  public handleTileClick(): void {
    const pc = this.deps.placementController;
    const fc = this.deps.fleetController;
    const ui = this.deps.uiManager;
    const audio = this.deps.audioManager;
    const wm = this.deps.worldMap;
    const tm = this.deps.trainManager;
    const cm = this.deps.cameraManager;
    const econ = this.deps.economy;
    const zm = this.deps.zoneManager;
    const de = this.deps.demandEngine;
    const mm = this.deps.miniMap;
    const tr = this.deps.terrainRenderer;
    const gm = this.deps.getGridManager();
    const vm = this.deps.visualEffectManager;

    if (!pc.hoveredTile) return;
    const { x, z } = pc.hoveredTile;
    const tool = ui.getActiveTool();

    // 1. 車両基地からの線路配置モード中（仮配置）
    if (fc.isDeploying()) {
      const deployLayer = wm.activeLayer;
      const tile = wm.getTile(x, z, deployLayer);
      if (!tile || !tile.type.includes('rail') && !tile.type.includes('station') && tile.type !== 'signal_yard' && !tile.type.includes('switch') && !tile.type.includes('scissors') && tile.type !== 'level_crossing') {
        ui.showToast('配置不可', '列車は線路または駅の上に配置してください。', 'warning');
        return;
      }
      const item = fc.getDeployingFleetItem();
      if (!item) return;

      const ok = fc.startDeployPreviewOnTile(x, z, deployLayer, tile);
      if (ok) {
        ui.setPlacementButtonsVisible(true);
        ui.setRotateButtonVisible(true);
        audio.playBuildSound();
        pc.updateRotationHint(tool);
      }
      return;
    }

    // 2. Select モード（列車 ➔ 画面上のタイルメッシュ直接 ➔ グリッド平面の順に判定）
    if (tool === 'select') {
      const train = this.raycastTrain();
      if (train) {
        this.deps.setSelectedTrainId(train.id);
        this.deps.setSelectedTilePos(null);
        if (train.currentTile.layer !== wm.activeLayer) {
          this.deps.onLayerSwitchRequested(train.currentTile.layer, false);
        }
        const target = tm.getFollowTargetByTrainId(train.id);
        if (target) {
          cm.startTracking(target, true);
        }
        ui.showTrainInspector(train);
        return;
      }

      // 画面に見えているタイルメッシュ（2F以上の高架駅、山岳駅、建物、分岐器等）を直接レイキャスト
      const hitTile = this.raycastTile();
      let targetTile: TileData | null = hitTile;
      let targetLayer: GridLayer = hitTile ? ((hitTile.layer ?? wm.activeLayer) as GridLayer) : wm.activeLayer;

      if (!targetTile) {
        // メッシュに直接当たらなかった場合、クリックされたグリッドマス (x, z) からタイルを検索
        const curLayer = wm.activeLayer;
        let existingTile = wm.getTile(x, z, curLayer);
        // 現在のレイヤーに何もない場合、他の階層（特に駅や線路がある階層）を走査
        if (!existingTile || existingTile.type === 'empty') {
          for (const l of GRID_LAYERS) {
            const cand = wm.getTile(x, z, l);
            if (cand && cand.type !== 'empty') {
              existingTile = cand;
              targetLayer = l;
              // 駅などの重要構造物があればそれを優先採用
              if (WorldMap.isStationTileType(cand.type) || cand.type === 'signal_yard') {
                break;
              }
            }
          }
        } else {
          targetLayer = curLayer;
        }
        targetTile = (existingTile && existingTile.type !== 'empty') ? existingTile : null;
      }

      if (!targetTile) {
        this.deps.setSelectedTrainId(null);
        this.deps.setSelectedTilePos(null);
        cm.stopTracking();
        ui.closeInspector();
        return;
      }

      const tile: TileData = targetTile;
      this.deps.setSelectedTrainId(null);
      this.deps.setSelectedTilePos({ x: tile.x, z: tile.z, layer: targetLayer });
      cm.stopTracking();
      const hub = wm.resolveSwitchHub(tile.x, tile.z, targetLayer);
      const isStationOrYard = tile.type.startsWith('station') || tile.type === 'signal_yard' || tile.type.startsWith('cargo_station');
      const runLength = isStationOrYard ? wm.getStationRunLength(tile.x, tile.z, targetLayer) : undefined;
      const stData = isStationOrYard ? wm.getStationAggregateData(tile.x, tile.z, targetLayer) : undefined;
      ui.showInspector(tile, hub, runLength, stData);
      return;
    }

    // 3. 列車個別撤去モード
    if (tool === 'demolish-train') {
      const train = this.raycastTrain();
      if (train) {
        const fleetItem = fc.getFleetRegistry().find(f => f.activeTrainId === train.id);
        if (fleetItem) {
          fleetItem.status = 'in_depot';
          fleetItem.activeTrainId = undefined;
        }
        if (this.deps.getCabTargetTrainId() === train.id) {
          this.deps.onExitCabView();
        }
        cm.stopTracking();
        tm.removeTrain(train.id);
        audio.playDemolishSound();
        if (this.deps.getSelectedTrainId() === train.id) {
          this.deps.setSelectedTrainId(null);
          ui.closeInspector();
        }
      } else {
        ui.showToast('対象なし', 'この位置に列車がありません。撤去したい列車をクリックしてください。', 'warning');
      }
      return;
    }

    // 4. カテゴリ別タイル撤去モード
    const demolishScope = DEMOLISH_SCOPE[tool];
    if (demolishScope) {
      let curLayer = wm.activeLayer;
      let tile = wm.getTile(x, z, curLayer);
      if ((!tile || tile.type === 'empty') && tool === 'demolish-city') {
        const cell = gm.getCell(x, 1, z);
        const surfaceLayer = (cell ? Math.max(1, cell.elevation) : 1) as GridLayer;
        const surfaceTile = wm.getTile(x, z, surfaceLayer);
        if (surfaceTile && surfaceTile.type !== 'empty') {
          curLayer = surfaceLayer;
          tile = surfaceTile;
        }
      }
      if (tile && tile.type !== 'empty') {
        if (!demolishScope.includes(tile.type)) {
          ui.showToast('撤去不可', 'このカテゴリーの撤去ツールでは撤去できない対象です。', 'warning');
          return;
        }
        const affectedTiles = wm.getDemolitionAffectedTiles(x, z, curLayer);
        const tilesToClean: Array<{ x: number; z: number; layer: GridLayer }> = affectedTiles.map(at => ({
          x: at.x,
          z: at.z,
          layer: (at.layer ?? curLayer) as GridLayer
        }));

        // スロープの場合は接続先の上位/下位階層も在線チェック対象に含める
        for (const at of affectedTiles) {
          const baseLyr = (at.layer ?? curLayer) as GridLayer;
          if (at.type === 'rail_slope' && at.slopePart === 3) {
            tilesToClean.push({ x: at.x, z: at.z, layer: (baseLyr + 1) as GridLayer });
          } else if (at.type === 'rail_slope_underground' && at.slopePart === 3) {
            tilesToClean.push({ x: at.x, z: at.z, layer: -1 as GridLayer });
          }
        }

        tm.updateOccupancyNow();
        for (const t of tilesToClean) {
          if (tm.isTileOccupiedByTrain(t.x, t.z, t.layer)) {
            ui.showToast('撤去不可', '⚠️ 列車が走行中・停車中の線路や駅は撤去できません。<br>列車が通過するのを待つか、車両管理から車庫へ回送してください。', 'warning');
            return;
          }
        }

        const config = TOOL_CONFIG[tool];
        const tileSnapshots: TileSnapshot[] = [];
        for (const at of affectedTiles) {
          tileSnapshots.push({
            x: at.x,
            z: at.z,
            layer: (at.layer ?? curLayer) as GridLayer,
            before: cloneTileSnapshot(at),
            after: null
          });
        }

        if (econ.spendFunds(config.cost, true)) {
          let removedPop = 0;
          for (const ts of tileSnapshots) {
            if (ts.before) {
              removedPop += UndoManager.getTilePopulation(ts.before.type, ts.before.level);
            }
          }
          const demolishMode = tool === 'demolish-track' ? 'track' : (tool === 'demolish-city' ? 'city' : 'all');
          wm.demolishTile(x, z, curLayer, demolishMode);
          if (removedPop > 0) {
            econ.addPopulation(-Math.min(econ.population, removedPop));
          }
          for (const t of tilesToClean) {
            vm.removeCargoYardVisual(t.x, t.z, t.layer);
          }
          // 撤去後の状態を after に記録（駅撤去なら通常レール、完全撤去なら更地）
          for (const ts of tileSnapshots) {
            const afterTile = wm.getTile(ts.x, ts.z, ts.layer);
            ts.after = cloneTileSnapshot(afterTile);
          }
          if (tileSnapshots.length > 0 && this.undoManager) {
            this.undoManager.pushAction({
              type: 'demolition',
              tiles: tileSnapshots,
              cost: config.cost,
              description: `${tool} による撤去`
            });
          }
          audio.playDemolishSound();
          const curSel = this.deps.getSelectedTilePos();
          if (curSel && tilesToClean.some(t => t.x === curSel.x && t.z === curSel.z && t.layer === curSel.layer)) {
            this.deps.setSelectedTilePos(null);
            ui.closeInspector();
          }
          this.deps.scheduleUI.refreshOrClose();
          this.deps.switchScheduleUI.refreshOrClose();
          mm.requestStaticUpdate();
          tr.rebuildAll(gm, this.deps.scene);
          tm.updateOccupancyNow();
          pc.clearHoverStationGhost();
          this.deps.externalConnectionManager?.checkConnections(wm);
        } else {
          ui.showToast('資金不足', '撤去に必要な資金が不足しています。', 'danger');
        }
      }
      return;
    }

    // 5. 列車購入モード
    if (tool === 'train-buy') {
      ui.openVehicleModal();
      return;
    }

    // 6. RCIゾーニングブラシ
    const ZONE_TOOL_TYPE: Partial<Record<ActiveTool, ZoneType>> = {
      'zone-residential': 'residential',
      'zone-commercial': 'commercial',
      'zone-industrial': 'industrial'
    };
    if (ZONE_TOOL_TYPE[tool]) {
      const config = TOOL_CONFIG[tool];
      if (!econ.spendFunds(config.cost, true)) {
        ui.showToast('資金不足', 'ゾーニングに必要な資金が不足しています。', 'danger');
        return;
      }
      const painted = zm.paintZone(x, z, ZONE_TOOL_TYPE[tool]!, 2);
      vm.refreshZoneOverlay(painted.map(c => ({ x: c.x, z: c.z })));
      de.clearCache();
      audio.playBuildSound();
      mm.requestStaticUpdate();
      return;
    }
    if (tool === 'zone-clear') {
      zm.clearZone(x, z, 2);
      vm.refreshZoneOverlayClear(x, z, 2);
      de.clearCache();
      audio.playDemolishSound();
      mm.requestStaticUpdate();
      return;
    }

    // 7. 貨物ヤード指定
    if (tool === 'cargo-yard') {
      const curLayer = wm.activeLayer;
      const tile = wm.getTile(x, z, curLayer);
      const isStationOrYard = tile && (tile.type.startsWith('station') || tile.type === 'signal_yard');
      if (!tile || !isStationOrYard) {
        ui.showToast('指定不可', '貨物ヤードに指定するには、先に駅または信号場をこのマスに設置してください。', 'warning');
        return;
      }
      if (tile.isCargoYard) {
        ui.showToast('設定済み', 'このマスはすでに貨物ヤードに指定されています。', 'info');
        return;
      }
      const config = TOOL_CONFIG[tool];
      if (!econ.spendFunds(config.cost, true)) {
        ui.showToast('資金不足', '貨物ヤード指定に必要な資金が不足しています。', 'danger');
        return;
      }
      tile.isCargoYard = true;
      vm.updateCargoYardVisual(tile.x, tile.z, curLayer);
      audio.playBuildSound();
      return;
    }

    // 8. 仮置きツール（線路・駅・建物・自然など）
    if (PLACEMENT_TOOLS.includes(tool)) {
      pc.stagePendingPlacement(tool, x, z);
    }
  }

  /**
   * Pointer Events の登録と入力調停
   */
  private setupPointerEvents(): void {
    const dom = this.deps.domElement;
    const pc = this.deps.placementController;
    const fc = this.deps.fleetController;
    const ui = this.deps.uiManager;
    const cm = this.deps.cameraManager;
    const ic = this.deps.inputController;
    const wm = this.deps.worldMap;

    let isMultiTouchActive = false;

    // ① CameraManager のパン移動と敷設ドラッグの入力調停
    cm.canPanPredicate = () => {
      if (pc.isDraggingTrack || isMultiTouchActive) return false;
      const tool = ui.getActiveTool();
      if (tool === 'select') return true;
      return false;
    };

    // ② UI要素上での pointerdown 伝播を遮断
    const uiSelectors = [
      '#build-toolbar',
      '#tool-submenu',
      '#rotation-hint',
      '#station-length-selector',
      '#floor-slicer',
      '#side-controls-dock',
      'header',
      'aside',
      '.modal-overlay',
      '.modal-backdrop',
      '#mobile-action-dock',
      '#minimap-container',
      '#inspector-panel',
      '#cab-view-overlay'
    ];
    uiSelectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(el => {
        el.addEventListener('pointerdown', (e: Event) => e.stopPropagation());
      });
    });

    // ③ ポインター追跡とドラッグ・タップ判定の一元化
    const activePointers = new Map<number, { x: number; y: number; time: number }>();
    let primaryPointerId: number | null = null;
    let pointerStartX = 0;
    let pointerStartY = 0;
    let pointerStartTime = 0;
    let hasDragged = false;

    dom.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button === 2) return;

      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, time: performance.now() });

      if (activePointers.size >= 2) {
        isMultiTouchActive = true;
        if (pc.isDraggingTrack) {
          pc.cancelPendingPlacements();
          pc.isDraggingTrack = false;
        }
        pc.dragStartTile = null;
        hasDragged = true;
        return;
      }

      primaryPointerId = e.pointerId;
      isMultiTouchActive = false;
      hasDragged = false;
      pointerStartX = e.clientX;
      pointerStartY = e.clientY;
      pointerStartTime = performance.now();

      if (cm.viewMode !== 'cab_view' && (e.button === 0 || e.pointerType === 'touch')) {
        ic.updateMousePosition(e.clientX, e.clientY);
        const tool = ui.getActiveTool();
        const isTunnelTool = tool === 'rail-tunnel';
        const intersect = ic.getGridIntersection(
          wm.gridSize,
          isTunnelTool ? undefined : (x, z) => wm.getElevationOffset(x, z)
        );
        const isTrackTool = tool.startsWith('rail') || tool === 'road';
        if (intersect && intersect.isValidTile && isTrackTool) {
          pc.dragStartTile = { x: intersect.tileX, z: intersect.tileZ };
        } else {
          pc.dragStartTile = null;
        }
      }
    });

    window.addEventListener('pointermove', (e: PointerEvent) => {
      if (activePointers.has(e.pointerId)) {
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, time: performance.now() });
      }

      if (isMultiTouchActive || activePointers.size >= 2) {
        return;
      }

      ic.updateMousePosition(e.clientX, e.clientY);
      const rect = dom.getBoundingClientRect();
      this.mousePos.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mousePos.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      if (primaryPointerId === e.pointerId) {
        const dragDist = Math.hypot(e.clientX - pointerStartX, e.clientY - pointerStartY);
        if (!hasDragged && dragDist >= 8) {
          hasDragged = true;
        }

        const tool = ui.getActiveTool();
        const isTrackTool = tool.startsWith('rail') || tool === 'road';
        if (pc.dragStartTile && isTrackTool && dragDist >= 10) {
          pc.isDraggingTrack = true;
        }
      }

      pc.updateHover();
    });

    window.addEventListener('pointerup', (e: PointerEvent) => {
      const wasTracking = activePointers.has(e.pointerId);
      activePointers.delete(e.pointerId);

      if (isMultiTouchActive) {
        if (activePointers.size === 0) {
          isMultiTouchActive = false;
          primaryPointerId = null;
        }
        return;
      }

      if (e.pointerId !== primaryPointerId && primaryPointerId !== null && wasTracking) {
        return;
      }

      if (cm.viewMode === 'cab_view') {
        primaryPointerId = null;
        pc.dragStartTile = null;
        return;
      }

      const target = document.elementFromPoint(e.clientX, e.clientY);
      const isOverUI = target ? !!target.closest('#build-toolbar, #tool-submenu, #rotation-hint, #station-length-selector, #floor-slicer, header, aside, .modal, .modal-backdrop, #mobile-action-dock, #minimap-container, #inspector-panel') : false;

      if (pc.isDraggingTrack) {
        if (isOverUI) {
          pc.cancelPendingPlacements();
        } else {
          pc.finishDragPlacement();
        }
        pc.isDraggingTrack = false;
        pc.dragStartTile = null;
        primaryPointerId = null;
        hasDragged = false;
        return;
      }

      const moveDist = Math.hypot(e.clientX - pointerStartX, e.clientY - pointerStartY);
      const elapsed = performance.now() - pointerStartTime;

      if (!hasDragged && moveDist < 8 && elapsed <= 500 && !isOverUI && (e.button === 0 || e.pointerType === 'touch')) {
        ic.updateMousePosition(e.clientX, e.clientY);
        pc.updateHover();
        this.handleTileClick();
      }

      pc.dragStartTile = null;
      primaryPointerId = null;
      hasDragged = false;
    });

    window.addEventListener('pointercancel', (e: PointerEvent) => {
      activePointers.delete(e.pointerId);
      if (activePointers.size === 0) {
        isMultiTouchActive = false;
        primaryPointerId = null;
      }
      if (pc.isDraggingTrack) {
        pc.cancelPendingPlacements();
        pc.isDraggingTrack = false;
      }
      pc.dragStartTile = null;
      hasDragged = false;
    });

    // 右クリックで回転（右ドラッグによるパン移動後は回転しない）
    dom.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (hasDragged || pc.isDraggingTrack || isMultiTouchActive || cm.wasRightPanDragged()) return;
      if (cm.viewMode === 'cab_view') return;

      const tool = ui.getActiveTool();
      if (fc.isDeploying() || ROTATABLE_TOOLS.includes(tool)) {
        pc.rotateCurrentPlacement();
      }
    });
  }

  /**
   * キーボードショートカットの登録
   */
  private setupKeyboardEvents(): void {
    const pc = this.deps.placementController;
    const fc = this.deps.fleetController;
    const ui = this.deps.uiManager;
    const tm = this.deps.timeManager;
    const wm = this.deps.worldMap;
    const cm = this.deps.cameraManager;

    window.addEventListener('keydown', (e) => {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable)) {
        return;
      }

      // タイトル画面表示中はゲーム内ショートカットを無効化
      const titleOverlay = document.getElementById('title-screen-overlay');
      if (titleOverlay && !titleOverlay.classList.contains('hidden')) {
        return;
      }

      // Ctrl+Z (Mac: Cmd+Z) によるUndo実行
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        this.undoManager?.undo();
        return;
      }

      if (e.key === 'r' || e.key === 'R') {
        const tool = ui.getActiveTool();
        if (fc.isDeploying() || ROTATABLE_TOOLS.includes(tool)) {
          pc.rotateCurrentPlacement();
        }
      } else if (e.key === 'Escape') {
        if (this.deps.scheduleUI.isOpen() || this.deps.switchScheduleUI.isOpen()) return;
        if (cm.viewMode === 'cab_view' || cm.viewMode === 'chase_view') {
          this.deps.onExitCabView();
          return;
        }
        const hadPending = pc.hasPendingPlacements() || fc.hasPendingDeploy();
        pc.cancelPendingPlacements();
        pc.updateRotationHint(ui.getActiveTool());
        if (!hadPending) {
          ui.closeInspector();
        }
      } else if (e.key === 'Enter') {
        if (fc.hasPendingDeploy() || pc.hasPendingPlacements()) {
          pc.confirmPendingPlacements();
        }
      } else if (e.key === 'm' || e.key === 'M') {
        this.deps.onToggleInfiniteFunds();
      } else if (e.key >= '0' && e.key <= '5') {
        const speed = parseInt(e.key, 10);
        tm.setSpeedLevel(speed as SpeedLevel);
        ui.setSpeedUI(speed);
      } else if (e.key === 'd' || e.key === 'D') {
        if (e.shiftKey) {
          const switchTile = wm.getAllTiles().find(t => t.type.startsWith('point_switch') || t.type.startsWith('scissors_crossing'));
          if (switchTile) {
            let target = switchTile;
            if (switchTile.type.startsWith('scissors_crossing')) {
              const orig = wm.resolveCrossingOrigin(switchTile.x, switchTile.z, switchTile.layer);
              if (orig) target = orig;
            }
            this.deps.switchScheduleUI.open(target);
            return;
          }
        }

        const selPos = this.deps.getSelectedTilePos();
        if (selPos) {
          const t = wm.getTile(selPos.x, selPos.z, selPos.layer);
          if (t) {
            if (WorldMap.isStationTileType(t.type)) {
              this.deps.scheduleUI.open(t);
              return;
            } else if (t.type.startsWith('point_switch')) {
              this.deps.switchScheduleUI.open(t);
              return;
            } else if (t.type.startsWith('scissors_crossing')) {
              const orig = wm.resolveCrossingOrigin(t.x, t.z, selPos.layer);
              this.deps.switchScheduleUI.open(orig || t);
              return;
            }
          }
        }

        const firstStation = wm.getAllTiles().find(t => WorldMap.isStationTileType(t.type));
        if (firstStation) {
          this.deps.scheduleUI.open(firstStation);
        }
      }
    });
  }

  public cycleCabTrain(dir: 1 | -1, onEnterCabView: (trainId: number) => void): void {
    const trains = this.deps.trainManager.getTrains().filter(t => !t.externalTravel);
    if (trains.length === 0) return;
    const curIdx = trains.findIndex(t => t.id === this.deps.getCabTargetTrainId());
    let nextIdx = curIdx + dir;
    if (nextIdx < 0) nextIdx = trains.length - 1;
    if (nextIdx >= trains.length) nextIdx = 0;
    onEnterCabView(trains[nextIdx].id);
  }

  public handleToggleSwitch(x: number, z: number, layer?: GridLayer): void {
    const wm = this.deps.worldMap;
    const targetLayer = layer ?? this.deps.getSelectedTilePos()?.layer ?? wm.activeLayer;
    const hub = wm.resolveSwitchHub(x, z, targetLayer);
    if (!hub) return;
    const hubLayer = (hub.layer ?? targetLayer) as GridLayer;
    if (this.deps.trainManager.isTileOccupiedByTrain(hub.x, hub.z, hubLayer)) {
      this.deps.uiManager.showToast('切替不可', '列車が分岐器上を通過・在線中のため、進路を切り替えできません。', 'warning');
      return;
    }
    wm.togglePointSwitch(hub.x, hub.z, hubLayer);
    this.deps.uiManager.showInspector(hub, hub);
    this.deps.audioManager.playBuildSound();
  }

  public handleCycleCrossing(x: number, z: number, layer?: GridLayer): void {
    const wm = this.deps.worldMap;
    const targetLayer = (layer ?? this.deps.getSelectedTilePos()?.layer ?? wm.activeLayer) as GridLayer;
    const clicked = wm.getTile(x, z, targetLayer) || wm.getTile(x, z);
    if (!clicked?.groupOrigin) return;
    const cLayer = (clicked.layer ?? targetLayer) as GridLayer;
    const origin = wm.getTile(clicked.groupOrigin.x, clicked.groupOrigin.z, cLayer) || wm.getTile(clicked.groupOrigin.x, clicked.groupOrigin.z);
    if (!origin) return;
    const along = (origin.rotation % 2 === 1) ? 1 : 2;
    const alongVec = WorldMap.DIRS[along];
    const acrossVec = WorldMap.DIRS[WorldMap.rotateCW(along)];
    const positions = [
      { x: origin.x, z: origin.z }, { x: origin.x + alongVec.x, z: origin.z + alongVec.z },
      { x: origin.x + acrossVec.x, z: origin.z + acrossVec.z }, { x: origin.x + alongVec.x + acrossVec.x, z: origin.z + alongVec.z + acrossVec.z }
    ];
    for (const p of positions) {
      if (this.deps.trainManager.isTileOccupiedByTrain(p.x, p.z, cLayer)) {
        this.deps.uiManager.showToast('切替不可', '列車が交差点上を通過・在線中のため、開通方向を切り替えできません。', 'warning');
        return;
      }
    }
    if (origin.switchSchedule) {
      origin.switchSchedule.mode = 'manual';
    }
    wm.cycleCrossingState(x, z, cLayer);
    const updated = wm.getTile(x, z, cLayer) || wm.getTile(x, z);
    if (updated) { this.deps.uiManager.showInspector(updated); this.deps.audioManager.playBuildSound(); }
  }

  public handleSetStationLength(x: number, z: number, targetLen: number): void {
    const wm = this.deps.worldMap;
    const econ = this.deps.economy;
    const targetLayer = (this.deps.getSelectedTilePos()?.layer ?? wm.activeLayer) as GridLayer;
    const tile = wm.getTile(x, z, targetLayer) || wm.getTile(x, z, wm.activeLayer) || wm.getTile(x, z);
    if (!tile) return;
    const stLayer = (tile.layer ?? targetLayer) as GridLayer;
    const oldStationTiles = wm.getStationTiles(x, z, stLayer).map(t => ({ x: t.x, z: t.z }));
    const currentLen = wm.getStationRunLength(x, z, stLayer);
    if (targetLen === currentLen) return;

    const diff = targetLen - currentLen;
    const unitCost = tile.type === 'signal_yard'
      ? TOOL_CONFIG['signal-yard'].cost
      : tile.type.startsWith('cargo_station')
      ? TOOL_CONFIG['cargo-station'].cost
      : tile.type.includes('elevated')
      ? TOOL_CONFIG['station-elevated'].cost
      : TOOL_CONFIG['station-small'].cost;
    const additionalCost = diff > 0 ? diff * unitCost : 0;

    if (additionalCost > 0 && !econ.canSpend(additionalCost, true)) {
      this.deps.uiManager.showToast('資金不足', `ホーム延伸には ¥${additionalCost.toLocaleString()} が必要です。`, 'danger');
      return;
    }

    const ok = wm.setStationLength(x, z, targetLen, stLayer, (tx, tz, lyr) => this.deps.trainManager.isTileOccupiedByTrain(tx, tz, lyr));
    if (ok) {
      if (additionalCost > 0) {
        econ.spendFunds(additionalCost, true, 'infrastructure', '駅ホーム延伸');
      }
      this.deps.audioManager.playBuildSound();
      const updated = wm.getTile(x, z, stLayer) || wm.getTile(x, z);
      if (updated) {
        this.deps.uiManager.showInspector(updated, undefined, targetLen, wm.getStationAggregateData(x, z, stLayer));
        // 短縮されたタイルのコンテナ表示を消去し、残ったタイルを更新
        for (const oldPos of oldStationTiles) {
          this.deps.visualEffectManager.updateCargoYardVisual(oldPos.x, oldPos.z, stLayer);
        }
        if (updated.type.startsWith('cargo_station') || updated.isCargoYard) {
          for (const st of wm.getStationTiles(x, z, stLayer)) {
            this.deps.visualEffectManager.updateCargoYardVisual(st.x, st.z, stLayer);
          }
        }
      }
      this.deps.miniMap.requestStaticUpdate();
    } else {
      this.deps.uiManager.showToast('有効長変更不可', '列車が在線・停車中であるか、ホームを延伸するためのスペースが不足しています。', 'warning');
    }
  }
}
