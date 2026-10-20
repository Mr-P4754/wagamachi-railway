import * as THREE from 'three';
import { WorldMap, CurveDirection, TileType, TileData, createDefaultStationSchedule, cloneStationSchedule, TileDataSnapshot, cloneTileSnapshot, getStationScheduleScore } from '../simulation/WorldMap';
import { TrainManager } from '../simulation/TrainManager';
import { Economy } from '../simulation/Economy';
import { AudioManager } from '../engine/AudioManager';
import { UIManager, TOOL_CONFIG, ActiveTool } from '../ui/UIManager';
import { GridManager } from '../core/GridManager';
import { GridLayer } from '../core/types';
import { layerToHeight } from '../core/Grid3D';
import { InputController } from '../ui/InputController';
import { TrackBuilder, DragTrackSegment } from '../core/TrackBuilder';
import { ModelFactory } from '../models/ModelFactory';
import { disposeHierarchy } from '../graphics/materials';
import { FleetController } from './FleetController';
import { UndoManager, TileSnapshot } from '../core/UndoManager';

export const CURVE_DIR_ORDER: CurveDirection[] = ['N_E', 'E_S', 'S_W', 'W_N'];
export const CURVE_DIR_LABEL: Record<CurveDirection, string> = {
  N_E: '北 → 東', E_S: '東 → 南', S_W: '南 → 西', W_N: '西 → 北'
};
export const AXIS_LABEL = ['南北方向', '東西方向'];
export const DIR_LABEL = ['北', '東', '南', '西'];

export const ROTATABLE_TOOLS: ActiveTool[] = [
  'rail-straight', 'rail-elevated', 'rail-tunnel', 'rail-curve', 'rail-curve-elevated',
  'rail-slope', 'rail-slope-underground', 'point-switch', 'point-switch-elevated',
  'scissors-crossing', 'scissors-crossing-elevated', 'level-crossing',
  'station-small', 'station-elevated', 'signal-yard', 'cargo-station', 'road'
];

export const PLACEMENT_TOOLS: ActiveTool[] = [
  'rail-straight', 'rail-elevated', 'rail-tunnel', 'rail-curve', 'rail-curve-elevated', 'rail-slope', 'rail-slope-underground',
  'point-switch', 'point-switch-elevated', 'scissors-crossing', 'scissors-crossing-elevated', 'level-crossing',
  'station-small', 'station-elevated', 'signal-yard', 'cargo-station',
  'road', 'building-res', 'building-com', 'building-ind', 'nature'
];

/**
 * 線路・駅・信号場・分岐器・シーサスクロッシング・踏切など「列車が乗れる/敷設延長に数える」タイルかどうか
 */
export function isTrackLikeType(type: TileType): boolean {
  return (
    type.includes('rail') ||
    type.includes('station') ||
    type === 'signal_yard' ||
    type.includes('switch') ||
    type.includes('scissors_crossing') ||
    type === 'level_crossing' ||
    type === 'external_connection'
  );
}

/**
 * 指定マスへの配置が「道路と直進レールの直交による踏切（level_crossing）の新規生成」に該当するかを判定
 */
export function isLevelCrossingCombination(
  tool: ActiveTool,
  rotation: number,
  existingTile: { type: TileType; rotation: number; crossingRoadAxis?: number } | undefined | null,
  layer: GridLayer
): boolean {
  if (layer !== 1 || !existingTile || existingTile.type === 'empty') return false;

  const newAxis = ((rotation % 2) + 2) % 2;
  const existingAxis = (((existingTile.rotation ?? 0) % 2) + 2) % 2;

  // ケースA: 既存の道路の上に直進レールを直交配置
  if (tool === 'rail-straight' && existingTile.type === 'road' && newAxis !== existingAxis) {
    return true;
  }

  // ケースB: 既存の地上レールの上に道路を直交配置
  if (tool === 'road' && existingTile.type === 'rail_ground' && newAxis !== existingAxis) {
    return true;
  }

  // ケースC: 既存の踏切の上に、同じ軸の直進レールまたは直交軸の道路を再配置/通過
  if (existingTile.type === 'level_crossing') {
    const crossingRailAxis = existingAxis;
    const crossingRoadAxis = existingTile.crossingRoadAxis ?? (1 - crossingRailAxis);
    if (tool === 'rail-straight' && newAxis === crossingRailAxis) {
      return true; // 線路ドラッグで既存踏切を同一軸で通過
    }
    if (tool === 'road' && newAxis === crossingRoadAxis) {
      return true; // 道路ドラッグで既存踏切を同一軸で通過
    }
  }

  return false;
}

/**
 * 仮置き中の1件（同じツールで複数件をまとめて保持し、最後にまとめて確定する）
 */
export interface PendingItem {
  tool: ActiveTool;
  x: number;
  z: number;
  layer?: GridLayer;
  rotation: number;
  ghost: THREE.Object3D | null;
  stationPart?: 'single' | 'start' | 'mid' | 'end';
  stationGroupId?: string;
  switchBranchSide?: 'left' | 'right';
  stationPlatformSide?: 'left' | 'right';
}

export interface PlacementControllerDependencies {
  scene: THREE.Scene;
  worldMap: WorldMap;
  gridManager: GridManager;
  trainManager: TrainManager;
  economy: Economy;
  audioManager: AudioManager;
  uiManager: UIManager;
  inputController: InputController;
  getFleetController?: () => FleetController | null;
  onPlacementExecuted?: () => void;
  onCargoYardVisualUpdate?: (x: number, z: number, layer: GridLayer) => void;
  undoManager?: UndoManager;
}

/**
 * 建設・仮置き・プレビュー・ドラッグ一括敷設・回転制御をカプセル化するコントローラー
 */
export class PlacementController {
  private scene: THREE.Scene;
  private worldMap: WorldMap;
  private gridManager: GridManager;
  private trainManager: TrainManager;
  private economy: Economy;
  private audioManager: AudioManager;
  private uiManager: UIManager;
  private inputController: InputController;
  private getFleetController?: () => FleetController | null;
  private onPlacementExecuted?: () => void;
  private onCargoYardVisualUpdate?: (x: number, z: number, layer: GridLayer) => void;
  private undoManager?: UndoManager;

  public setUndoManager(undoManager: UndoManager): void {
    this.undoManager = undoManager;
  }

  // 仮置き中のプレースメント一覧
  private pendingItems: PendingItem[] = [];

  // 現在の設置向き（0-3）
  public currentRotation: number = 0;
  // 分岐器の左右分岐方向 ('right': 右分岐, 'left': 左分岐)
  public currentSwitchSide: 'left' | 'right' = 'right';
  // 駅舎ホームの配置方向 ('right': 右側, 'left': 左側)
  public currentStationSide: 'left' | 'right' = 'right';
  // 駅ホーム有効長（1〜10両）
  public currentStationLength: number = 2;

  // 線路一括敷設（ドラッグ延伸モード）状態
  public isDraggingTrack: boolean = false;
  public dragStartTile: { x: number; z: number } | null = null;
  private dragGhostGroup: THREE.Group | null = null;
  private dragCurrentSegments: DragTrackSegment[] = [];
  private prevDragStartTile: { x: number; z: number; layer: GridLayer } | null = null;
  private prevDragEndTile: { x: number; z: number; layer: GridLayer } | null = null;

  // スマホ用ターゲットレティクル操作状態
  public mobileDragStartTile: { x: number; z: number } | null = null;

  // ホバーカーソル＆ガイドライン
  public hoverPlane: THREE.Mesh;
  public hoveredTile: { x: number; z: number } | null = null;
  private groundDashedGuide: THREE.Group;
  private groundDashedLines: THREE.LineSegments;
  private targetDashedLines: THREE.LineSegments;
  private verticalDashedLines: THREE.LineSegments;

  // ホバー追従駅ゴースト
  private hoverStationGhost: THREE.Group | null = null;
  private hoverStationCacheKey: string = '';

  // ゴースト用マテリアル
  private ghostMaterial = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.5,
    depthWrite: false
  });
  private tunnelGhostMaterial = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.72,
    depthTest: false,
    depthWrite: false
  });

  constructor(deps: PlacementControllerDependencies) {
    this.scene = deps.scene;
    this.worldMap = deps.worldMap;
    this.gridManager = deps.gridManager;
    this.trainManager = deps.trainManager;
    this.economy = deps.economy;
    this.audioManager = deps.audioManager;
    this.uiManager = deps.uiManager;
    this.inputController = deps.inputController;
    this.getFleetController = deps.getFleetController;
    this.onPlacementExecuted = deps.onPlacementExecuted;
    this.onCargoYardVisualUpdate = deps.onCargoYardVisualUpdate;
    this.undoManager = deps.undoManager;

    this.ghostMaterial.userData.keepAlive = true;
    this.tunnelGhostMaterial.userData.keepAlive = true;

    // 1. タイルホバーカーソル（半透明ボックス）
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
    this.scene.add(this.hoverPlane);

    // 2. 階層変更時に対応する地表座標を示す破線ガイド
    this.groundDashedGuide = new THREE.Group();
    this.groundDashedGuide.name = 'GroundDashedGuide';
    this.groundDashedGuide.visible = false;

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

    const targetBorderGeo = new THREE.BufferGeometry().setFromPoints(borderPoints);
    this.targetDashedLines = new THREE.LineSegments(targetBorderGeo, dashedMat);
    this.targetDashedLines.computeLineDistances();
    this.groundDashedGuide.add(this.targetDashedLines);

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
    this.scene.add(this.groundDashedGuide);
  }

  public setGridManager(gm: GridManager): void {
    this.gridManager = gm;
  }

  public getPendingItems(): readonly PendingItem[] {
    return this.pendingItems;
  }

  public hasPendingPlacements(): boolean {
    return this.pendingItems.length > 0;
  }

  /**
   * 現在の階層およびマスの標高に応じて、ツールを自動的に適切な立体種別へ解決する
   */
  public resolveAutoToolForLayer(
    tool: ActiveTool,
    layer: GridLayer = this.worldMap.activeLayer,
    x?: number,
    z?: number
  ): ActiveTool {
    let surfaceElevation = 1;
    if (x !== undefined && z !== undefined) {
      const cell = this.gridManager.getCell(x, 1, z);
      if (cell) surfaceElevation = cell.elevation;
    }

    const isTunnel = layer < surfaceElevation;
    const isElevated = layer > surfaceElevation;

    if (tool === 'rail-straight' || tool === 'rail-elevated' || tool === 'rail-tunnel') {
      if (tool === 'rail-tunnel') return 'rail-tunnel';
      if (isTunnel) return 'rail-tunnel';
      if (isElevated) return 'rail-elevated';
      return 'rail-straight';
    }
    if (tool === 'rail-curve' || tool === 'rail-curve-elevated') {
      return isElevated ? 'rail-curve-elevated' : 'rail-curve';
    }
    if (tool === 'point-switch' || tool === 'point-switch-elevated') {
      return isElevated ? 'point-switch-elevated' : 'point-switch';
    }
    if (tool === 'scissors-crossing' || tool === 'scissors-crossing-elevated') {
      return isElevated ? 'scissors-crossing-elevated' : 'scissors-crossing';
    }
    if (tool === 'station-small' || tool === 'station-elevated') {
      if (tool === 'station-elevated') return 'station-elevated';
      return isElevated ? 'station-elevated' : 'station-small';
    }
    return tool;
  }

  /**
   * ホバー位置の更新
   */
  public updateHover(): void {
    const tool = this.uiManager.getActiveTool();
    const isTunnelTool = tool === 'rail-tunnel';
    const intersect = this.inputController.getGridIntersection(
      this.worldMap.gridSize,
      isTunnelTool ? undefined : (x, z) => this.worldMap.getElevationOffset(x, z)
    );

    const fleetCtrl = this.getFleetController ? this.getFleetController() : null;

    if (intersect && intersect.isValidTile) {
      const tx = intersect.tileX;
      const tz = intersect.tileZ;
      this.hoveredTile = { x: tx, z: tz };

      const groundElevY = this.worldMap.getElevationOffset(tx, tz);
      const activeLayer = this.worldMap.activeLayer;

      const isSurfaceTool = tool.startsWith('zone-') || tool === 'road' || tool === 'nature' || tool.startsWith('building-');
      const isStationTool = tool === 'station-small' || tool === 'station-elevated' || tool === 'signal-yard' || tool === 'cargo-station';
      let finalY: number;
      if (isSurfaceTool) {
        finalY = groundElevY;
      } else {
        let effectiveLayer = activeLayer;
        if (tool === 'station-elevated' && activeLayer === 1) {
          effectiveLayer = 2;
        }
        const effectiveBaseHeight = layerToHeight(effectiveLayer);
        const elevOffset = this.worldMap.getTrackElevationOffset(tx, tz, effectiveLayer);
        finalY = effectiveBaseHeight + elevOffset;
      }

      this.hoverPlane.position.set(tx * WorldMap.TILE_SIZE, finalY + 0.05, tz * WorldMap.TILE_SIZE);
      this.hoverPlane.visible = true;
      const mat = this.hoverPlane.material as THREE.MeshBasicMaterial;
      mat.color.set(tool.startsWith('demolish') ? 0xf43f5e : 0x38bdf8);

      // 破線ガイドの表示条件
      if (tool === 'rail-slope') {
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
      if (fleetCtrl && fleetCtrl.isDeploying() && !fleetCtrl.hasPendingDeploy()) {
        fleetCtrl.updateHoverTrainGhost(tx, tz);
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
    if (fleetCtrl && fleetCtrl.isDeploying() && !fleetCtrl.hasPendingDeploy()) {
      fleetCtrl.clearHoverTrainGhost();
    }
  }

  /**
   * 階層操作中に対応する地表座標・垂直関係を示す破線ガイドを更新
   */
  private updateGroundDashedGuide(tx: number, tz: number, groundY: number, currentY: number): void {
    const half = WorldMap.TILE_SIZE / 2;
    const worldX = tx * WorldMap.TILE_SIZE;
    const worldZ = tz * WorldMap.TILE_SIZE;

    this.groundDashedLines.position.set(worldX, groundY + 0.04, worldZ);
    this.groundDashedLines.computeLineDistances();

    this.targetDashedLines.position.set(worldX, currentY + 0.04, worldZ);
    this.targetDashedLines.computeLineDistances();

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
      array[idx++] = worldX + cx;
      array[idx++] = groundY + 0.04;
      array[idx++] = worldZ + cz;
      array[idx++] = worldX + cx;
      array[idx++] = groundY + 0.04 + dy;
      array[idx++] = worldZ + cz;
    }
    posAttr.needsUpdate = true;
    this.verticalDashedLines.computeLineDistances();
  }

  /**
   * 勾配線路（スロープ）設置時の立体ガイド
   */
  private updateSlopeDashedGuide(
    startTx: number,
    startTz: number,
    startY: number,
    endTx: number,
    endTz: number,
    endGroundY: number,
    endTargetY: number
  ): void {
    const half = WorldMap.TILE_SIZE / 2;
    const startWorldX = startTx * WorldMap.TILE_SIZE;
    const startWorldZ = startTz * WorldMap.TILE_SIZE;
    const endWorldX = endTx * WorldMap.TILE_SIZE;
    const endWorldZ = endTz * WorldMap.TILE_SIZE;

    this.groundDashedLines.position.set(startWorldX, startY + 0.04, startWorldZ);
    this.groundDashedLines.computeLineDistances();

    this.targetDashedLines.position.set(endWorldX, endTargetY + 0.04, endWorldZ);
    this.targetDashedLines.computeLineDistances();

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
      array[idx++] = endWorldX + cx;
      array[idx++] = endGroundY + 0.04;
      array[idx++] = endWorldZ + cz;
      array[idx++] = endWorldX + cx;
      array[idx++] = endGroundY + 0.04 + dy;
      array[idx++] = endWorldZ + cz;
    }
    posAttr.needsUpdate = true;
    this.verticalDashedLines.computeLineDistances();
  }

  /**
   * ドラッグ延伸による線路自動補間ゴーストプレビューを更新
   */
  public updateDragPreview(start: { x: number; z: number }, current: { x: number; z: number }): void {
    const tool = this.uiManager.getActiveTool();
    const isTunnelTool = tool === 'rail-tunnel';
    const curLayer: GridLayer = this.worldMap.activeLayer;

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
      this.scene.remove(this.dragGhostGroup);
      disposeHierarchy(this.dragGhostGroup);
      this.dragGhostGroup = null;
    }

    const startExisting = this.worldMap.getTile(start.x, start.z, curLayer);
    let preferHorizontalFirst = true;
    if (startExisting && (startExisting.type === 'rail_ground' || startExisting.type === 'rail_elevated')) {
      // 始点が南北線路(axis=0)なら南北(垂直)先行、東西線路(axis=1)なら東西(水平)先行にすると始点または本線上で綺麗に分岐する
      preferHorizontalFirst = ((startExisting.rotation ?? 0) % 2) === 1;
    }

    const segments = TrackBuilder.calculatePath(
      start.x,
      start.z,
      current.x,
      current.z,
      curLayer,
      preferHorizontalFirst
    );
    for (const seg of segments) {
      if (tool === 'road') {
        seg.tool = 'road';
        if (seg.curveDir) {
          seg.rotation = (start.x !== current.x && seg.x === current.x) ? 0 : 1;
          seg.curveDir = undefined; // 道路は直線セグメントとして補間
          seg.isCorner = true; // L字コーナーの屈曲点フラグ
        }
        continue;
      }
      const cell = this.gridManager.getCell(seg.x, 1, seg.z);
      const surfaceElevation = cell ? cell.elevation : 1;
      if ((seg.tool === 'rail-straight' || seg.tool === 'rail-elevated') && this.worldMap.isTunnelSection(seg.x, seg.z, seg.layer)) {
        seg.tool = 'rail-tunnel';
      } else if (seg.layer === surfaceElevation) {
        // 山岳地表面（layer === surfaceElevation）では高架ではなく地表線路・地表カーブとして敷設
        if (seg.tool === 'rail-elevated') seg.tool = 'rail-straight';
        if (seg.tool === 'rail-curve-elevated') seg.tool = 'rail-curve';
      }

      // ★修正: seg.tool !== 'road' を追加し、道路ドラッグ時は踏切生成へ進ませる
      const existing = this.worldMap.getTile(seg.x, seg.z, seg.layer);
      if (seg.tool !== 'road' && existing && (existing.type === 'rail_ground' || existing.type === 'rail_elevated')) {
        const straightAxis = (existing.rotation ?? 0) % 2; // 0: 南北(0,2), 1: 東西(1,3)
        const straightDirs = straightAxis === 0 ? [0, 2] : [1, 3];

        if (seg.curveDir) {
          const [cA, cB] = WorldMap.curveDirToIndices(seg.curveDir);
          const sharedDir = [cA, cB].find(d => straightDirs.includes(d));
          const branchDir = [cA, cB].find(d => !straightDirs.includes(d));

          if (sharedDir !== undefined && branchDir !== undefined) {
            const forward = WorldMap.opposite(sharedDir);
            const branchSide = (WorldMap.rotateCW(forward) === branchDir) ? 'right' : 'left';
            const switchTool: ActiveTool = existing.type === 'rail_elevated' ? 'point-switch-elevated' : 'point-switch';
            seg.tool = switchTool;
            seg.rotation = forward;
            seg.switchBranchSide = branchSide;
            seg.curveDir = undefined;
            seg.isAutoSwitch = true;
          }
        } else if (seg.x === start.x && seg.z === start.z && segments.length >= 2 && (seg.rotation % 2) !== straightAxis) {
          // 始点マスから既存レールと直交する方向へ直線ドラッグした場合
          const nextSeg = segments[1];
          const branchDir = nextSeg.x > seg.x ? 1 : nextSeg.x < seg.x ? 3 : nextSeg.z > seg.z ? 2 : 0;
          const forward = straightDirs[0]; // 北(0) または 東(1)
          const branchSide = (WorldMap.rotateCW(forward) === branchDir) ? 'right' : 'left';
          const switchTool: ActiveTool = existing.type === 'rail_elevated' ? 'point-switch-elevated' : 'point-switch';
          seg.tool = switchTool;
          seg.rotation = forward;
          seg.switchBranchSide = branchSide;
          seg.isAutoSwitch = true;
        }
      }
    }
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
    this.scene.add(ghost);
    this.dragGhostGroup = ghost;

    let totalCost = 0;
    let placeableCount = 0;
    for (const seg of segments) {
      const waterCheck = this.worldMap.canPlaceAtWater(seg.x, seg.z, seg.layer);
      if (!waterCheck.allowed) continue;
      if (this.pendingItems.some(p => p.x === seg.x && p.z === seg.z && (p.layer ?? 1) === seg.layer)) continue;
      const existing = this.worldMap.getTile(seg.x, seg.z, seg.layer);
      if (existing && existing.type === 'level_crossing') continue; // 既存踏切の通過は課金対象外
      const isCrossing = !seg.isCorner && isLevelCrossingCombination(seg.tool, seg.rotation, existing, seg.layer);
      if (this.worldMap.isPermanentTrackOrStation(seg.x, seg.z, seg.layer) && !isCrossing && !seg.isAutoSwitch) continue;
      // 農地(farmland)と自然(nature)のみ、線路・道路の敷設時に自動で切り拓いて上書き可能とする（建物は誤破壊と人口バグ防止のため保護）
      const isClearableTerrain = existing && (existing.type === 'farmland' || existing.type === 'nature');
      if (existing && existing.type !== 'empty' && !isCrossing && !isClearableTerrain) continue;

      let segTool = seg.tool;
      totalCost += TOOL_CONFIG[segTool]?.cost || 100000;
      placeableCount++;
    }

    const previewPrefix = tool === 'road' ? '🚗 道路敷設' : '🛤️ 線路敷設';
    this.uiManager.setRotationHint(
      true,
      `${previewPrefix}: ${placeableCount}マス  ¥${totalCost.toLocaleString('ja-JP')}`
    );
  }

  /**
   * ドラッグ延伸線路の仮置き登録を完了
   */
  /**
   * 既存レール上に分岐器（point-switch）を上書き配置する際の設定を解決
   */
  public resolveSwitchOverwrite(
    tool: ActiveTool,
    rotation: number,
    existingTile: TileData | undefined,
    branchSide: 'left' | 'right' = this.currentSwitchSide
  ): { isSwitch: boolean; switchRot: number; branchSide: 'left' | 'right'; isElevated: boolean } | null {
    if (!existingTile || !tool.startsWith('point-switch')) return null;
    const isGroundRail = existingTile.type === 'rail_ground';
    const isElevRail = existingTile.type === 'rail_elevated';
    const isElevatedTool = tool === 'point-switch-elevated' || isElevRail;

    // 既存の直線レールの上から分岐器を置く場合
    if (isGroundRail || isElevRail) {
      const straightAxis = (existingTile.rotation ?? 0) % 2; // 0: 南北(0,2), 1: 東西(1,3)
      let switchRot = rotation;
      if (switchRot % 2 !== straightAxis) {
        switchRot = straightAxis === 0 ? 0 : 1;
      }
      return { isSwitch: true, switchRot, branchSide, isElevated: isElevatedTool };
    }

    // 既存の他の上書き可能線路（曲線や旧分岐器など）の上から分岐器を置く場合
    if (this.worldMap.isOverwritableTrack(existingTile.x, existingTile.z, existingTile.layer)) {
      return { isSwitch: true, switchRot: rotation, branchSide, isElevated: isElevatedTool };
    }

    return null;
  }

  public finishDragPlacement(): void {
    this.prevDragStartTile = null;
    this.prevDragEndTile = null;
    if (this.dragGhostGroup) {
      this.scene.remove(this.dragGhostGroup);
      disposeHierarchy(this.dragGhostGroup);
      this.dragGhostGroup = null;
    }

    if (this.dragCurrentSegments.length === 0) return;

    const curActiveLayer = this.worldMap.activeLayer;
    if (this.uiManager.getActiveTool() === 'road' && curActiveLayer < 0) {
      this.uiManager.showToast('設置不可', '地下階層には道路を設置できません。地上1F以上の階層に切り替えてください。', 'warning');
      return;
    }

    let addedCount = 0;
    for (const seg of this.dragCurrentSegments) {
      if (seg.tool === 'road') {
        const cell = this.gridManager.getCell(seg.x, 1, seg.z);
        const surfaceElev = cell ? cell.elevation : 1;
        if (seg.layer < surfaceElev) {
          seg.layer = surfaceElev as GridLayer;
        }
      }
      const waterCheck = this.worldMap.canPlaceAtWater(seg.x, seg.z, seg.layer);
      if (!waterCheck.allowed) continue;

      if (this.pendingItems.some(p => p.x === seg.x && p.z === seg.z && (p.layer ?? 1) === seg.layer)) {
        continue;
      }
      const existing = this.worldMap.getTile(seg.x, seg.z, seg.layer);
      if (existing && existing.type === 'level_crossing') continue; // 既存踏切はそのまま通過（仮置き不要）
      const isCrossing = !seg.isCorner && isLevelCrossingCombination(seg.tool, seg.rotation, existing, seg.layer);

      // ★修正: seg.tool !== 'road' を追加し、道路ドラッグ時は踏切生成へ進ませる
      if (seg.tool !== 'road' && existing && (existing.type === 'rail_ground' || existing.type === 'rail_elevated')) {
        const straightAxis = (existing.rotation ?? 0) % 2; // 0: 南北(0,2), 1: 東西(1,3)
        const straightDirs = straightAxis === 0 ? [0, 2] : [1, 3];
        let forward = seg.rotation;
        let branchSide: 'left' | 'right' = seg.switchBranchSide ?? 'right';
        let shouldConvertToSwitch = false;

        if (seg.curveDir) {
          const [cA, cB] = WorldMap.curveDirToIndices(seg.curveDir);
          const sharedDir = [cA, cB].find(d => straightDirs.includes(d));
          const branchDir = [cA, cB].find(d => !straightDirs.includes(d));

          if (sharedDir !== undefined && branchDir !== undefined) {
            forward = WorldMap.opposite(sharedDir);
            branchSide = (WorldMap.rotateCW(forward) === branchDir) ? 'right' : 'left';
            shouldConvertToSwitch = true;
          }
        } else if (seg.isAutoSwitch) {
          shouldConvertToSwitch = true;
        } else if (this.dragCurrentSegments.length >= 2 && seg === this.dragCurrentSegments[0] && (seg.rotation % 2) !== straightAxis) {
          const nextSeg = this.dragCurrentSegments[1];
          const branchDir = nextSeg.x > seg.x ? 1 : nextSeg.x < seg.x ? 3 : nextSeg.z > seg.z ? 2 : 0;
          forward = straightDirs[0];
          branchSide = (WorldMap.rotateCW(forward) === branchDir) ? 'right' : 'left';
          shouldConvertToSwitch = true;
        }

        if (shouldConvertToSwitch) {
          const switchTool: ActiveTool = existing.type === 'rail_elevated' ? 'point-switch-elevated' : 'point-switch';
          const item: PendingItem = {
            tool: switchTool,
            x: seg.x,
            z: seg.z,
            layer: seg.layer,
            rotation: forward,
            ghost: null,
            switchBranchSide: branchSide
          };
          this.pendingItems.push(item);
          this.refreshGhostFor(item);
          addedCount++;
          continue;
        }
      }

      if (this.worldMap.isPermanentTrackOrStation(seg.x, seg.z, seg.layer) && !isCrossing) continue;
      // 農地(farmland)と自然(nature)のみ、線路・道路の敷設時に自動で切り拓いて上書き可能とする（建物は誤破壊と人口バグ防止のため保護）
      const isClearableTerrain = existing && (existing.type === 'farmland' || existing.type === 'nature');
      if (existing && existing.type !== 'empty' && !isCrossing && !isClearableTerrain) continue;

      let segTool = seg.tool;
      let segRotation = seg.rotation;
      let segBranchSide: 'left' | 'right' | undefined = undefined;

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
        ghost: null,
        switchBranchSide: segBranchSide
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
   * プレビュー用メッシュ（半透明ゴースト）を生成
   */
  public createGhostMesh(
    tool: ActiveTool,
    rotation: number,
    stationPart: 'single' | 'start' | 'mid' | 'end' = 'single',
    branchSide: 'left' | 'right' = this.currentSwitchSide,
    platformSide: 'left' | 'right' = this.currentStationSide,
    layer: GridLayer = this.worldMap.activeLayer,
    x?: number,
    z?: number
  ): THREE.Object3D | null {
    let effectiveTool = this.resolveAutoToolForLayer(tool, layer, x, z);
    const isTunnelSec = (x !== undefined && z !== undefined)
      ? this.worldMap.isTunnelSection(x, z, layer)
      : (layer < 0 || tool === 'rail-tunnel');

    if (isTunnelSec && (tool === 'rail-straight' || tool === 'rail-elevated' || tool === 'rail-tunnel')) {
      effectiveTool = 'rail-tunnel';
    }

    const axis = rotation % 2;
    const baseH = layerToHeight(layer);
    let mesh: THREE.Group | null = null;

    if (x !== undefined && z !== undefined) {
      const existing = this.worldMap.getTile(x, z, layer);
      if (effectiveTool === 'level-crossing') {
        let railAxis = axis;
        if (existing && existing.type === 'road') {
          const roadAxis = (((existing.rotation ?? 0) % 2) + 2) % 2;
          railAxis = 1 - roadAxis;
        } else if (existing && existing.type === 'rail_ground') {
          railAxis = (((existing.rotation ?? 0) % 2) + 2) % 2;
        }
        mesh = ModelFactory.createLevelCrossing(railAxis);
        return mesh;
      }
      if (isLevelCrossingCombination(effectiveTool, rotation, existing, layer)) {
        const railAxis = effectiveTool === 'rail-straight' ? axis : (((existing!.rotation ?? 0) % 2 + 2) % 2);
        mesh = ModelFactory.createLevelCrossing(railAxis);
        return mesh;
      }
    }

    switch (effectiveTool) {
      case 'level-crossing':
        mesh = ModelFactory.createLevelCrossing(axis);
        break;
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
        mesh = ModelFactory.createStation(axis, false, stationPart, platformSide, '駅', 3.0, true);
        break;
      case 'station-elevated':
        mesh = ModelFactory.createStation(axis, true, stationPart, platformSide, '駅', baseH, true);
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
   * 勾配(4×1)ゴースト
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
   * 地下勾配(4×1)ゴースト
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
   * シーサスクロッシング(2×2)ゴースト
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
   * 指定した仮置きアイテムのゴーストを（再）生成する
   */
  public refreshGhostFor(item: PendingItem): void {
    if (item.ghost) {
      this.scene.remove(item.ghost);
      disposeHierarchy(item.ghost);
      item.ghost = null;
    }
    const targetLayer = item.layer ?? this.worldMap.activeLayer;
    const branchSide = item.switchBranchSide ?? this.currentSwitchSide;
    const platformSide = item.stationPlatformSide ?? this.currentStationSide;
    const ghost = this.createGhostMesh(item.tool, item.rotation, item.stationPart ?? 'single', branchSide, platformSide, targetLayer, item.x, item.z);
    if (ghost) {
      const baseHeight = layerToHeight(targetLayer);
      const isSurfaceTool = item.tool === 'road' || item.tool === 'nature' || item.tool.startsWith('building-');
      const elevY = isSurfaceTool
        ? ((targetLayer === 1) ? this.worldMap.getElevationOffset(item.x, item.z) : 0)
        : this.worldMap.getTrackElevationOffset(item.x, item.z, targetLayer);
      ghost.position.set(item.x * WorldMap.TILE_SIZE, baseHeight + elevY, item.z * WorldMap.TILE_SIZE);
      this.scene.add(ghost);
    }
    item.ghost = ghost;
  }

  /**
   * 駅・信号場・貨物駅のホバー追従プレビューゴースト更新
   */
  public updateHoverStationGhost(x: number, z: number): void {
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
        const elevY = this.worldMap.getTrackElevationOffset(tx, tz, targetLayer);
        mesh.position.set(stepX * i * WorldMap.TILE_SIZE, elevY, stepZ * i * WorldMap.TILE_SIZE);
        group.add(mesh);
      }
    }

    group.position.set(x * WorldMap.TILE_SIZE, baseHeight, z * WorldMap.TILE_SIZE);
    this.scene.add(group);
    this.hoverStationGhost = group;
    this.hoverStationCacheKey = cacheKey;
  }

  /**
   * ホバー追従駅ゴーストの消去
   */
  public clearHoverStationGhost(): void {
    if (this.hoverStationGhost) {
      this.scene.remove(this.hoverStationGhost);
      disposeHierarchy(this.hoverStationGhost);
      this.hoverStationGhost = null;
      this.hoverStationCacheKey = '';
    }
  }

  /**
   * 仮置き中のプレースメントを全てキャンセル
   */
  public cancelPendingPlacements(): void {
    for (const item of this.pendingItems) {
      if (item.ghost) {
        this.scene.remove(item.ghost);
        disposeHierarchy(item.ghost);
      }
    }
    this.pendingItems = [];

    const fleetCtrl = this.getFleetController ? this.getFleetController() : null;
    if (fleetCtrl) {
      fleetCtrl.cancelDeploy();
    }

    this.clearHoverStationGhost();

    if (this.dragGhostGroup) {
      this.scene.remove(this.dragGhostGroup);
      disposeHierarchy(this.dragGhostGroup);
      this.dragGhostGroup = null;
    }
    this.dragCurrentSegments = [];
    this.isDraggingTrack = false;
    this.dragStartTile = null;
    this.mobileDragStartTile = null;

    this.hoverPlane.visible = false;
    this.groundDashedGuide.visible = false;
    this.hoveredTile = null;
    this.uiManager.setRotationHint(false);
    this.uiManager.setPlacementButtonsVisible(false);
  }

  /**
   * 仮置きを追加する（まだワールドには反映しない・課金しない）
   */
  public stagePendingPlacement(tool: ActiveTool, x: number, z: number): void {
    this.trainManager.updateOccupancyNow();

    if (!this.economy.canInvest) {
      this.uiManager.showToast('追加投資制限中', '資金が赤字のため、新規の線路敷設・建築は行えません。（資金が黒字化すると自動解除されます）', 'warning');
      return;
    }

    const isInfrastructureTool = (t: ActiveTool | string) => {
      return (
        t.startsWith('rail') ||
        t.startsWith('point-switch') ||
        t.startsWith('scissors-crossing') ||
        t.startsWith('station') ||
        t.startsWith('cargo-station') ||
        t === 'signal-yard' ||
        t === 'road' ||
        t === 'level-crossing'
      );
    };

    let curLayer: GridLayer = this.worldMap.activeLayer;
    const isSurfaceOnlyTool = tool === 'road' || tool === 'nature' || tool.startsWith('building-');
    if (isSurfaceOnlyTool && curLayer < 0) {
      this.uiManager.showToast('設置不可', '地下階層には道路・建物・植林を設置できません。地上1F以上の階層に切り替えてください。', 'warning');
      return;
    }
    if (tool === 'station-elevated' && curLayer === 1) {
      curLayer = 2;
    }
    if (tool === 'rail-slope') {
      if (curLayer >= 5) {
        this.uiManager.showToast('敷設不可', '5Fからは上り勾配線路を敷設できません（4F以下をご利用ください）。', 'warning');
        return;
      }
      if (curLayer < 0) {
        curLayer = 1;
      }
    }
    if (tool === 'rail-slope-underground') {
      if (curLayer !== 1) {
        this.uiManager.showToast('敷設不可', '地下勾配線路は地上1Fから地下B1Fへの接続専用です。地上1Fでご利用ください。', 'warning');
        return;
      }
    }
    const cellAtPos = this.gridManager.getCell(x, 1, z);
    const surfaceElev = cellAtPos ? cellAtPos.elevation : 1;
    const isSurfacePlacementTool = tool === 'road' || tool === 'nature' || tool.startsWith('building-');
    if (isSurfacePlacementTool && curLayer < surfaceElev) {
      curLayer = surfaceElev as GridLayer;
    }
    let effectiveTool = this.resolveAutoToolForLayer(tool, curLayer, x, z);
    if ((tool === 'rail-straight' || tool === 'rail-elevated' || tool === 'rail-tunnel') && this.worldMap.isTunnelSection(x, z, curLayer)) {
      effectiveTool = 'rail-tunnel';
    }

    const isStationOrYard = effectiveTool === 'station-small' || effectiveTool === 'station-elevated' || effectiveTool === 'signal-yard' || effectiveTool === 'cargo-station';
    if (isStationOrYard) {
      const baseTrackTile = this.worldMap.getTile(x, z, curLayer);
      let stationRot = this.currentRotation;
      if (baseTrackTile && (baseTrackTile.type === 'rail_ground' || baseTrackTile.type === 'rail_elevated')) {
        stationRot = baseTrackTile.rotation;
      }
      const len = this.currentStationLength;
      const axis = stationRot % 2;
      const stepX = axis === 1 ? 1 : 0;
      const stepZ = axis === 1 ? 0 : 1;

      for (let i = 0; i < len; i++) {
        const tx = x + stepX * i;
        const tz = z + stepZ * i;
        const waterCheck = this.worldMap.canPlaceAtWater(tx, tz, curLayer);
        if (!waterCheck.allowed) {
          this.uiManager.showToast('設置不可', waterCheck.reason || '水上（地上1F）には駅・信号場を設置できません。地上2F以上の高架、または地下をご利用ください。', 'warning');
          return;
        }
      }

      const existingIdx = this.pendingItems.findIndex(p => p.tool === effectiveTool && p.x === x && p.z === z && (p.layer ?? 1) === curLayer);
      if (existingIdx !== -1) {
        const originItem = this.pendingItems[existingIdx];
        const toRemove = this.pendingItems.filter(p => {
          return p.tool === effectiveTool && (
            (originItem.stationGroupId && p.stationGroupId === originItem.stationGroupId) ||
            (Math.abs(p.x - originItem.x) <= 10 && Math.abs(p.z - originItem.z) <= 10)
          ) && (p.layer ?? 1) === curLayer;
        });
        for (const rem of toRemove) {
          if (rem.ghost) this.scene.remove(rem.ghost);
        }
        this.pendingItems = this.pendingItems.filter(p => !toRemove.includes(p));
        this.uiManager.setPlacementButtonsVisible(this.pendingItems.length > 0);
        this.updateRotationHint(tool);
        if (this.pendingItems.length === 0 && this.hoveredTile) {
          this.updateHoverStationGhost(this.hoveredTile.x, this.hoveredTile.z);
        }
        return;
      }

      for (let i = 0; i < len; i++) {
        const tx = x + stepX * i;
        const tz = z + stepZ * i;
        if (!this.worldMap.isInBounds(tx, tz)) {
          this.uiManager.showToast('設置不可', 'マップ外には設置できません。', 'warning');
          return;
        }
        const existingTile = this.worldMap.getTile(tx, tz, curLayer);
        const isCompatibleTrack = existingTile && (existingTile.type === 'rail_ground' || existingTile.type === 'rail_elevated') && (existingTile.rotation === axis);
        if (existingTile && existingTile.type !== 'empty' && !isCompatibleTrack) {
          this.uiManager.showToast('設置不可', '既存の施設や曲線・分岐レールと重なる位置には駅を設置できません。', 'warning');
          return;
        }
        if (this.pendingItems.some(p => p.x === tx && p.z === tz && (p.layer ?? 1) === curLayer)) {
          this.uiManager.showToast('設置不可', 'すでに仮置きされている線路や施設と重なる位置には設置できません。', 'warning');
          return;
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
      if (removed.ghost) this.scene.remove(removed.ghost);
      this.uiManager.setPlacementButtonsVisible(this.pendingItems.length > 0);
      this.updateRotationHint(tool);
      return;
    }

    const waterCheck = this.worldMap.canPlaceAtWater(x, z, curLayer);
    if (!waterCheck.allowed) {
      this.uiManager.showToast('敷設不可', waterCheck.reason || '水上（地上1F）には敷設できません。地上2F以上の高架橋梁、または地下トンネルをご利用ください。', 'warning');
      return;
    }

    if (this.gridManager.isWaterAtGroundLevel(x, z) && !isInfrastructureTool(effectiveTool)) {
      this.uiManager.showToast('設置不可', '水上には建物を設置できません。', 'warning');
      return;
    }

    if (effectiveTool === 'rail-slope' || effectiveTool === 'rail-slope-underground') {
      const isUnderground = effectiveTool === 'rail-slope-underground';
      const axisVal = this.currentRotation % 2;
      const reversed = this.currentRotation >= 2;
      const axisDirs: [number, number] = axisVal === 1 ? [1, 3] : [0, 2];
      const [, stepIdx] = reversed ? [axisDirs[1], axisDirs[0]] : [axisDirs[0], axisDirs[1]];
      const stepDir = WorldMap.DIRS[stepIdx];
      const otherLayer: GridLayer = isUnderground ? -1 : ((curLayer + 1) as GridLayer);

      for (let i = 0; i < 4; i++) {
        const tx = x + stepDir.x * i;
        const tz = z + stepDir.z * i;

        if (!this.worldMap.isInBounds(tx, tz)) {
          this.uiManager.showToast('敷設不可', 'マップ外には敷設できません。', 'warning');
          return;
        }
        if (isUnderground && curLayer === 1 && this.worldMap.getElevationOffset(tx, tz) > 0) {
          this.uiManager.showToast('敷設不可', '山岳・丘陵地帯（標高の高い場所）には地下潜入スロープを敷設できません。平坦な平地（地上1F）をご利用ください。', 'warning');
          return;
        }
        const waterCheck = this.worldMap.canPlaceAtWater(tx, tz, curLayer);
        if (!waterCheck.allowed) {
          this.uiManager.showToast('敷設不可', waterCheck.reason || '水上には敷設できません。', 'warning');
          return;
        }
        // 開始階層および接続階層の既存線路・建物チェック
        if (this.worldMap.isPermanentTrackOrStation(tx, tz, curLayer)) {
          this.uiManager.showToast('敷設不可', '既存の線路や駅が存在する位置には敷設できません。', 'warning');
          return;
        }
        const otherTile = this.worldMap.getTile(tx, tz, otherLayer);
        if (otherTile && otherTile.type !== 'empty') {
          this.uiManager.showToast('敷設不可', '接続先階層に既存の線路や建物が存在するため敷設できません。', 'warning');
          return;
        }
        // 在線チェック
        if (this.trainManager.isTileOccupiedByTrain(tx, tz, curLayer) || this.trainManager.isTileOccupiedByTrain(tx, tz, otherLayer)) {
          this.uiManager.showToast('敷設不可', '列車が走行・停車中の位置には敷設できません。', 'warning');
          return;
        }
        // 仮置き衝突チェック
        if (this.pendingItems.some(p => p.x === tx && p.z === tz && ((p.layer ?? 1) === curLayer || (p.layer ?? 1) === otherLayer))) {
          this.uiManager.showToast('仮置き不可', 'すでに別の線路や施設が仮置きされています。', 'warning');
          return;
        }
      }
    }

    const pendingConflict = this.pendingItems.find(p => p.x === x && p.z === z && (p.layer ?? 1) === curLayer);
    if (pendingConflict) {
      this.uiManager.showToast('仮置き不可', 'すでに別の線路や施設が仮置きされています。', 'warning');
      return;
    }

    const existingTile = this.worldMap.getTile(x, z, curLayer);
    const isLevelCrossingTool = effectiveTool === 'level-crossing';
    let targetRotation = this.currentRotation;

    if (isLevelCrossingTool) {
      if (curLayer !== 1) {
        this.uiManager.showToast('設置不可', '踏切は地上1F専用です。地上1Fでご利用ください。', 'warning');
        return;
      }
      if (existingTile) {
        if (existingTile.type === 'road') {
          const roadAxis = (((existingTile.rotation ?? 0) % 2) + 2) % 2;
          targetRotation = 1 - roadAxis; // 道路と直交する線路軸
        } else if (existingTile.type === 'rail_ground') {
          targetRotation = (((existingTile.rotation ?? 0) % 2) + 2) % 2; // 線路軸
        } else if (existingTile.type === 'level_crossing') {
          this.uiManager.showToast('設置済み', 'この位置にはすでに踏切が設置されています。', 'info');
          return;
        } else if (existingTile.type !== 'empty') {
          this.uiManager.showToast('設置不可', '建物や駅が存在する位置には踏切を設置できません。', 'warning');
          return;
        }
      }
    }

    const isScissorsTool = effectiveTool.startsWith('scissors-crossing');
    // シーサスクロッシング（2x2）の既存線路上書き判定
    let isScissorsCandidate = false;
    if (isScissorsTool) {
      const along = targetRotation === 1 ? 1 : 2;
      const across = WorldMap.rotateCW(along);
      const alongVec = WorldMap.DIRS[along];
      const acrossVec = WorldMap.DIRS[across];
      const scissorsPositions = [
        { x, z },
        { x: x + alongVec.x, z: z + alongVec.z },
        { x: x + acrossVec.x, z: z + acrossVec.z },
        { x: x + alongVec.x + acrossVec.x, z: z + alongVec.z + acrossVec.z }
      ];

      for (const sp of scissorsPositions) {
        if (!this.worldMap.isInBounds(sp.x, sp.z)) {
          this.uiManager.showToast('設置不可', 'マップ外には設置できません。', 'warning');
          return;
        }
        if (!this.worldMap.isOverwritableTrack(sp.x, sp.z, curLayer)) {
          this.uiManager.showToast('設置不可', '駅や建物、道路が存在する位置にはシーサスクロッシングを設置できません。', 'warning');
          return;
        }
        if (this.trainManager.isTileOccupiedByTrain(sp.x, sp.z, curLayer)) {
          this.uiManager.showToast('設置不可', '列車が走行・停車中の位置には設置できません。', 'warning');
          return;
        }
        const waterCheck = this.worldMap.canPlaceAtWater(sp.x, sp.z, curLayer);
        if (!waterCheck.allowed) {
          this.uiManager.showToast('設置不可', waterCheck.reason || '水上には設置できません。', 'warning');
          return;
        }
      }
      isScissorsCandidate = true;
    }

    // ★追加: 単発カーブレールツールで既存の直線レールをクリックした場合の自動分岐化
    let switchBranchSide = this.currentSwitchSide;
    let isSwitchCandidate = false;

    if ((effectiveTool === 'rail-curve' || effectiveTool === 'rail-curve-elevated') && existingTile && (existingTile.type === 'rail_ground' || existingTile.type === 'rail_elevated')) {
      const straightAxis = (existingTile.rotation ?? 0) % 2; // 0: 南北(0,2), 1: 東西(1,3)
      const straightDirs = straightAxis === 0 ? [0, 2] : [1, 3];
      const curveDir = CURVE_DIR_ORDER[targetRotation];
      if (curveDir) {
        const [cA, cB] = WorldMap.curveDirToIndices(curveDir);
        const sharedDir = [cA, cB].find(d => straightDirs.includes(d));
        const branchDir = [cA, cB].find(d => !straightDirs.includes(d));
        if (sharedDir !== undefined && branchDir !== undefined) {
          const forward = WorldMap.opposite(sharedDir);
          const branchSide = (WorldMap.rotateCW(forward) === branchDir) ? 'right' : 'left';
          const switchTool: ActiveTool = existingTile.type === 'rail_elevated' ? 'point-switch-elevated' : 'point-switch';
          effectiveTool = switchTool;
          targetRotation = forward;
          switchBranchSide = branchSide;
          isSwitchCandidate = true;
        }
      }
    }

    const isPointSwitchTool = effectiveTool.startsWith('point-switch');
    if (isPointSwitchTool) {
      if (this.trainManager.isTileOccupiedByTrain(x, z, curLayer)) {
        this.uiManager.showToast('設置不可', '列車が走行・停車中の位置には設置できません。', 'warning');
        return;
      }
      if (existingTile && !this.worldMap.isOverwritableTrack(x, z, curLayer)) {
        this.uiManager.showToast('設置不可', '駅や建物、道路が存在する位置には分岐器を設置できません。', 'warning');
        return;
      }
      if (existingTile && (existingTile.type === 'rail_ground' || existingTile.type === 'rail_elevated')) {
        // 既存の直線レールがある場合、その軸に合わせて通過方向を整合
        const straightAxis = (existingTile.rotation ?? 0) % 2;
        if (targetRotation % 2 !== straightAxis) {
          targetRotation = straightAxis === 0 ? 0 : 1;
        }
        if (existingTile.type === 'rail_elevated') {
          effectiveTool = 'point-switch-elevated';
        }
      }
      isSwitchCandidate = true;
    }

    const isCrossingCandidate = isLevelCrossingTool ||
      (existingTile?.type !== 'level_crossing' && isLevelCrossingCombination(effectiveTool, this.currentRotation, existingTile, curLayer));

    if (this.worldMap.isPermanentTrackOrStation(x, z, curLayer) && !isCrossingCandidate && !isSwitchCandidate && !isScissorsCandidate) {
      this.uiManager.showToast('設置不可', '線路や駅が存在する位置には設置できません。', 'warning');
      return;
    }

    // 既存が道路または踏切で直交踏切にならない場合は敷設不可
    if (existingTile && (existingTile.type === 'road' || existingTile.type === 'level_crossing') && !isCrossingCandidate) {
      this.uiManager.showToast('設置不可', '道路と線路が直交しない位置には敷設できません（踏切になりません）。', 'warning');
      return;
    }

    // 農地(farmland)と自然(nature)のみ、線路・道路の敷設時に自動で切り拓いて上書き可能とする（建物は誤破壊と人口バグ防止のため保護）
    const isClearableTerrain = existingTile && (existingTile.type === 'farmland' || existingTile.type === 'nature');
    if (existingTile && existingTile.type !== 'empty' && !isCrossingCandidate && !isSwitchCandidate && !isScissorsCandidate) {
      if (!isInfrastructureTool(effectiveTool) || !isClearableTerrain) {
        this.uiManager.showToast('設置不可', '既存の建物や施設が存在する位置には敷設できません（撤去ツールをご利用ください）。', 'warning');
        return;
      }
    }

    const item: PendingItem = {
      tool: effectiveTool,
      x,
      z,
      layer: curLayer,
      rotation: targetRotation,
      ghost: null,
      switchBranchSide
    };
    this.pendingItems.push(item);
    this.refreshGhostFor(item);
    this.uiManager.setPlacementButtonsVisible(true);
    this.updateRotationHint(tool);
  }

  /**
   * PendingItem が影響を及ぼす全タイル座標を算出する（シーサスクロッシング2x2やスロープ4マス等に対応）
   */
  private getItemTargetPositions(item: PendingItem): Array<{ x: number; z: number; layer: GridLayer }> {
    const layer = (item.layer ?? this.worldMap.activeLayer) as GridLayer;
    const tool = item.tool;
    const positions: Array<{ x: number; z: number; layer: GridLayer }> = [];

    if (tool === 'rail-slope' || tool === 'rail-slope-underground') {
      const axisVal = item.rotation % 2;
      const reversed = item.rotation >= 2;
      const axisDirs: [number, number] = axisVal === 1 ? [1, 3] : [0, 2];
      const [, stepIdx] = reversed ? [axisDirs[1], axisDirs[0]] : [axisDirs[0], axisDirs[1]];
      const stepDir = WorldMap.DIRS[stepIdx];
      const otherLayer: GridLayer = tool === 'rail-slope'
        ? (layer === 1 ? 2 : ((layer + 1) as GridLayer))
        : -1;
      for (let i = 0; i < 4; i++) {
        const tx = item.x + stepDir.x * i;
        const tz = item.z + stepDir.z * i;
        positions.push({ x: tx, z: tz, layer });
        positions.push({ x: tx, z: tz, layer: otherLayer });
      }
    } else if (tool === 'scissors-crossing' || tool === 'scissors-crossing-elevated') {
      const along = item.rotation === 1 ? 1 : 2;
      const across = WorldMap.rotateCW(along);
      const alongVec = WorldMap.DIRS[along];
      const acrossVec = WorldMap.DIRS[across];
      positions.push(
        { x: item.x, z: item.z, layer },
        { x: item.x + alongVec.x, z: item.z + alongVec.z, layer },
        { x: item.x + acrossVec.x, z: item.z + acrossVec.z, layer },
        { x: item.x + alongVec.x + acrossVec.x, z: item.z + alongVec.z + acrossVec.z, layer }
      );
    } else {
      positions.push({ x: item.x, z: item.z, layer });
    }
    return positions;
  }

  /**
   * 仮置き中の全アイテムを一括確定する
   */
  public confirmPendingPlacements(): void {
    const fleetCtrl = this.getFleetController ? this.getFleetController() : null;
    if (fleetCtrl && fleetCtrl.hasPendingDeploy()) {
      fleetCtrl.confirmDeploy();
      this.updateRotationHint(this.uiManager.getActiveTool());
      return;
    }

    if (this.pendingItems.length === 0) return;

    this.trainManager.updateOccupancyNow();

    const items = this.pendingItems;
    const total = items.reduce((sum, it) => sum + TOOL_CONFIG[it.tool].cost, 0);

    // Undo用に配置前のタイルスナップショットを採取
    const beforeSnapshots = new Map<string, TileDataSnapshot | null>();
    for (const item of items) {
      const targetPosList = this.getItemTargetPositions(item);
      for (const pos of targetPosList) {
        const key = `${pos.x},${pos.z},${pos.layer}`;
        if (!beforeSnapshots.has(key)) {
          const t = this.worldMap.getTile(pos.x, pos.z, pos.layer);
          beforeSnapshots.set(key, cloneTileSnapshot(t));
        }
      }
    }

    // 資金残高・投資制限の事前確認（引き落としは設置完了後の実質コストに対して行う）
    if (!this.economy.canSpend(total, true)) {
      this.uiManager.showToast('資金不足', `資金が不足しています（必要: ¥${total.toLocaleString('ja-JP')}）。`, 'danger');
      return;
    }

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
      this.uiManager.showToast('駅設置不可', '線路や他の駅・障害物と重なっているため、駅の設置を中止しました。', 'danger');
    }

    // 実際に設置に成功した正味の実質コスト（netCost）のみを引き落とし・固定資産台帳登録
    const netCost = total - refund;
    if (netCost > 0) {
      this.economy.spendFunds(netCost, true, 'infrastructure', `${successfullyPlacedItems.length}件のインフラ設備`);
    }

    if (placedCount > 0) {
      this.audioManager.playBuildSound();
    }
    if (placedCount < items.length && invalidStationGroupIds.size === 0) {
      this.uiManager.showToast('一部設置不可', `${items.length - placedCount}件はスペース不足等のため設置できませんでした。`, 'warning');
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
        // 既存タイルにダイヤ設定があれば取得してホーム全体で統一する
        let sharedSchedule = firstTile?.stationSchedule;
        let sharedSide = firstTile?.stationPlatformSide ?? 'right';
        let highestSchedScore = getStationScheduleScore(sharedSchedule);
        for (const pt of reg.platform.tiles) {
          const t = this.worldMap.getTile(pt.x, pt.z, pt.layer);
          if (t?.stationSchedule) {
            const score = getStationScheduleScore(t.stationSchedule);
            if (score > highestSchedScore) {
              highestSchedScore = score;
              sharedSchedule = t.stationSchedule;
              sharedSide = t.stationPlatformSide ?? sharedSide;
            }
          }
        }

        const totalLen = reg.platform.tiles.length;
        reg.platform.tiles.forEach((tCoord, idx) => {
          const t = this.worldMap.getTile(tCoord.x, tCoord.z, tCoord.layer);
          if (t) {
            t.stationGroupId = reg.station.id;
            t.stationPlatformId = reg.platform.id;
            t.stationName = reg.station.name;
            if (sharedSchedule) {
              t.stationSchedule = cloneStationSchedule(sharedSchedule);
            }
            const expectedPart: 'single' | 'start' | 'mid' | 'end' =
              totalLen === 1 ? 'single' : (idx === 0 ? 'start' : (idx === totalLen - 1 ? 'end' : 'mid'));
            if (t.stationPart !== expectedPart && t.type.startsWith('station')) {
              t.stationPart = expectedPart;
              t.stationPlatformSide = sharedSide;
              if (t.mesh) {
                t.mesh.removeFromParent();
                disposeHierarchy(t.mesh);
              }
              const baseH = layerToHeight(tCoord.layer);
              const elevY = this.worldMap.getTrackElevationOffset(tCoord.x, tCoord.z, tCoord.layer);
              const isElev = t.type.includes('elevated') || tCoord.layer >= 2;
              const newMesh = ModelFactory.createStation(axis, isElev, expectedPart, sharedSide, reg.station.name, baseH);
              newMesh.position.set(tCoord.x * WorldMap.TILE_SIZE, baseH + elevY, tCoord.z * WorldMap.TILE_SIZE);
              this.worldMap.attachExternalTileMesh(t, newMesh);
            } else if (t.mesh) {
              ModelFactory.updateStationSign(t.mesh, reg.station.name);
            }
            if (isCargo && this.onCargoYardVisualUpdate) {
              this.onCargoYardVisualUpdate(tCoord.x, tCoord.z, tCoord.layer);
            }
          }
        });
      }
    }

    // Undo履歴の記録（本設置が確定してワールドデータと資金が実際に変更された時点でのみ記録）
    if (successfullyPlacedItems.length > 0 && this.undoManager) {
      const netCost = total - refund;
      const tileSnapshots: TileSnapshot[] = [];
      const recordedKeys = new Set<string>();

      for (const item of successfullyPlacedItems) {
        const targetPosList = this.getItemTargetPositions(item);
        for (const pos of targetPosList) {
          const key = `${pos.x},${pos.z},${pos.layer}`;
          if (!recordedKeys.has(key)) {
            recordedKeys.add(key);
            const afterTile = this.worldMap.getTile(pos.x, pos.z, pos.layer);
            tileSnapshots.push({
              x: pos.x,
              z: pos.z,
              layer: pos.layer,
              before: beforeSnapshots.get(key) ?? null,
              after: cloneTileSnapshot(afterTile)
            });
          }
        }
      }

      if (tileSnapshots.length > 0) {
        this.undoManager.pushAction({
          type: 'placement',
          tiles: tileSnapshots,
          cost: netCost,
          description: `${successfullyPlacedItems.length}件の設置`
        });
      }
    }

    this.cancelPendingPlacements();
    this.updateRotationHint(this.uiManager.getActiveTool());

    if (this.onPlacementExecuted) {
      this.onPlacementExecuted();
    }
  }

  /**
   * 実際の設置処理（WorldMap 反映のみ。課金は呼び出し側で行う）
   */
  public executePlacement(
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
    const cell = this.gridManager.getCell(x, 1, z);
    const surfaceElevation = cell ? cell.elevation : 1;

    // 地表構造物（道路・建物・植林等）は、山岳マスでは山岳地表面（surfaceElevation）に配置
    const isSurfaceTool = tool === 'road' || tool === 'nature' || tool.startsWith('building-');
    if (isSurfaceTool && layer < surfaceElevation) {
      layer = surfaceElevation as GridLayer;
    }

    if (this.worldMap.isTunnelSection(x, z, layer) && (tool === 'rail-straight' || tool === 'rail-elevated' || tool === 'rail-tunnel')) {
      tool = 'rail-tunnel';
    } else {
      tool = this.resolveAutoToolForLayer(tool, layer, x, z);
    }

    const isInfrastructureTool =
      tool.startsWith('rail') ||
      tool.startsWith('point-switch') ||
      tool.startsWith('scissors-crossing') ||
      tool.startsWith('station') ||
      tool.startsWith('cargo-station') ||
      tool === 'signal-yard' ||
      tool === 'road';

    const targetPositions: { x: number; z: number; layer: GridLayer }[] = [];

    if (tool === 'rail-slope') {
      const axisVal = rotation % 2;
      const reversed = rotation >= 2;
      const axisDirs: [number, number] = axisVal === 1 ? [1, 3] : [0, 2];
      const [, highIdx] = reversed ? [axisDirs[1], axisDirs[0]] : [axisDirs[0], axisDirs[1]];
      const stepDir = WorldMap.DIRS[highIdx];
      const upperLayer: GridLayer = (layer + 1) as GridLayer;
      for (let i = 0; i < 4; i++) {
        const tx = x + stepDir.x * i;
        const tz = z + stepDir.z * i;
        targetPositions.push({ x: tx, z: tz, layer });
        targetPositions.push({ x: tx, z: tz, layer: upperLayer });
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
        targetPositions.push({ x: tx, z: tz, layer: -1 });
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
      targetPositions.push({ x, z, layer });
    }

    const isStationTool = tool.startsWith('station') || tool.startsWith('cargo-station') || tool === 'signal-yard';
    for (const pos of targetPositions) {
      if (!this.worldMap.isInBounds(pos.x, pos.z)) {
        return false;
      }
      const existingTile = this.worldMap.getTile(pos.x, pos.z, pos.layer);
      const isCompatibleTrack = isStationTool && existingTile &&
        (existingTile.type === 'rail_ground' || existingTile.type === 'rail_elevated') &&
        (existingTile.rotation === (rotation % 2));

      const isCrossingCandidate = isLevelCrossingCombination(tool, rotation, existingTile, pos.layer) ||
        (tool === 'level-crossing' && pos.layer === 1 && (!existingTile || existingTile.type === 'empty' || existingTile.type === 'road' || existingTile.type === 'rail_ground'));

      const isSwitchCandidate = tool.startsWith('point-switch') && this.worldMap.isOverwritableTrack(pos.x, pos.z, pos.layer);
      const isScissorsCandidate = tool.startsWith('scissors-crossing') && this.worldMap.isOverwritableTrack(pos.x, pos.z, pos.layer);

      if (!isCompatibleTrack && !isCrossingCandidate && !isSwitchCandidate && !isScissorsCandidate) {
        if (this.worldMap.isPermanentTrackOrStation(pos.x, pos.z, pos.layer)) {
          return false;
        }
        // 既存が道路または踏切で直交踏切にならない場合は敷設不可
        if (existingTile && (existingTile.type === 'road' || existingTile.type === 'level_crossing')) {
          return false;
        }
        // 農地(farmland)と自然(nature)のみ、線路・道路の敷設時に自動で切り拓いて上書き可能とする（建物は誤破壊と人口バグ防止のため保護）
        const isClearableTerrain = existingTile && (existingTile.type === 'farmland' || existingTile.type === 'nature');
        if (existingTile && existingTile.type !== 'empty') {
          if (!isInfrastructureTool || isStationTool || !isClearableTerrain) {
            return false;
          }
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

    if (tool === 'rail-curve' || tool === 'rail-curve-elevated') {
      const isElevated = tool === 'rail-curve-elevated';
      const curveDir = CURVE_DIR_ORDER[rotation];
      return this.worldMap.placeCurve(x, z, curveDir, isElevated, layer);
    }

    if (tool === 'point-switch' || tool === 'point-switch-elevated') {
      const isElevated = tool === 'point-switch-elevated';
      return this.worldMap.placeSwitch(x, z, rotation, isElevated, branchSide, layer);
    }

    if (tool === 'scissors-crossing' || tool === 'scissors-crossing-elevated') {
      const isElevated = tool === 'scissors-crossing-elevated';
      return this.worldMap.placeScissorsCrossing(x, z, rotation, isElevated, layer);
    }

    if (tool === 'rail-slope') {
      const axis = rotation % 2;
      const reversed = rotation >= 2;
      return this.worldMap.placeSlope(x, z, axis, reversed, layer);
    }

    if (tool === 'rail-slope-underground') {
      const axis = rotation % 2;
      const reversed = rotation >= 2;
      return this.worldMap.placeUndergroundSlope(x, z, axis, reversed, layer);
    }

    if (tool === 'rail-tunnel') {
      const tileRotation = rotation % 2;
      return this.worldMap.setTile(x, z, 'rail_ground', tileRotation, 1, stationPlatformSide, layer);
    }

    if (tool === 'level-crossing') {
      const railAxis = rotation % 2;
      return this.worldMap.placeLevelCrossing(x, z, railAxis, layer);
    }

    // 道路と線路の直交交差による踏切自動生成（または既存踏切への同一軸通過）
    if (layer === 1 && (tool === 'road' || tool === 'rail-straight')) {
      const existing = this.worldMap.getTile(x, z, 1);
      if (existing && isLevelCrossingCombination(tool, rotation, existing, 1)) {
        if (existing.type === 'level_crossing') {
          return true; // 既存踏切への同一軸通過
        }
        const railAxis = tool === 'rail-straight' ? (rotation % 2) : (1 - (rotation % 2));
        return this.worldMap.placeLevelCrossing(x, z, railAxis, 1);
      }
    }

    const config = TOOL_CONFIG[tool];
    if (config && config.tileType) {
      const tileRotation = ROTATABLE_TOOLS.includes(tool) ? rotation % 2 : 0;
      let targetTileType = config.tileType as TileType;
      if (tool === 'cargo-station' && layer >= 2) {
        targetTileType = 'cargo_station_elevated';
      }
      const existingTile = this.worldMap.getTile(x, z, layer);
      const prevPop = UndoManager.getTilePopulation(existingTile?.type, existingTile?.level);

      const ok = this.worldMap.setTile(x, z, targetTileType, tileRotation, 1, stationPlatformSide, layer);
      if (ok) {
        const isStationOrYard = tool === 'station-small' || tool === 'station-elevated' || tool === 'signal-yard' || tool === 'cargo-station';
        if (isStationOrYard) {
          const tile = this.worldMap.getTile(x, z, layer);
          if (tile) {
            tile.stationPlatformSide = stationPlatformSide;
            tile.stationSchedule = tile.stationSchedule || createDefaultStationSchedule();
            if (tool === 'cargo-station') {
              tile.isCargoYard = true;
            }
            if (stationGroupId) tile.stationGroupId = stationGroupId;
            if (stationPart) {
              tile.stationPart = stationPart;
              if (tile.mesh) {
                tile.mesh.removeFromParent();
                disposeHierarchy(tile.mesh);
                const baseH = layerToHeight(layer);
                const isElevated = tool === 'station-elevated' || ((tool === 'signal-yard' || tool === 'cargo-station') && layer >= 2);
                const newMesh = tool === 'signal-yard'
                  ? ModelFactory.createSignalYard(tileRotation, isElevated, stationPlatformSide, baseH)
                  : (tool === 'cargo-station'
                      ? ModelFactory.createCargoStation(tileRotation, isElevated, stationPlatformSide, baseH)
                      : ModelFactory.createStation(tileRotation, isElevated, stationPart, stationPlatformSide, tile.stationName || '駅', baseH));
                const elevY = this.worldMap.getTrackElevationOffset(x, z, layer);
                newMesh.position.set(x * WorldMap.TILE_SIZE, baseH + elevY, z * WorldMap.TILE_SIZE);
                this.worldMap.attachExternalTileMesh(tile, newMesh);
              }
            }
          }
        }
        const newPop = UndoManager.getTilePopulation(config.tileType, 1);
        const popDelta = newPop - prevPop;
        if (popDelta !== 0) {
          this.economy.addPopulation(popDelta);
        }
      }
      return ok;
    }

    return false;
  }

  /**
   * 設置向きを回転（0-3循環）
   */
  public rotateCurrentPlacement(): void {
    const fleetCtrl = this.getFleetController ? this.getFleetController() : null;
    if (fleetCtrl && fleetCtrl.isDeploying()) {
      fleetCtrl.rotateDeployDirection();
      this.updateRotationHint(this.uiManager.getActiveTool());
      return;
    }

    const tool = this.uiManager.getActiveTool();
    if (!ROTATABLE_TOOLS.includes(tool)) return;

    if (tool === 'point-switch' || tool === 'point-switch-elevated') {
      this.currentRotation = (this.currentRotation + 1) % 4;
      if (this.currentRotation === 0) {
        this.currentSwitchSide = this.currentSwitchSide === 'right' ? 'left' : 'right';
      }
    } else {
      this.currentRotation = (this.currentRotation + 1) % 4;
    }

    if (this.pendingItems.length > 0) {
      if (tool.startsWith('station') || tool === 'signal-yard' || tool === 'cargo-station') {
        // station-small が station-elevated に自動変換されていても対象として取得する
        const stationItems = this.pendingItems.filter(
          p => p.tool.startsWith('station') || p.tool === 'signal-yard' || p.tool === 'cargo-station'
        );
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
        const lastItem = this.pendingItems[this.pendingItems.length - 1];
        if (ROTATABLE_TOOLS.includes(lastItem.tool)) {
          const existingAtLast = this.worldMap.getTile(lastItem.x, lastItem.z, lastItem.layer ?? this.worldMap.activeLayer);
          if (lastItem.tool.startsWith('point-switch') && existingAtLast && (existingAtLast.type === 'rail_ground' || existingAtLast.type === 'rail_elevated')) {
            // 既存の直線レール上の分岐器は、レールの軸に沿った2方向 × 左右2方向 の4通りで循環
            const straightAxis = (existingAtLast.rotation ?? 0) % 2;
            const dirs = straightAxis === 0 ? [0, 2] : [1, 3];
            if (lastItem.switchBranchSide === 'right') {
              lastItem.switchBranchSide = 'left';
            } else {
              lastItem.switchBranchSide = 'right';
              lastItem.rotation = (lastItem.rotation === dirs[0]) ? dirs[1] : dirs[0];
            }
            this.currentRotation = lastItem.rotation;
            this.currentSwitchSide = lastItem.switchBranchSide;
          } else {
            lastItem.rotation = this.currentRotation;
            if (lastItem.tool.startsWith('point-switch')) {
              lastItem.switchBranchSide = this.currentSwitchSide;
            }
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

  /**
   * 駅舎ホームの配置方向（右側・左側）を切り替える
   */
  public toggleStationSide(): void {
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
   * 分岐器の左右分岐方向を切り替える
   */
  public toggleSwitchSide(): void {
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
  }

  /**
   * 駅有効長の変更
   */
  public setStationLength(len: number): void {
    this.currentStationLength = len;
    this.cancelPendingPlacements();
    this.updateRotationHint(this.uiManager.getActiveTool());
  }

  /**
   * 現在のツール・回転状態に応じたヒント表示を更新
   */
  public updateRotationHint(tool: ActiveTool): void {
    const fleetCtrl = this.getFleetController ? this.getFleetController() : null;
    if (fleetCtrl && fleetCtrl.isDeploying()) {
      const item = fleetCtrl.getDeployingFleetItem();
      this.uiManager.setSwitchSideButtonVisible(false);
      this.uiManager.setStationSideButtonsVisible(false);
      this.uiManager.setRotateButtonVisible(true);
      if (fleetCtrl.hasPendingDeploy()) {
        const pending = fleetCtrl.getPendingDeploy()!;
        this.uiManager.setRotationHint(
          true,
          `🚆 ${item?.name} 仮配置中 — 進行方向: ${DIR_LABEL[pending.directionIdx]} ｜ Rキーで向き変更・「設置を決定」で運行開始`
        );
      } else {
        this.uiManager.setRotationHint(
          true,
          `🚆 ${item?.name} — 配置する線路をクリック  進行方向: ${DIR_LABEL[fleetCtrl.deployDirectionIdx]}`
        );
      }
      return;
    }

    const isRotatable = ROTATABLE_TOOLS.includes(tool);
    const hasPending = this.pendingItems.length > 0;

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
        label = `通過: ${DIR_LABEL[this.currentRotation]} ／ 分岐: ${this.currentSwitchSide === 'left' ? '左' : '右'}`;
      } else if (tool === 'scissors-crossing' || tool === 'scissors-crossing-elevated') {
        label = `並走: ${AXIS_LABEL[this.currentRotation % 2]}`;
      } else if (tool === 'rail-slope') {
        const axis = this.currentRotation % 2;
        const reversed = this.currentRotation >= 2;
        const axisDirs = axis === 1 ? ['西', '東'] : ['北', '南'];
        const [low, high] = reversed ? [axisDirs[1], axisDirs[0]] : axisDirs;
        const curL = this.worldMap.activeLayer;
        const lowL = curL <= 1 ? '1F' : `${curL}F`;
        const highL = `${curL + 1}F`;
        label = `上り: ${low} → ${high} [${lowL} → ${highL}]`;
      } else if (tool === 'rail-slope-underground') {
        const axis = this.currentRotation % 2;
        const reversed = this.currentRotation >= 2;
        const axisDirs = axis === 1 ? ['西', '東'] : ['北', '南'];
        const [entry, exit] = reversed ? [axisDirs[1], axisDirs[0]] : axisDirs;
        label = `地下スロープ: ${entry} → ${exit} [1F → B1]`;
      } else if (isStation) {
        const sideText = this.currentStationSide === 'left' ? '左' : '右';
        const axisText = AXIS_LABEL[this.currentRotation % 2];
        label = `向き: ${axisText} ／ ${this.currentStationLength}両・ホーム${sideText}側`;
        this.uiManager.setStationRotationText(axisText);

        if (!hasPending) {
          this.uiManager.setRotationHint(false);
          return;
        }
      } else if (tool === 'level-crossing') {
        const railAxis = this.currentRotation % 2;
        label = `踏切 — 線路: ${AXIS_LABEL[railAxis]} ／ 道路: ${AXIS_LABEL[1 - railAxis]}`;
      } else {
        label = `向き: ${AXIS_LABEL[this.currentRotation % 2]}`;
      }
    } else {
      const toolConfig = TOOL_CONFIG[tool];
      label = `選択中: ${toolConfig?.name || '施設'}`;
    }

    if (hasPending) {
      const total = this.pendingItems.reduce((sum, it) => sum + (TOOL_CONFIG[it.tool]?.cost || 0), 0);
      label = `🔶 仮置き ${this.pendingItems.length}件 ¥${total.toLocaleString()} ｜ ${label}`;
    }

    this.uiManager.setRotationHint(true, label);
  }
}
