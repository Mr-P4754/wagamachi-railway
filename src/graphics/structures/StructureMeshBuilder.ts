import * as THREE from 'three';
import { GameMaterials } from '../materials';
import { BuildingBakery } from './BuildingBakery';

/**
 * 道路・住宅・商業ビル・樹木等の都市構造物メッシュ生成ビルダー
 */
export class StructureMeshBuilder {
  /**
   * 道路（アスファルト＋白線＋歩道）
   */
  public static createRoad(rotation: number = 0): THREE.Group {
    const group = new THREE.Group();

    const road = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.05, 2.0), GameMaterials.asphaltMat);
    road.position.y = 0.025;
    road.receiveShadow = true;
    group.add(road);

    const lineGeo = new THREE.PlaneGeometry(0.08, 0.6);
    for (let i = -1; i <= 1; i++) {
      const line = new THREE.Mesh(lineGeo, GameMaterials.roadLineMat);
      line.rotation.x = -Math.PI / 2;
      line.position.set(0, 0.052, i * 0.75);
      group.add(line);
    }

    const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 2.0), GameMaterials.sidewalkMat);
    sideL.position.set(-0.9, 0.04, 0);
    group.add(sideL);

    const sideR = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 2.0), GameMaterials.sidewalkMat);
    sideR.position.set(0.9, 0.04, 0);
    group.add(sideR);

    if (rotation === 1) {
      group.rotation.y = Math.PI / 2;
    }
    return group;
  }

  /**
   * 住宅系建築物（Lv.1 戸建て, Lv.2 低層アパート, Lv.3 中層マンション, Lv.4 高層タワーマンション）
   * マテリアル単位に焼き込まれた共有ジオメトリを用いる（1棟あたり数ドローコール）
   */
  public static createHouse(type: number = 0, level: number = 1): THREE.Group {
    const safeLevel = Math.max(1, Math.min(4, level));
    // 外壁・屋根マテリアルが変化するのは Lv.1 のみ（Lv.2 以降は屋根色のみ影響）
    const wallIdx = type % (GameMaterials.wallMats.length - 1);
    const roofIdx = type % GameMaterials.roofMats.length;
    const key = `house_${safeLevel}_${wallIdx}_${roofIdx}`;
    return BuildingBakery.build(key, () => this.buildHouseSource(type, safeLevel));
  }

  /**
   * 住宅系建築物の原型（多パーツ構成）を生成する（焼き込み元）
   */
  private static buildHouseSource(type: number = 0, level: number = 1): THREE.Group {
    const group = new THREE.Group();
    const safeLevel = Math.max(1, Math.min(4, level));
    const wallMat = GameMaterials.wallMats[type % (GameMaterials.wallMats.length - 1)];
    const roofMat = GameMaterials.roofMats[type % GameMaterials.roofMats.length];

    if (safeLevel === 1) {
      // Lv.1: 戸建て住宅
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.1, 1.3), wallMat);
      body.position.y = 0.55;
      body.castShadow = true;
      group.add(body);

      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.1, 0.65, 4), roofMat);
      roof.position.y = 1.425;
      roof.rotation.y = Math.PI / 4;
      roof.castShadow = true;
      group.add(roof);

      const winGeo = new THREE.PlaneGeometry(0.25, 0.3);
      const win1 = new THREE.Mesh(winGeo, GameMaterials.windowDayMat);
      win1.position.set(0.3, 0.6, 0.655);
      group.add(win1);

      const win2 = new THREE.Mesh(winGeo, GameMaterials.windowDayMat);
      win2.position.set(-0.3, 0.6, 0.655);
      group.add(win2);
    } else if (safeLevel === 2) {
      // Lv.2: 2階建てモダンアパート・集合住宅
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.8, 1.4), GameMaterials.wallMats[0]);
      body.position.y = 0.9;
      body.castShadow = true;
      group.add(body);

      const roof = new THREE.Mesh(new THREE.BoxGeometry(1.56, 0.12, 1.46), roofMat);
      roof.position.y = 1.86;
      group.add(roof);

      const winGeo = new THREE.PlaneGeometry(0.28, 0.35);
      for (const y of [0.55, 1.3]) {
        for (const x of [-0.45, 0, 0.45]) {
          const winF = new THREE.Mesh(winGeo, GameMaterials.windowDayMat);
          winF.position.set(x, y, 0.705);
          group.add(winF);

          const winB = new THREE.Mesh(winGeo, GameMaterials.windowDayMat);
          winB.position.set(x, y, -0.705);
          winB.rotation.y = Math.PI;
          group.add(winB);
        }
      }

      // 玄関ポーチ
      const porch = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.08, 0.3), GameMaterials.concreteMat);
      porch.position.set(0, 0.04, 0.8);
      group.add(porch);
    } else if (safeLevel === 3) {
      // Lv.3: 中層マンション（5〜6階建て規模）
      const height = 3.4;
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, height, 1.6), GameMaterials.wallMats[3]);
      body.position.y = height / 2;
      body.castShadow = true;
      group.add(body);

      // バルコニーライン（各階の水平アクセント）
      const winGeo = new THREE.PlaneGeometry(0.26, 0.36);
      for (let y = 0.6; y < height - 0.4; y += 0.65) {
        // バルコニー手すり
        const balcony = new THREE.Mesh(new THREE.BoxGeometry(1.64, 0.12, 0.2), GameMaterials.concreteMat);
        balcony.position.set(0, y - 0.15, 0.82);
        group.add(balcony);

        for (const x of [-0.5, 0, 0.5]) {
          const winF = new THREE.Mesh(winGeo, GameMaterials.windowDayMat);
          winF.position.set(x, y, 0.805);
          group.add(winF);

          const winB = new THREE.Mesh(winGeo, GameMaterials.windowDayMat);
          winB.position.set(x, y, -0.805);
          winB.rotation.y = Math.PI;
          group.add(winB);
        }
      }

      // 屋上貯水槽
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.4, 8), GameMaterials.concreteMat);
      tank.position.set(0.3, height + 0.2, -0.2);
      group.add(tank);
    } else {
      // Lv.4: 高層タワーマンション（10階建て規模）
      const height = 5.8;
      const tower = new THREE.Mesh(new THREE.BoxGeometry(1.6, height, 1.6), GameMaterials.wallMats[0]);
      tower.position.y = height / 2;
      tower.castShadow = true;
      group.add(tower);

      // コーナーストライプ（高層ビルの垂直アクセント）
      const stripeMat = GameMaterials.wallMats[4];
      const stripeL = new THREE.Mesh(new THREE.BoxGeometry(0.15, height, 0.15), stripeMat);
      stripeL.position.set(-0.75, height / 2, 0.75);
      group.add(stripeL);
      const stripeR = new THREE.Mesh(new THREE.BoxGeometry(0.15, height, 0.15), stripeMat);
      stripeR.position.set(0.75, height / 2, 0.75);
      group.add(stripeR);

      // 格子窓
      const winGeo = new THREE.PlaneGeometry(0.22, 0.32);
      for (let y = 0.55; y < height - 0.4; y += 0.55) {
        for (const x of [-0.45, 0, 0.45]) {
          const winF = new THREE.Mesh(winGeo, GameMaterials.windowDayMat);
          winF.position.set(x, y, 0.805);
          group.add(winF);

          const winB = new THREE.Mesh(winGeo, GameMaterials.windowDayMat);
          winB.position.set(x, y, -0.805);
          winB.rotation.y = Math.PI;
          group.add(winB);
        }
      }

      // 屋上ヘリポート・設備タワー
      const heliPad = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.15, 1.2), GameMaterials.concreteMat);
      heliPad.position.set(0, height + 0.08, 0);
      group.add(heliPad);
      const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.6, 6), GameMaterials.poleMat);
      beacon.position.set(0, height + 0.45, 0);
      group.add(beacon);
    }

    return group;
  }

  /**
   * 商業ビル・オフィスビル（Lv.1 個人商店・低層店舗, Lv.2 中型テナントビル, Lv.3 大型オフィスビル, Lv.4 超高層ランドマークタワー）
   * マテリアル単位に焼き込まれた共有ジオメトリを用いる（1棟あたり数ドローコール）
   */
  public static createCommercialBuilding(level: number = 1): THREE.Group {
    const safeLevel = Math.max(1, Math.min(4, level));
    return BuildingBakery.build(`commercial_${safeLevel}`, () => this.buildCommercialSource(safeLevel));
  }

  /**
   * 商業ビルの原型（多パーツ構成）を生成する（焼き込み元）
   */
  private static buildCommercialSource(level: number = 1): THREE.Group {
    const group = new THREE.Group();
    const safeLevel = Math.max(1, Math.min(4, level));

    // レベルに応じた建物の高さ
    const heightMap = [1.6, 2.8, 4.6, 6.8];
    const height = heightMap[safeLevel - 1];

    if (safeLevel === 1) {
      // Lv.1: 小型店舗・個人商店・カフェ
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, height, 1.4), GameMaterials.wallMats[1]);
      body.position.y = height / 2;
      body.castShadow = true;
      group.add(body);

      // 1F ショーウィンドウ（大型ガラス）
      const shopWin = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.6), GameMaterials.windowDayMat);
      shopWin.position.set(0, 0.5, 0.705);
      group.add(shopWin);

      // 商店ひさし（オーニング）
      const awning = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.35), GameMaterials.roofMats[1]);
      awning.position.set(0, 0.9, 0.8);
      group.add(awning);

      // 2F窓
      const win2F = new THREE.Mesh(new THREE.PlaneGeometry(0.35, 0.35), GameMaterials.windowDayMat);
      win2F.position.set(0, 1.25, 0.705);
      group.add(win2F);
    } else {
      // Lv.2〜Lv.4: オフィスビル・高層ビル
      const mainMat = safeLevel >= 3 ? GameMaterials.wallMats[4] : GameMaterials.wallMats[3];
      const tower = new THREE.Mesh(new THREE.BoxGeometry(1.5, height, 1.5), mainMat);
      tower.position.y = height / 2;
      tower.castShadow = true;
      group.add(tower);

      const winGeo = new THREE.PlaneGeometry(0.24, 0.34);
      for (let f = 0.5; f < height - 0.4; f += 0.68) {
        for (const x of [-0.45, 0, 0.45]) {
          const winF = new THREE.Mesh(winGeo, GameMaterials.windowDayMat);
          winF.position.set(x, f, 0.755);
          group.add(winF);

          const winB = new THREE.Mesh(winGeo, GameMaterials.windowDayMat);
          winB.position.set(x, f, -0.755);
          winB.rotation.y = Math.PI;
          group.add(winB);
        }
      }

      // 屋上設備（エアコン室外機、アンテナ塔）
      const ac = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.5), GameMaterials.concreteMat);
      ac.position.set(0.3, height + 0.15, 0.3);
      group.add(ac);

      if (safeLevel >= 3) {
        const ac2 = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.25, 0.4), GameMaterials.concreteMat);
        ac2.position.set(-0.3, height + 0.125, -0.2);
        group.add(ac2);
      }

      if (safeLevel === 4) {
        // 超高層ビルの尖塔（アンテナタワー）
        const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.08, 1.2, 8), GameMaterials.poleMat);
        spire.position.set(0, height + 0.6, 0);
        group.add(spire);
      }
    }

    return group;
  }

  /**
   * 樹木・緑地
   */
  public static createTree(): THREE.Group {
    const group = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.8, 6), GameMaterials.woodTrunkMat);
    trunk.position.y = 0.4;
    group.add(trunk);

    const foliageMat = GameMaterials.foliageMats[Math.floor(Math.random() * GameMaterials.foliageMats.length)];
    const leaves1 = new THREE.Mesh(new THREE.DodecahedronGeometry(0.65, 1), foliageMat);
    leaves1.position.set(0, 1.0, 0);
    leaves1.castShadow = true;
    group.add(leaves1);

    const leaves2 = new THREE.Mesh(new THREE.DodecahedronGeometry(0.48, 1), foliageMat);
    leaves2.position.set(0.2, 1.4, -0.1);
    leaves2.castShadow = true;
    group.add(leaves2);

    return group;
  }

  /**
   * 工業系建物（工場・倉庫・コンビナート）
   * マテリアル単位に焼き込まれた共有ジオメトリを用いる（1棟あたり数ドローコール）
   * @param level 発展レベル (1: 小型倉庫/作業所, 2: 中規模製造工場/サイロ, 3: 大型重化学コンビナート)
   */
  public static createIndustrialBuilding(level: number = 1): THREE.Group {
    const safeLevel = Math.max(1, Math.min(3, level));
    return BuildingBakery.build(`industrial_${safeLevel}`, () => this.buildIndustrialSource(safeLevel));
  }

  /**
   * 工業系建物の原型（多パーツ構成）を生成する（焼き込み元）
   */
  private static buildIndustrialSource(level: number = 1): THREE.Group {
    const group = new THREE.Group();
    const safeLevel = Math.max(1, Math.min(3, level));

    // コンクリート敷地ベース（1.8 × 0.06 × 1.8）
    const baseGeo = new THREE.BoxGeometry(1.8, 0.06, 1.8);
    const base = new THREE.Mesh(baseGeo, GameMaterials.concreteMat);
    base.position.y = 0.03;
    base.receiveShadow = true;
    group.add(base);

    if (safeLevel === 1) {
      // === Lv.1: 小型作業所・配送倉庫 (Warehouse / Workshop) ===
      // メイン倉庫棟（トタン調・切妻屋根）
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.7, 1.2), GameMaterials.wallMats[3]);
      body.position.set(0, 0.35 + 0.06, -0.1);
      body.castShadow = true;
      group.add(body);

      // 屋根（三角屋根）
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.1, 0.45, 4), GameMaterials.roofMats[0]);
      roof.position.set(0, 0.7 + 0.06 + 0.225, -0.1);
      roof.rotation.y = Math.PI / 4;
      roof.castShadow = true;
      group.add(roof);

      // 搬入口シャッター（ダークスチール調）
      const shutter = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), GameMaterials.roofMats[0]);
      shutter.position.set(0, 0.25 + 0.06, 0.505);
      group.add(shutter);

      // 屋外木箱・パレット（資材）
      const pallet = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.2, 0.35), GameMaterials.woodTrunkMat);
      pallet.position.set(0.5, 0.1 + 0.06, 0.5);
      pallet.castShadow = true;
      group.add(pallet);

      // 小型円筒タンク
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.5, 8), GameMaterials.poleMat);
      tank.position.set(-0.55, 0.25 + 0.06, 0.5);
      tank.castShadow = true;
      group.add(tank);

    } else if (safeLevel === 2) {
      // === Lv.2: 中規模製造工場・サイロ付きプラント (Factory / Plant) ===
      // 主棟
      const mainBuilding = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.0, 1.4), GameMaterials.wallMats[3]);
      mainBuilding.position.set(-0.25, 0.5 + 0.06, 0);
      mainBuilding.castShadow = true;
      group.add(mainBuilding);

      // 屋上換気ダクト
      const duct = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 0.6), GameMaterials.concreteMat);
      duct.position.set(-0.25, 1.0 + 0.06 + 0.1, 0);
      group.add(duct);

      // 円柱形サイロ（2基）
      for (const zOffset of [-0.35, 0.35]) {
        const silo = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 1.1, 12), GameMaterials.railMat);
        silo.position.set(0.52, 0.55 + 0.06, zOffset);
        silo.castShadow = true;
        group.add(silo);

        const cap = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.18, 12), GameMaterials.roofMats[0]);
        cap.position.set(0.52, 1.1 + 0.06 + 0.09, zOffset);
        group.add(cap);
      }

      // 小型煙突（チムニー）
      const chimney = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.6, 8), GameMaterials.poleMat);
      chimney.position.set(-0.6, 0.8 + 0.06, -0.5);
      chimney.castShadow = true;
      group.add(chimney);

      // 窓
      const winGeo = new THREE.PlaneGeometry(0.2, 0.2);
      for (const x of [-0.45, -0.05]) {
        const win = new THREE.Mesh(winGeo, GameMaterials.windowDayMat);
        win.position.set(x, 0.6 + 0.06, 0.705);
        group.add(win);
      }

    } else {
      // === Lv.3: 重化学コンビナート・大型プラント (Industrial Complex / Refinery) ===
      // 中央メインプラント棟
      const plant = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.4, 1.2), GameMaterials.wallMats[3]);
      plant.position.set(-0.15, 0.7 + 0.06, -0.15);
      plant.castShadow = true;
      group.add(plant);

      // 大型サイロ（3基トライアングル配置）
      const siloPositions = [
        { x: 0.55, z: 0.45 },
        { x: 0.55, z: -0.2 },
        { x: 0.05, z: 0.55 }
      ];
      for (const sp of siloPositions) {
        const bigSilo = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.4, 12), GameMaterials.railMat);
        bigSilo.position.set(sp.x, 0.7 + 0.06, sp.z);
        bigSilo.castShadow = true;
        group.add(bigSilo);

        const dome = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8, 0, Math.PI * 2, 0, Math.PI / 2), GameMaterials.roofMats[1]);
        dome.position.set(sp.x, 1.4 + 0.06, sp.z);
        group.add(dome);
      }

      // 高い赤白煙突（2.2m）
      const chimneyBase = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.6, 8), GameMaterials.concreteMat);
      chimneyBase.position.set(-0.6, 0.3 + 0.06, 0.55);
      chimneyBase.castShadow = true;
      group.add(chimneyBase);

      // 赤と白の交互セグメント
      for (let s = 0; s < 4; s++) {
        const mat = (s % 2 === 0) ? GameMaterials.roofMats[1] : GameMaterials.wallMats[0];
        const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.09 - s * 0.01, 0.10 - s * 0.01, 0.4, 8), mat);
        seg.position.set(-0.6, 0.6 + 0.06 + s * 0.4 + 0.2, 0.55);
        seg.castShadow = true;
        group.add(seg);
      }

      // 配管パイプライン（水平）
      const pipeGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.9, 6);
      const pipe = new THREE.Mesh(pipeGeo, GameMaterials.poleMat);
      pipe.rotation.z = Math.PI / 2;
      pipe.position.set(0.1, 1.1 + 0.06, -0.15);
      group.add(pipe);

      // 敷地内警告ライン
      const gateLine = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.08), GameMaterials.yellowLineMat);
      gateLine.rotation.x = -Math.PI / 2;
      gateLine.position.set(-0.4, 0.065, 0.8);
      group.add(gateLine);
    }

    return group;
  }

  /**
   * 田畑・農地（黄金色の稲穂、緑の畝、ビニールハウス）
   * BuildingBakery でベイクしてドローコール負荷を最小化
   */
  public static createFarmland(variation: number = 0): THREE.Group {
    const safeVar = Math.abs(variation) % 3;
    const key = `farmland_${safeVar}`;
    return BuildingBakery.build(key, () => this.buildFarmlandSource(safeVar));
  }

  /**
   * 田畑・農地の原型メッシュ構築
   * @param variation 0: 黄金色の水田・稲穂（案山子付き）, 1: 緑の畝・野菜畑（木箱付き）, 2: ビニールハウス農園（緑の畝併設）
   */
  private static buildFarmlandSource(variation: number): THREE.Group {
    const group = new THREE.Group();

    // 1. 畑の土台（あぜ道・土） 1.92 × 1.92 × 0.03
    const soil = new THREE.Mesh(new THREE.BoxGeometry(1.92, 0.03, 1.92), GameMaterials.farmlandSoilMat);
    soil.position.y = 0.015;
    soil.receiveShadow = true;
    group.add(soil);

    if (variation === 0) {
      // === バリエーション0: 黄金色の水田・稲穂 ===
      // 4列の黄金色の稲穂の畝
      const paddyWidth = 0.34;
      const paddyLength = 1.76;
      const paddyHeight = 0.07;
      const paddyGeo = new THREE.BoxGeometry(paddyWidth, paddyHeight, paddyLength);
      const xs = [-0.55, -0.18, 0.18, 0.55];
      for (const x of xs) {
        const paddy = new THREE.Mesh(paddyGeo, GameMaterials.farmlandPaddyMat);
        paddy.position.set(x, 0.03 + paddyHeight / 2, 0);
        paddy.castShadow = true;
        paddy.receiveShadow = true;
        group.add(paddy);
      }

      // 小さな木製案山子（かかし）
      const poleGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.35, 6);
      const pole = new THREE.Mesh(poleGeo, GameMaterials.woodTrunkMat);
      pole.position.set(0.78, 0.2, 0.75);
      pole.castShadow = true;
      group.add(pole);

      const crossGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.22, 6);
      const cross = new THREE.Mesh(crossGeo, GameMaterials.woodTrunkMat);
      cross.rotation.z = Math.PI / 2;
      cross.position.set(0.78, 0.26, 0.75);
      cross.castShadow = true;
      group.add(cross);

      const headGeo = new THREE.SphereGeometry(0.035, 6, 6);
      const head = new THREE.Mesh(headGeo, GameMaterials.wallMats[0]);
      head.position.set(0.78, 0.38, 0.75);
      group.add(head);

    } else if (variation === 1) {
      // === バリエーション1: 緑の畝・野菜畑 ===
      // 4列の緑の畝
      const ridgeWidth = 0.32;
      const ridgeLength = 1.76;
      const ridgeHeight = 0.065;
      const ridgeGeo = new THREE.BoxGeometry(ridgeWidth, ridgeHeight, ridgeLength);
      const xs = [-0.55, -0.18, 0.18, 0.55];
      for (const x of xs) {
        const ridge = new THREE.Mesh(ridgeGeo, GameMaterials.farmlandCropMat);
        ridge.position.set(x, 0.03 + ridgeHeight / 2, 0);
        ridge.castShadow = true;
        ridge.receiveShadow = true;
        group.add(ridge);
      }

      // 端に置かれた農作業用の収穫木箱
      const crateGeo = new THREE.BoxGeometry(0.18, 0.14, 0.18);
      const crate1 = new THREE.Mesh(crateGeo, GameMaterials.woodTrunkMat);
      crate1.position.set(-0.78, 0.03 + 0.07, 0.7);
      crate1.castShadow = true;
      group.add(crate1);

      const crate2 = new THREE.Mesh(crateGeo, GameMaterials.woodTrunkMat);
      crate2.position.set(-0.78, 0.03 + 0.07, 0.48);
      crate2.rotation.y = 0.2;
      crate2.castShadow = true;
      group.add(crate2);

    } else {
      // === バリエーション2: 小さなビニールハウス農園 ＋ 緑の畝 ===
      // 西側半分（x = -0.42）にビニールハウス（幅 0.72, 長さ 1.6, 高さ 0.42）
      const houseW = 0.72;
      const houseL = 1.6;
      const houseH = 0.32;

      // ビニールハウス本体（半透明のため濃い影を落とさないよう castShadow は false）
      const baseBox = new THREE.Mesh(
        new THREE.BoxGeometry(houseW, houseH, houseL),
        GameMaterials.greenhouseSheetMat
      );
      baseBox.position.set(-0.45, 0.03 + houseH / 2, 0);
      baseBox.castShadow = false;
      baseBox.receiveShadow = true;
      group.add(baseBox);

      // 屋根（アーチ型シリンダー：半透明のため castShadow は false）
      const roofGeo = new THREE.CylinderGeometry(houseW / 2, houseW / 2, houseL, 8, 1, false, 0, Math.PI);
      const roof = new THREE.Mesh(roofGeo, GameMaterials.greenhouseSheetMat);
      roof.rotation.x = Math.PI / 2;
      roof.rotation.z = Math.PI;
      roof.position.set(-0.45, 0.03 + houseH, 0);
      roof.castShadow = false;
      roof.receiveShadow = true;
      group.add(roof);

      // 前後のフレーム支柱（フレーム自体は影を落とす）
      for (const z of [-houseL / 2 + 0.02, houseL / 2 - 0.02]) {
        const frame = new THREE.Mesh(
          new THREE.BoxGeometry(houseW + 0.02, 0.03, 0.03),
          GameMaterials.poleMat
        );
        frame.position.set(-0.45, 0.03 + houseH, z);
        frame.castShadow = true;
        group.add(frame);
      }

      // 東側半分（x = 0.22, 0.60）に緑の畝 2列
      const ridgeGeo = new THREE.BoxGeometry(0.3, 0.065, 1.76);
      for (const x of [0.22, 0.60]) {
        const ridge = new THREE.Mesh(ridgeGeo, GameMaterials.farmlandCropMat);
        ridge.position.set(x, 0.03 + 0.0325, 0);
        ridge.castShadow = true;
        ridge.receiveShadow = true;
        group.add(ridge);
      }
    }

    return group;
  }
}
