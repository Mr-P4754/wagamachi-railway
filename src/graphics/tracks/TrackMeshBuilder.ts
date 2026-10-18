import * as THREE from 'three';
import { GameMaterials } from '../materials';

/**
 * 軌道・線路・分岐器・構造物メッシュ生成ビルダー
 */
export class TrackMeshBuilder {
  private static readonly DIR_IDX_VEC: { x: number; z: number }[] = [
    { x: 0, z: -1 }, // 0: 北 (N)
    { x: 1, z: 0 },  // 1: 東 (E)
    { x: 0, z: 1 },  // 2: 南 (S)
    { x: -1, z: 0 }  // 3: 西 (W)
  ];

  private static readonly CURVE_DIR_INDICES: Record<'N_E' | 'E_S' | 'S_W' | 'W_N', [number, number]> = {
    N_E: [0, 1], E_S: [1, 2], S_W: [2, 3], W_N: [3, 0]
  };

  /**
   * 直線地上線路の生成
   */
  public static createGroundTrack(rotation: number = 0, hasPole: boolean = false): THREE.Group {
    const group = new THREE.Group();

    // 道床バラスト
    const ballastGeo = new THREE.BoxGeometry(1.6, 0.16, 2.0);
    const ballast = new THREE.Mesh(ballastGeo, GameMaterials.ballastMat);
    ballast.position.y = 0.08;
    ballast.receiveShadow = true;
    group.add(ballast);

    // 枕木 (5本)
    const sleeperGeo = new THREE.BoxGeometry(1.4, 0.08, 0.16);
    for (let i = 0; i < 5; i++) {
      const sleeper = new THREE.Mesh(sleeperGeo, GameMaterials.sleeperMat);
      sleeper.position.set(0, 0.18, (i / 4 - 0.5) * 1.5);
      sleeper.castShadow = true;
      group.add(sleeper);
    }

    // レール左右2本
    const railGeo = new THREE.BoxGeometry(0.06, 0.1, 2.0);
    const railL = new THREE.Mesh(railGeo, GameMaterials.railMat);
    railL.position.set(-0.45, 0.24, 0);
    railL.castShadow = true;
    group.add(railL);

    const railR = new THREE.Mesh(railGeo, GameMaterials.railMat);
    railR.position.set(0.45, 0.24, 0);
    railR.castShadow = true;
    group.add(railR);

    if (hasPole) {
      group.add(this.createCatenaryPole());
    }

    if (rotation === 1) {
      group.rotation.y = Math.PI / 2;
    }
    return group;
  }

  /**
   * 高架直線線路の生成
   */
  public static createElevatedTrack(
    rotation: number = 0,
    showPier: boolean = true,
    pierHeight: number = 3.0
  ): THREE.Group {
    const group = new THREE.Group();

    if (showPier && pierHeight > 0) {
      const pierGeo = new THREE.BoxGeometry(0.8, pierHeight, 0.8);
      const pier = new THREE.Mesh(pierGeo, GameMaterials.concreteMat);
      pier.position.y = -pierHeight / 2;
      pier.castShadow = true;
      group.add(pier);
    }

    const deckGeo = new THREE.BoxGeometry(2.0, 0.35, 2.0);
    const deck = new THREE.Mesh(deckGeo, GameMaterials.concreteMat);
    deck.position.y = 0.175;
    deck.receiveShadow = true;
    group.add(deck);

    const wallGeo = new THREE.BoxGeometry(0.12, 0.65, 2.0);
    const wallL = new THREE.Mesh(wallGeo, GameMaterials.concreteMat);
    wallL.position.set(-0.94, 0.45, 0);
    group.add(wallL);

    const wallR = new THREE.Mesh(wallGeo, GameMaterials.concreteMat);
    wallR.position.set(0.94, 0.45, 0);
    group.add(wallR);

    const sleeperGeo = new THREE.BoxGeometry(1.3, 0.06, 0.16);
    for (let i = 0; i < 5; i++) {
      const sleeper = new THREE.Mesh(sleeperGeo, GameMaterials.sleeperMat);
      sleeper.position.set(0, 0.38, (i / 4 - 0.5) * 1.5);
      group.add(sleeper);
    }

    const railGeo = new THREE.BoxGeometry(0.06, 0.08, 2.0);
    const railL = new THREE.Mesh(railGeo, GameMaterials.railMat);
    railL.position.set(-0.45, 0.44, 0);
    group.add(railL);

    const railR = new THREE.Mesh(railGeo, GameMaterials.railMat);
    railR.position.set(0.45, 0.44, 0);
    group.add(railR);

    if (rotation === 1) {
      group.rotation.y = Math.PI / 2;
    }
    return group;
  }

  /**
   * 円弧曲線レール用枕木・軌条の追加（共用内部関数）
   */
  public static addCurveRails(group: THREE.Group, idxA: number, idxB: number, baseHeight: number, sleeperCount: number = 3): void {
    const vA = this.DIR_IDX_VEC[idxA];
    const vB = this.DIR_IDX_VEC[idxB];
    const cx = vA.x + vB.x;
    const cz = vA.z + vB.z;

    const edgeAngle = (v: { x: number; z: number }) => Math.atan2(v.z - cz, v.x - cx);
    let a1 = edgeAngle(vA);
    let a2 = edgeAngle(vB);
    let diff = a2 - a1;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    a2 = a1 + diff;

    for (let i = 0; i < sleeperCount; i++) {
      const theta = a1 + ((i + 0.5) / sleeperCount) * (a2 - a1);
      const sleeper = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.08, 0.18), GameMaterials.sleeperMat);
      sleeper.position.set(cx + Math.cos(theta) * 1.0, baseHeight + 0.18, cz + Math.sin(theta) * 1.0);
      sleeper.rotation.y = -theta;
      group.add(sleeper);
    }

    const railPtsInner: THREE.Vector3[] = [];
    const railPtsOuter: THREE.Vector3[] = [];
    const steps = 8;
    const rInner = 1 - 0.45;
    const rOuter = 1 + 0.45;
    for (let s = 0; s <= steps; s++) {
      const t = a1 + (s / steps) * (a2 - a1);
      railPtsInner.push(new THREE.Vector3(cx + Math.cos(t) * rInner, baseHeight + 0.24, cz + Math.sin(t) * rInner));
      railPtsOuter.push(new THREE.Vector3(cx + Math.cos(t) * rOuter, baseHeight + 0.24, cz + Math.sin(t) * rOuter));
    }

    const tubeGeoIn = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railPtsInner), 10, 0.035, 6, false);
    const tubeGeoOut = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railPtsOuter), 10, 0.035, 6, false);
    group.add(new THREE.Mesh(tubeGeoIn, GameMaterials.railMat));
    group.add(new THREE.Mesh(tubeGeoOut, GameMaterials.railMat));
  }

  /**
   * 曲線レールセグメント（地上・高架・トンネル）
   */
  public static createCurveTrackSegment(
    curveDir: 'N_E' | 'E_S' | 'S_W' | 'W_N',
    isElevated: boolean = false,
    pierHeight: number = 3.0,
    isTunnel: boolean = false
  ): THREE.Group {
    const group = new THREE.Group();
    const railBaseHeight = isElevated ? 0.2 : (isTunnel ? 0.05 : 0);

    if (isElevated) {
      if (pierHeight > 0) {
        const pierGeo = new THREE.BoxGeometry(0.7, pierHeight, 0.7);
        const pier = new THREE.Mesh(pierGeo, GameMaterials.concreteMat);
        pier.position.y = -pierHeight / 2;
        group.add(pier);
      }

      const deckGeo = new THREE.BoxGeometry(2.0, 0.35, 2.0);
      const deck = new THREE.Mesh(deckGeo, GameMaterials.concreteMat);
      deck.position.y = 0.175;
      group.add(deck);
    } else if (isTunnel) {
      // トンネル道床・コンクリートスラブ
      const slabGeo = new THREE.BoxGeometry(1.95, 0.2, 1.95);
      const slab = new THREE.Mesh(slabGeo, GameMaterials.concreteMat);
      slab.position.y = 0.1;
      slab.receiveShadow = true;
      group.add(slab);

      // 曲線に沿ったシールドトンネル円弧側壁・アーチリブ
      const [idxA, idxB] = this.CURVE_DIR_INDICES[curveDir];
      const vA = this.DIR_IDX_VEC[idxA];
      const vB = this.DIR_IDX_VEC[idxB];
      const cx = vA.x + vB.x;
      const cz = vA.z + vB.z;

      const edgeAngle = (v: { x: number; z: number }) => Math.atan2(v.z - cz, v.x - cx);
      let a1 = edgeAngle(vA);
      let a2 = edgeAngle(vB);
      let diff = a2 - a1;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      a2 = a1 + diff;

      // 外側側壁（r = 1.65）
      const rOuterWall = 1.65;
      for (let s = 0; s < 4; s++) {
        const theta = a1 + ((s + 0.5) / 4) * (a2 - a1);
        const wallPiece = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.4, 0.7), GameMaterials.concreteMat);
        wallPiece.position.set(cx + Math.cos(theta) * rOuterWall, 0.8, cz + Math.sin(theta) * rOuterWall);
        wallPiece.rotation.y = -theta;
        group.add(wallPiece);
      }

      // 天井アーチリブ梁（3箇所）
      const ribGeo = new THREE.BoxGeometry(1.88, 0.15, 0.35);
      for (let s = 0; s < 3; s++) {
        const theta = a1 + ((s + 0.5) / 3) * (a2 - a1);
        const rib = new THREE.Mesh(ribGeo, GameMaterials.concreteMat);
        rib.position.set(cx + Math.cos(theta) * 1.0, 1.5, cz + Math.sin(theta) * 1.0);
        rib.rotation.y = -theta;
        group.add(rib);
      }
    } else {
      const bedGeo = new THREE.BoxGeometry(1.9, 0.16, 1.9);
      const bed = new THREE.Mesh(bedGeo, GameMaterials.ballastMat);
      bed.position.y = 0.08;
      group.add(bed);
    }

    const [idxA, idxB] = this.CURVE_DIR_INDICES[curveDir];
    this.addCurveRails(group, idxA, idxB, railBaseHeight);

    return group;
  }

  /**
   * 分岐器ハブ（ポイント）
   */
  public static createSwitchHub(
    forward: number = 0,
    isDiverged: boolean = false,
    isElevated: boolean = false,
    branchSide: 'left' | 'right' = 'right',
    pierHeight: number = 3.0,
    isTunnel: boolean = false
  ): THREE.Group {
    const group = new THREE.Group();
    const railBaseHeight = isElevated ? 0.2 : (isTunnel ? 0.05 : 0);
    const back = (forward + 2) % 4;
    const branchDir = branchSide === 'left' ? (forward + 3) % 4 : (forward + 1) % 4;
    const axisRotation = (forward === 1 || forward === 3) ? 1 : 0;

    const baseTrack = isElevated
      ? this.createElevatedTrack(axisRotation, true, pierHeight)
      : (isTunnel
        ? this.createTunnelTrack(axisRotation)
        : this.createGroundTrack(axisRotation, false));
    group.add(baseTrack);

    this.addCurveRails(group, back, branchDir, railBaseHeight, 2);

    const branchVec = this.DIR_IDX_VEC[branchDir];
    const boxGeo = new THREE.BoxGeometry(0.25, 0.3, 0.35);
    const switchBoxMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, metalness: 0.5 });
    const switchBox = new THREE.Mesh(boxGeo, switchBoxMat);
    switchBox.position.set(branchVec.x * 0.75, railBaseHeight + 0.2, branchVec.z * 0.75);
    group.add(switchBox);

    const lampMat = new THREE.MeshBasicMaterial({ color: isDiverged ? 0xf59e0b : 0x10b981 });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), lampMat);
    lamp.position.set(branchVec.x * 0.75, railBaseHeight + 0.42, branchVec.z * 0.75);
    lamp.userData.isSwitchLamp = true;
    group.add(lamp);

    // 開通方向を示す発光シェブロン矢印インジケーター（直進＝双方向矢印、分岐＝単方向矢印）
    // ① 双方向矢印（直進開通時用：前後に鏃を持つ形状）
    const biArrowShape = new THREE.Shape();
    biArrowShape.moveTo(0, 0.40);
    biArrowShape.lineTo(0.20, 0.18);
    biArrowShape.lineTo(0.08, 0.20);
    biArrowShape.lineTo(0.08, -0.20);
    biArrowShape.lineTo(0.20, -0.18);
    biArrowShape.lineTo(0, -0.40);
    biArrowShape.lineTo(-0.20, -0.18);
    biArrowShape.lineTo(-0.08, -0.20);
    biArrowShape.lineTo(-0.08, 0.20);
    biArrowShape.lineTo(-0.20, 0.18);
    biArrowShape.closePath();
    const biArrowGeo = new THREE.ShapeGeometry(biArrowShape);
    biArrowGeo.rotateX(-Math.PI / 2);

    const biBgShape = new THREE.Shape();
    biBgShape.moveTo(0, 0.46);
    biBgShape.lineTo(0.26, 0.14);
    biBgShape.lineTo(0.13, 0.16);
    biBgShape.lineTo(0.13, -0.16);
    biBgShape.lineTo(0.26, -0.14);
    biBgShape.lineTo(0, -0.46);
    biBgShape.lineTo(-0.26, -0.14);
    biBgShape.lineTo(-0.13, -0.16);
    biBgShape.lineTo(-0.13, 0.16);
    biBgShape.lineTo(-0.26, 0.14);
    biBgShape.closePath();
    const biBgGeo = new THREE.ShapeGeometry(biBgShape);
    biBgGeo.rotateX(-Math.PI / 2);
    const bgMat = new THREE.MeshBasicMaterial({ color: 0x0f172a, side: THREE.DoubleSide });

    const straightArrowGroup = new THREE.Group();
    straightArrowGroup.userData.isStraightArrow = true;
    const biBgMesh = new THREE.Mesh(biBgGeo, bgMat);
    biBgMesh.position.y = -0.01;
    const biArrowMat = new THREE.MeshBasicMaterial({ color: 0x10b981, side: THREE.DoubleSide });
    const biArrowMesh = new THREE.Mesh(biArrowGeo, biArrowMat);
    straightArrowGroup.add(biBgMesh);
    straightArrowGroup.add(biArrowMesh);

    // ② 単方向矢印（分岐開通時用：先端に鏃を持つ形状）
    const uniArrowShape = new THREE.Shape();
    uniArrowShape.moveTo(0, 0.38);
    uniArrowShape.lineTo(0.22, 0.04);
    uniArrowShape.lineTo(0.10, 0.08);
    uniArrowShape.lineTo(0.10, -0.28);
    uniArrowShape.lineTo(-0.10, -0.28);
    uniArrowShape.lineTo(-0.10, 0.08);
    uniArrowShape.lineTo(-0.22, 0.04);
    uniArrowShape.closePath();
    const uniArrowGeo = new THREE.ShapeGeometry(uniArrowShape);
    uniArrowGeo.rotateX(-Math.PI / 2);

    const uniBgShape = new THREE.Shape();
    uniBgShape.moveTo(0, 0.44);
    uniBgShape.lineTo(0.28, 0.00);
    uniBgShape.lineTo(0.14, 0.04);
    uniBgShape.lineTo(0.14, -0.34);
    uniBgShape.lineTo(-0.14, -0.34);
    uniBgShape.lineTo(-0.14, 0.04);
    uniBgShape.lineTo(-0.28, 0.00);
    uniBgShape.closePath();
    const uniBgGeo = new THREE.ShapeGeometry(uniBgShape);
    uniBgGeo.rotateX(-Math.PI / 2);

    const divergeArrowGroup = new THREE.Group();
    divergeArrowGroup.userData.isDivergeArrow = true;
    const uniBgMesh = new THREE.Mesh(uniBgGeo, bgMat);
    uniBgMesh.position.y = -0.01;
    const uniArrowMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b, side: THREE.DoubleSide });
    const uniArrowMesh = new THREE.Mesh(uniArrowGeo, uniArrowMat);
    divergeArrowGroup.add(uniBgMesh);
    divergeArrowGroup.add(uniArrowMesh);

    straightArrowGroup.visible = !isDiverged;
    divergeArrowGroup.visible = isDiverged;

    const forwardVec = this.DIR_IDX_VEC[forward];
    const forwardAngle = Math.atan2(forwardVec.x, -forwardVec.z);
    const branchAngle = Math.atan2(branchVec.x, -branchVec.z);

    const arrowGroup = new THREE.Group();
    arrowGroup.userData.isSwitchArrow = true;
    arrowGroup.userData.forwardAngle = forwardAngle;
    arrowGroup.userData.branchAngle = branchAngle;
    arrowGroup.position.set(0, railBaseHeight + 0.48, 0);
    arrowGroup.rotation.y = isDiverged ? branchAngle : forwardAngle;

    arrowGroup.add(straightArrowGroup);
    arrowGroup.add(divergeArrowGroup);
    group.add(arrowGroup);

    return group;
  }

  /**
   * 分岐器メッシュ全体を再生成せず、インジケーターランプおよび開通矢印の向き・色・形状を高速更新する
   */
  public static updateSwitchHubState(group: THREE.Object3D, isDiverged: boolean): boolean {
    let updated = false;
    const targetColor = isDiverged ? 0xf59e0b : 0x10b981;
    group.traverse(child => {
      if (child instanceof THREE.Mesh && child.userData.isSwitchLamp) {
        const mat = child.material as THREE.MeshBasicMaterial;
        if (mat && mat.color) {
          mat.color.setHex(targetColor);
          updated = true;
        }
      }
      if (child.userData && child.userData.isSwitchArrow) {
        child.rotation.y = isDiverged ? child.userData.branchAngle : child.userData.forwardAngle;
        child.traverse(gc => {
          if (gc.userData && gc.userData.isStraightArrow !== undefined) {
            gc.visible = !isDiverged;
          } else if (gc.userData && gc.userData.isDivergeArrow !== undefined) {
            gc.visible = isDiverged;
          }
        });
        updated = true;
      }
    });
    return updated;
  }

  /**
   * シーサスクロッシング（2×2複線交差分岐の1マス）
   */
  public static createScissorsCrossingTile(
    along: number,
    role: 0 | 1 | 2 | 3,
    isElevated: boolean = false,
    crossingState: 'straight' | 'cross-a' | 'cross-b' = 'straight',
    pierHeight: number = 3.0,
    isTunnel: boolean = false
  ): THREE.Group {
    const group = new THREE.Group();
    const railBaseHeight = isElevated ? 0.2 : (isTunnel ? 0.05 : 0);
    const isEastWest = (along === 1 || along === 3);

    const baseTrack = isElevated
      ? this.createElevatedTrack(0, true, pierHeight)
      : (isTunnel
        ? this.createTunnelTrack(0)
        : this.createGroundTrack(0, false));
    group.add(baseTrack);

    let pStart: THREE.Vector2;
    let pEnd: THREE.Vector2;

    switch (role) {
      case 0:
        pStart = new THREE.Vector2(0, -0.6);
        pEnd = new THREE.Vector2(-1.0, 1.0);
        break;
      case 1:
        pStart = new THREE.Vector2(-1.0, -1.0);
        pEnd = new THREE.Vector2(0, 0.6);
        break;
      case 2:
        pStart = new THREE.Vector2(0, -0.6);
        pEnd = new THREE.Vector2(1.0, 1.0);
        break;
      case 3:
        pStart = new THREE.Vector2(1.0, -1.0);
        pEnd = new THREE.Vector2(0, 0.6);
        break;
    }

    const dir = new THREE.Vector2().subVectors(pEnd, pStart);
    const dirNorm = dir.clone().normalize();
    const norm = new THREE.Vector2(-dirNorm.y, dirNorm.x);
    const halfGauge = 0.45;

    const sleeperCount = 4;
    const sleeperGeo = new THREE.BoxGeometry(1.3, 0.08, 0.16);
    const angle = Math.atan2(dirNorm.y, dirNorm.x);
    for (let i = 0; i < sleeperCount; i++) {
      const t = (i + 0.5) / sleeperCount;
      const sp = new THREE.Vector2().lerpVectors(pStart, pEnd, t);
      const sleeper = new THREE.Mesh(sleeperGeo, GameMaterials.sleeperMat);
      sleeper.position.set(sp.x, railBaseHeight + 0.18, sp.y);
      sleeper.rotation.y = -angle + Math.PI / 2;
      sleeper.castShadow = true;
      group.add(sleeper);
    }

    const railY = railBaseHeight + 0.24;
    for (const side of [-1, 1]) {
      const rStart = pStart.clone().addScaledVector(norm, side * halfGauge);
      const rEnd = pEnd.clone().addScaledVector(norm, side * halfGauge);
      const railPts = [
        new THREE.Vector3(rStart.x, railY, rStart.y),
        new THREE.Vector3(rEnd.x, railY, rEnd.y)
      ];
      const tubeGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railPts), 6, 0.035, 6, false);
      const railMesh = new THREE.Mesh(tubeGeo, GameMaterials.railMat);
      railMesh.castShadow = true;
      group.add(railMesh);
    }

    const frogGeo = new THREE.BoxGeometry(0.08, 0.08, 0.35);
    const frog1 = new THREE.Mesh(frogGeo, GameMaterials.railMat);
    const nearCorner = new THREE.Vector2().lerpVectors(pStart, pEnd, (role === 0 || role === 2) ? 0.85 : 0.15);
    frog1.position.set(nearCorner.x, railY + 0.01, nearCorner.y);
    frog1.rotation.y = -angle;
    group.add(frog1);

    if (role === 0 || role === 2) {
      const colors: Record<string, number> = {
        straight: 0x10b981,
        'cross-a': role === 0 ? 0xf59e0b : 0x10b981,
        'cross-b': role === 2 ? 0xf59e0b : 0x10b981
      };
      const lampColor = colors[crossingState] ?? 0x10b981;

      const signGroup = new THREE.Group();
      const mastGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.6, 6);
      const mast = new THREE.Mesh(mastGeo, GameMaterials.poleMat);
      mast.position.y = railBaseHeight + 0.3;
      signGroup.add(mast);

      const lampGeo = new THREE.SphereGeometry(0.09, 8, 8);
      const lampMat = new THREE.MeshBasicMaterial({ color: lampColor });
      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.y = railBaseHeight + 0.62;
      lamp.userData.isScissorsLamp = true;
      lamp.userData.crossingRole = role;
      signGroup.add(lamp);

      const signX = role === 0 ? 0.75 : -0.75;
      signGroup.position.set(signX, 0, -0.6);
      group.add(signGroup);
    }

    if (isEastWest) {
      group.rotation.y = Math.PI / 2;
    }
    return group;
  }

  /**
   * シーサスクロッシングのメッシュ全体を再生成せず、インジケーターランプの色のみを高速更新する
   */
  public static updateScissorsCrossingTileState(
    group: THREE.Object3D,
    role: 0 | 1 | 2 | 3,
    crossingState: 'straight' | 'cross-a' | 'cross-b'
  ): boolean {
    if (role !== 0 && role !== 2) return true;
    const colors: Record<string, number> = {
      straight: 0x10b981,
      'cross-a': role === 0 ? 0xf59e0b : 0x10b981,
      'cross-b': role === 2 ? 0xf59e0b : 0x10b981
    };
    const lampColor = colors[crossingState] ?? 0x10b981;
    let updated = false;
    group.traverse(child => {
      if (child instanceof THREE.Mesh && child.userData.isScissorsLamp) {
        const mat = child.material as THREE.MeshBasicMaterial;
        if (mat && mat.color) {
          mat.color.setHex(lampColor);
          updated = true;
        }
      }
    });
    return updated;
  }

  /**
   * 踏切（道路と線路の平面交差）
   */
  public static createLevelCrossing(railAxis: number = 0): THREE.Group {
    const group = new THREE.Group();

    // 道路面（アスファルト＋白線＋歩道）
    const roadGroup = new THREE.Group();
    const road = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.05, 2.0), GameMaterials.asphaltMat);
    road.position.y = 0.025;
    road.receiveShadow = true;
    roadGroup.add(road);

    const lineGeo = new THREE.PlaneGeometry(0.08, 0.6);
    for (let i = -1; i <= 1; i++) {
      const line = new THREE.Mesh(lineGeo, GameMaterials.roadLineMat);
      line.rotation.x = -Math.PI / 2;
      line.position.set(0, 0.052, i * 0.75);
      roadGroup.add(line);
    }

    const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 2.0), GameMaterials.sidewalkMat);
    sideL.position.set(-0.9, 0.04, 0);
    roadGroup.add(sideL);

    const sideR = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 2.0), GameMaterials.sidewalkMat);
    sideR.position.set(0.9, 0.04, 0);
    roadGroup.add(sideR);

    if (railAxis === 0) {
      roadGroup.rotation.y = Math.PI / 2;
    }
    group.add(roadGroup);

    // 線路面
    const railGroup = new THREE.Group();
    const railGeo = new THREE.BoxGeometry(0.06, 0.06, 2.0);
    for (const off of [-0.45, 0.45]) {
      const rail = new THREE.Mesh(railGeo, GameMaterials.railMat);
      rail.position.set(off, 0.1, 0);
      railGroup.add(rail);
    }
    if (railAxis === 1) railGroup.rotation.y = Math.PI / 2;
    group.add(railGroup);

    // 警報機・警戒帯
    const decorGroup = new THREE.Group();
    const stripeMat = new THREE.MeshBasicMaterial({ color: 0xfacc15 });
    for (const s of [-0.85, 0.85]) {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 1.9), stripeMat);
      stripe.rotation.x = -Math.PI / 2;
      stripe.position.set(0, 0.055, s);
      decorGroup.add(stripe);
    }
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.5 });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
    for (const corner of [{ x: -0.95, z: -0.95 }, { x: 0.95, z: 0.95 }]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 1.0, 8), poleMat);
      pole.position.set(corner.x, 0.5, corner.z);
      decorGroup.add(pole);

      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), lampMat);
      lamp.position.set(corner.x, 0.95, corner.z);
      decorGroup.add(lamp);
    }
    if (railAxis === 1) decorGroup.rotation.y = Math.PI / 2;
    group.add(decorGroup);

    return group;
  }

  /**
   * 勾配線路（4マス単位のスロープユニット）
   */
  public static createSlopeTrackPart(rotation: number = 0, reversed: boolean = false, part: number = 0): THREE.Group {
    const group = new THREE.Group();
    const totalHeight = 3.0;
    const partRise = totalHeight / 4;
    const centerY = (part + 0.5) * partRise;
    const pitch = Math.atan2(partRise, 2.0);

    const axisSign = rotation === 1 ? 1 : -1;
    const localPitch = (reversed ? -axisSign : axisSign) * pitch;

    const bedGeo = new THREE.BoxGeometry(2.0, 0.4, 2.05);
    const bed = new THREE.Mesh(bedGeo, GameMaterials.concreteMat);
    bed.position.set(0, centerY, 0);
    bed.rotation.x = localPitch;
    group.add(bed);

    const pierHeight = Math.max(centerY, 0.15);
    const pierGeo = new THREE.BoxGeometry(0.7, pierHeight, 0.7);
    const pier = new THREE.Mesh(pierGeo, GameMaterials.concreteMat);
    pier.position.set(0, pierHeight / 2, 0);
    group.add(pier);

    const railGeo = new THREE.BoxGeometry(0.06, 0.08, 2.05);
    const railL = new THREE.Mesh(railGeo, GameMaterials.railMat);
    railL.position.set(-0.45, centerY + 0.25, 0);
    railL.rotation.x = localPitch;
    group.add(railL);

    const railR = new THREE.Mesh(railGeo, GameMaterials.railMat);
    railR.position.set(0.45, centerY + 0.25, 0);
    railR.rotation.x = localPitch;
    group.add(railR);

    if (rotation === 1) {
      group.rotation.y = Math.PI / 2;
    }
    return group;
  }

  /**
   * 地下勾配線路（地上から地下へ潜る4マス単位のスロープユニット）
   */
  public static createUndergroundSlopeTrackPart(rotation: number = 0, reversed: boolean = false, part: number = 0): THREE.Group {
    const group = new THREE.Group();
    const totalHeight = 3.0;
    const partRise = totalHeight / 4;
    const centerY = - (part + 0.5) * partRise;
    const pitch = Math.atan2(partRise, 2.0);

    const axisSign = rotation === 1 ? 1 : -1;
    const localPitch = (reversed ? axisSign : -axisSign) * pitch;

    // 掘割の道床（下り坂のコンクリート床）
    const bedGeo = new THREE.BoxGeometry(1.8, 0.3, 2.05);
    const bed = new THREE.Mesh(bedGeo, GameMaterials.concreteMat);
    bed.position.set(0, centerY, 0);
    bed.rotation.x = localPitch;
    group.add(bed);

    // 左右の擁壁（地表0mまで伸びる側壁）
    const wallH = Math.max(0.6, Math.abs(centerY) + 0.4);
    const wallGeo = new THREE.BoxGeometry(0.15, wallH, 2.05);
    const wallL = new THREE.Mesh(wallGeo, GameMaterials.concreteMat);
    wallL.position.set(-0.95, -wallH / 2 + 0.2, 0);
    group.add(wallL);

    const wallR = new THREE.Mesh(wallGeo, GameMaterials.concreteMat);
    wallR.position.set(0.95, -wallH / 2 + 0.2, 0);
    group.add(wallR);

    // レール
    const railGeo = new THREE.BoxGeometry(0.06, 0.08, 2.05);
    const railL = new THREE.Mesh(railGeo, GameMaterials.railMat);
    railL.position.set(-0.45, centerY + 0.2, 0);
    railL.rotation.x = localPitch;
    group.add(railL);

    const railR = new THREE.Mesh(railGeo, GameMaterials.railMat);
    railR.position.set(0.45, centerY + 0.2, 0);
    railR.rotation.x = localPitch;
    group.add(railR);

    // Part 1 にトンネル坑口ポータルを配置
    if (part === 1) {
      const portalMat = GameMaterials.concreteMat;
      const portalRoof = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.4, 0.4), portalMat);
      portalRoof.position.set(0, 0.2, 0);
      group.add(portalRoof);

      const eave = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.1, 0.6), portalMat);
      eave.position.set(0, 0.4, 0);
      group.add(eave);
    }

    if (rotation === 1) {
      group.rotation.y = Math.PI / 2;
    }
    return group;
  }

  /**
   * シールドトンネル・地下線路の生成（地下B1F〜B2Fおよび山岳トンネル用）
   */
  public static createTunnelTrack(rotation: number = 0, portalEnds?: { start?: boolean; end?: boolean }): THREE.Group {
    const group = new THREE.Group();

    // トンネル道床・コンクリートスラブ
    const slabGeo = new THREE.BoxGeometry(1.8, 0.2, 2.0);
    const slab = new THREE.Mesh(slabGeo, GameMaterials.concreteMat);
    slab.position.y = 0.1;
    slab.receiveShadow = true;
    group.add(slab);

    // シールドトンネルの円弧側壁
    const wallGeo = new THREE.BoxGeometry(0.18, 1.4, 2.0);
    const wallL = new THREE.Mesh(wallGeo, GameMaterials.concreteMat);
    wallL.position.set(-0.85, 0.8, 0);
    group.add(wallL);

    const wallR = new THREE.Mesh(wallGeo, GameMaterials.concreteMat);
    wallR.position.set(0.85, 0.8, 0);
    group.add(wallR);

    // 天井アーチリブ（内部の列車・線路を常時視認できるよう開口部を持たせたシールド梁）
    const ribGeo = new THREE.BoxGeometry(1.88, 0.15, 0.35);
    for (let i = -0.7; i <= 0.7; i += 0.7) {
      const rib = new THREE.Mesh(ribGeo, GameMaterials.concreteMat);
      rib.position.set(0, 1.5, i);
      group.add(rib);
    }

    // レール左右2本
    const railGeo = new THREE.BoxGeometry(0.06, 0.1, 2.0);
    const railL = new THREE.Mesh(railGeo, GameMaterials.railMat);
    railL.position.set(-0.45, 0.25, 0);
    group.add(railL);

    const railR = new THREE.Mesh(railGeo, GameMaterials.railMat);
    railR.position.set(0.45, 0.25, 0);
    group.add(railR);

    // 山岳トンネル坑口ポータル（出入り口のコンクリート坑門・額縁・庇）
    const addPortal = (zPos: number) => {
      const portalMat = GameMaterials.concreteMat;
      const portalGroup = new THREE.Group();

      // 左右の重厚な側柱
      const pWallGeo = new THREE.BoxGeometry(0.24, 1.6, 0.35);
      const pWallL = new THREE.Mesh(pWallGeo, portalMat);
      pWallL.position.set(-0.95, 0.8, zPos);
      pWallL.castShadow = true;
      portalGroup.add(pWallL);

      const pWallR = new THREE.Mesh(pWallGeo, portalMat);
      pWallR.position.set(0.95, 0.8, zPos);
      pWallR.castShadow = true;
      portalGroup.add(pWallR);

      // 上部額縁（アーチ上部梁）
      const pTopGeo = new THREE.BoxGeometry(2.14, 0.35, 0.35);
      const pTop = new THREE.Mesh(pTopGeo, portalMat);
      pTop.position.set(0, 1.5, zPos);
      pTop.castShadow = true;
      portalGroup.add(pTop);

      // 上部の庇（eave: 雨除け・土留め）
      const eaveGeo = new THREE.BoxGeometry(2.26, 0.12, 0.55);
      const eave = new THREE.Mesh(eaveGeo, portalMat);
      eave.position.set(0, 1.7, zPos);
      eave.castShadow = true;
      portalGroup.add(eave);

      group.add(portalGroup);
    };

    if (portalEnds?.start) {
      addPortal(-0.85);
    }
    if (portalEnds?.end) {
      addPortal(0.85);
    }

    if (rotation === 1) {
      group.rotation.y = Math.PI / 2;
    }
    return group;
  }

  /**
   * 架線柱
   */
  public static createCatenaryPole(): THREE.Group {
    const poleGroup = new THREE.Group();
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 2.4, 6), GameMaterials.poleMat);
    mast.position.set(-1.0, 1.2, 0);
    poleGroup.add(mast);

    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.04, 0.04), GameMaterials.poleMat);
    arm.position.set(-0.4, 2.3, 0);
    poleGroup.add(arm);
    return poleGroup;
  }

  private static gatewaySignCache = new Map<string, THREE.CanvasTexture>();

  /**
   * 隣町ゲートウェイ看板用のCanvasTextureを生成
   */
  public static createGatewaySignTexture(cityName: string, isConnected: boolean): THREE.Texture {
    if (typeof document === 'undefined') {
      return new THREE.Texture();
    }
    const cacheKey = `${cityName}_${isConnected}`;
    const cached = TrackMeshBuilder.gatewaySignCache.get(cacheKey);
    if (cached) return cached;

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      // ダークネイビー背景
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, 512, 128);
      // 外枠アクセントバー
      ctx.fillStyle = isConnected ? '#10b981' : '#f59e0b';
      ctx.fillRect(0, 0, 512, 12);
      // 接続ステータス文字
      ctx.fillStyle = isConnected ? '#34d399' : '#fbbf24';
      ctx.font = 'bold 22px sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(isConnected ? '● 幹線接続中 [CONNECTED]' : '▲ 線路未接続 [OFFLINE]', 496, 20);
      // 行先都市名
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 42px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(cityName, 20, 80);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.userData = { keepAlive: true };
    TrackMeshBuilder.gatewaySignCache.set(cacheKey, texture);
    return texture;
  }

  /**
   * ② 外部接続都市への境界線路メッシュ生成
   * 特別なゲートウェイ・ポータル・看板は表示せず、マップ外へ延伸している自然な線路を描画
   */
  public static createExternalConnectionTile(
    rotation: number = 0,
    _cityName: string = '新東都方面',
    _isConnected: boolean = false
  ): THREE.Group {
    return TrackMeshBuilder.createGroundTrack(rotation, false);
  }

  /**
   * 外部都市境界線路メッシュの更新（ゲートウェイ看板廃止に伴う互換用 no-op）
   */
  public static updateGatewayMesh(_mesh: THREE.Object3D, _cityName: string, _isConnected: boolean): void {
    // ゲートウェイ看板・LEDは非表示（通常線路のまま）のため何もしない
  }
}



