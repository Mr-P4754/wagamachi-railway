import { WorldMap, TileData } from './WorldMap';

export type ExternalCityRole = 'resort' | 'commercial' | 'port' | 'industrial';

export interface ExternalCityNode {
  id: string;
  name: string;            // 都市名（例: "新東都方面"）
  subtitle: string;        // サブタイトル・特色
  direction: 'north' | 'east' | 'south' | 'west';
  role?: ExternalCityRole; // 都市の産業・需要特性
  population: number;      // 都市人口（45,000〜150,000人）
  connected: boolean;      // 自都市の線路がマップ外へ延伸されているか
  connectedTileCount: number; // 接続中の境界線路数
  passengerSupplyRate: number; // 毎時補充される基本待機乗客数
  cargoSupplyRate: number;     // 毎時補充される貨物コンテナ数
  totalPassengersTransported: number; // 累計輸送乗客数
  totalCargoExported: number;         // 累計輸出貨物数
}

export interface ExternalConnectionSnapshot {
  cities: ExternalCityNode[];
}

export class ExternalConnectionManager {
  private cities: ExternalCityNode[] = [];

  constructor() {
    this.initDefaultCities();
  }

  /**
   * 四方向の外部仮想都市パラメータを初期化
   */
  public initDefaultCities(_gridSize: number = WorldMap.GRID_SIZE): void {
    this.cities = [
      {
        id: 'ext_north',
        name: '北ノ森市方面',
        subtitle: '高原リゾート・林業木材資源都市',
        direction: 'north',
        role: 'resort',
        population: 45000,
        connected: false,
        connectedTileCount: 0,
        passengerSupplyRate: 40,
        cargoSupplyRate: 3,
        totalPassengersTransported: 0,
        totalCargoExported: 0
      },
      {
        id: 'ext_east',
        name: '新東都方面',
        subtitle: '巨大首都圏・一大ビジネス商業中心地',
        direction: 'east',
        role: 'commercial',
        population: 150000,
        connected: false,
        connectedTileCount: 0,
        passengerSupplyRate: 120,
        cargoSupplyRate: 1,
        totalPassengersTransported: 0,
        totalCargoExported: 0
      },
      {
        id: 'ext_south',
        name: '南港市方面',
        subtitle: '国際コンテナ貿易海洋港湾都市',
        direction: 'south',
        role: 'port',
        population: 75000,
        connected: false,
        connectedTileCount: 0,
        passengerSupplyRate: 60,
        cargoSupplyRate: 5,
        totalPassengersTransported: 0,
        totalCargoExported: 0
      },
      {
        id: 'ext_west',
        name: '西条重工市方面',
        subtitle: '一大臨海コンビナート・鉄鋼重工業都市',
        direction: 'west',
        role: 'industrial',
        population: 90000,
        connected: false,
        connectedTileCount: 0,
        passengerSupplyRate: 80,
        cargoSupplyRate: 6,
        totalPassengersTransported: 0,
        totalCargoExported: 0
      }
    ];
  }

  /**
   * 外部都市の特定時刻における乗客需要係数を算出（基準値 1.0）
   * 都市の性格（商業ビジネス・高原リゾート・国際港湾・重工業）に応じた時間帯ピーク特性を持つ
   */
  public static getCityPassengerDemandMultiplier(city: ExternalCityNode, hour: number): number {
    const h = ((hour % 24) + 24) % 24;
    const role = city.role ?? (
      city.direction === 'east' ? 'commercial' :
      city.direction === 'north' ? 'resort' :
      city.direction === 'south' ? 'port' : 'industrial'
    );

    switch (role) {
      case 'commercial': {
        // 新東都（巨大首都圏・商業ビジネス都市）
        // 朝ラッシュ: 都心への通勤・出張で活発
        if (h >= 7 && h < 9) return 2.2;
        if (h === 9) return 1.6;
        // 昼間: ショッピング・ビジネス利用
        if (h >= 10 && h < 16) return 1.0;
        if (h === 16) return 1.5;
        // 夕ラッシュ: 都心からの帰宅ラッシュピーク！
        if (h >= 17 && h < 20) return 2.8;
        if (h >= 20 && h < 22) return 1.4;
        if (h === 22) return 0.8;
        // 深夜帯
        if (h === 23 || h === 0) return 0.35;
        return 0.15; // 1〜6時
      }

      case 'resort': {
        // 北ノ森市（高原リゾート・林業木材資源都市）
        // 観光客の朝の出発
        if (h >= 7 && h < 10) return 1.4;
        // 昼間・午後: 行楽・ショッピング・レジャーのピーク
        if (h >= 10 && h < 16) return 2.0;
        // 夕方: 観光地からの帰路
        if (h >= 16 && h < 19) return 1.5;
        if (h >= 19 && h < 21) return 0.8;
        // 夜間・早朝: 観光地のため夜は非常に静か
        if (h >= 21 || h < 5) return 0.1;
        return 0.5; // 5〜6時
      }

      case 'port': {
        // 南港市（国際コンテナ貿易海洋港湾都市）
        // 港湾交代勤務シフト＆ビジネス
        if (h >= 6 && h < 9) return 2.0; // 朝シフト交代・出勤
        if (h >= 9 && h < 14) return 1.1; // 昼間物流・港湾ビジネス
        if (h >= 14 && h < 16) return 1.8; // 昼シフト交代
        if (h >= 16 && h < 19) return 1.7; // 夕方退勤
        if (h >= 19 && h < 22) return 0.9;
        if (h >= 22 && h < 24) return 1.5; // 夜勤シフト交代
        return 0.35; // 24時間港湾のため深夜も一定の移動あり (0〜5時)
      }

      case 'industrial':
      default: {
        // 西条重工市（一大臨海コンビナート・鉄鋼重工業都市）
        // 工場朝ラッシュ
        if (h >= 6 && h < 9) return 2.4;
        // 昼間: 工場内作業中のため旅客移動は落ち着く
        if (h >= 9 && h < 16) return 0.7;
        // 工場夕ラッシュ（退勤）
        if (h >= 16 && h < 19) return 2.3;
        if (h >= 19 && h < 22) return 1.2;
        if (h >= 22 && h < 24) return 0.8;
        return 0.2; // 深夜 (0〜5時)
      }
    }
  }

  /**
   * 現在の需要状態のラベル（UI表示用）を取得
   */
  public static getDemandPhaseInfo(city: ExternalCityNode, hour: number): { label: string; multiplier: number; percentage: number } {
    const mult = ExternalConnectionManager.getCityPassengerDemandMultiplier(city, hour);
    const pct = Math.round(mult * 100);
    const h = ((hour % 24) + 24) % 24;

    let label = '通常需要';
    if (mult >= 2.0) {
      label = (h >= 6 && h < 10) ? '朝ラッシュ' : (h >= 16 && h < 20) ? '夕ラッシュ' : 'ピーク需要';
    } else if (mult >= 1.4) {
      label = '高需要';
    } else if (mult <= 0.35) {
      label = '深夜閑散';
    } else if (mult < 0.8) {
      label = '閑散帯';
    }

    return { label, multiplier: mult, percentage: pct };
  }

  /**
   * マップ境界端の線路タイルが外部（マップ外）を向いて延伸しているかを判定し、その方角を返す
   */
  public static getExternalConnectionDirection(tile: TileData, gridSize: number = WorldMap.GRID_SIZE): 'north' | 'east' | 'south' | 'west' | null {
    const half = Math.floor(gridSize / 2);
    const minX = -half;
    const maxX = half; // ← half - 1 から half に修正（北・西と完全対称化）
    const minZ = -half;
    const maxZ = half; // ← half - 1 から half に修正（北・西と完全対称化）

    // 線路系・駅系タイルでなければ対象外
    if (
      !tile.type.startsWith('rail') &&
      !tile.type.startsWith('station') &&
      !tile.type.startsWith('point_switch') &&
      !tile.type.startsWith('scissors_crossing') &&
      tile.type !== 'external_connection' &&
      tile.type !== 'level_crossing'
    ) {
      return null;
    }

    const exits = WorldMap.getTileExits(tile);

    // 北端境界 (z === minZ) かつ 北方向 (idx: 0) へ線路の出口が向いている
    if (tile.z === minZ && exits.some(e => e.idx === 0)) {
      return 'north';
    }
    // 南端境界 (z === maxZ) かつ 南方向 (idx: 2) へ線路の出口が向いている
    if (tile.z === maxZ && exits.some(e => e.idx === 2)) {
      return 'south';
    }
    // 東端境界 (x === maxX) かつ 東方向 (idx: 1) へ線路の出口が向いている
    if (tile.x === maxX && exits.some(e => e.idx === 1)) {
      return 'east';
    }
    // 西端境界 (x === minX) かつ 西方向 (idx: 3) へ線路の出口が向いている
    if (tile.x === minX && exits.some(e => e.idx === 3)) {
      return 'west';
    }

    return null;
  }

  /**
   * 固定ゲートウェイタイルは設置不要（互換性維持のための空実装）
   */
  public placeGatewayTiles(_worldMap: WorldMap): void {
    // 固定ゲートウェイは配置せず、プレイヤーが自由に延伸した線路を検知する
  }

  /**
   * マップ外へ延伸された線路を走査し、外部都市との接続判定およびタイルメタデータを更新する
   */
  public checkConnections(
    worldMap: WorldMap,
    onConnected?: (city: ExternalCityNode) => void
  ): boolean[] {
    const results: boolean[] = [];
    const gridSize = worldMap.gridSize || WorldMap.GRID_SIZE;

    // 各方角ごとに接続されている境界線路タイルを収集
    const connectedTilesByDir = new Map<'north' | 'east' | 'south' | 'west', TileData[]>();
    connectedTilesByDir.set('north', []);
    connectedTilesByDir.set('east', []);
    connectedTilesByDir.set('south', []);
    connectedTilesByDir.set('west', []);

    const allTiles = worldMap.getAllTiles();
    for (const tile of allTiles) {
      const dir = ExternalConnectionManager.getExternalConnectionDirection(tile, gridSize);
      if (dir) {
        connectedTilesByDir.get(dir)?.push(tile);
      } else if (tile.isExternalConnection) {
        // もはや外部を向いていないタイルの接続フラグを解除
        tile.isExternalConnection = false;
        tile.externalCityId = undefined;
      }
    }

    for (const city of this.cities) {
      const borderTiles = connectedTilesByDir.get(city.direction) || [];
      const isConnected = borderTiles.length > 0;
      const wasConnected = city.connected;

      city.connected = isConnected;
      city.connectedTileCount = borderTiles.length;

      // 該当する境界線路タイルに外部接続都市情報を同期
      for (const t of borderTiles) {
        t.externalCityId = city.id;
        t.isExternalConnection = true;
        if (!t.stationName || t.stationName.includes('方面')) {
          t.stationName = `${city.name} 直通`;
        }
      }

      if (isConnected && !wasConnected && onConnected) {
        onConnected(city);
      }

      results.push(isConnected);
    }

    return results;
  }

  /**
   * 1時間ごとの時間経過時に呼び出され、接続されている境界線路タイルに乗客・貨物を補充する
   * 時間帯需要係数によって乗客補充数が増減する
   */
  public updateHourlySupply(worldMap: WorldMap, hour: number = 12): void {
    const gridSize = worldMap.gridSize || WorldMap.GRID_SIZE;
    const allTiles = worldMap.getAllTiles();

    for (const city of this.cities) {
      if (!city.connected) continue;

      // 該当する都市へ延伸されている境界線路タイルを取得
      const borderTiles = allTiles.filter(
        t => ExternalConnectionManager.getExternalConnectionDirection(t, gridSize) === city.direction
      );
      if (borderTiles.length === 0) continue;

      const mult = ExternalConnectionManager.getCityPassengerDemandMultiplier(city, hour);
      const effectivePassengerSupply = Math.max(5, Math.round(city.passengerSupplyRate * mult));
      const perTilePassenger = Math.max(5, Math.floor(effectivePassengerSupply / borderTiles.length));
      const perTileCargo = Math.max(1, Math.floor(city.cargoSupplyRate / borderTiles.length));

      for (const tile of borderTiles) {
        const curPass = tile.stationPassengers ?? 0;
        const curCargo = tile.cargoContainers ?? 0;
        // 需要に応じた最大待機乗客数（基本300人、ラッシュ時は最大600人まで受け入れ可能）
        const maxPassCap = Math.round(300 * Math.max(1.0, mult));
        tile.stationPassengers = Math.min(maxPassCap, curPass + perTilePassenger);
        tile.cargoContainers = Math.min(20, curCargo + perTileCargo);
      }
    }
  }

  /**
   * 指定した座標の外部接続都市ノードを取得
   */
  public getCityByPos(x: number, z: number, worldMap?: WorldMap): ExternalCityNode | undefined {
    if (!worldMap) return undefined;
    const tile = worldMap.getTile(x, z);
    if (!tile) return undefined;
    const dir = ExternalConnectionManager.getExternalConnectionDirection(tile, worldMap.gridSize);
    return dir ? this.getCityByDirection(dir) : undefined;
  }

  /**
   * 指定した方角の都市ノードを取得
   */
  public getCityByDirection(direction: 'north' | 'east' | 'south' | 'west'): ExternalCityNode | undefined {
    return this.cities.find(c => c.direction === direction);
  }

  /**
   * 指定した都市IDのノードを取得
   */
  public getCityById(id: string): ExternalCityNode | undefined {
    return this.cities.find(c => c.id === id);
  }

  /**
   * 全都市ノードの一覧を取得
   */
  public getAllCities(): readonly ExternalCityNode[] {
    return this.cities;
  }

  /**
   * 輸送実績の記録（乗客）
   */
  public recordPassengersTransported(cityId: string, count: number): void {
    const city = this.getCityById(cityId);
    if (city) {
      city.totalPassengersTransported += count;
    }
  }

  /**
   * 輸出実績の記録（貨物）
   */
  public recordCargoExported(cityId: string, count: number): void {
    const city = this.getCityById(cityId);
    if (city) {
      city.totalCargoExported += count;
    }
  }

  /**
   * スナップショット保存
   */
  public toSnapshot(): ExternalConnectionSnapshot {
    return {
      cities: JSON.parse(JSON.stringify(this.cities))
    };
  }

  /**
   * スナップショットから復元
   */
  public loadFromSnapshot(snapshot: Partial<ExternalConnectionSnapshot>): void {
    if (snapshot && Array.isArray(snapshot.cities)) {
      this.cities = JSON.parse(JSON.stringify(snapshot.cities));
    }
  }
}

