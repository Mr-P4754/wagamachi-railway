import * as THREE from 'three';
import { GridLayer } from './types';
import { layerToHeight } from './Grid3D';
import { ActiveTool } from '../ui/UIManager';
import { CurveDirection, WorldMap } from '../simulation/WorldMap';
import { ModelFactory } from '../models/ModelFactory';

export interface DragTrackSegment {
  x: number;
  z: number;
  layer: GridLayer;
  tool: ActiveTool;
  rotation: number;
  curveDir?: CurveDirection;
  isSlope?: boolean;
  isCorner?: boolean;
  switchBranchSide?: 'left' | 'right';
  isAutoSwitch?: boolean;
}

/**
 * 長距離線路の一括ドラッグ延伸＆自動補間ビルダー
 */
export class TrackBuilder {
  /**
   * 始点 (startX, startZ) から 終点 (endX, endZ) までの補間線路シーケンスを生成する
   * @param start 始点座標
   * @param end 終点座標
   * @param layer 敷設階層 (-2..5)
   * @param preferHorizontalFirst 水平方向を先に延伸するかどうか (デフォルト: true)
   */
  public static calculatePath(
    startX: number,
    startZ: number,
    endX: number,
    endZ: number,
    layer: GridLayer,
    preferHorizontalFirst: boolean = true
  ): DragTrackSegment[] {
    const segments: DragTrackSegment[] = [];
    const isElevated = layer >= 2;
    const isUnderground = layer < 0;
    const straightTool: ActiveTool = isUnderground ? 'rail-tunnel' : (isElevated ? 'rail-elevated' : 'rail-straight');

    const dx = endX - startX;
    const dz = endZ - startZ;

    // 1. 完全同一マス
    if (dx === 0 && dz === 0) {
      segments.push({
        x: startX,
        z: startZ,
        layer,
        tool: straightTool,
        rotation: 0
      });
      return segments;
    }

    // 2. 単純な直線（南北軸: X同一）
    if (dx === 0) {
      const stepZ = dz > 0 ? 1 : -1;
      const count = Math.abs(dz);
      for (let i = 0; i <= count; i++) {
        segments.push({
          x: startX,
          z: startZ + stepZ * i,
          layer,
          tool: straightTool,
          rotation: 0 // NS軸
        });
      }
      return segments;
    }

    // 3. 単純な直線（東西軸: Z同一）
    if (dz === 0) {
      const stepX = dx > 0 ? 1 : -1;
      const count = Math.abs(dx);
      for (let i = 0; i <= count; i++) {
        segments.push({
          x: startX + stepX * i,
          z: startZ,
          layer,
          tool: straightTool,
          rotation: 1 // EW軸
        });
      }
      return segments;
    }

    // 4. L字型／角カーブによる自動補間
    // パターンA: 水平(X)先行 ➔ コーナー ➔ 垂直(Z)
    // パターンB: 垂直(Z)先行 ➔ コーナー ➔ 水平(X)
    const horizontalFirst = preferHorizontalFirst;
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;

    if (horizontalFirst) {
      const cornerX = endX;
      const cornerZ = startZ;

      // 始点からコーナー手前までの東西直線
      for (let curX = startX; curX !== cornerX; curX += stepX) {
        segments.push({
          x: curX,
          z: startZ,
          layer,
          tool: straightTool,
          rotation: 1 // EW軸
        });
      }

      // コーナーのカーブ方向を計算
      // 進入: dx > 0 ? 西から東(1) : 東から西(3)
      // 進出: dz > 0 ? 北から南(2) : 南から北(0)
      const enterDir = stepX > 0 ? 1 : 3;
      const leaveDir = stepZ > 0 ? 2 : 0;
      const curveDir = WorldMap.indicesToCurveDir(WorldMap.opposite(enterDir), leaveDir);

      segments.push({
        x: cornerX,
        z: cornerZ,
        layer,
        tool: isElevated ? 'rail-curve-elevated' : 'rail-curve',
        rotation: 0,
        curveDir
      });

      // コーナーの次から終点までの南北直線
      for (let curZ = cornerZ + stepZ; curZ !== endZ + stepZ; curZ += stepZ) {
        segments.push({
          x: endX,
          z: curZ,
          layer,
          tool: straightTool,
          rotation: 0 // NS軸
        });
      }
    } else {
      const cornerX = startX;
      const cornerZ = endZ;

      // 始点からコーナー手前までの南北直線
      for (let curZ = startZ; curZ !== cornerZ; curZ += stepZ) {
        segments.push({
          x: startX,
          z: curZ,
          layer,
          tool: straightTool,
          rotation: 0 // NS軸
        });
      }

      // コーナーのカーブ方向
      const enterDir = stepZ > 0 ? 2 : 0;
      const leaveDir = stepX > 0 ? 1 : 3;
      const curveDir = WorldMap.indicesToCurveDir(WorldMap.opposite(enterDir), leaveDir);

      segments.push({
        x: cornerX,
        z: cornerZ,
        layer,
        tool: isElevated ? 'rail-curve-elevated' : 'rail-curve',
        rotation: 0,
        curveDir
      });

      // コーナーの次から終点までの東西直線
      for (let curX = cornerX + stepX; curX !== endX + stepX; curX += stepX) {
        segments.push({
          x: curX,
          z: endZ,
          layer,
          tool: straightTool,
          rotation: 1 // EW軸
        });
      }
    }

    return segments;
  }

  /**
   * 補間セグメント群から半透明ゴーストメッシュグループを生成する
   */
  public static createGhostGroup(
    segments: DragTrackSegment[],
    ghostMaterial: THREE.Material,
    elevationProvider?: (x: number, z: number) => number
  ): THREE.Group {
    const group = new THREE.Group();
    group.name = 'TrackBuilder_GhostGroup';

    for (const seg of segments) {
      const isElevated = seg.layer >= 2;
      const isTunnel = seg.layer < 0 || seg.tool === 'rail-tunnel';
      const baseH = layerToHeight(seg.layer);
      let mesh: THREE.Group;
      if (seg.tool === 'road') {
        mesh = ModelFactory.createRoad(seg.rotation);
      } else if (seg.tool.startsWith('point-switch')) {
        mesh = ModelFactory.createSwitchHub(seg.rotation, false, isElevated, seg.switchBranchSide ?? 'right', baseH, isTunnel);
      } else if (seg.curveDir) {
        mesh = ModelFactory.createCurveTrackSegment(seg.curveDir, isElevated, baseH, isTunnel);
      } else if (isTunnel) {
        mesh = ModelFactory.createTunnelTrack(seg.rotation);
      } else if (isElevated) {
        mesh = ModelFactory.createElevatedTrack(seg.rotation, WorldMap.shouldShowPier(seg.x, seg.z, seg.rotation), baseH);
      } else {
        mesh = ModelFactory.createGroundTrack(seg.rotation, false);
      }

      // マテリアルをゴースト半透明に置換
      mesh.traverse(obj => {
        if ((obj as THREE.Mesh).isMesh) {
          const m = obj as THREE.Mesh;
          m.material = ghostMaterial;
          m.castShadow = false;
          m.receiveShadow = false;
        }
      });

      // 高さ（標高オフセット ＋ 階層高さ）
      const elevOffset = (seg.layer === 1 && elevationProvider) ? elevationProvider(seg.x, seg.z) : 0;
      const baseHeight = layerToHeight(seg.layer) + elevOffset;

      mesh.position.set(seg.x * WorldMap.TILE_SIZE, baseHeight, seg.z * WorldMap.TILE_SIZE);
      group.add(mesh);
    }

    return group;
  }
}
