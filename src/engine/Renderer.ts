import * as THREE from 'three';
import { GameMaterials } from '../graphics/materials';

export type TimeOfDay = 'day' | 'sunset' | 'night';
export type TimeLightingMode = 'auto' | 'day' | 'night';
export type GraphicsQuality = 'high' | 'medium' | 'low';

export class EngineRenderer {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public renderer: THREE.WebGLRenderer;
  public container: HTMLElement;

  public dirLight: THREE.DirectionalLight;
  public ambientLight: THREE.AmbientLight;
  public hemiLight: THREE.HemisphereLight;
  public gridHelper: THREE.GridHelper;
  public groundMesh: THREE.Mesh;
  public undergroundFloorMesh: THREE.Mesh;
  public groundHoleGroup: THREE.Group;
  private groundHoles: Map<string, THREE.Mesh> = new Map();
  private holeMaterial: THREE.MeshBasicMaterial = new THREE.MeshBasicMaterial({
    depthWrite: false,
    colorWrite: false,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilZPass: THREE.ReplaceStencilOp
  });

  private currentTimeOfDay: TimeOfDay = 'day';
  private lightingMode: TimeLightingMode = 'auto';
  private isUndergroundMode: boolean = false;
  private graphicsQuality: GraphicsQuality = 'high';

  /** 画面リサイズや解像度変更時にカメラマネージャー等の外部Frustum更新を呼ぶコールバック */
  public onResizeCallback?: () => void;

  /** 太陽光の向き（影の注視点からの相対位置）。時間帯ライティングがこの値を更新する */
  private lightOffset: THREE.Vector3 = new THREE.Vector3(50, 75, 40);
  /** 影を描画する中心（カメラ注視点に追従） */
  private shadowFocus: THREE.Vector3 = new THREE.Vector3();
  /** 影カメラの半幅（ワールド単位） */
  private shadowHalfExtent: number = 50;

  // 前面展望用ヘッドライト（前照灯）
  private cabHeadlight: THREE.SpotLight | null = null;
  private cabHeadlightTarget: THREE.Object3D | null = null;

  constructor(containerId: string) {
    const container = document.getElementById(containerId);
    if (!container) throw new Error(`Container #${containerId} not found`);
    this.container = container;

    // 1. Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xd6e6f2); // Day sky blue
    this.scene.fog = null; // クォータービュー（平行投影）のため遠距離フォグによる白飛びを防止

    // 2. Camera
    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
    this.camera.position.set(35, 40, 35);
    this.camera.lookAt(0, 0, 0);

    // 3. WebGLRenderer with soft shadows
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.container.appendChild(this.renderer.domElement);

    // 4. Ground plane (ぴったり64マスの境界サイズ: 64 * 2.0 = 128)
    const groundGeo = new THREE.PlaneGeometry(128, 128);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x86b96e, // Natural rich grass
      roughness: 0.85,
      metalness: 0.05,
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: THREE.NotEqualStencilFunc
    });
    this.groundMesh = new THREE.Mesh(groundGeo, groundMat);
    this.groundMesh.rotation.x = -Math.PI / 2;
    this.groundMesh.position.y = -0.01;
    this.groundMesh.receiveShadow = true;
    this.groundMesh.renderOrder = 1;
    this.scene.add(this.groundMesh);

    // 4-a. 地表開口部ステンシルマスクグループ（地下スロープ掘割部分の地面クリッピング）
    this.groundHoleGroup = new THREE.Group();
    this.groundHoleGroup.name = 'GroundHoleGroup';
    this.scene.add(this.groundHoleGroup);

    // 4-b. 地下専用作業フロア（地下B1F/B2F選択時に表示される地下基盤コンクリート床）
    const undergroundMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b, // 深いスレートグレー（地下トンネル基盤）
      roughness: 0.9,
      metalness: 0.1
    });
    this.undergroundFloorMesh = new THREE.Mesh(new THREE.PlaneGeometry(128, 128), undergroundMat);
    this.undergroundFloorMesh.rotation.x = -Math.PI / 2;
    this.undergroundFloorMesh.position.y = -3.01;
    this.undergroundFloorMesh.receiveShadow = true;
    this.undergroundFloorMesh.visible = false;
    this.scene.add(this.undergroundFloorMesh);

    // 5. Grid helper (soft modern grid)
    this.gridHelper = new THREE.GridHelper(128, 64, 0x0284c7, 0x94a3b8);
    this.gridHelper.position.y = 0.01;
    const gridMat = this.gridHelper.material as THREE.Material;
    gridMat.opacity = 0.28;
    gridMat.transparent = true;
    gridMat.stencilWrite = true;
    gridMat.stencilRef = 1;
    gridMat.stencilFunc = THREE.NotEqualStencilFunc;
    this.gridHelper.renderOrder = 1;
    this.scene.add(this.gridHelper);

    // 6. Lighting
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
    this.scene.add(this.ambientLight);

    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.4);
    this.hemiLight.position.set(0, 50, 0);
    this.scene.add(this.hemiLight);

    this.dirLight = new THREE.DirectionalLight(0xfffaed, 1.25);
    this.lightOffset.set(50, 75, 40);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.width = 2048;
    this.dirLight.shadow.mapSize.height = 2048;
    this.dirLight.shadow.camera.near = 1;
    this.dirLight.shadow.camera.far = 500;
    const d = 50;
    this.dirLight.shadow.camera.left = -d;
    this.dirLight.shadow.camera.right = d;
    this.dirLight.shadow.camera.top = d;
    this.dirLight.shadow.camera.bottom = -d;
    // 奥行き範囲(far=500)拡大に合わせ、正規化深度上のバイアスを縮小して浮き影を抑制
    this.dirLight.shadow.bias = -0.0002;
    this.scene.add(this.dirLight);
    // 影の注視点追従のため、ライトのターゲットをシーンに登録（行列更新対象にする）
    this.scene.add(this.dirLight.target);

    // Resize handler
    window.addEventListener('resize', this.onResize.bind(this));
  }

  private onResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.onResizeCallback?.();
  }

  public setGridVisible(visible: boolean) {
    this.gridHelper.visible = visible;
  }

  public getLightingMode(): TimeLightingMode {
    return this.lightingMode;
  }

  public setLightingMode(mode: TimeLightingMode): void {
    this.lightingMode = mode;
  }

  /**
   * 昼夜切替モードを循環切替: ①昼夜切替OFF(auto) → ②昼間固定(day) → ③夜間固定(night) → ①...
   */
  public cycleLightingMode(): TimeLightingMode {
    if (this.lightingMode === 'auto') {
      this.lightingMode = 'day';
    } else if (this.lightingMode === 'day') {
      this.lightingMode = 'night';
    } else {
      this.lightingMode = 'auto';
    }
    return this.lightingMode;
  }

  public toggleTimeOfDay(): TimeOfDay {
    this.cycleLightingMode();
    return this.currentTimeOfDay;
  }

  public setTimeOfDay(time: TimeOfDay) {
    this.currentTimeOfDay = time;
    if (time === 'day') {
      this.applyDayLighting();
      GameMaterials.updateMaterialsTimeOfDay(false, 0.0);
    } else if (time === 'sunset') {
      this.scene.background = new THREE.Color(0xfdba74);
      (this.scene.fog as THREE.FogExp2 | null)?.color.set(0xfdba74);
      this.dirLight.color.set(0xf97316);
      this.dirLight.intensity = 1.1;
      this.lightOffset.set(65, 30, 15);
      this.ambientLight.color.set(0xfb923c);
      this.ambientLight.intensity = 0.55;
      (this.groundMesh.material as THREE.MeshStandardMaterial).color.set(0x927042);
      GameMaterials.updateMaterialsTimeOfDay(true, 0.45);
    } else {
      // Night
      this.applyNightLighting();
      GameMaterials.updateMaterialsTimeOfDay(true, 1.0);
    }
  }

  /**
   * 昼間の標準照明を適用（爽やかな青空・明るい太陽光）
   */
  private applyDayLighting(): void {
    this.scene.background = new THREE.Color(0xd6e6f2);
    (this.scene.fog as THREE.FogExp2 | null)?.color.set(0xd6e6f2);
    this.dirLight.color.set(0xfffaed);
    this.dirLight.intensity = 1.25;
    this.lightOffset.set(50, 75, 40);
    this.ambientLight.color.set(0xffffff);
    this.ambientLight.intensity = 0.65;
    (this.groundMesh.material as THREE.MeshStandardMaterial).color.set(0x86b96e);
  }

  /**
   * 夜間の標準照明を適用（夜空・落ち着いた月光）
   */
  private applyNightLighting(): void {
    this.scene.background = new THREE.Color(0x090d16);
    (this.scene.fog as THREE.FogExp2 | null)?.color.set(0x090d16);
    this.dirLight.color.set(0x93c5fd);
    this.dirLight.intensity = 0.35;
    this.lightOffset.set(-30, 60, -40);
    this.ambientLight.color.set(0x1e293b);
    this.ambientLight.intensity = 0.42;
    (this.groundMesh.material as THREE.MeshStandardMaterial).color.set(0x1c2833);
  }

  /**
   * ゲーム内時刻に応じた滑らかな連続ライティング＆環境光のトーンダウン
   * （固定モードが指定されている場合は時間帯に関係なく指定の明るさに固定）
   * @param hour 0〜23
   * @param minute 0〜59
   */
  public updateLightingByTime(hour: number, minute: number): void {
    if (this.isUndergroundMode) {
      // 地下世界ライティング: 昼間モードまたは昼間時間帯（6〜18時）は高輝度作業用フラッドライトで明るく照らす
      const isDaytime = this.lightingMode === 'day' || (this.lightingMode === 'auto' && hour >= 6 && hour < 18);
      if (isDaytime) {
        this.dirLight.intensity = 1.1;
        this.dirLight.color.set(0xfffaed);
        this.lightOffset.set(20, 80, 20);
        this.dirLight.castShadow = false; // 地下では床の陰影破綻を防ぐためシャドウ無効
        this.ambientLight.intensity = 0.85;
        this.ambientLight.color.set(0xe2e8f0); // 明るい作業用ホワイトグレー
        this.scene.background = new THREE.Color(0x1a2332); // 視認性の高いスレートグレー
        if (this.scene.fog) {
          (this.scene.fog as THREE.FogExp2).color.set(0x1a2332);
        }
        this.currentTimeOfDay = 'day';
        GameMaterials.updateMaterialsTimeOfDay(false, 0.0);
      } else {
        // 夜間モードまたは夜間時間帯: 落ち着いた地下空間
        this.dirLight.intensity = 0.2;
        this.dirLight.color.set(0x93c5fd);
        this.dirLight.castShadow = false;
        this.ambientLight.intensity = 0.45;
        this.ambientLight.color.set(0x384252);
        this.scene.background = new THREE.Color(0x0a0f18);
        if (this.scene.fog) {
          (this.scene.fog as THREE.FogExp2).color.set(0x0a0f18);
        }
        this.currentTimeOfDay = 'night';
        GameMaterials.updateMaterialsTimeOfDay(true, 1.0);
      }
      return;
    }

    this.dirLight.castShadow = (this.graphicsQuality !== 'low');

    // ② 昼間固定モード: 時間帯に関係なく昼間の明るさに固定
    if (this.lightingMode === 'day') {
      this.applyDayLighting();
      this.currentTimeOfDay = 'day';
      GameMaterials.updateMaterialsTimeOfDay(false, 0.0);
      return;
    }

    // ③ 夜間固定モード: 時間帯に関係なく夜間の明るさに固定
    if (this.lightingMode === 'night') {
      this.applyNightLighting();
      this.currentTimeOfDay = 'night';
      GameMaterials.updateMaterialsTimeOfDay(true, 1.0);
      return;
    }

    // ① 昼夜切替OFF (auto) モード: ゲーム内時刻に応じた滑らかな連続ライティング
    const timeVal = hour + minute / 60; // 0.0〜24.0

    // 昼夜・夕暮れ判定および補間係数の算出
    let nightFactor = 0;
    let effectiveTimeOfDay: TimeOfDay = 'day';

    if (timeVal >= 17.0 && timeVal < 19.5) {
      // 17:00〜19:30: 夕暮れ・日没フェーズ
      const progress = (timeVal - 17.0) / 2.5;
      nightFactor = progress * 0.7;
      effectiveTimeOfDay = progress < 0.6 ? 'sunset' : 'night';

      // 昼光から夕焼け色、そして夜空へ補間
      const bgCol = new THREE.Color().lerpColors(
        new THREE.Color(0xd6e6f2),
        new THREE.Color(0xfdba74),
        Math.min(1, progress * 1.5)
      );
      if (progress > 0.5) {
        bgCol.lerp(new THREE.Color(0x090d16), (progress - 0.5) * 2);
      }
      this.scene.background = bgCol;
      (this.scene.fog as THREE.FogExp2 | null)?.color.copy(bgCol);

      this.dirLight.color.lerpColors(new THREE.Color(0xfffaed), new THREE.Color(0xf97316), Math.min(1, progress * 1.3));
      if (progress > 0.6) {
        this.dirLight.color.lerp(new THREE.Color(0x93c5fd), (progress - 0.6) * 2.5);
      }
      this.dirLight.intensity = 1.25 - progress * 0.8;
      this.ambientLight.intensity = 0.65 - progress * 0.22;
      this.ambientLight.color.lerpColors(new THREE.Color(0xffffff), new THREE.Color(0xfb923c), Math.min(1, progress * 1.4));
      if (progress > 0.6) {
        this.ambientLight.color.lerp(new THREE.Color(0x1e293b), (progress - 0.6) * 2.5);
      }
    } else if (timeVal >= 19.5 || timeVal < 4.5) {
      // 19:30〜04:30: 深夜フェーズ
      nightFactor = 1.0;
      effectiveTimeOfDay = 'night';
      this.applyNightLighting();
    } else if (timeVal >= 4.5 && timeVal < 7.0) {
      // 04:30〜07:00: 早朝・夜明けフェーズ
      const progress = (timeVal - 4.5) / 2.5;
      nightFactor = 1.0 - progress;
      effectiveTimeOfDay = progress < 0.4 ? 'night' : (progress < 0.8 ? 'sunset' : 'day');

      const bgCol = new THREE.Color(0x090d16).lerp(new THREE.Color(0xfde047), progress * 0.6);
      bgCol.lerp(new THREE.Color(0xd6e6f2), Math.max(0, (progress - 0.5) * 2));
      this.scene.background = bgCol;
      (this.scene.fog as THREE.FogExp2 | null)?.color.copy(bgCol);

      this.dirLight.color.lerpColors(new THREE.Color(0x93c5fd), new THREE.Color(0xfffaed), progress);
      this.dirLight.intensity = 0.35 + progress * 0.9;
      this.ambientLight.intensity = 0.42 + progress * 0.23;
      this.ambientLight.color.lerpColors(new THREE.Color(0x1e293b), new THREE.Color(0xffffff), progress);
      (this.groundMesh.material as THREE.MeshStandardMaterial).color.lerpColors(new THREE.Color(0x1c2833), new THREE.Color(0x86b96e), progress);
    } else {
      // 07:00〜17:00: クリアな昼間フェーズ
      nightFactor = 0.0;
      effectiveTimeOfDay = 'day';
      this.applyDayLighting();
    }

    this.currentTimeOfDay = effectiveTimeOfDay;
    GameMaterials.updateMaterialsTimeOfDay(nightFactor > 0.3, nightFactor);
  }

  public getTimeOfDay(): TimeOfDay {
    return this.currentTimeOfDay;
  }

  public updateGroundAndGridSize(size: number) {
    const worldSize = size * 2.0; // 1マス = 2.0
    this.groundMesh.geometry.dispose();
    this.groundMesh.geometry = new THREE.PlaneGeometry(worldSize, worldSize);

    this.undergroundFloorMesh.geometry.dispose();
    this.undergroundFloorMesh.geometry = new THREE.PlaneGeometry(worldSize, worldSize);

    this.scene.remove(this.gridHelper);
    this.gridHelper.geometry.dispose();
    this.gridHelper = new THREE.GridHelper(worldSize, size, 0x0284c7, 0x94a3b8);
    this.gridHelper.position.y = 0.01;
    const gridMat = this.gridHelper.material as THREE.Material;
    gridMat.opacity = 0.28;
    gridMat.transparent = true;
    gridMat.stencilWrite = true;
    gridMat.stencilRef = 1;
    gridMat.stencilFunc = THREE.NotEqualStencilFunc;
    this.gridHelper.renderOrder = 1;
    this.scene.add(this.gridHelper);
  }

  /**
   * 地表に穴あけマスク（ステンシル値1）を追加する（地下スロープ掘割部分の地面クリッピング用）
   */
  public addGroundHole(x: number, z: number, rotation: number = 0): void {
    const key = `${x},${z}`;
    if (this.groundHoles.has(key)) return;

    // 擁壁幅 1.76m、長さ 2.05m（マス境界に隙間なく連続するサイズ）
    const isEastWest = (rotation % 2) === 1;
    const w = isEastWest ? 2.05 : 1.76;
    const h = isEastWest ? 1.76 : 2.05;
    const geo = new THREE.PlaneGeometry(w, h);
    const mesh = new THREE.Mesh(geo, this.holeMaterial);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x * 2.0, 0.02, z * 2.0); // 地表(y=-0.01)よりわずかに上
    mesh.renderOrder = 0; // groundMesh より先に描画してステンシルバッファをマーク
    this.groundHoleGroup.add(mesh);
    this.groundHoles.set(key, mesh);
  }

  /**
   * 指定座標の地表穴あけマスクを撤去
   */
  public removeGroundHole(x: number, z: number): void {
    const key = `${x},${z}`;
    const mesh = this.groundHoles.get(key);
    if (mesh) {
      this.groundHoleGroup.remove(mesh);
      mesh.geometry.dispose();
      this.groundHoles.delete(key);
    }
  }

  /**
   * 全ての地表穴あけマスクを消去
   */
  public clearGroundHoles(): void {
    for (const mesh of this.groundHoles.values()) {
      this.groundHoleGroup.remove(mesh);
      mesh.geometry.dispose();
    }
    this.groundHoles.clear();
  }

  /**
   * 地上1Fの緑地プレーンの表示/非表示を切り替える（地下作業時は非表示）
   */
  public setGroundVisible(visible: boolean) {
    this.groundMesh.visible = visible;
  }

  /**
   * グリッドヘルパーのY高さを指定階層に同期
   */
  public setGridHeight(height: number) {
    this.gridHelper.position.y = height + 0.01;
  }

  /**
   * 地下専用作業フロアの表示と高さを設定
   */
  public setUndergroundFloor(visible: boolean, height: number = -3.0) {
    this.undergroundFloorMesh.visible = visible;
    this.undergroundFloorMesh.position.y = height - 0.01;
    this.isUndergroundMode = visible;
    if (!visible) {
      this.dirLight.castShadow = (this.graphicsQuality !== 'low');
    }
  }

  /**
   * 地下階層表示モードの設定
   */
  public setUndergroundMode(underground: boolean) {
    this.isUndergroundMode = underground;
    if (!underground) {
      this.dirLight.castShadow = (this.graphicsQuality !== 'low');
    }
  }

  public getIsUndergroundMode(): boolean {
    return this.isUndergroundMode;
  }

  /**
   * 描画クオリティを動的に設定・適用
   * @param level 'high' | 'medium' | 'low'
   * @param onResizeCamera カメラアスペクト比・フラスタム再計算用コールバック
   */
  public setGraphicsQuality(level: GraphicsQuality, onResizeCamera?: () => void): void {
    this.graphicsQuality = level;

    // 1. ピクセル比（解像度）の更新
    let targetPixelRatio = 1.0;
    if (level === 'high') {
      targetPixelRatio = Math.min(window.devicePixelRatio, 2.0);
    } else if (level === 'medium') {
      targetPixelRatio = Math.min(window.devicePixelRatio, 1.5);
    } else {
      // low: 描画ピクセル数を1.0固定（Retina等の高DPI環境でもGPU負荷を最小化）
      targetPixelRatio = 1.0;
    }
    this.renderer.setPixelRatio(targetPixelRatio);

    // 2. レンダラーサイズとカメラ投影行列の同期再計算
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    // 3. シャドウマップおよびディレクショナルライトの影設定更新
    if (level === 'low') {
      // シャドウ完全無効化
      this.renderer.shadowMap.enabled = false;
      this.dirLight.castShadow = false;
      if (this.dirLight.shadow.map) {
        this.dirLight.shadow.map.dispose();
        this.dirLight.shadow.map = null;
      }
    } else {
      // シャドウ有効化
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = (level === 'high') ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
      this.dirLight.castShadow = !this.isUndergroundMode;

      const mapSize = (level === 'high') ? 2048 : 1024;
      if (this.dirLight.shadow.mapSize.width !== mapSize || this.dirLight.shadow.mapSize.height !== mapSize) {
        this.dirLight.shadow.mapSize.set(mapSize, mapSize);
        if (this.dirLight.shadow.map) {
          this.dirLight.shadow.map.dispose();
          this.dirLight.shadow.map = null;
        }
      }
    }

    // 4. マテリアルの再コンパイルをトリガー（シャドウシェーダーの切替アーティファクト防止）
    this.scene.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((m) => {
            if (m) m.needsUpdate = true;
          });
        } else if (mesh.material) {
          mesh.material.needsUpdate = true;
        }
      }
    });

    // 5. 外部カメラフラスタム等の更新を実行
    if (onResizeCamera) {
      onResizeCamera();
    } else if (this.onResizeCallback) {
      this.onResizeCallback();
    }
  }

  public getGraphicsQuality(): GraphicsQuality {
    return this.graphicsQuality;
  }

  /**
   * 影の描画範囲（影カメラ）をカメラ注視点とズーム量に追従させる
   * （原点固定だと、広域マップでは中央付近以外に影が落ちないため）
   * @param focus 影を描画する中心（ワールド座標）
   * @param halfExtent 影カメラの半幅（ワールド単位）
   */
  public setShadowFocus(focus: THREE.Vector3, halfExtent: number): void {
    if (this.graphicsQuality === 'low') return;
    const d = THREE.MathUtils.clamp(halfExtent, 30, 160);
    if (Math.abs(d - this.shadowHalfExtent) > 2) {
      this.shadowHalfExtent = d;
      const cam = this.dirLight.shadow.camera;
      cam.left = -d;
      cam.right = d;
      cam.top = d;
      cam.bottom = -d;
      cam.updateProjectionMatrix();
    }
    // テクセル単位にスナップして、カメラ移動時の影のちらつき（シャドウスイミング）を抑制
    const texel = (this.shadowHalfExtent * 2) / this.dirLight.shadow.mapSize.width;
    this.shadowFocus.set(
      Math.round(focus.x / texel) * texel,
      0,
      Math.round(focus.z / texel) * texel
    );
  }

  public render(customCamera?: THREE.Camera) {
    // 時間帯ライティングの光の向き（lightOffset）を、影の注視点基準で配置
    // 影カメラの投影範囲が広がっても奥行き方向で切れないよう、光源を一定距離(250)に配置する
    this.dirLight.position.copy(this.lightOffset).normalize().multiplyScalar(250).add(this.shadowFocus);
    this.dirLight.target.position.copy(this.shadowFocus);
    this.renderer.render(this.scene, customCamera || this.camera);
  }

  /**
   * 前面展望用透視投影フォグの有効化／無効化
   * クォータービュー時は正投影のため null、前面展望時は遠方エッジを自然に隠蔽する THREE.Fog を適用
   */
  public setCabViewFog(enabled: boolean): void {
    if (enabled) {
      const bgColor = (this.scene.background as THREE.Color) || new THREE.Color(0xd6e6f2);
      this.scene.fog = new THREE.Fog(bgColor.getHex(), 120, 280);
    } else {
      this.scene.fog = null;
    }
  }

  /**
   * 前面展望用ヘッドライト（前照灯スポットライト）の有効化
   * 夜間や地下トンネル走行時に進行方向レールを鮮明に照らし出す
   */
  public enableCabHeadlight(): void {
    if (!this.cabHeadlight) {
      this.cabHeadlight = new THREE.SpotLight(0xfffae6, 1.8, 45, 0.38, 0.5, 1.2);
      this.cabHeadlight.castShadow = false; // パフォーマンス優先
      this.cabHeadlightTarget = new THREE.Object3D();
      this.scene.add(this.cabHeadlight);
      this.scene.add(this.cabHeadlightTarget);
      this.cabHeadlight.target = this.cabHeadlightTarget;
    }
  }

  /**
   * 前面展望用ヘッドライトの位置・照射方向をカメラ座標・視線方向と同期
   */
  public updateCabHeadlight(camPos: THREE.Vector3, forwardDir: THREE.Vector3): void {
    if (!this.cabHeadlight || !this.cabHeadlightTarget) return;
    this.cabHeadlight.position.set(camPos.x, camPos.y - 0.1, camPos.z);
    this.cabHeadlightTarget.position.set(
      camPos.x + forwardDir.x * 25,
      camPos.y + forwardDir.y * 25 - 0.4,
      camPos.z + forwardDir.z * 25
    );
  }

  /**
   * 前面展望用ヘッドライトのシーンからの除去・解放
   */
  public disableCabHeadlight(): void {
    if (this.cabHeadlight) {
      this.scene.remove(this.cabHeadlight);
      this.cabHeadlight.dispose?.();
      this.cabHeadlight = null;
    }
    if (this.cabHeadlightTarget) {
      this.scene.remove(this.cabHeadlightTarget);
      this.cabHeadlightTarget = null;
    }
  }
}
