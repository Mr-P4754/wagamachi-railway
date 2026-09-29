import * as THREE from 'three';
import { GridLayer } from '../core/types';
import { layerToHeight } from '../core/Grid3D';
import { WorldMap } from '../simulation/WorldMap';
import { CameraManager } from '../graphics/CameraManager';

export interface GridIntersection {
  tileX: number;
  tileZ: number;
  layer: GridLayer;
  worldPoint: THREE.Vector3;
  isValidTile: boolean;
}

/**
 * クォータービュー用高精度Raycast ＆ マルチデバイス入力コントローラー
 */
export class InputController {
  private raycaster: THREE.Raycaster = new THREE.Raycaster();
  private mousePos: THREE.Vector2 = new THREE.Vector2(0, 0);
  private cameraManager: CameraManager;
  private domElement: HTMLElement;
  private activeLayer: GridLayer = 1;
  private isMobileMode: boolean = false;

  // 画面中央ターゲットレティクル用の固定中央スクリーン座標
  private readonly centerScreenPos: THREE.Vector2 = new THREE.Vector2(0, 0);

  constructor(cameraManager: CameraManager, domElement: HTMLElement) {
    this.cameraManager = cameraManager;
    this.domElement = domElement;

    // タッチデバイス（スマホ）かどうかの自動検出
    this.detectDeviceMode();
  }

  private detectDeviceMode(): void {
    const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const isSmallScreen = window.innerWidth <= 768;
    this.isMobileMode = hasTouch && isSmallScreen;
  }

  public setMobileMode(isMobile: boolean): void {
    this.isMobileMode = isMobile;
  }

  public getIsMobileMode(): boolean {
    return this.isMobileMode;
  }

  public setActiveLayer(layer: GridLayer): void {
    this.activeLayer = layer;
  }

  public getActiveLayer(): GridLayer {
    return this.activeLayer;
  }

  public updateMousePosition(clientX: number, clientY: number): void {
    const rect = this.domElement.getBoundingClientRect();
    this.mousePos.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mousePos.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  }

  /**
   * 平行投影カメラにおける、現在アクティブ階層の基準平面への交差計算
   * @param mapSize マップ全体のマス数 (例: 64, 128, 256)
   * @param elevationOffsetProvider 地上1Fの場合のタイル標高（山岳の起伏）提供関数
   * @param useCenterScreen スマホ用画面中央レティクルからの光線を使用するかどうか
   */
  public getGridIntersection(
    mapSize: number,
    elevationOffsetProvider?: (x: number, z: number) => number,
    useCenterScreen: boolean = false
  ): GridIntersection | null {
    // useCenterScreen が true の場合のみ画面中央レティクルを使用し、それ以外はタップ・マウス位置を使用
    const screenCoord = useCenterScreen ? this.centerScreenPos : this.mousePos;
    this.raycaster.setFromCamera(screenCoord, this.cameraManager.activeCamera);

    // 1. まず地表1F基準面 (Y = 0) または アクティブ階層の基準高さで平面交差を算出
    const baseTargetY = layerToHeight(this.activeLayer);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -baseTargetY);
    const hitPoint = new THREE.Vector3();

    const hit = this.raycaster.ray.intersectPlane(plane, hitPoint);
    if (!hit) return null;

    let finalHitPoint = hitPoint;
    let finalTx = Math.round(hitPoint.x / WorldMap.TILE_SIZE);
    let finalTz = Math.round(hitPoint.z / WorldMap.TILE_SIZE);

    // ② 山岳地帯での「クリック座標ズレ」解消:
    // クォータービュー（斜め見下ろし視点）において、山（標高 > 0）をクリックした際に
    // 光線が山を突き抜けて奥のY=0平面と判定されるのを防ぐため、
    // 標高平面への反復交差判定（固定小数点反復）を行い、カーソル直下の山岳タイルへ正確に収束させる
    if (this.activeLayer === 1 && elevationOffsetProvider) {
      for (let iter = 0; iter < 3; iter++) {
        const elev = elevationOffsetProvider(finalTx, finalTz);
        if (elev <= 0) break;

        const elevPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(baseTargetY + elev));
        const elevHit = new THREE.Vector3();
        if (this.raycaster.ray.intersectPlane(elevPlane, elevHit)) {
          const nextTx = Math.round(elevHit.x / WorldMap.TILE_SIZE);
          const nextTz = Math.round(elevHit.z / WorldMap.TILE_SIZE);
          finalHitPoint = elevHit;
          if (nextTx === finalTx && nextTz === finalTz) {
            break;
          }
          finalTx = nextTx;
          finalTz = nextTz;
        } else {
          break;
        }
      }
    }

    const half = Math.floor(mapSize / 2);
    const isValidTile = finalTx >= -half && finalTx < half && finalTz >= -half && finalTz < half;

    return {
      tileX: finalTx,
      tileZ: finalTz,
      layer: this.activeLayer,
      worldPoint: finalHitPoint,
      isValidTile
    };
  }
}
