import * as THREE from 'three';
import { WorldMap } from '../WorldMap';
import { ModelFactory } from '../../models/ModelFactory';
import { GridLayer } from '../../core/types';
import { GRID_LAYERS } from '../../core/constants';
import { checkCoupleEligibility } from '../../core/CouplingSystem';
import { TrainInstance } from './types';
import { TrainKinematics } from './TrainKinematics';

/**
 * 衝突防止・ATS・在線占有管理専門クラス
 */
export class TrainCollisionSystem {
  private kinematics: TrainKinematics;

  constructor(kinematics: TrainKinematics) {
    this.kinematics = kinematics;
  }

  /**
   * ① 最大10両編成の全車両（先頭車〜最後尾車）が存在する全タイル座標を算出
   */
  public calculateOccupiedTiles(train: TrainInstance, worldMap: WorldMap): Array<{ x: number; z: number; layer: GridLayer }> {
    const tilesMap = new Map<string, { x: number; z: number; layer: GridLayer }>();

    for (let i = 0; i < train.carCount; i++) {
      const lagDist = i * ModelFactory.CAR_SPACING;
      const sample = this.kinematics.sampleHistoryAtLag(train.pathHistory, lagDist);
      const tx = Math.round(sample.pos.x / WorldMap.TILE_SIZE);
      const tz = Math.round(sample.pos.z / WorldMap.TILE_SIZE);

      let bestLayer: GridLayer = sample.layer ?? train.currentTile.layer;
      let minDiff = Infinity;

      const candidateLayers: GridLayer[] = [...GRID_LAYERS];
      const baseLayer = sample.layer ?? train.currentTile.layer ?? 1;
      candidateLayers.sort((l1, l2) => Math.abs(l1 - baseLayer) - Math.abs(l2 - baseLayer));

      for (const lyr of candidateLayers) {
        const t = worldMap.getTile(tx, tz, lyr);
        if (t && this.kinematics.isTrackTile(t)) {
          const h = this.kinematics.getTileInterpolatedHeight(t, lyr);
          const diff = Math.abs(h - sample.pos.y);
          if (diff < minDiff && diff < 1.8) {
            minDiff = diff;
            bestLayer = lyr;
          }
        }
      }

      const key = `${tx},${bestLayer},${tz}`;
      if (!tilesMap.has(key)) {
        tilesMap.set(key, { x: tx, z: tz, layer: bestLayer });
      }
    }

    const targetLayer = train.targetTile.layer;
    const targetKey = `${train.targetTile.x},${targetLayer},${train.targetTile.z}`;
    if (!tilesMap.has(targetKey)) {
      tilesMap.set(targetKey, { x: train.targetTile.x, z: train.targetTile.z, layer: targetLayer });
    }

    return Array.from(tilesMap.values());
  }

  /**
   * 連結待機中の先行列車に対して、ATSをバイパスして進入を許可するか判定
   */
  public canBypassAtsForCoupling(follower: TrainInstance, leader: TrainInstance, worldMap: WorldMap): boolean {
    if (!leader.isStopped) return false;
    // 異なる車種（旅客と貨物、特急と通勤型など）の異種併合を防止
    if (follower.model.id !== leader.model.id) return false;

    const followerTile = worldMap.getTile(follower.currentTile.x, follower.currentTile.z, follower.currentTile.layer);
    const leaderTile = worldMap.getTile(leader.currentTile.x, leader.currentTile.z, leader.currentTile.layer);
    if (!followerTile || !leaderTile) return false;
    if (!leaderTile.type.startsWith('station')) return false;

    // 同じ階層かつ同じ線路軸上にいなければ別ホームなので不可
    if (follower.currentTile.layer !== leader.currentTile.layer) return false;
    const isEastWest = Math.abs(leader.direction.x) > 0.5;
    if (isEastWest && follower.currentTile.z !== leader.currentTile.z) return false;
    if (!isEastWest && follower.currentTile.x !== leader.currentTile.x) return false;

    // 駅ID(stationGroupId)ではなく、番線・ホームID(stationPlatformId)で同一ホームか判定する
    const leaderPlatformId = leaderTile.stationPlatformId ?? leaderTile.stationGroupId;
    if (!leaderPlatformId) return false;

    // 同じホームで分割された直後の編成（既に lastStationGroupId がこのホームになっている編成）は再連結させない
    if (follower.lastStationGroupId === leaderPlatformId) return false;

    const targetTileData = worldMap.getTile(follower.targetTile.x, follower.targetTile.z, follower.targetTile.layer);
    let followerPlatformId =
      (followerTile.stationPlatformId ?? followerTile.stationGroupId) ??
      (targetTileData?.stationPlatformId ?? targetTileData?.stationGroupId);

    // 手前の線路から駅へ進入中（targetTileの次が駅）の場合も検出
    if (!followerPlatformId) {
      const next1 = this.kinematics.findNextTrackTile(follower.targetTile.x, follower.targetTile.z, follower.targetTile.layer, follower.direction, false, worldMap);
      if (next1) {
        const next1Tile = worldMap.getTile(next1.x, next1.z, (next1.layer ?? follower.targetTile.layer) as GridLayer);
        followerPlatformId = next1Tile?.stationPlatformId ?? next1Tile?.stationGroupId;
      }
    }

    if (!followerPlatformId || followerPlatformId !== leaderPlatformId) return false;

    const effectiveLength = worldMap.getStationRunLength(leader.currentTile.x, leader.currentTile.z, leader.currentTile.layer) || 1;
    return checkCoupleEligibility(leader.carCount, follower.carCount, effectiveLength).eligible;
  }

  /**
   * ATS衝突防止チェック（空間ハッシュ・タイル逆引きによる O(N) 高速化）
   */
  public checkAtsCollisionAvoidance(trains: TrainInstance[], worldMap: WorldMap, speedMultiplier: number = 1): void {
    if (trains.length === 0) return;

    // 1. 在線タイル逆引きインデックスの構築 (O(N))
    const tileOccupancyMap = new Map<string, TrainInstance>();
    for (const train of trains) {
      if (!train || !train.occupiedTiles || train.occupiedTiles.length === 0) continue;
      for (const t of train.occupiedTiles) {
        const key = `${t.x},${t.layer},${t.z}`;
        const existing = tileOccupancyMap.get(key);
        if (!existing || (!existing.isStopped && train.isStopped)) {
          tileOccupancyMap.set(key, train);
        }
      }
    }

    // 2. 各列車の前方探索と ATS 判定 (O(N))
    for (let i = 0; i < trains.length; i++) {
      const trainA = trains[i];
      if (!trainA || !trainA.occupiedTiles || trainA.occupiedTiles.length === 0) continue;

      if (trainA.isStopped) {
        trainA.isAtsBraked = false;
        trainA.isApproachingCouple = false;
        continue;
      }

      trainA.isApproachingCouple = false;

      const candidateTrains = new Set<TrainInstance>();

      // (a) 自列車の占有タイル自体の重複チェック
      for (const ta of trainA.occupiedTiles) {
        const key = `${ta.x},${ta.layer},${ta.z}`;
        const occupant = tileOccupancyMap.get(key);
        if (occupant && occupant.id !== trainA.id) {
          candidateTrains.add(occupant);
        }
      }

      // (b) 目標タイルの検索
      const targetKey = `${trainA.targetTile.x},${trainA.targetTile.layer},${trainA.targetTile.z}`;
      const targetOccupant = tileOccupancyMap.get(targetKey);
      if (targetOccupant && targetOccupant.id !== trainA.id) {
        candidateTrains.add(targetOccupant);
      }

      // (c) 直近1マス先・2マス先の先読み検索
      const next1 = this.kinematics.findNextTrackTile(trainA.targetTile.x, trainA.targetTile.z, trainA.targetTile.layer, trainA.direction, false, worldMap);
      if (next1) {
        const l1 = (next1.layer ?? trainA.targetTile.layer) as GridLayer;
        const key1 = `${next1.x},${l1},${next1.z}`;
        const occupant1 = tileOccupancyMap.get(key1);
        if (occupant1 && occupant1.id !== trainA.id) {
          candidateTrains.add(occupant1);
        }

        const dir1 = new THREE.Vector3(next1.x - trainA.targetTile.x, 0, next1.z - trainA.targetTile.z).normalize();
        const next2 = this.kinematics.findNextTrackTile(next1.x, next1.z, l1, dir1, false, worldMap);
        if (next2) {
          const l2 = (next2.layer ?? l1) as GridLayer;
          const key2 = `${next2.x},${l2},${next2.z}`;
          const occupant2 = tileOccupancyMap.get(key2);
          if (occupant2 && occupant2.id !== trainA.id) {
            candidateTrains.add(occupant2);
          }
        }
      }

      if (candidateTrains.size === 0) {
        trainA.isAtsBraked = false;
        trainA.isApproachingCouple = false;
        continue;
      }

      let mustStop = false;

      // 【高倍速LOD】speedMultiplier >= 60 の場合は、台車の微細な幾何計算ループをバイパス
      if (speedMultiplier >= 60) {
        for (const trainB of candidateTrains) {
          const dx = trainB.frontPosition.x - trainA.frontPosition.x;
          const dz = trainB.frontPosition.z - trainA.frontPosition.z;
          const dot = dx * trainA.direction.x + dz * trainA.direction.z;
          const l1 = next1 ? ((next1.layer ?? trainA.targetTile.layer) as GridLayer) : trainA.targetTile.layer;
          const isTargetBlocked = trainB.occupiedTiles.some(ot =>
            (ot.x === trainA.targetTile.x && ot.z === trainA.targetTile.z && ot.layer === trainA.targetTile.layer) ||
            (next1 !== null && ot.x === next1.x && ot.z === next1.z && ot.layer === l1)
          );

          if (dot <= 0 && !isTargetBlocked) {
            continue; // 後方にいる列車なので自列車は停止しない
          }

          if (this.canBypassAtsForCoupling(trainA, trainB, worldMap)) {
            trainA.isApproachingCouple = true;
            continue;
          }
          mustStop = true;
          break;
        }
        trainA.isAtsBraked = mustStop;
        continue;
      }

      // 通常速度時: 各車両・台車の位置から高精度に距離判定
      for (const trainB of candidateTrains) {
        const checkPoints = [trainB.frontPosition, ...trainB.cars.map(c => c.position)];
        let closestDist = Infinity;
        let isAhead = false;

        for (const pt of checkPoints) {
          if (Math.abs(trainA.frontPosition.y - pt.y) > 1.5) {
            continue;
          }

          const dx = pt.x - trainA.frontPosition.x;
          const dz = pt.z - trainA.frontPosition.z;
          const horizontalDist = Math.hypot(dx, dz);

          const toPtHoriz = new THREE.Vector3(dx, 0, dz);
          const dot = toPtHoriz.dot(trainA.direction);

          if (dot > 0) {
            if (horizontalDist < closestDist) {
              closestDist = horizontalDist;
              isAhead = true;
            }
          } else if (horizontalDist < 2.0) {
            if (horizontalDist < closestDist) {
              closestDist = horizontalDist;
            }
          }
        }

        if (isAhead && closestDist < 4.2) {
          if (this.canBypassAtsForCoupling(trainA, trainB, worldMap)) {
            // 併合進入時は安全のため徐行速度に減速して最後尾へアプローチ
            trainA.isApproachingCouple = true;
            continue;
          }
          mustStop = true;
          break;
        }

        if (closestDist < 2.0) {
          if (this.canBypassAtsForCoupling(trainA, trainB, worldMap)) {
            trainA.isApproachingCouple = true;
            continue;
          }
          mustStop = true;
          break;
        }
      }

      trainA.isAtsBraked = mustStop;
    }
  }

  /**
   * ⑤ 指定座標・階層が運行中列車のいずれかによって占有されているかを判定
   */
  public isTileOccupiedByTrain(
    x: number,
    z: number,
    layer: GridLayer,
    trains: TrainInstance[],
    worldMap: WorldMap
  ): boolean {
    const tile = worldMap.getTile(x, z, layer);
    const isEmptyTile = !tile || tile.type === 'empty';

    for (const train of trains) {
      if (isEmptyTile) {
        const isPhysicallyNear = train.cars.some(car => {
          const distSq = (car.position.x - x * WorldMap.TILE_SIZE) ** 2 +
                         (car.position.z - z * WorldMap.TILE_SIZE) ** 2;
          return distSq < (0.8 * WorldMap.TILE_SIZE) ** 2;
        });
        if (isPhysicallyNear) return true;
        continue;
      }

      if (train.occupiedTiles && train.occupiedTiles.some(t => t.x === x && t.z === z && t.layer === layer)) {
        return true;
      }
      if ((train.currentTile.x === x && train.currentTile.z === z && train.currentTile.layer === layer) ||
          (train.targetTile.x === x && train.targetTile.z === z && train.targetTile.layer === layer)) {
        return true;
      }
    }
    return false;
  }
}
