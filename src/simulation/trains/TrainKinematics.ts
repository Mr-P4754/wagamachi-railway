import * as THREE from 'three';
import { WorldMap, TileData } from '../WorldMap';
import { ModelFactory } from '../../models/ModelFactory';
import { GridLayer } from '../../core/types';
import { layerToHeight } from '../../core/Grid3D';
import { GRID_LAYERS } from '../../core/constants';
import { TrainInstance, PathSample } from './types';

/**
 * 物理移動・軌道追従・車両姿勢制御専門クラス
 */
export class TrainKinematics {
  /**
   * タイルの種類・階層・標高オフセットに応じた接続高さを取得
   */
  public getTileInterpolatedHeight(t?: TileData, defaultLayer: GridLayer = 1): number {
    if (!t) return layerToHeight(defaultLayer);
    const elev = t.elevationOffset ?? 0;
    const tLayer = t.layer ?? defaultLayer;
    const baseH = layerToHeight(tLayer, elev);
    if (t.type === 'rail_slope') {
      const part = t.slopePart ?? 0;
      return baseH + (part + 0.5) * 0.75;
    }
    if (t.type === 'rail_slope_underground') {
      const part = t.slopePart ?? 0;
      return elev - (part + 0.5) * 0.75;
    }
    return baseH;
  }

  /**
   * ベクトルから最も近い方位インデックス（0:東, 1:南, 2:西, 3:北）を算出
   */
  public vecToDirIdx(v: THREE.Vector3): number {
    let best = 0;
    let bestDot = -Infinity;
    for (let i = 0; i < 4; i++) {
      const d = WorldMap.DIRS[i];
      const dot = v.x * d.x + v.z * d.z;
      if (dot > bestDot + 1e-4) {
        bestDot = dot;
        best = i;
      }
    }
    return best;
  }

  /**
   * タイルが線路系オブジェクト（レール、駅ホーム、分岐器等）であるかを判定
   */
  public isTrackTile(t: TileData): boolean {
    return t.type.startsWith('rail') ||
           WorldMap.isStationTileType(t.type) ||
           t.type.startsWith('point_switch') ||
           t.type.startsWith('scissors_crossing') ||
           t.type === 'level_crossing' ||
           t.type === 'external_connection';
  }

  /**
   * 実際の線路接続（向き・曲線・勾配レベル・ポイント開通方向）に基づく次タイル探索
   */
  public findNextTrackTile(
    currX: number,
    currZ: number,
    currLayer: GridLayer,
    currentDir: THREE.Vector3,
    isSpawn: boolean = false,
    worldMap: WorldMap
  ): TileData | null {
    const curTile = worldMap.getTile(currX, currZ, currLayer);
    if (!curTile) return null;

    const curExits = WorldMap.getTileExits(curTile);
    if (curExits.length === 0) return null;

    const headingIdx = this.vecToDirIdx(currentDir);

    let candidateIdxs: number[];
    if (isSpawn) {
      const matching = curExits.find(e => e.idx === headingIdx);
      candidateIdxs = matching ? [matching.idx] : curExits.map(e => e.idx);
    } else if (curTile.type.startsWith('point_switch')) {
      const incomingSide = WorldMap.opposite(headingIdx);
      const forward = ((curTile.rotation % 4) + 4) % 4;
      const back = WorldMap.opposite(forward);
      const branchDir = curTile.switchBranchSide === 'left' ? WorldMap.rotateCCW(forward) : WorldMap.rotateCW(forward);

      if (incomingSide === forward || incomingSide === branchDir) {
        candidateIdxs = [back];
      } else {
        const targetExit = curTile.switchState === 'diverge' ? branchDir : forward;
        candidateIdxs = [targetExit];
      }
    } else {
      const backIdx = WorldMap.opposite(headingIdx);
      const forward = curExits.filter(e => e.idx !== backIdx).map(e => e.idx);
      candidateIdxs = forward.length > 0 ? forward : curExits.map(e => e.idx);
    }

    for (const idx of candidateIdxs) {
      const exit = curExits.find(e => e.idx === idx);
      if (!exit) continue;

      let nx: number;
      let nz: number;
      if (exit.targetOffset) {
        nx = currX + exit.targetOffset.dx;
        nz = currZ + exit.targetOffset.dz;
      } else {
        const d = WorldMap.DIRS[idx];
        nx = currX + d.x;
        nz = currZ + d.z;
      }

      const backIdx = WorldMap.opposite(idx);

      let neighbor = worldMap.getTile(nx, nz, currLayer);
      let nExits = neighbor && this.isTrackTile(neighbor) ? WorldMap.getTileExits(neighbor) : [];
      let nExit = nExits.find(e => e.idx === backIdx);

      if (!nExit) {
        for (const candLayer of GRID_LAYERS) {
          if (candLayer === currLayer) continue;
          const candTile = worldMap.getTile(nx, nz, candLayer);
          if (!candTile || !this.isTrackTile(candTile)) continue;
          const candExits = WorldMap.getTileExits(candTile);
          const candExit = candExits.find(e => e.idx === backIdx);
          if (candExit) {
            if (exit.worldHeight !== undefined && candExit.worldHeight !== undefined) {
              if (Math.abs(exit.worldHeight - candExit.worldHeight) <= 0.05) {
                neighbor = candTile;
                nExits = candExits;
                nExit = candExit;
                break;
              }
            } else if (exit.level === candExit.level) {
              neighbor = candTile;
              nExits = candExits;
              nExit = candExit;
              break;
            }
          }
        }
      }

      if (!neighbor || !nExit) continue;

      if (exit.worldHeight !== undefined && nExit.worldHeight !== undefined) {
        if (Math.abs(exit.worldHeight - nExit.worldHeight) > 0.05) {
          continue;
        }
      } else if (nExit.level !== exit.level) {
        continue;
      }

      return neighbor;
    }

    return null;
  }

  /**
   * 次に進むべきタイルを決定し、方向・目標タイルを更新する
   */
  public resolveNextTileOrReverse(train: TrainInstance, worldMap: WorldMap): void {
    const next = this.findNextTrackTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer, train.direction, false, worldMap);
    if (next) {
      let newDir = new THREE.Vector3(next.x - train.currentTile.x, 0, next.z - train.currentTile.z).normalize();
      const curTile = worldMap.getTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer);
      if (curTile && curTile.type.startsWith('scissors_crossing')) {
        const curExits = WorldMap.getTileExits(curTile);
        const headingIdx = this.vecToDirIdx(train.direction);
        const backIdx = WorldMap.opposite(headingIdx);
        const fwdExit = curExits.find(e => e.idx !== backIdx);
        if (fwdExit && !fwdExit.targetOffset) {
          const straightD = WorldMap.DIRS[fwdExit.idx];
          newDir = new THREE.Vector3(straightD.x, 0, straightD.z).normalize();
        }
      }

      train.direction.copy(newDir);
      train.targetTile = { x: next.x, z: next.z, layer: (next.layer ?? train.currentTile.layer) as GridLayer };
      train.isTrapped = false;
    } else {
      this.reverseTrainDirection(train, worldMap);
      const afterRevNext = this.findNextTrackTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer, train.direction, false, worldMap);
      if (!afterRevNext) {
        train.isTrapped = true;
        train.speed = 0;
      } else {
        train.isTrapped = false;
      }
    }
  }

  /**
   * 現在の progress に応じた先頭車のワールド位置 frontPosition を算出・更新
   */
  public updateTrainFrontPosition(train: TrainInstance, worldMap: WorldMap): void {
    const fromTile = worldMap.getTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer);
    const toTile = worldMap.getTile(train.targetTile.x, train.targetTile.z, train.targetTile.layer);
    const fromH = this.getTileInterpolatedHeight(fromTile, train.currentTile.layer);
    const toH = this.getTileInterpolatedHeight(toTile, train.targetTile.layer);
    train.heightY = THREE.MathUtils.lerp(fromH, toH, train.progress);

    const fromPos = new THREE.Vector3(
      train.currentTile.x * WorldMap.TILE_SIZE,
      fromH,
      train.currentTile.z * WorldMap.TILE_SIZE
    );
    const toPos = new THREE.Vector3(
      train.targetTile.x * WorldMap.TILE_SIZE,
      toH,
      train.targetTile.z * WorldMap.TILE_SIZE
    );
    train.frontPosition.lerpVectors(fromPos, toPos, train.progress);
  }

  /**
   * 先頭車の最新位置・姿勢を経路履歴（pathHistory）へ即座に記録・同期する
   */
  public recordCurrentHeadSample(train: TrainInstance, worldMap: WorldMap): void {
    this.updateTrainFrontPosition(train, worldMap);
    const fromTile = worldMap.getTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer);
    const toTile = worldMap.getTile(train.targetTile.x, train.targetTile.z, train.targetTile.layer);
    const fromH = this.getTileInterpolatedHeight(fromTile, train.currentTile.layer);
    const toH = this.getTileInterpolatedHeight(toTile, train.targetTile.layer);

    const yaw = train.direction.lengthSq() > 0.001
      ? Math.atan2(train.direction.x, train.direction.z)
      : (train.pathHistory[train.pathHistory.length - 1]?.yaw ?? 0);

    const heightDiff = toH - fromH;
    const pitch = Math.abs(heightDiff) > 0.05
      ? -Math.atan2(heightDiff, WorldMap.TILE_SIZE)
      : 0;

    const isCurving = fromTile?.type.includes('curve') || toTile?.type.includes('curve');
    const cant = isCurving ? 0.04 : 0;

    const currentHeadLayer: GridLayer = (train.progress < 0.5
      ? (train.currentTile.layer ?? 1)
      : (train.targetTile.layer ?? train.currentTile.layer ?? 1)) as GridLayer;

    this.recordPathSample(train, train.frontPosition, yaw, pitch, cant, currentHeadLayer);
  }

  /**
   * 先頭車の現在状態を経路履歴に追記・間引きする
   */
  public recordPathSample(
    train: TrainInstance,
    pos: THREE.Vector3,
    yaw: number,
    pitch: number,
    cant: number,
    layer: GridLayer
  ): void {
    const hist = train.pathHistory;
    const last = hist[hist.length - 1];
    const segDist = last ? last.pos.distanceTo(pos) : 0;

    // 停止中（移動量が極小）の場合は新規追加せず、姿勢（yaw/pitch/cant）のみ最新化
    if (last && segDist < 0.001 && hist.length > 1) {
      hist[hist.length - 1] = { pos: pos.clone(), yaw, pitch, cant, dist: last.dist, layer };
    } else if (!last || segDist >= 0.001) {
      const prevDist = last ? last.dist : 0;
      hist.push({ pos: pos.clone(), yaw, pitch, cant, dist: prevDist + segDist, layer });
    }

    const maxNeeded = (train.carCount - 1) * ModelFactory.CAR_SPACING + 15;
    const newestDist = hist[hist.length - 1].dist;
    while (hist.length > 2 && (newestDist - hist[1].dist) > maxNeeded) {
      hist.shift();
    }
  }

  /**
   * 履歴上で「先頭からの距離 lagDist だけ手前」に相当する状態を補間して取得する
   */
  public sampleHistoryAtLag(hist: PathSample[], lagDist: number): PathSample {
    const newest = hist[hist.length - 1];
    if (!newest) {
      return { pos: new THREE.Vector3(), yaw: 0, pitch: 0, cant: 0, dist: 0, layer: 1 };
    }
    const targetDist = newest.dist - lagDist;

    if (targetDist <= hist[0].dist) return hist[0];

    for (let i = hist.length - 1; i > 0; i--) {
      const a = hist[i - 1];
      const b = hist[i];
      if (targetDist >= a.dist && targetDist <= b.dist) {
        const span = b.dist - a.dist;
        const t = span > 1e-6 ? (targetDist - a.dist) / span : 0;

        let diffYaw = b.yaw - a.yaw;
        while (diffYaw < -Math.PI) diffYaw += Math.PI * 2;
        while (diffYaw > Math.PI) diffYaw -= Math.PI * 2;

        return {
          pos: new THREE.Vector3().lerpVectors(a.pos, b.pos, t),
          yaw: a.yaw + diffYaw * t,
          pitch: THREE.MathUtils.lerp(a.pitch, b.pitch, t),
          cant: THREE.MathUtils.lerp(a.cant, b.cant, t),
          dist: targetDist,
          layer: t < 0.5 ? a.layer : b.layer
        };
      }
    }
    return newest;
  }

  /**
   * 各車両を、車両間隔ぶんだけ先頭車の走行履歴を遅れて辿った位置・向きに配置する
   */
  public applyCarTransforms(train: TrainInstance): void {
    for (let i = 0; i < train.cars.length; i++) {
      const lagDist = i * ModelFactory.CAR_SPACING;
      const sample = this.sampleHistoryAtLag(train.pathHistory, lagDist);
      const car = train.cars[i];
      car.position.copy(sample.pos);
      car.rotation.set(sample.pitch, sample.yaw, sample.cant, 'YXZ');
    }
  }

  /**
   * 列車の折り返し処理
   * 進行方向と反対側の先頭車両（旧最後尾）が新しい先頭車両となり、
   * 車両が瞬間移動することなくその場から逆向きに走り出すよう物理座標と履歴を反転・再構築する
   */
  public reverseTrainDirection(train: TrainInstance, worldMap: WorldMap): void {
    this.recordCurrentHeadSample(train, worldMap);

    const carCount = train.carCount;
    const origStationGroupId = train.lastStationGroupId;

    const samples: PathSample[] = [];
    const lagMax = (carCount - 1) * ModelFactory.CAR_SPACING;
    const steps = Math.max(1, Math.ceil(lagMax / 0.5));

    for (let k = 0; k <= steps; k++) {
      const lagDist = lagMax * (k / steps);
      const sample = this.sampleHistoryAtLag(train.pathHistory, lagDist);
      samples.push(sample);
    }

    const newDir = train.direction.clone().negate();

    const oldRearSample = samples[steps];
    const newFrontPos = oldRearSample.pos.clone();
    train.frontPosition.copy(newFrontPos);
    const curX = Math.round(newFrontPos.x / WorldMap.TILE_SIZE);
    const curZ = Math.round(newFrontPos.z / WorldMap.TILE_SIZE);

    let bestLayer: GridLayer = train.currentTile.layer;
    let minDiff = Infinity;
    const allLayers = GRID_LAYERS;
    for (const lyr of allLayers) {
      const t = worldMap.getTile(curX, curZ, lyr);
      if (t && this.isTrackTile(t)) {
        const h = this.getTileInterpolatedHeight(t, lyr);
        const diff = Math.abs(h - newFrontPos.y);
        if (diff < minDiff) {
          minDiff = diff;
          bestLayer = lyr;
        }
      }
    }

    train.currentTile = { x: curX, z: curZ, layer: bestLayer };
    const stationTile = worldMap.getTile(curX, curZ, train.currentTile.layer);
    if (stationTile && WorldMap.isStationTileType(stationTile.type)) {
      train.lastStationGroupId = stationTile.stationGroupId || `st_${curX}_${curZ}`;
    } else if (origStationGroupId) {
      train.lastStationGroupId = origStationGroupId;
    }

    const next = this.findNextTrackTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer, newDir, true, worldMap);
    if (next) {
      train.isTrapped = false;
      const stepDir = new THREE.Vector3(next.x - train.currentTile.x, 0, next.z - train.currentTile.z).normalize();
      train.direction.copy(stepDir);
      train.targetTile = { x: next.x, z: next.z, layer: (next.layer ?? train.currentTile.layer) as GridLayer };

      // 旧最後尾車位置 newFrontPos とタイル中心 fromPos からのオフセットを計算し、ワープを防止
      const fromPos = new THREE.Vector3(train.currentTile.x * WorldMap.TILE_SIZE, newFrontPos.y, train.currentTile.z * WorldMap.TILE_SIZE);
      const toPos = new THREE.Vector3(train.targetTile.x * WorldMap.TILE_SIZE, newFrontPos.y, train.targetTile.z * WorldMap.TILE_SIZE);
      const spanVec = toPos.clone().sub(fromPos);
      const spanLen = spanVec.length();

      if (spanLen > 1e-4) {
        const offsetVec = newFrontPos.clone().sub(fromPos);
        const proj = offsetVec.dot(spanVec.clone().normalize());

        if (proj >= 0) {
          // タイル中心を通過して次のタイルに向かっている
          train.progress = Math.min(0.999, Math.max(0, proj / spanLen));
        } else {
          // タイル中心より手前にある（手前のタイルから現在タイルへ向かっている）
          const prevX = Math.round(train.currentTile.x - stepDir.x);
          const prevZ = Math.round(train.currentTile.z - stepDir.z);
          const prevTile = worldMap.getTile(prevX, prevZ, train.currentTile.layer);
          if (prevTile && this.isTrackTile(prevTile)) {
            train.targetTile = { ...train.currentTile };
            train.currentTile = { x: prevX, z: prevZ, layer: (prevTile.layer ?? train.currentTile.layer) as GridLayer };
            train.progress = Math.min(0.999, Math.max(0, (spanLen + proj) / spanLen));
          } else {
            train.progress = 0;
          }
        }
      } else {
        train.progress = 0;
      }
    } else {
      train.direction.copy(newDir);
      train.targetTile = { ...train.currentTile };
      train.isTrapped = true;
      train.speed = 0;
      train.progress = 0;
    }

    const newHistory: PathSample[] = [];
    for (let i = 0; i <= steps; i++) {
      const s = samples[i];
      const pos = s.pos.clone();
      const dist = (i / steps) * lagMax;
      
      let reversedYaw = s.yaw + Math.PI;
      while (reversedYaw < -Math.PI) reversedYaw += Math.PI * 2;
      while (reversedYaw > Math.PI) reversedYaw -= Math.PI * 2;

      newHistory.push({
        pos,
        yaw: reversedYaw,
        pitch: -s.pitch,
        cant: -s.cant,
        dist,
        layer: s.layer ?? bestLayer
      });
    }
    train.pathHistory = newHistory;
    train.isReversed = !train.isReversed;

    // 車両メッシュ（train.cars）は先頭車から順に lagDist = i * CAR_SPACING で配置されるため、
    // 破棄・再生成せず既存メッシュをそのまま再利用して高倍速時のGC・GPUスパイクを防止
    // 反転直後に各車両メッシュの位置と回転を即座に同期（車両分離表示の完全防止）
    this.applyCarTransforms(train);
  }
}
