import * as THREE from 'three';
import { VehicleModelInfo } from '../../simulation/VehicleCatalog';

/**
 * 鉄道車両・編成・車体・パンタグラフ・台車メッシュ生成ビルダー
 */
export class VehicleMeshBuilder {
  /**
   * 車両間隔（車両間連結ピッチ）
   * 曲線追従のディレイ距離計算にも共用
   */
  public static readonly CAR_SPACING = 1.95;

  /** 車両用共有マテリアルキャッシュ（同一パラメータのマテリアルを全編成で使い回す） */
  private static materialCache = new Map<string, THREE.Material>();

  /**
   * パラメータが同一の MeshStandardMaterial を共有取得する
   * （1両ごとに新規生成すると、40編成×10両で数千個のマテリアルとなり描画時の状態切替が増大するため）
   * ※ 共有物のため userData.keepAlive を付与し、disposeHierarchy による解放対象から除外する
   */
  public static sharedStandard(params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
    const key = `S:${JSON.stringify(params)}`;
    let mat = this.materialCache.get(key) as THREE.MeshStandardMaterial | undefined;
    if (!mat) {
      mat = new THREE.MeshStandardMaterial(params);
      mat.userData.keepAlive = true;
      this.materialCache.set(key, mat);
    }
    return mat;
  }

  /**
   * パラメータが同一の MeshBasicMaterial を共有取得する
   */
  public static sharedBasic(params: THREE.MeshBasicMaterialParameters): THREE.MeshBasicMaterial {
    const key = `B:${JSON.stringify(params)}`;
    let mat = this.materialCache.get(key) as THREE.MeshBasicMaterial | undefined;
    if (!mat) {
      mat = new THREE.MeshBasicMaterial(params);
      mat.userData.keepAlive = true;
      this.materialCache.set(key, mat);
    }
    return mat;
  }

  /**
   * 車両編成の動的生成
   * @param modelInfo 車両カタログ情報（カラー、定員、性能等）
   * @param carCount 編成両数（1〜4両、今後最大10両に対応）
   */
  public static createTrainFormation(
    modelInfo: VehicleModelInfo,
    carCount: number = 3
  ): { group: THREE.Group; cars: THREE.Group[] } {
    const formationGroup = new THREE.Group();
    const cars: THREE.Group[] = [];

    const isFreight = modelInfo.category === 'freight' || modelInfo.id === 'freight-train';

    for (let i = 0; i < carCount; i++) {
      const isFront = (i === 0);
      const isRear = (i === carCount - 1);
      const hasDoubleCab = (carCount === 1); // 単行車両

      let car: THREE.Group;
      if (isFreight) {
        if (i === 0) {
          // 1両目は電気機関車
          car = this.createLocomotiveCar(modelInfo);
        } else {
          // 2両目以降はコキ100系コンテナ貨車
          car = this.createContainerFlatCar(i, isRear);
        }
      } else {
        car = this.createStyledTrainCar(modelInfo, isFront, isRear, hasDoubleCab);
      }

      // グループ原点(Z=0)＝進行方向の先頭車の初期位置とし、後続車は後方(-Z)へ配置
      const offsetZ = -i * this.CAR_SPACING;
      car.position.z = offsetZ;

      formationGroup.add(car);
      cars.push(car);
    }

    return { group: formationGroup, cars };
  }

  /**
   * 単両車体の生成
   */
  public static createStyledTrainCar(
    modelInfo: VehicleModelInfo,
    isFront: boolean,
    isRear: boolean,
    hasDoubleCab: boolean
  ): THREE.Group {
    const car = new THREE.Group();
    const length = 1.85;
    const width = 0.72;
    const height = 0.78;

    // 車体本体
    const bodyMat = VehicleMeshBuilder.sharedStandard({
      color: modelInfo.bodyColor,
      metalness: modelInfo.bodyColor === 0xd1d5db ? 0.8 : 0.2,
      roughness: 0.35
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, length), bodyMat);
    body.position.y = height / 2 + 0.24;
    body.castShadow = true;
    car.add(body);

    // 帯・ラインカラースプライト
    const stripeMat = VehicleMeshBuilder.sharedStandard({
      color: modelInfo.stripeColor,
      roughness: 0.3
    });
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(width + 0.01, 0.12, length + 0.005), stripeMat);
    stripe.position.y = height / 2 + 0.15;
    car.add(stripe);

    // 屋根
    const roofMat = VehicleMeshBuilder.sharedStandard({
      color: modelInfo.roofColor,
      roughness: 0.6
    });
    const roof = new THREE.Mesh(new THREE.BoxGeometry(width - 0.04, 0.08, length), roofMat);
    roof.position.y = height + 0.26;
    car.add(roof);

    // 運転台・前面マスク（先頭車・最後尾車・単行両運転台車）
    if (isFront || isRear || hasDoubleCab) {
      const zDir = isFront ? 1 : -1;
      const faceZ = (length / 2 + 0.02) * zDir;
      const maskMat = VehicleMeshBuilder.sharedStandard({ color: 0x1e293b, roughness: 0.3 });

      // 切妻型前面ブラックマスク
      const maskMesh = new THREE.Mesh(new THREE.BoxGeometry(width - 0.02, height * 0.88, 0.04), maskMat);
      maskMesh.position.set(0, height / 2 + 0.24, faceZ);
      car.add(maskMesh);

      // フロントガラス（大型窓）
      const frontWinMat = VehicleMeshBuilder.sharedStandard({ color: 0x0f172a, metalness: 0.9, roughness: 0.1 });
      const winGeo = new THREE.BoxGeometry(0.26, 0.28, 0.05);
      const frontWinL = new THREE.Mesh(winGeo, frontWinMat);
      frontWinL.position.set(-0.18, height / 2 + 0.36, faceZ + 0.01 * zDir);
      car.add(frontWinL);
      const frontWinR = new THREE.Mesh(winGeo, frontWinMat);
      frontWinR.position.set(0.18, height / 2 + 0.36, faceZ + 0.01 * zDir);
      car.add(frontWinR);

      // 貫通扉
      const doorMat = VehicleMeshBuilder.sharedStandard({ color: modelInfo.bodyColor, roughness: 0.4 });
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.16, height * 0.84, 0.052), doorMat);
      door.position.set(0, height / 2 + 0.24, faceZ + 0.005 * zDir);
      car.add(door);

      // 行先表示幕
      const signMat = VehicleMeshBuilder.sharedBasic({ color: 0x0f172a });
      const sign = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.07, 0.055), signMat);
      sign.position.set(0, height + 0.18, faceZ + 0.01 * zDir);
      car.add(sign);

      // ヘッドライト / テールライト
      const isHead = isFront || (hasDoubleCab && zDir === 1);
      const lightMat = VehicleMeshBuilder.sharedBasic({ color: isHead ? 0xfffae0 : 0xef4444 });
      const lightL = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 8), lightMat);
      lightL.position.set(-0.22, 0.44, faceZ + 0.03 * zDir);
      car.add(lightL);

      const lightR = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 8), lightMat);
      lightR.position.set(0.22, 0.44, faceZ + 0.03 * zDir);
      car.add(lightR);

      // スカート（排障器）
      const skirtMat = VehicleMeshBuilder.sharedStandard({ color: 0x475569, roughness: 0.5 });
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(width - 0.08, 0.12, 0.06), skirtMat);
      skirt.position.set(0, 0.18, faceZ + 0.02 * zDir);
      car.add(skirt);
    }

    // 側窓
    const winMat = VehicleMeshBuilder.sharedStandard({ color: 0x0f172a, roughness: 0.1, metalness: 0.9 });
    for (const z of [-0.45, 0.45]) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(width + 0.02, 0.26, 0.38), winMat);
      win.position.set(0, height / 2 + 0.32, z);
      car.add(win);
    }

    // クーラー室外機
    const coolerMat = VehicleMeshBuilder.sharedStandard({ color: 0x94a3b8, roughness: 0.4 });
    const cooler = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.08, 0.6), coolerMat);
    cooler.position.set(0, height + 0.32, 0);
    car.add(cooler);

    // パンタグラフ（先頭車）
    if (isFront) {
      const panto = this.createPantograph();
      panto.position.set(0, height + 0.32, -0.4);
      car.add(panto);
    }

    // 台車・車輪
    const wheelMat = VehicleMeshBuilder.sharedStandard({ color: 0x334155, metalness: 0.8, roughness: 0.3 });
    for (const bz of [-0.55, 0.55]) {
      const wL = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.06, 12), wheelMat);
      wL.rotation.z = Math.PI / 2;
      wL.position.set(-0.36, 0.12, bz);
      car.add(wL);

      const wR = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.06, 12), wheelMat);
      wR.rotation.z = Math.PI / 2;
      wR.position.set(0.36, 0.12, bz);
      car.add(wR);
    }

    return car;
  }

  /**
   * パンタグラフ
   */
  public static createPantograph(): THREE.Group {
    const pGroup = new THREE.Group();
    const frameMat = VehicleMeshBuilder.sharedStandard({ color: 0xef4444, metalness: 0.6, roughness: 0.3 });

    const base = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.02, 0.24), frameMat);
    pGroup.add(base);

    const arm1 = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.28), frameMat);
    arm1.rotation.x = Math.PI / 4;
    arm1.position.set(0, 0.1, 0.06);
    pGroup.add(arm1);

    const arm2 = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.28), frameMat);
    arm2.rotation.x = -Math.PI / 4;
    arm2.position.set(0, 0.22, 0.06);
    pGroup.add(arm2);

    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.02, 0.04), frameMat);
    shoe.position.set(0, 0.32, 0);
    pGroup.add(shoe);

    return pGroup;
  }

  /**
   * 電気機関車（EF級）の車体生成（先頭車専用）
   */
  public static createLocomotiveCar(
    modelInfo: VehicleModelInfo
  ): THREE.Group {
    const car = new THREE.Group();
    const length = 1.90;
    const width = 0.74;
    const height = 0.78;

    // ① 機関車メインボディ（ディープブルー）
    const bodyMat = VehicleMeshBuilder.sharedStandard({
      color: modelInfo.bodyColor,
      roughness: 0.35,
      metalness: 0.25
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, length), bodyMat);
    body.position.y = height / 2 + 0.24;
    body.castShadow = true;
    car.add(body);

    // ② 機関車下部フレーム（ダークグレー）
    const underFrameMat = VehicleMeshBuilder.sharedStandard({ color: 0x1e293b, roughness: 0.5 });
    const underFrame = new THREE.Mesh(new THREE.BoxGeometry(width + 0.02, 0.12, length + 0.02), underFrameMat);
    underFrame.position.y = 0.28;
    car.add(underFrame);

    // ③ ゴールド・イエロー警戒ライン（車体側面・前面）
    const stripeMat = VehicleMeshBuilder.sharedStandard({
      color: modelInfo.stripeColor,
      roughness: 0.3
    });
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(width + 0.01, 0.08, length + 0.01), stripeMat);
    stripe.position.y = height / 2 + 0.16;
    car.add(stripe);

    // ④ 屋根上機器・ランボード
    const roofMat = VehicleMeshBuilder.sharedStandard({ color: 0x475569, roughness: 0.5 });
    const roof = new THREE.Mesh(new THREE.BoxGeometry(width - 0.04, 0.09, length), roofMat);
    roof.position.y = height + 0.27;
    car.add(roof);

    // モニター屋根（機器室上部の出っ張り）
    const monitorGeo = new THREE.BoxGeometry(0.38, 0.07, 0.90);
    const monitorMat = VehicleMeshBuilder.sharedStandard({ color: 0x64748b, roughness: 0.4 });
    const monitor = new THREE.Mesh(monitorGeo, monitorMat);
    monitor.position.y = height + 0.34;
    car.add(monitor);

    // 側面機器室エアフィルタールーバー（左右スリット）
    const louverMat = VehicleMeshBuilder.sharedStandard({ color: 0x334155, roughness: 0.6 });
    for (const side of [-width / 2 - 0.005, width / 2 + 0.005]) {
      const louver = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.24, 0.70), louverMat);
      louver.position.set(side, height / 2 + 0.32, 0);
      car.add(louver);
    }

    // ⑤ 前後運転室キャブ造形（前・後）
    const zDirs = [1, -1];
    for (const zDir of zDirs) {
      const faceZ = (length / 2 + 0.01) * zDir;

      // 前面傾斜・フロントブラックマスク
      const frontMaskMat = VehicleMeshBuilder.sharedStandard({ color: 0x0f172a, roughness: 0.3 });
      const frontMask = new THREE.Mesh(new THREE.BoxGeometry(width - 0.02, height * 0.75, 0.04), frontMaskMat);
      frontMask.position.set(0, height / 2 + 0.26, faceZ);
      car.add(frontMask);

      // フロント大型2連窓
      const winMat = VehicleMeshBuilder.sharedStandard({ color: 0x0f172a, metalness: 0.9, roughness: 0.1 });
      const winGeo = new THREE.BoxGeometry(0.25, 0.24, 0.05);
      const winL = new THREE.Mesh(winGeo, winMat);
      winL.position.set(-0.18, height / 2 + 0.38, faceZ + 0.01 * zDir);
      car.add(winL);
      const winR = new THREE.Mesh(winGeo, winMat);
      winR.position.set(0.18, height / 2 + 0.38, faceZ + 0.01 * zDir);
      car.add(winR);

      // 前面V字/ナンバープレート（ゴールド）
      const plateMat = VehicleMeshBuilder.sharedStandard({ color: 0xfbbf24, metalness: 0.6, roughness: 0.3 });
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.06, 0.052), plateMat);
      plate.position.set(0, height / 2 + 0.14, faceZ + 0.01 * zDir);
      car.add(plate);

      // 前照灯（進行方向前照灯：温白色、後部：赤）
      const isFrontFacing = (zDir === 1);
      const lightMat = VehicleMeshBuilder.sharedBasic({ color: isFrontFacing ? 0xfffae0 : 0xef4444 });
      for (const lx of [-0.22, 0.22]) {
        const light = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), lightMat);
        light.position.set(lx, height / 2 + 0.14, faceZ + 0.025 * zDir);
        car.add(light);
      }

      // スカート（排障器・スノープラウ風）
      const skirtMat = VehicleMeshBuilder.sharedStandard({ color: 0x334155, roughness: 0.5 });
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(width - 0.06, 0.14, 0.06), skirtMat);
      skirt.position.set(0, 0.16, faceZ + 0.015 * zDir);
      car.add(skirt);

      // 連結器（黒）
      const couplerMat = VehicleMeshBuilder.sharedStandard({ color: 0x111827, metalness: 0.8 });
      const coupler = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.08, 0.10), couplerMat);
      coupler.position.set(0, 0.15, faceZ + 0.06 * zDir);
      car.add(coupler);
    }

    // ⑥ 屋根上パンタグラフ（機関車らしく前後に2基装備）
    for (const pZ of [-0.60, 0.60]) {
      const panto = this.createPantograph();
      panto.position.set(0, height + 0.33, pZ);
      car.add(panto);
    }

    // ⑦ 2軸ボギー台車×2基
    const wheelMat = VehicleMeshBuilder.sharedStandard({ color: 0x334155, metalness: 0.8, roughness: 0.3 });
    const bogieFrameMat = VehicleMeshBuilder.sharedStandard({ color: 0x1e293b, roughness: 0.7 });

    for (const bz of [-0.58, 0.58]) {
      // 台車枠
      const bogie = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.09, 0.44), bogieFrameMat);
      bogie.position.set(0, 0.13, bz);
      car.add(bogie);

      // 車輪（各台車2軸）
      for (const wz of [-0.14, 0.14]) {
        const wL = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.06, 12), wheelMat);
        wL.rotation.z = Math.PI / 2;
        wL.position.set(-0.35, 0.12, bz + wz);
        car.add(wL);

        const wR = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.06, 12), wheelMat);
        wR.rotation.z = Math.PI / 2;
        wR.position.set(0.35, 0.12, bz + wz);
        car.add(wR);
      }
    }

    return car;
  }

  /**
   * コキ100系コンテナ貨車（2両目以降）
   * @param carIndex 車両インデックス（コンテナ種別のバリエーション生成に使用）
   * @param isRear 編成の最後尾かどうか（後部反射板の装着判定）
   */
  public static createContainerFlatCar(carIndex: number, isRear: boolean): THREE.Group {
    const car = new THREE.Group();
    const length = 1.85;
    const width = 0.68;

    // ① コキ100系ブルーの細身台枠（フラットフレーム）
    const kokiBlueMat = VehicleMeshBuilder.sharedStandard({
      color: 0x1d4ed8, // JR貨物コキ100系ブルー
      roughness: 0.45,
      metalness: 0.3
    });

    // センタートラス梁
    const centerBeam = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.09, length), kokiBlueMat);
    centerBeam.position.y = 0.24;
    centerBeam.castShadow = true;
    car.add(centerBeam);

    // 左右サイドレールフレーム
    const sideFrameL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, length), kokiBlueMat);
    sideFrameL.position.set(-width / 2 + 0.025, 0.25, 0);
    car.add(sideFrameL);

    const sideFrameR = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, length), kokiBlueMat);
    sideFrameR.position.set(width / 2 - 0.025, 0.25, 0);
    car.add(sideFrameR);

    // デッキ床面（横梁リブ）
    const deckMat = VehicleMeshBuilder.sharedStandard({ color: 0x1e3a8a, roughness: 0.6 });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(width, 0.02, length), deckMat);
    deck.position.y = 0.28;
    car.add(deck);

    // 端部手すり・ブレーキハンドル（後端）
    const handrailMat = VehicleMeshBuilder.sharedStandard({ color: 0xf1f5f9, roughness: 0.3 });
    const brakeHandleMat = VehicleMeshBuilder.sharedStandard({ color: 0xf59e0b, roughness: 0.3 });
    const handrail = new THREE.Mesh(new THREE.BoxGeometry(width - 0.08, 0.16, 0.02), handrailMat);
    handrail.position.set(0, 0.36, -length / 2 + 0.02);
    car.add(handrail);
    const brakeWheel = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.02, 8), brakeHandleMat);
    brakeWheel.position.set(0.18, 0.42, -length / 2 + 0.02);
    brakeWheel.rotation.x = Math.PI / 2;
    car.add(brakeWheel);

    // ② 台車（FT1形2軸ボギー台車×2基）
    const wheelMat = VehicleMeshBuilder.sharedStandard({ color: 0x334155, metalness: 0.8, roughness: 0.3 });
    const bogieFrameMat = VehicleMeshBuilder.sharedStandard({ color: 0x1e293b, roughness: 0.7 });

    for (const bz of [-0.58, 0.58]) {
      const bogie = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.07, 0.40), bogieFrameMat);
      bogie.position.set(0, 0.13, bz);
      car.add(bogie);

      for (const wz of [-0.13, 0.13]) {
        const wL = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.05, 12), wheelMat);
        wL.rotation.z = Math.PI / 2;
        wL.position.set(-0.33, 0.11, bz + wz);
        car.add(wL);

        const wR = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.05, 12), wheelMat);
        wR.rotation.z = Math.PI / 2;
        wR.position.set(0.33, 0.11, bz + wz);
        car.add(wR);
      }
    }

    // ③ コンテナ積載（1両につき3個のスロット: z = -0.54, 0.0, 0.54）
    // 実物同様に19Dコンテナ（赤紫/エンジ）、18D（ブルー）、JOT冷蔵（白/水色）などを多彩に積載
    const slotZs = [-0.54, 0.0, 0.54];
    const containerTypes = [
      { name: '19D_maroon', color: 0x831843, stripe: 0xf8fafc }, // JR貨物 19D (エンジ/あずき色)
      { name: '18D_blue', color: 0x1d4ed8, stripe: 0xf8fafc },   // JR貨物 18D (青/白帯)
      { name: 'JOT_cool', color: 0xf1f5f9, stripe: 0x0284c7 },   // JOT 日本石油輸送 (ホワイト/スカイブルー)
      { name: '19G_red', color: 0x991b1b, stripe: 0xfacc15 },    // 19G形 (赤/ゴールド帯)
      { name: 'ventilated', color: 0x1e3a8a, stripe: 0x10b981 }  // 通風コンテナ (濃紺/グリーン帯)
    ];

    const lockMat = VehicleMeshBuilder.sharedStandard({ color: 0xf59e0b, metalness: 0.6, roughness: 0.3 });

    slotZs.forEach((sz, slotIdx) => {
      // 緊締金具（ツイストロック4箇所）のグループ
      const lockGroup = new THREE.Group();
      lockGroup.name = `cargo_lock_${slotIdx}`;
      for (const lx of [-0.26, 0.26]) {
        for (const lz of [-0.20, 0.20]) {
          const lock = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.04), lockMat);
          lock.position.set(lx, 0.30, sz + lz);
          lockGroup.add(lock);
        }
      }
      lockGroup.visible = true; // 初期は空荷なので金具が見える
      car.add(lockGroup);

      // コンテナボックス本体
      const typeIndex = (carIndex * 3 + slotIdx) % containerTypes.length;
      const cType = containerTypes[typeIndex];
      const containerMesh = this.createContainerBox(cType.color, cType.stripe);
      containerMesh.name = `cargo_container_${slotIdx}`;
      containerMesh.position.set(0, 0.29 + 0.44 / 2, sz);
      containerMesh.visible = false; // 購入時は0個（空荷）
      car.add(containerMesh);
    });

    // ④ 最後尾車両の場合：赤色丸形後部標識板（JR貨物特有のリアルな反射板）
    if (isRear) {
      const plateMat = VehicleMeshBuilder.sharedBasic({ color: 0xef4444 });
      const rimMat = VehicleMeshBuilder.sharedStandard({ color: 0xf8fafc, roughness: 0.3 });

      for (const rx of [-0.24, 0.24]) {
        // 白い縁取りリング
        const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.015, 12), rimMat);
        rim.rotation.x = Math.PI / 2;
        rim.position.set(rx, 0.38, -length / 2 - 0.015);
        car.add(rim);

        // 赤色反射板本体
        const reflector = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 12), plateMat);
        reflector.rotation.x = Math.PI / 2;
        reflector.position.set(rx, 0.38, -length / 2 - 0.02);
        car.add(reflector);
      }
    }

    return car;
  }

  /**
   * JR 12ft コンテナ単体のメッシュ生成
   */
  public static createContainerBox(color: number, stripeColor: number): THREE.Group {
    const container = new THREE.Group();
    const cWidth = 0.62;
    const cHeight = 0.44;
    const cLength = 0.50;

    // コンテナ本体ボックス
    const boxMat = VehicleMeshBuilder.sharedStandard({
      color,
      roughness: 0.4,
      metalness: 0.15
    });
    const box = new THREE.Mesh(new THREE.BoxGeometry(cWidth, cHeight, cLength), boxMat);
    box.castShadow = true;
    container.add(box);

    // コンテナ帯ライン（JR貨物ロゴ・ライン）
    const stripeMat = VehicleMeshBuilder.sharedStandard({
      color: stripeColor,
      roughness: 0.3
    });
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(cWidth + 0.005, 0.07, cLength + 0.005), stripeMat);
    stripe.position.y = 0.04;
    container.add(stripe);

    // コーナーキャスティング金具（四隅の黒金物ディテール）
    const cornerMat = VehicleMeshBuilder.sharedStandard({ color: 0x0f172a, roughness: 0.5 });
    for (const cx of [-cWidth / 2, cWidth / 2]) {
      for (const cy of [-cHeight / 2 + 0.03, cHeight / 2 - 0.03]) {
        for (const cz of [-cLength / 2, cLength / 2]) {
          const corner = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, 0.03), cornerMat);
          corner.position.set(cx, cy, cz);
          container.add(corner);
        }
      }
    }

    return container;
  }

  /**
   * 貨物列車の積載コンテナ数（cargoLoad）に応じて、各貨車のコンテナ描写と緊締金具の表示/非表示を更新する
   * @param cars 編成全体の車両グループ配列 (先頭のcars[0]は機関車、cars[1...]がコンテナ貨車)
   * @param cargoLoad 現在の積載コンテナ数 (0 〜 capacity)
   */
  public static updateTrainCargoVisual(cars: THREE.Group[], cargoLoad: number): void {
    let remaining = Math.max(0, cargoLoad);
    for (const car of cars) {
      // コンテナスロット（cargo_container_0 または cargo_lock_0）を持つ貨車のみ処理
      if (!car.getObjectByName('cargo_container_0') && !car.getObjectByName('cargo_lock_0')) {
        continue;
      }
      for (let s = 0; s < 3; s++) {
        const container = car.getObjectByName(`cargo_container_${s}`);
        const lock = car.getObjectByName(`cargo_lock_${s}`);
        const hasContainer = remaining > 0;
        if (container) {
          container.visible = hasContainer;
        }
        if (lock) {
          lock.visible = !hasContainer;
        }
        if (hasContainer) {
          remaining--;
        }
      }
    }
  }
}

