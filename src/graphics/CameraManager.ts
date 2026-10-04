import * as THREE from 'three';
import { GameMaterials } from './materials';

export type CameraViewMode = 'quarter_view' | 'cab_view' | 'chase_view';
export type CameraMode = 'orbit' | 'cab' | 'chase';

export interface FollowTarget {
  position: THREE.Vector3;
  direction?: THREE.Vector3;
  speed?: number;
  pitch?: number;
  yaw?: number;
  trainId?: number;
}

/**
 * 平行投影（OrthographicCamera）クォータービューカメラエンジン
 */
export class CameraManager {
  public orthoCamera: THREE.OrthographicCamera;
  public perspectiveCamera: THREE.PerspectiveCamera;
  public activeCamera: THREE.Camera;
  public viewMode: CameraViewMode = 'quarter_view';

  private domElement: HTMLElement;

  // 注視点
  public target: THREE.Vector3 = new THREE.Vector3(0, 0, 0);

  // 4方向90度ステップ回転
  // 0: 北東 (π/4), 1: 南東 (3π/4), 2: 南西 (5π/4), 3: 北西 (7π/4)
  private directionIndex: number = 0;
  private currentTheta: number = Math.PI / 4;
  private targetTheta: number = Math.PI / 4;
  private readonly phi: number = Math.PI / 4; // 見下ろし45度

  // ズーム設定（画面短辺タイルマス数基準）
  // 1マス = 2.0 ワールド単位
  public static readonly TILE_SIZE = 2.0;
  public static readonly MIN_TILES = 13;   // 最大ズームイン限界 (短辺13マス)
  public static readonly DEFAULT_TILES = 32; // 標準初期値 (短辺32マス)
  public static readonly MAX_TILES = 90;   // 最大ズームアウト限界 (短辺90マス)

  private visibleTilesOnShortSide: number = CameraManager.DEFAULT_TILES;

  // 列車追尾
  private trackingTarget: FollowTarget | null = null;
  public isTracking: boolean = false;
  public onTrackingCancelled: () => void = () => {};

  // 操作状態
  private isPanning: boolean = false;
  private lastMouseX: number = 0;
  private lastMouseY: number = 0;
  private keysPressed: Record<string, boolean> = {};

  // カメラパン（1本指ドラッグ / マウス左ドラッグ）の可否判定述語
  public canPanPredicate: (() => boolean) | null = null;

  // 前面展望（Cab View）姿勢補間用
  private currentCabForward: THREE.Vector3 = new THREE.Vector3(0, 0, 1);
  private currentCabPitch: number = 0;

  // 列車追従（Chase View）姿勢・オービット補間用
  private chaseDistance: number = 9.0; // 追従距離 (4〜20)
  private chaseRelativeYaw: number = 0; // 進行方向に対する相対オービット方位角
  private chasePhi: number = 0.45; // 仰角 (約26度, 上部約3.5〜4.5ワールド単位)
  private currentWorldYaw: number = 0; // ワールド方位角（折り返し時滑らか補間）
  private currentChasePos: THREE.Vector3 = new THREE.Vector3();
  private currentChaseTargetPos: THREE.Vector3 = new THREE.Vector3();
  private isChaseDragging: boolean = false;
  private lastChaseMouseX: number = 0;
  private lastChaseMouseY: number = 0;
  private isChaseTouchPanning: boolean = false;
  private lastChaseTouchX: number = 0;
  private lastChaseTouchY: number = 0;
  private chaseTouchStartDist: number = 0;

  public getCabForward(): THREE.Vector3 {
    return this.currentCabForward;
  }

  /**
   * 現在カメラパンが可能かどうかを判定
   */
  public canPan(): boolean {
    if (this.viewMode !== 'quarter_view') return false;
    if (this.canPanPredicate) {
      return this.canPanPredicate();
    }
    return true;
  }

  // カメラ光軸の距離（平行投影なのでクリッププレーン内に収まる距離）
  private readonly cameraDistance: number = 120;

  constructor(domElement: HTMLElement) {
    this.domElement = domElement;

    // 1. OrthographicCamera の生成 (near: -1000, far: 2000)
    const aspect = window.innerWidth / window.innerHeight;
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 2000);

    // 2. 前面展望用 PerspectiveCamera（far: 280 に最適化して遠景過剰描画負荷を抑制）
    this.perspectiveCamera = new THREE.PerspectiveCamera(55, aspect, 0.1, 280);

    this.activeCamera = this.orthoCamera;

    this.updateFrustum(window.innerWidth, window.innerHeight);
    this.updateCameraTransform();
    this.bindEvents();
  }

  /**
   * 画面サイズ・短辺タイル数に応じた平行投影Frustumの更新
   */
  public updateFrustum(width: number, height: number): void {
    const aspect = width / height;
    const halfShortWorldUnits = (this.visibleTilesOnShortSide * CameraManager.TILE_SIZE) / 2;

    if (aspect >= 1.0) {
      // 横長画面（短辺は高さ）
      this.orthoCamera.top = halfShortWorldUnits;
      this.orthoCamera.bottom = -halfShortWorldUnits;
      this.orthoCamera.left = -halfShortWorldUnits * aspect;
      this.orthoCamera.right = halfShortWorldUnits * aspect;
    } else {
      // 縦長画面（短辺は幅）
      this.orthoCamera.left = -halfShortWorldUnits;
      this.orthoCamera.right = halfShortWorldUnits;
      this.orthoCamera.top = halfShortWorldUnits / aspect;
      this.orthoCamera.bottom = -halfShortWorldUnits / aspect;
    }

    this.orthoCamera.updateProjectionMatrix();

    if (this.perspectiveCamera) {
      this.perspectiveCamera.aspect = aspect;
      this.perspectiveCamera.updateProjectionMatrix();
    }
  }

  /**
   * カメラ位置・注視点の再計算
   */
  private updateCameraTransform(): void {
    if (this.viewMode !== 'quarter_view') return;

    // 視線方向ベクトル（方位角 currentTheta, 仰角 phi）
    const cosPhi = Math.cos(this.phi);
    const sinPhi = Math.sin(this.phi);
    const sinTheta = Math.sin(this.currentTheta);
    const cosTheta = Math.cos(this.currentTheta);

    const offsetX = this.cameraDistance * cosPhi * sinTheta;
    const offsetY = this.cameraDistance * sinPhi;
    const offsetZ = this.cameraDistance * cosPhi * cosTheta;

    this.orthoCamera.position.set(
      this.target.x + offsetX,
      this.target.y + offsetY,
      this.target.z + offsetZ
    );
    this.orthoCamera.lookAt(this.target);
  }

  /**
   * 4方向90度ステップ回転（時計回り ⟳）
   */
  public rotateStepCW(): void {
    this.directionIndex = (this.directionIndex + 1) % 4;
    this.targetTheta = this.directionIndex * (Math.PI / 2) + Math.PI / 4;
  }

  /**
   * 4方向90度ステップ回転（反時計回り ⟲）
   */
  public rotateStepCCW(): void {
    this.directionIndex = (this.directionIndex + 3) % 4;
    this.targetTheta = this.directionIndex * (Math.PI / 2) + Math.PI / 4;
  }

  /**
   * ズーム操作（マウスホイール・ピンチ）
   * @param deltaTile マス数の増減
   */
  public zoomBy(deltaTile: number): void {
    if (this.viewMode !== 'quarter_view') return;
    const nextTiles = this.visibleTilesOnShortSide + deltaTile;
    this.visibleTilesOnShortSide = THREE.MathUtils.clamp(
      nextTiles,
      CameraManager.MIN_TILES,
      CameraManager.MAX_TILES
    );
    this.updateFrustum(window.innerWidth, window.innerHeight);
  }

  /**
   * 列車追尾の開始
   */
  public startTracking(target: FollowTarget, immediate: boolean = false): void {
    this.trackingTarget = target;
    this.isTracking = true;
    if (immediate && target.position) {
      this.target.copy(target.position);
      if (this.viewMode === 'quarter_view') {
        this.updateCameraTransform();
      }
    }
  }

  /**
   * 列車追尾の解除
   */
  public stopTracking(): void {
    if (this.isTracking) {
      this.isTracking = false;
      this.trackingTarget = null;
      this.onTrackingCancelled();
    }
  }

  /**
   * 指定したワールド座標へカメラ注視点をジャンプ
   */
  public jumpToPosition(pos: { x: number; z: number } | THREE.Vector3): void {
    this.stopTracking();
    this.target.set(pos.x, 0, pos.z);
    this.updateCameraTransform();
  }

  /**
   * 建物・地表の半透明透過モード（X-Ray）トグル
   */
  public toggleXRayMode(): boolean {
    const next = !GameMaterials.isTransparentMode();
    GameMaterials.setTransparentMode(next);
    return next;
  }

  /**
   * 前面展望モードへの切り替え
   */
  public setCabViewMode(target: FollowTarget): void {
    const isNew = this.viewMode !== 'cab_view' || (this.trackingTarget?.trainId !== target.trainId);
    this.viewMode = 'cab_view';
    this.activeCamera = this.perspectiveCamera;
    this.trackingTarget = target;
    this.isTracking = true;

    if (isNew) {
      // 新しい列車に乗り換えた初回のみ姿勢補間状態を初期化
      this.currentCabPitch = target.pitch ?? 0;
      const initialDir = target.direction ? target.direction.clone().normalize() : new THREE.Vector3(0, 0, 1);
      this.currentCabForward.copy(initialDir);
    }
  }

  /**
   * 列車追従（Chase）カメラモードの開始
   */
  public setChaseViewMode(target: FollowTarget): void {
    const isNew = this.viewMode !== 'chase_view' || (this.trackingTarget?.trainId !== target.trainId);
    this.viewMode = 'chase_view';
    this.activeCamera = this.perspectiveCamera;
    this.trackingTarget = target;
    this.isTracking = true;

    if (isNew) {
      this.chaseDistance = 9.0;
      this.chaseRelativeYaw = 0;
      this.chasePhi = 0.45;

      const dir = target.direction ? target.direction.clone().normalize() : new THREE.Vector3(0, 0, 1);
      const horizDir = new THREE.Vector3(dir.x, 0, dir.z).normalize();
      if (horizDir.lengthSq() < 0.001) horizDir.set(0, 0, 1);

      const trainYaw = Math.atan2(horizDir.x, horizDir.z);
      this.currentWorldYaw = trainYaw + Math.PI; // 初期は列車の後方

      this.currentChaseTargetPos.set(target.position.x, target.position.y + 0.6, target.position.z);

      const horizDist = this.chaseDistance * Math.cos(this.chasePhi);
      const vertDist = this.chaseDistance * Math.sin(this.chasePhi);
      this.currentChasePos.set(
        this.currentChaseTargetPos.x + Math.sin(this.currentWorldYaw) * horizDist,
        this.currentChaseTargetPos.y + vertDist,
        this.currentChaseTargetPos.z + Math.cos(this.currentWorldYaw) * horizDist
      );
      this.perspectiveCamera.position.copy(this.currentChasePos);
      this.perspectiveCamera.lookAt(this.currentChaseTargetPos);
      this.target.copy(this.currentChaseTargetPos);
    }
  }

  /**
   * 追従対象ターゲットの同期
   */
  public setChaseTarget(target: FollowTarget): void {
    this.trackingTarget = target;
  }

  /**
   * クォータービューモードへの復帰
   */
  public setQuarterViewMode(): void {
    this.viewMode = 'quarter_view';
    this.activeCamera = this.orthoCamera;
    this.updateFrustum(window.innerWidth, window.innerHeight);
    this.updateCameraTransform();
  }

  /**
   * 毎フレームの更新処理（回転補間、追尾Lerp、キーボードパン）
   */
  public update(deltaSeconds: number): void {
    // 1. 4方向90度ステップ回転のスムーズ補間
    let thetaDiff = this.targetTheta - this.currentTheta;
    while (thetaDiff > Math.PI) thetaDiff -= Math.PI * 2;
    while (thetaDiff < -Math.PI) thetaDiff += Math.PI * 2;

    if (Math.abs(thetaDiff) > 0.001) {
      this.currentTheta += thetaDiff * 0.15;
    } else {
      this.currentTheta = this.targetTheta;
    }
    this.currentTheta = ((this.currentTheta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

    // 2. 列車追尾のLerp補間
    if (this.isTracking && this.trackingTarget) {
      if (this.viewMode === 'quarter_view') {
        const dist = this.target.distanceTo(this.trackingTarget.position);
        if (dist > 8) {
          // 高速進行時や長距離移動時は画面外へ飛び出さないよう即時同期
          this.target.copy(this.trackingTarget.position);
        } else {
          this.target.lerp(this.trackingTarget.position, 0.15);
        }
      } else if (this.viewMode === 'cab_view') {
        // ① 運転席フロントガラス直前かつ運転席目線高さ（車体前端 +0.95m, 高さ +0.85m）
        // 車体ポリゴンの内側に入り込まないよう、フロントガラス直前に配置
        const pos = this.trackingTarget.position;
        const dir = this.trackingTarget.direction || new THREE.Vector3(0, 0, 1);
        const horizDir = new THREE.Vector3(dir.x, 0, dir.z).normalize();
        if (horizDir.lengthSq() < 0.001) {
          horizDir.set(0, 0, 1);
        }

        this.perspectiveCamera.position.set(
          pos.x + horizDir.x * 0.95,
          pos.y + 0.85,
          pos.z + horizDir.z * 0.95
        );

        // ② ピッチ角（勾配・スロープ対応）の滑らかな反映と、ヨー角（カーブ）の微振動防止
        const targetPitch = this.trackingTarget.pitch ?? 0;
        this.currentCabPitch = THREE.MathUtils.lerp(this.currentCabPitch, targetPitch, 0.15);

        const cosP = Math.cos(this.currentCabPitch);
        const sinP = Math.sin(this.currentCabPitch);
        const targetForward = new THREE.Vector3(
          horizDir.x * cosP,
          -sinP, // 上り勾配(pitch < 0)では上向き、下り勾配(pitch > 0)では下向き
          horizDir.z * cosP
        ).normalize();

        // 進行方向ベクトルをLerp補間し、カーブやポイントでの視線ガクつきを防止。
        // 折り返し等で進行方向が大きく反転した際（内積 < 0.2）は、自車内側を映さないよう即座に同期
        if (this.currentCabForward.dot(targetForward) < 0.2) {
          this.currentCabForward.copy(targetForward);
        } else {
          this.currentCabForward.lerp(targetForward, 0.2).normalize();
        }

        const lookTarget = new THREE.Vector3().addVectors(this.perspectiveCamera.position, this.currentCabForward);
        this.perspectiveCamera.lookAt(lookTarget);

        // 【虚無空間突入バグ解消】前面展望中も注視点（target）を列車位置に同期させ、進行方向の地形チャンク生成を維持
        this.target.copy(pos);
      } else if (this.viewMode === 'chase_view') {
        const pos = this.trackingTarget.position;
        const dir = this.trackingTarget.direction || new THREE.Vector3(0, 0, 1);
        const horizDir = new THREE.Vector3(dir.x, 0, dir.z).normalize();
        if (horizDir.lengthSq() < 0.001) {
          horizDir.set(0, 0, 1);
        }

        // 1. 注視点（列車の車体中心やや上）の滑らかなLerp追従
        const targetLookAt = new THREE.Vector3(pos.x, pos.y + 0.6, pos.z);
        const distToTarget = this.currentChaseTargetPos.distanceTo(targetLookAt);
        if (distToTarget > 12) {
          this.currentChaseTargetPos.copy(targetLookAt);
        } else {
          this.currentChaseTargetPos.lerp(targetLookAt, 0.18);
        }

        // 2. ワールド方位角（Yaw）の補間: 進行方向の斜め後方＋ユーザー操作の相対Yaw
        const trainYaw = Math.atan2(horizDir.x, horizDir.z);
        const targetYaw = trainYaw + Math.PI + this.chaseRelativeYaw;
        let yawDiff = targetYaw - this.currentWorldYaw;
        while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
        while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
        this.currentWorldYaw += yawDiff * 0.12;

        // 3. カメラ目標位置の算出とLerp補間
        const horizDist = this.chaseDistance * Math.cos(this.chasePhi);
        const vertDist = this.chaseDistance * Math.sin(this.chasePhi);
        const desiredCamPos = new THREE.Vector3(
          this.currentChaseTargetPos.x + Math.sin(this.currentWorldYaw) * horizDist,
          this.currentChaseTargetPos.y + vertDist,
          this.currentChaseTargetPos.z + Math.cos(this.currentWorldYaw) * horizDist
        );

        const distToCam = this.currentChasePos.distanceTo(desiredCamPos);
        if (distToCam > 18) {
          this.currentChasePos.copy(desiredCamPos);
        } else {
          this.currentChasePos.lerp(desiredCamPos, 0.18);
        }

        this.perspectiveCamera.position.copy(this.currentChasePos);
        this.perspectiveCamera.lookAt(this.currentChaseTargetPos);

        // 地形チャンク生成維持のため target を注視点に同期
        this.target.copy(this.currentChaseTargetPos);
      }
    }

    // 3. キーボードによるパン操作 (WASD / 矢印キー)
    this.handleKeyboardPan(deltaSeconds);

    // 4. カメラ座標の更新
    if (this.viewMode === 'quarter_view') {
      this.updateCameraTransform();
    }
  }

  /**
   * キーボードパン
   */
  private handleKeyboardPan(deltaSeconds: number): void {
    if (this.viewMode !== 'quarter_view') return;

    let moveForward = 0;
    let moveRight = 0;

    if (this.keysPressed['w'] || this.keysPressed['arrowup']) moveForward += 1;
    if (this.keysPressed['s'] || this.keysPressed['arrowdown']) moveForward -= 1;
    if (this.keysPressed['d'] || this.keysPressed['arrowright']) moveRight += 1;
    if (this.keysPressed['a'] || this.keysPressed['arrowleft']) moveRight -= 1;

    if (moveForward !== 0 || moveRight !== 0) {
      this.stopTracking(); // 手動操作で追尾解除

      const speed = this.visibleTilesOnShortSide * CameraManager.TILE_SIZE * 0.8 * deltaSeconds;

      // 現在の視線方位に応じた前方・右方ベクトル
      const forward = new THREE.Vector3(-Math.sin(this.currentTheta), 0, -Math.cos(this.currentTheta)).normalize();
      const right = new THREE.Vector3(Math.cos(this.currentTheta), 0, -Math.sin(this.currentTheta)).normalize();

      this.target.addScaledVector(forward, moveForward * speed);
      this.target.addScaledVector(right, moveRight * speed);
    }
  }

  /**
   * イベントバインド
   */
  private bindEvents(): void {
    this.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

    // マウス押下
    this.domElement.addEventListener('mousedown', (e) => {
      if (this.viewMode === 'quarter_view') {
        // 中ドラッグ (button=1) は常にパン移動、左ドラッグ (button=0) は canPan() が真の場合のみパン移動
        if (e.button === 1 || (e.button === 0 && this.canPan())) {
          this.isPanning = true;
          this.lastMouseX = e.clientX;
          this.lastMouseY = e.clientY;
        }
      } else if (this.viewMode === 'chase_view') {
        if (e.button === 0 || e.button === 1 || e.button === 2) {
          this.isChaseDragging = true;
          this.lastChaseMouseX = e.clientX;
          this.lastChaseMouseY = e.clientY;
        }
      }
    });

    // マウス移動
    window.addEventListener('mousemove', (e) => {
      if (this.viewMode === 'quarter_view' && this.isPanning) {
        const dx = e.clientX - this.lastMouseX;
        const dy = e.clientY - this.lastMouseY;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;

        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          this.stopTracking(); // 手動ドラッグで追尾解除
        }

        // ピクセル移動量をワールド移動量へ換算
        const shortSidePx = Math.min(window.innerWidth, window.innerHeight);
        const worldUnitsPerPixel = (this.visibleTilesOnShortSide * CameraManager.TILE_SIZE) / shortSidePx;

        const forward = new THREE.Vector3(-Math.sin(this.currentTheta), 0, -Math.cos(this.currentTheta)).normalize();
        const right = new THREE.Vector3(Math.cos(this.currentTheta), 0, -Math.sin(this.currentTheta)).normalize();

        // 斜め45度見下ろしのため、画面Y方向の移動は水平奥行き方向へ投影
        const factorY = 1 / Math.sin(this.phi);

        this.target.addScaledVector(right, -dx * worldUnitsPerPixel);
        this.target.addScaledVector(forward, dy * worldUnitsPerPixel * factorY);
      } else if (this.viewMode === 'chase_view' && this.isChaseDragging) {
        const dx = e.clientX - this.lastChaseMouseX;
        const dy = e.clientY - this.lastChaseMouseY;
        this.lastChaseMouseX = e.clientX;
        this.lastChaseMouseY = e.clientY;

        // 水平ドラッグで相対オービット方位角変更、垂直ドラッグで仰角変更
        this.chaseRelativeYaw += dx * 0.008;
        this.chasePhi = THREE.MathUtils.clamp(this.chasePhi + dy * 0.006, 0.08, 1.35);
      }
    });

    // マウス離脱
    window.addEventListener('mouseup', () => {
      this.isPanning = false;
      this.isChaseDragging = false;
    });

    // ホイールズーム
    this.domElement.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.viewMode === 'quarter_view') {
        const delta = e.deltaY > 0 ? 3 : -3;
        this.zoomBy(delta);
      } else if (this.viewMode === 'chase_view') {
        const delta = e.deltaY > 0 ? 0.8 : -0.8;
        this.chaseDistance = THREE.MathUtils.clamp(this.chaseDistance + delta, 4.0, 20.0);
      }
    }, { passive: false });

    // タッチ操作（スマホ用: 1本指パン、2本指ピンチズーム）
    let touchStartDist = 0;
    let touchStartX = 0;
    let touchStartY = 0;
    let lastTouchX = 0;
    let lastTouchY = 0;
    let isTouchPanning = false;
    let hasMovedSignificantly = false;

    this.domElement.addEventListener('touchstart', (e: TouchEvent) => {
      if (this.viewMode === 'quarter_view') {
        if (e.touches.length === 1) {
          if (this.canPan()) {
            isTouchPanning = true;
            hasMovedSignificantly = false;
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            lastTouchX = e.touches[0].clientX;
            lastTouchY = e.touches[0].clientY;
          } else {
            isTouchPanning = false;
          }
        } else if (e.touches.length === 2) {
          isTouchPanning = false;
          hasMovedSignificantly = true;
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          touchStartDist = Math.hypot(dx, dy);
        }
      } else if (this.viewMode === 'chase_view') {
        if (e.touches.length === 1) {
          this.isChaseTouchPanning = true;
          this.lastChaseTouchX = e.touches[0].clientX;
          this.lastChaseTouchY = e.touches[0].clientY;
        } else if (e.touches.length === 2) {
          this.isChaseTouchPanning = false;
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          this.chaseTouchStartDist = Math.hypot(dx, dy);
        }
      }
    }, { passive: true });

    window.addEventListener('touchmove', (e: TouchEvent) => {
      if (this.viewMode === 'quarter_view') {
        if (e.touches.length === 1 && isTouchPanning) {
          if (!this.canPan()) {
            isTouchPanning = false;
            return;
          }
          const clientX = e.touches[0].clientX;
          const clientY = e.touches[0].clientY;
          
          if (!hasMovedSignificantly) {
            const totalDist = Math.hypot(clientX - touchStartX, clientY - touchStartY);
            if (totalDist > 4) {
              hasMovedSignificantly = true;
            } else {
              return;
            }
          }

          const dx = clientX - lastTouchX;
          const dy = clientY - lastTouchY;
          lastTouchX = clientX;
          lastTouchY = clientY;

          if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
            this.stopTracking();
          }

          const shortSidePx = Math.min(window.innerWidth, window.innerHeight);
          const worldUnitsPerPixel = (this.visibleTilesOnShortSide * CameraManager.TILE_SIZE) / shortSidePx;

          const forward = new THREE.Vector3(-Math.sin(this.currentTheta), 0, -Math.cos(this.currentTheta)).normalize();
          const right = new THREE.Vector3(Math.cos(this.currentTheta), 0, -Math.sin(this.currentTheta)).normalize();
          const factorY = 1 / Math.sin(this.phi);

          this.target.addScaledVector(right, -dx * worldUnitsPerPixel);
          this.target.addScaledVector(forward, dy * worldUnitsPerPixel * factorY);
        } else if (e.touches.length === 2 && touchStartDist > 0) {
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          const currentDist = Math.hypot(dx, dy);
          const diff = currentDist - touchStartDist;
          if (Math.abs(diff) > 4) {
            this.zoomBy(diff > 0 ? -1.5 : 1.5);
            touchStartDist = currentDist;
          }
        }
      } else if (this.viewMode === 'chase_view') {
        if (e.touches.length === 1 && this.isChaseTouchPanning) {
          const clientX = e.touches[0].clientX;
          const clientY = e.touches[0].clientY;
          const dx = clientX - this.lastChaseTouchX;
          const dy = clientY - this.lastChaseTouchY;
          this.lastChaseTouchX = clientX;
          this.lastChaseTouchY = clientY;

          this.chaseRelativeYaw += dx * 0.008;
          this.chasePhi = THREE.MathUtils.clamp(this.chasePhi + dy * 0.006, 0.08, 1.35);
        } else if (e.touches.length === 2 && this.chaseTouchStartDist > 0) {
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          const currentDist = Math.hypot(dx, dy);
          const diff = currentDist - this.chaseTouchStartDist;
          if (Math.abs(diff) > 4) {
            this.chaseDistance = THREE.MathUtils.clamp(this.chaseDistance - diff * 0.02, 4.0, 20.0);
            this.chaseTouchStartDist = currentDist;
          }
        }
      }
    }, { passive: true });

    window.addEventListener('touchend', (e: TouchEvent) => {
      if (this.viewMode === 'quarter_view') {
        if (e.touches.length === 0) {
          isTouchPanning = false;
          hasMovedSignificantly = false;
          touchStartDist = 0;
        } else if (e.touches.length === 1) {
          isTouchPanning = true;
          hasMovedSignificantly = true;
          lastTouchX = e.touches[0].clientX;
          lastTouchY = e.touches[0].clientY;
        }
      } else if (this.viewMode === 'chase_view') {
        if (e.touches.length === 0) {
          this.isChaseTouchPanning = false;
          this.chaseTouchStartDist = 0;
        } else if (e.touches.length === 1) {
          this.isChaseTouchPanning = true;
          this.lastChaseTouchX = e.touches[0].clientX;
          this.lastChaseTouchY = e.touches[0].clientY;
        }
      }
    }, { passive: true });

    // キーボード入力 (Q/Eキーで90度回転, WASDキーでカメラ移動)
    // ① テキスト入力中（input/textarea等）のショートカット暴発を完全防止
    const isTextInputFocused = (): boolean => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
    };

    window.addEventListener('focusin', () => {
      if (isTextInputFocused()) {
        this.keysPressed = {};
      }
    });

    window.addEventListener('keydown', (e) => {
      if (isTextInputFocused()) return;

      const key = e.key.toLowerCase();
      this.keysPressed[key] = true;

      if (key === 'q') {
        this.rotateStepCCW();
      } else if (key === 'e') {
        this.rotateStepCW();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (isTextInputFocused()) {
        this.keysPressed = {};
        return;
      }
      this.keysPressed[e.key.toLowerCase()] = false;
    });

    // リサイズハンドラ
    window.addEventListener('resize', () => {
      this.updateFrustum(window.innerWidth, window.innerHeight);
    });
  }

  /**
   * 現在のカメラが捉えている視界短辺のタイル数
   */
  public getShortSideTiles(): number {
    return this.visibleTilesOnShortSide;
  }

  /**
   * 【UIの嘘解消】現在の画面ビューポート4隅が地表面（Y = 0 平面）と交差する4つのワールド座標 (x, z) を算出する
   * クォータービュー（平行投影・見下ろし45度・方位角theta）の場合、真上から見ると「ひし形（ダイヤ型）」になる。
   * 返却順: [画面左上, 画面右上, 画面右下, 画面左下]
   */
  public getViewportGroundCorners(): Array<{ x: number; z: number }> {
    const camera = this.activeCamera;
    camera.updateMatrixWorld();

    const ndcCorners = [
      new THREE.Vector3(-1, 1, -1),  // 画面左上
      new THREE.Vector3(1, 1, -1),   // 画面右上
      new THREE.Vector3(1, -1, -1),  // 画面右下
      new THREE.Vector3(-1, -1, -1)  // 画面左下
    ];

    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);

    const groundY = 0;
    const corners: Array<{ x: number; z: number }> = [];

    for (const ndc of ndcCorners) {
      const worldNear = ndc.clone().unproject(camera);
      let rayOrigin: THREE.Vector3;
      let rayDir: THREE.Vector3;

      if (camera instanceof THREE.OrthographicCamera) {
        rayOrigin = worldNear;
        rayDir = dir;
      } else {
        rayOrigin = camera.position;
        rayDir = worldNear.clone().sub(camera.position).normalize();
      }

      if (Math.abs(rayDir.y) > 1e-6) {
        const t = (groundY - rayOrigin.y) / rayDir.y;
        if (t >= 0 || camera instanceof THREE.OrthographicCamera) {
          corners.push({ x: rayOrigin.x + t * rayDir.x, z: rayOrigin.z + t * rayDir.z });
          continue;
        }
      }
      corners.push({ x: worldNear.x, z: worldNear.z });
    }

    return corners;
  }
}
