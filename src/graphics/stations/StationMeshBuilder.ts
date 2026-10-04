import * as THREE from 'three';
import { GameMaterials } from '../materials';
import { TrackMeshBuilder } from '../tracks/TrackMeshBuilder';

/**
 * 駅舎・プラットホーム・上屋メッシュ生成ビルダー
 */
export class StationMeshBuilder {
  private static signTextureCache = new Map<string, THREE.CanvasTexture>();

  /**
   * 複数マス対応駅ホームの生成
   * @param rotation 0: 南北方向, 1: 東西方向
   * @param isElevated 高架駅かどうか
   * @param part 'single'(単独1両), 'start'(起点スロープ), 'mid'(中間), 'end'(終端スロープ)
   * @param platformSide 'left'(線路の左側), 'right'(線路の右側)
   * @param stationName 駅名
   * @param pierHeight 橋脚の高さ
   * @param isGhost 仮置き・ホバープレビュー用ゴーストかどうか（true時は看板テクスチャ生成を抑止）
   */
  public static createStation(
    rotation: number = 0,
    isElevated: boolean = false,
    part: 'single' | 'start' | 'mid' | 'end' = 'single',
    platformSide: 'left' | 'right' = 'right',
    stationName: string = '駅',
    pierHeight: number = 3.0,
    isGhost: boolean = false
  ): THREE.Group {
    const group = new THREE.Group();
    const railBaseHeight = isElevated ? 0.2 : 0;
    const sideMult = platformSide === 'left' ? -1 : 1;

    // 軌道部分は無回転で追加し、最後に親グループ全体で回転
    const track = isElevated
      ? TrackMeshBuilder.createElevatedTrack(0, true, pierHeight)
      : TrackMeshBuilder.createGroundTrack(0, false);
    group.add(track);

    // プラットホーム本体
    const pLength = (part === 'start' || part === 'end') ? 1.8 : 2.0;
    const platformGeo = new THREE.BoxGeometry(0.85, 0.45, pLength);
    const platform = new THREE.Mesh(platformGeo, GameMaterials.platformMat);
    platform.position.set(1.0 * sideMult, railBaseHeight + 0.225, 0);
    platform.receiveShadow = true;
    group.add(platform);

    // 点字ブロック・黄色警告ライン
    const yellowGeo = new THREE.PlaneGeometry(0.08, pLength - 0.05);
    const yellow = new THREE.Mesh(yellowGeo, GameMaterials.yellowLineMat);
    yellow.rotation.x = -Math.PI / 2;
    yellow.position.set(0.65 * sideMult, railBaseHeight + 0.46, 0);
    group.add(yellow);

    // 上屋屋根・駅名標（中間部および単独駅）
    if (part === 'single' || part === 'mid') {
      const roofPillars = [-0.6, 0.6];
      roofPillars.forEach(z => {
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 6), GameMaterials.poleMat);
        pillar.position.set(1.1 * sideMult, railBaseHeight + 0.45 + 0.7, z);
        group.add(pillar);
      });

      const canopyGeo = new THREE.BoxGeometry(0.95, 0.08, 2.0);
      const canopy = new THREE.Mesh(canopyGeo, GameMaterials.stationRoofMat);
      canopy.position.set(1.0 * sideMult, railBaseHeight + 0.45 + 1.4, 0);
      canopy.castShadow = true;
      group.add(canopy);

      const signGeo = new THREE.BoxGeometry(0.05, 0.25, 0.65);
      // ゴースト時はテクスチャ生成をスキップして単色共有マテリアルを適用
      const signMat = isGhost
        ? GameMaterials.concreteMat
        : new THREE.MeshBasicMaterial({ map: StationMeshBuilder.createSignTexture(stationName) });
      const sign = new THREE.Mesh(signGeo, signMat);
      sign.name = 'stationSign';
      sign.position.set(0.95 * sideMult, railBaseHeight + 1.25, 0);
      group.add(sign);
    }

    if (rotation === 1) {
      group.rotation.y = Math.PI / 2;
    }
    return group;
  }

  /**
   * 駅名看板用 CanvasTexture を生成（キャッシュプール化）
   */
  public static createSignTexture(text: string): THREE.Texture {
    if (typeof document === 'undefined') {
      return new THREE.Texture();
    }
    const cached = StationMeshBuilder.signTextureCache.get(text);
    if (cached) {
      return cached;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 256, 64);
      // 上部ブルーライン（JR・私鉄風）
      ctx.fillStyle = '#0284c7';
      ctx.fillRect(0, 0, 256, 12);
      // 駅名テキスト
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 26px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 128, 38);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.userData = { keepAlive: true };
    StationMeshBuilder.signTextureCache.set(text, texture);
    return texture;
  }

  /**
   * 駅メッシュ内の駅名標テクスチャを更新
   */
  public static updateSignboardText(mesh: THREE.Object3D, newName: string): void {
    if (typeof document === 'undefined') return;
    const newTex = StationMeshBuilder.createSignTexture(newName);
    mesh.traverse(obj => {
      if (obj.name === 'stationSign' && (obj as THREE.Mesh).isMesh) {
        const m = obj as THREE.Mesh;
        if (m.material) {
          if (Array.isArray(m.material)) {
            m.material.forEach(mat => {
              (mat as any).map = newTex;
              mat.needsUpdate = true;
            });
          } else {
            (m.material as any).map = newTex;
            (m.material as any).needsUpdate = true;
          }
        }
      }
    });
  }

  /**
   * 信号場・留置線メッシュの生成
   * 乗降客を扱わず、都市発展も誘発しない低コストな運行専用施設。
   * プラットホームの代わりに、保守用通路、信号機器詰所（プレハブ小屋）、信号機器箱、照明灯を配置する。
   */
  public static createSignalYard(
    rotation: number = 0,
    isElevated: boolean = false,
    side: 'left' | 'right' = 'right',
    pierHeight: number = 3.0
  ): THREE.Group {
    const group = new THREE.Group();
    const railBaseHeight = isElevated ? 0.2 : 0;
    const sideMult = side === 'left' ? -1 : 1;

    // 軌道部分
    const track = isElevated
      ? TrackMeshBuilder.createElevatedTrack(0, true, pierHeight)
      : TrackMeshBuilder.createGroundTrack(0, false);
    group.add(track);

    // 保守用通路（砂利・コンクリート簡易ステップ）
    const pathGeo = new THREE.BoxGeometry(0.5, 0.1, 1.9);
    const pathMesh = new THREE.Mesh(pathGeo, GameMaterials.ballastMat);
    pathMesh.position.set(0.75 * sideMult, railBaseHeight + 0.05, 0);
    group.add(pathMesh);

    // 信号機器詰所（小さな保線プレハブ小屋）
    const hutGeo = new THREE.BoxGeometry(0.55, 0.65, 0.9);
    const hutMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.7 });
    const hut = new THREE.Mesh(hutGeo, hutMat);
    hut.position.set(1.15 * sideMult, railBaseHeight + 0.325, 0.2);
    hut.castShadow = true;
    group.add(hut);

    // 詰所の屋根
    const roofGeo = new THREE.BoxGeometry(0.62, 0.06, 0.96);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.5 });
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.set(1.15 * sideMult, railBaseHeight + 0.68, 0.2);
    roof.castShadow = true;
    group.add(roof);

    // 信号機器箱（銀色のリレーボックス）
    const boxGeo = new THREE.BoxGeometry(0.22, 0.38, 0.28);
    const boxMat = new THREE.MeshStandardMaterial({ color: 0xcfd8dc, metalness: 0.6, roughness: 0.3 });
    const box = new THREE.Mesh(boxGeo, boxMat);
    box.position.set(1.1 * sideMult, railBaseHeight + 0.19, -0.6);
    group.add(box);

    if (rotation === 1) {
      group.rotation.y = Math.PI / 2;
    }
    return group;
  }

  /**
   * 貨物駅・コンテナヤードメッシュの生成
   */
  public static createCargoStation(
    rotation: number = 0,
    isElevated: boolean = false,
    side: 'left' | 'right' = 'right',
    pierHeight: number = 3.0
  ): THREE.Group {
    const group = new THREE.Group();
    const railBaseHeight = isElevated ? 0.2 : 0;
    const sideMult = side === 'left' ? -1 : 1;

    // 軌道部分
    const track = isElevated
      ? TrackMeshBuilder.createElevatedTrack(0, true, pierHeight)
      : TrackMeshBuilder.createGroundTrack(0, false);
    group.add(track);

    // 貨物ヤード（コンクリートの広い敷地）
    const yardGeo = new THREE.BoxGeometry(1.4, 0.1, 2.0);
    const yard = new THREE.Mesh(yardGeo, GameMaterials.concreteMat);
    yard.position.set(1.0 * sideMult, railBaseHeight + 0.05, 0);
    yard.receiveShadow = true;
    group.add(yard);

    if (rotation === 1) {
      group.rotation.y = Math.PI / 2;
    }
    return group;
  }

  /**
   * 3D閉塞信号機（信号柱・器具箱・灯具）の生成
   */
  public static createSignalPost(state: 'green' | 'red' | 'yellow' = 'green'): THREE.Group {
    const group = new THREE.Group();

    // 信号柱（ポール）
    const poleGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.6, 8);
    const pole = new THREE.Mesh(poleGeo, GameMaterials.poleMat);
    pole.position.y = 0.8;
    group.add(pole);

    // 信号灯具ケース（遮光フード付きバックプレート）
    const caseGeo = new THREE.BoxGeometry(0.18, 0.45, 0.12);
    const casing = new THREE.Mesh(caseGeo, GameMaterials.signalHousingMat);
    casing.position.set(0, 1.45, 0);
    group.add(casing);

    // 2灯式（上: 赤, 下: 緑）
    const lampGeo = new THREE.SphereGeometry(0.06, 8, 8);

    // 赤ランプ
    const redMat = (state === 'red') ? GameMaterials.signalRedMat : new THREE.MeshBasicMaterial({ color: 0x3f1515 });
    const redLamp = new THREE.Mesh(lampGeo, redMat);
    redLamp.position.set(0, 1.55, 0.07);
    group.add(redLamp);

    // 青ランプ
    const greenMat = (state === 'green') ? GameMaterials.signalGreenMat : new THREE.MeshBasicMaterial({ color: 0x0f3015 });
    const greenLamp = new THREE.Mesh(lampGeo, greenMat);
    greenLamp.position.set(0, 1.35, 0.07);
    group.add(greenLamp);

    return group;
  }
}

