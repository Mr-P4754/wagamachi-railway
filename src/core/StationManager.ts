import { GridLayer, PlatformData, StationData } from './types';

export interface PlatformSaveData {
  id: string;
  stationId: string;
  platformNumber: number;
  length: number;
  trackAxis: number;
  tiles: Array<{ x: number; z: number; layer: GridLayer }>;
  isSignalYard: boolean;
  isCargoStation?: boolean;
  dailyPassengers: number;
  previousDayPassengers: number;
  twoDaysAgoPassengers?: number;
  dailyLoadedCargo?: number;
  dailyUnloadedCargo?: number;
  previousDayLoadedCargo?: number;
  previousDayUnloadedCargo?: number;
  totalPassengers: number;
  totalRevenue: number;
}

export interface StationSaveData {
  stations: Array<{
    id: string;
    name: string;
    platforms: PlatformSaveData[];
    isSignalYard: boolean;
    isCargoStation?: boolean;
    dailyPassengers: number;
    previousDayPassengers: number;
    twoDaysAgoPassengers?: number;
    dailyLoadedCargo?: number;
    dailyUnloadedCargo?: number;
    previousDayLoadedCargo?: number;
    previousDayUnloadedCargo?: number;
    totalPassengers: number;
    totalRevenue: number;
    maintenance: number;
    netProfit: number;
  }>;
  nextStationNumber: number;
  nextYardNumber: number;
}

/**
 * 複数ホーム構造（1番線・2番線…）および信号場・留置線を統括管理するマネージャークラス
 */
export class StationManager {
  private stations: Map<string, StationData> = new Map();
  private tileToPlatform: Map<string, { stationId: string; platformId: string }> = new Map();
  private nextStationNumber: number = 1;
  private nextYardNumber: number = 1;

  constructor() {}

  /**
   * タイル座標キーを生成
   */
  private makeTileKey(x: number, z: number, layer: GridLayer): string {
    const safeLayer = (layer ?? 1) as GridLayer;
    return `${x},${safeLayer},${z}`;
  }

  /**
   * 駅一覧を取得
   */
  public getStations(): StationData[] {
    return Array.from(this.stations.values());
  }

  /**
   * 指定したIDの駅を取得
   */
  public getStation(id: string): StationData | undefined {
    return this.stations.get(id);
  }

  /**
   * タイル座標から所属する駅および番線データを取得
   */
  public getPlatformByTile(x: number, z: number, layer: GridLayer): { station: StationData; platform: PlatformData } | undefined {
    const key = this.makeTileKey(x, z, layer);
    const mapping = this.tileToPlatform.get(key);
    if (!mapping) return undefined;

    const station = this.stations.get(mapping.stationId);
    if (!station) return undefined;

    const platform = station.platforms.find(p => p.id === mapping.platformId);
    if (!platform) return undefined;

    return { station, platform };
  }

  /**
   * ホーム（番線）の登録または更新
   * 近接・平行するホームがある場合は、同一駅の「N番線」として自動統合する
   */
  public registerPlatform(params: {
    tiles: Array<{ x: number; z: number; layer: GridLayer }>;
    length: number;
    trackAxis: number; // 0: 南北, 1: 東西
    isSignalYard: boolean;
    isCargoStation?: boolean;
    customName?: string;
    existingStationId?: string;
  }): { station: StationData; platform: PlatformData } {
    const { tiles, length, trackAxis, isSignalYard, isCargoStation, customName, existingStationId } = params;
    const isCargo = !!isCargoStation;
    if (tiles.length === 0) {
      throw new Error('Platform must contain at least one tile');
    }

    const firstTile = tiles[0];

    // 既存の駅ID指定がある場合はそれを優先
    let targetStation: StationData | undefined;
    if (existingStationId) {
      targetStation = this.stations.get(existingStationId);
    }

    // 指定がない場合、近接（平行線路上）の駅を検索して複数番線として自動統合
    if (!targetStation) {
      targetStation = this.findNearbyStation(tiles, trackAxis, isSignalYard, isCargo);
    }

    // 新規駅の作成
    if (!targetStation) {
      const stationId = existingStationId || (isSignalYard
        ? `yard_${Date.now()}_${firstTile.x}_${firstTile.z}`
        : (isCargo
          ? `cargo_${Date.now()}_${firstTile.x}_${firstTile.z}`
          : `st_${Date.now()}_${firstTile.x}_${firstTile.z}`));
      const defaultName = customName || (
        isSignalYard
          ? `第${this.nextYardNumber++}信号場`
          : (isCargo
            ? `第${this.nextStationNumber++}貨物駅`
            : `第${this.nextStationNumber++}駅`)
      );

      const baseMaintenance = isSignalYard ? 10000 : (isCargo ? 25000 : 50000);
      targetStation = {
        id: stationId,
        name: defaultName,
        platforms: [],
        isSignalYard,
        isCargoStation: isCargo,
        dailyPassengers: 0,
        previousDayPassengers: 0,
        dailyLoadedCargo: 0,
        dailyUnloadedCargo: 0,
        previousDayLoadedCargo: 0,
        previousDayUnloadedCargo: 0,
        totalPassengers: 0,
        totalRevenue: 0,
        maintenance: baseMaintenance,
        netProfit: -baseMaintenance
      };
      this.stations.set(stationId, targetStation);
    }

    // ホームIDの生成と番線番号の採番
    const platformNumber = targetStation.platforms.length + 1;
    const platformId = `${targetStation.id}_p${platformNumber}`;

    const newPlatform: PlatformData = {
      id: platformId,
      stationId: targetStation.id,
      platformNumber,
      length,
      trackAxis,
      tiles,
      isSignalYard,
      isCargoStation: isCargo,
      dailyPassengers: 0,
      previousDayPassengers: 0,
      dailyLoadedCargo: 0,
      dailyUnloadedCargo: 0,
      previousDayLoadedCargo: 0,
      previousDayUnloadedCargo: 0,
      totalPassengers: 0,
      totalRevenue: 0
    };

    targetStation.platforms.push(newPlatform);

    // タイル対ホームのマッピングを登録
    for (const t of tiles) {
      this.tileToPlatform.set(this.makeTileKey(t.x, t.z, t.layer), {
        stationId: targetStation.id,
        platformId: newPlatform.id
      });
    }

    // 駅の維持管理費を更新（ホーム数に比例、信号場:2万、貨物駅:5万、旅客駅:20万）
    const baseMaintenance = isSignalYard ? 20000 : (isCargo ? 50000 : 200000);
    targetStation.maintenance = targetStation.platforms.length * baseMaintenance;
    targetStation.netProfit = targetStation.totalRevenue - targetStation.maintenance;

    return { station: targetStation, platform: newPlatform };
  }

  /**
   * 近接・平行するホームが存在するかを探索（同一駅の複数番線として統合するため）
   * 距離が2マス以内で同じ軌道軸・同じ階層の既存駅を対象とする
   */
  private findNearbyStation(
    tiles: Array<{ x: number; z: number; layer: GridLayer }>,
    trackAxis: number,
    isSignalYard: boolean,
    isCargoStation: boolean = false
  ): StationData | undefined {
    for (const tile of tiles) {
      for (const station of this.stations.values()) {
        if (station.isSignalYard !== isSignalYard) continue;
        if (!!station.isCargoStation !== isCargoStation) continue;

        for (const platform of station.platforms) {
          if (platform.trackAxis !== trackAxis) continue;

          for (const pt of platform.tiles) {
            if (pt.layer !== tile.layer) continue;
            // 平行する線路（南北軸なら X差が1〜2マス以内で Zが重複または近接）
            const dx = Math.abs(pt.x - tile.x);
            const dz = Math.abs(pt.z - tile.z);
            if (trackAxis === 0 && dx >= 1 && dx <= 2 && dz <= 2) {
              return station;
            }
            // 東西軸なら Z差が1〜2マス以内で Xが重複または近接
            if (trackAxis === 1 && dz >= 1 && dz <= 2 && dx <= 2) {
              return station;
            }
          }
        }
      }
    }
    return undefined;
  }

  /**
   * 駅名のリネーム
   * プレイヤーが自由に変更した名前を同一駅の全ホームに反映する
   */
  public renameStation(stationId: string, newName: string): boolean {
    const trimmed = newName.trim();
    if (!trimmed) return false;

    const station = this.stations.get(stationId);
    if (!station) return false;

    station.name = trimmed;
    return true;
  }

  /**
   * ホーム有効長の変更（1〜10両）
   * 駅の延伸・短縮に伴う新タイルリストが渡された場合は、マッピングとタイル一覧も同期更新する
   */
  public updatePlatformLength(
    stationId: string,
    platformId: string,
    newLength: number,
    newTiles?: Array<{ x: number; z: number; layer: GridLayer }>
  ): boolean {
    const station = this.stations.get(stationId);
    if (!station) return false;

    const platform = station.platforms.find(p => p.id === platformId);
    if (!platform) return false;

    platform.length = Math.max(1, Math.min(10, newLength));

    if (newTiles && newTiles.length > 0) {
      // 以前のタイルマッピングを解除
      for (const t of platform.tiles) {
        this.tileToPlatform.delete(this.makeTileKey(t.x, t.z, t.layer));
      }
      // 新しいタイルリストを設定
      platform.tiles = newTiles.map(t => ({ x: t.x, z: t.z, layer: t.layer }));
      for (const t of newTiles) {
        this.tileToPlatform.set(this.makeTileKey(t.x, t.z, t.layer), {
          stationId: station.id,
          platformId: platform.id
        });
      }
    }

    return true;
  }

  /**
   * ホーム有効長と編成長の進入安全判定
   * 「ホーム有効長 ＜ 編成長」の列車が進入した場合は、客扱い停止（過走・ホームはみ出し）防止のため
   * シンプルに「停車不可（通過扱い）」とする安全判定
   */
  public canTrainStopAtPlatform(
    arg1: string | PlatformData | number,
    arg2: string | PlatformData | number,
    arg3?: number
  ): { allowed: boolean; reason?: string } {
    let platformLength = 1;
    let carCount = 1;

    if (typeof arg1 === 'string' && typeof arg2 === 'string' && typeof arg3 === 'number') {
      // (stationId, platformId, carCount)
      const station = this.stations.get(arg1);
      const plat = station?.platforms.find(p => p.id === arg2);
      platformLength = plat?.length ?? 1;
      carCount = arg3;
    } else if (typeof arg1 === 'number' && typeof arg2 === 'object' && arg2 !== null) {
      // (carCount, platform)
      carCount = arg1;
      platformLength = (arg2 as PlatformData).length;
    } else if (typeof arg1 === 'object' && arg1 !== null && typeof arg2 === 'number') {
      // (platform, carCount)
      platformLength = (arg1 as PlatformData).length;
      carCount = arg2;
    } else if (typeof arg1 === 'number' && typeof arg2 === 'number') {
      // (carCount, length)
      carCount = arg1;
      platformLength = arg2;
    }

    const allowed = carCount <= platformLength;
    return {
      allowed,
      reason: allowed ? undefined : `編成長(${carCount}両)がホーム有効長(${platformLength}両)を超過しているため停車不可（通過扱い）`
    };
  }

  /**
   * タイル撤去時のホーム削除処理
   */
  public removeTileFromPlatform(x: number, z: number, layer: GridLayer): void {
    const key = this.makeTileKey(x, z, layer);
    const mapping = this.tileToPlatform.get(key);
    if (!mapping) return;

    this.tileToPlatform.delete(key);
    const station = this.stations.get(mapping.stationId);
    if (!station) return;

    const platform = station.platforms.find(p => p.id === mapping.platformId);
    if (!platform) return;

    platform.tiles = platform.tiles.filter(t => !(t.x === x && t.z === z && t.layer === layer));

    // ホームの全タイルが撤去されたらホームを除去
    if (platform.tiles.length === 0) {
      station.platforms = station.platforms.filter(p => p.id !== platform.id);
      // 番線番号を再採番
      station.platforms.forEach((p, idx) => {
        p.platformNumber = idx + 1;
      });
    }

    // 駅の全ホームが撤去されたら駅を除去
    if (station.platforms.length === 0) {
      this.stations.delete(station.id);
    } else {
      const baseMaintenance = station.isSignalYard ? 20000 : (station.isCargoStation ? 50000 : 200000);
      station.maintenance = station.platforms.length * baseMaintenance;
      station.netProfit = station.totalRevenue - station.maintenance;
    }
  }

  /**
   * 駅の利用客数・運賃収入の加算
   * 信号場・留置線の場合は乗降客数0・運賃0を厳守
   */
  public addBoardingRecord(stationId: string, platformId: string, passengers: number, fare: number): void {
    const station = this.stations.get(stationId);
    if (!station || station.isSignalYard) return; // 信号場は乗降客ゼロ

    const platform = station.platforms.find(p => p.id === platformId);
    if (platform) {
      platform.dailyPassengers += passengers;
      platform.totalPassengers += passengers;
      platform.totalRevenue += fare;
    }

    station.dailyPassengers += passengers;
    station.totalPassengers += passengers;
    station.totalRevenue += fare;
    station.netProfit = station.totalRevenue - station.maintenance;
  }

  /**
   * 貨物駅での積み込み・荷下ろし実績と運賃収入を加算
   */
  public addCargoRecord(stationId: string, platformId: string, loaded: number, unloaded: number, revenue: number): void {
    const station = this.stations.get(stationId);
    if (!station) return;

    const platform = station.platforms.find(p => p.id === platformId);
    if (platform) {
      platform.dailyLoadedCargo = (platform.dailyLoadedCargo ?? 0) + loaded;
      platform.dailyUnloadedCargo = (platform.dailyUnloadedCargo ?? 0) + unloaded;
      platform.totalRevenue += revenue;
    }

    station.dailyLoadedCargo = (station.dailyLoadedCargo ?? 0) + loaded;
    station.dailyUnloadedCargo = (station.dailyUnloadedCargo ?? 0) + unloaded;
    station.totalRevenue += revenue;
    station.netProfit = station.totalRevenue - station.maintenance;
  }

  /**
   * 日次（日付変更時）の乗降客数・貨物取扱数カウンタを前日に退避してリセット
   */
  public resetDailyPassengers(): void {
    for (const station of this.stations.values()) {
      station.twoDaysAgoPassengers = station.previousDayPassengers ?? 0;
      station.previousDayPassengers = station.dailyPassengers;
      station.dailyPassengers = 0;
      station.previousDayLoadedCargo = station.dailyLoadedCargo ?? 0;
      station.dailyLoadedCargo = 0;
      station.previousDayUnloadedCargo = station.dailyUnloadedCargo ?? 0;
      station.dailyUnloadedCargo = 0;
      for (const platform of station.platforms) {
        platform.twoDaysAgoPassengers = platform.previousDayPassengers ?? 0;
        platform.previousDayPassengers = platform.dailyPassengers;
        platform.dailyPassengers = 0;
        platform.previousDayLoadedCargo = platform.dailyLoadedCargo ?? 0;
        platform.dailyLoadedCargo = 0;
        platform.previousDayUnloadedCargo = platform.dailyUnloadedCargo ?? 0;
        platform.dailyUnloadedCargo = 0;
      }
    }
  }

  /**
   * 全クリア（マップリセット時）
   */
  public clear(): void {
    this.stations.clear();
    this.tileToPlatform.clear();
    this.nextStationNumber = 1;
    this.nextYardNumber = 1;
  }

  /**
   * 【駅の記憶喪失解消】駅システム全体のシリアライズ
   * 各駅の番線構成、乗降客統計、財務データ、採番カウンタを出力
   */
  public serialize(): StationSaveData {
    const stationsList: StationSaveData['stations'] = [];
    for (const st of this.stations.values()) {
      stationsList.push({
        id: st.id,
        name: st.name,
        isSignalYard: st.isSignalYard,
        isCargoStation: st.isCargoStation,
        dailyPassengers: st.dailyPassengers,
        previousDayPassengers: st.previousDayPassengers ?? 0,
        twoDaysAgoPassengers: st.twoDaysAgoPassengers ?? 0,
        dailyLoadedCargo: st.dailyLoadedCargo ?? 0,
        dailyUnloadedCargo: st.dailyUnloadedCargo ?? 0,
        previousDayLoadedCargo: st.previousDayLoadedCargo ?? 0,
        previousDayUnloadedCargo: st.previousDayUnloadedCargo ?? 0,
        totalPassengers: st.totalPassengers,
        totalRevenue: st.totalRevenue,
        maintenance: st.maintenance,
        netProfit: st.netProfit,
        platforms: st.platforms.map(p => ({
          id: p.id,
          stationId: p.stationId,
          platformNumber: p.platformNumber,
          length: p.length,
          trackAxis: p.trackAxis,
          tiles: p.tiles.map(t => ({ x: t.x, z: t.z, layer: t.layer })),
          isSignalYard: p.isSignalYard,
          isCargoStation: p.isCargoStation,
          dailyPassengers: p.dailyPassengers,
          previousDayPassengers: p.previousDayPassengers ?? 0,
          twoDaysAgoPassengers: p.twoDaysAgoPassengers ?? 0,
          dailyLoadedCargo: p.dailyLoadedCargo ?? 0,
          dailyUnloadedCargo: p.dailyUnloadedCargo ?? 0,
          previousDayLoadedCargo: p.previousDayLoadedCargo ?? 0,
          previousDayUnloadedCargo: p.previousDayUnloadedCargo ?? 0,
          totalPassengers: p.totalPassengers,
          totalRevenue: p.totalRevenue
        }))
      });
    }

    return {
      stations: stationsList,
      nextStationNumber: this.nextStationNumber,
      nextYardNumber: this.nextYardNumber
    };
  }

  /**
   * 【駅の記憶喪失解消】駅システム全体のデシリアライズ
   * 保存された駅・ホーム・財務・乗客・番線・タイルマッピングを完全復元
   */
  public deserialize(data: StationSaveData): void {
    this.clear();
    if (!data) return;

    this.nextStationNumber = data.nextStationNumber ?? 1;
    this.nextYardNumber = data.nextYardNumber ?? 1;

    if (Array.isArray(data.stations)) {
      for (const st of data.stations) {
        const stationObj: StationData = {
          id: st.id,
          name: st.name,
          platforms: [],
          isSignalYard: !!st.isSignalYard,
          isCargoStation: !!st.isCargoStation,
          dailyPassengers: st.dailyPassengers ?? 0,
          previousDayPassengers: st.previousDayPassengers ?? 0,
          twoDaysAgoPassengers: st.twoDaysAgoPassengers ?? 0,
          dailyLoadedCargo: st.dailyLoadedCargo ?? 0,
          dailyUnloadedCargo: st.dailyUnloadedCargo ?? 0,
          previousDayLoadedCargo: st.previousDayLoadedCargo ?? 0,
          previousDayUnloadedCargo: st.previousDayUnloadedCargo ?? 0,
          totalPassengers: st.totalPassengers ?? 0,
          totalRevenue: st.totalRevenue ?? 0,
          maintenance: st.maintenance ?? 0,
          netProfit: st.netProfit ?? 0
        };

        if (Array.isArray(st.platforms)) {
          for (const p of st.platforms) {
            const platformObj: PlatformData = {
              id: p.id,
              stationId: p.stationId,
              platformNumber: p.platformNumber,
              length: p.length,
              trackAxis: p.trackAxis,
              tiles: Array.isArray(p.tiles) ? p.tiles.map(t => ({ x: t.x, z: t.z, layer: (t.layer ?? 1) as GridLayer })) : [],
              isSignalYard: !!p.isSignalYard,
              isCargoStation: !!p.isCargoStation,
              dailyPassengers: p.dailyPassengers ?? 0,
              previousDayPassengers: p.previousDayPassengers ?? 0,
              twoDaysAgoPassengers: p.twoDaysAgoPassengers ?? 0,
              dailyLoadedCargo: p.dailyLoadedCargo ?? 0,
              dailyUnloadedCargo: p.dailyUnloadedCargo ?? 0,
              previousDayLoadedCargo: p.previousDayLoadedCargo ?? 0,
              previousDayUnloadedCargo: p.previousDayUnloadedCargo ?? 0,
              totalPassengers: p.totalPassengers ?? 0,
              totalRevenue: p.totalRevenue ?? 0
            };
            stationObj.platforms.push(platformObj);

            for (const t of platformObj.tiles) {
              this.tileToPlatform.set(this.makeTileKey(t.x, t.z, t.layer), {
                stationId: stationObj.id,
                platformId: platformObj.id
              });
            }
          }
        }

        this.stations.set(stationObj.id, stationObj);
      }
    }
  }
}
