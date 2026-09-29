import { MapSize, TerrainType } from './types';

export type GamePhase = 'title' | 'playing' | 'paused';

export interface GameSettings {
  mapSize: MapSize;
  terrainType: TerrainType;
}

/**
 * ゲームステート管理クラス
 * タイトル画面、パラメータ選択、ゲーム進行状況の制御
 */
export class GameState {
  private static instance: GameState;

  public phase: GamePhase = 'title';
  public currentSettings: GameSettings = {
    mapSize: 256,
    terrainType: 'balanced'
  };

  private constructor() {}

  public static getInstance(): GameState {
    if (!GameState.instance) {
      GameState.instance = new GameState();
    }
    return GameState.instance;
  }

  /**
   * ローカルストレージにセーブデータが存在するか確認
   */
  public hasSaveData(): boolean {
    try {
      const data = localStorage.getItem('wagamachi_save_data') || localStorage.getItem('saikyo_save_data') || localStorage.getItem('stk_3d_world');
      return !!data;
    } catch {
      return false;
    }
  }

  /**
   * 新規ゲームの設定を適用してプレイ中へ遷移
   */
  public startNewGame(mapSize: MapSize, terrainType: TerrainType): void {
    this.currentSettings = { mapSize, terrainType };
    this.phase = 'playing';
  }

  /**
   * セーブデータ読込によるプレイ中へ遷移
   */
  public resumeGame(): void {
    this.phase = 'playing';
  }

  /**
   * タイトル画面へ戻る
   */
  public returnToTitle(): void {
    this.phase = 'title';
  }
}
