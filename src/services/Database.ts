import Dexie, { type Table } from 'dexie';
import { GridLayer } from '../core/types';
import type { CurveDirection, SwitchState, CrossingState } from '../simulation/WorldMap';

/**
 * タイルデータの永続化用レコード定義
 */
export interface SavedTileRecord {
  id: string; // 一意キー: `${x},${z},${layer}`
  x: number;
  z: number;
  layer: GridLayer;
  type: string;
  rotation: number;
  level: number;
  elevationOffset?: number;
  curveDir?: CurveDirection;
  switchState?: SwitchState;
  switchBranchSide?: 'left' | 'right';
  switchSchedule?: any;
  crossingState?: CrossingState;
  crossingRoadAxis?: number;
  slopePart?: number;
  slopeReversed?: boolean;
  cargoContainers?: number;
  stationName?: string;
  stationGroupId?: string;
  stationPlatformId?: string;
  stationPart?: 'single' | 'start' | 'mid' | 'end';
  stationPlatformSide?: 'left' | 'right';
  stationSchedule?: any;
  stationPassengers?: number;
  isCargoYard?: boolean;
  externalCityId?: string;
  isExternalConnection?: boolean;
  // レガシー互換・エイリアスプロパティ
  rot?: number;
  lvl?: number;
  sw?: SwitchState;
  branchSide?: 'left' | 'right';
  crossState?: CrossingState;
  roadAxis?: number;
  slopeRev?: boolean;
  cargoYard?: boolean;
}

/**
 * 運行列車データの永続化用レコード定義
 */
export interface SavedTrainRecord {
  id: number;
  data: any; // 列車シリアライズデータ
  fleetId?: string;
}

/**
 * 経済・財務データの永続化用レコード定義
 */
export interface SavedEconomyRecord {
  id: string; // 通常は 'current'
  funds: number;
  population: number;
  year: number;
  month: number;
  day: number;
  periodFareIncome: number;
  periodCargoIncome: number;
  periodConstructionCost: number;
  periodMaintenanceCost: number;
  fiscalYearFareIncome: number;
  fiscalYearCargoIncome: number;
  fiscalYearMaintenanceCost: number;
  fiscalYearConstructionCost: number;
  pendingCorporateTax: number;
  pendingPropertyTax: number;
  pendingTotalTax: number;
  lastSettledYear: number;
  monthlyHistory: any[];
  yearlyHistory: any[];
  lastDepreciationCost?: number;
  lastTotalBookValue?: number;
  depreciationLedger?: any;
}

/**
 * システム設定・メタデータ用Key-Valueレコード定義
 */
export interface SavedSystemRecord {
  key: string;
  value: any;
}

/**
 * WagamachiRailwayDB
 * 大規模都市・大量オブジェクト対応の IndexedDB (Dexie) データベース
 */
export class WagamachiRailwayDB extends Dexie {
  tiles!: Table<SavedTileRecord, string>;
  trains!: Table<SavedTrainRecord, number>;
  economy!: Table<SavedEconomyRecord, string>;
  system!: Table<SavedSystemRecord, string>;

  constructor() {
    super('WagamachiRailwayDB');
    this.version(1).stores({
      tiles: 'id, x, z, layer, type',
      trains: 'id, fleetId',
      economy: 'id',
      system: 'key'
    });
  }
}

export const db = new WagamachiRailwayDB();
