// 2Dミニマップ（路線図レーダー ＆ ワンタップカメラジャンプ）
// 画面隅に地形・線路・駅・ゾーン・列車位置を一望できる軽量Canvas 2Dオーバーレイを表示し、
// クリック/タップした座標へメインカメラの注視点を瞬時にジャンプさせる。

import { GridManager } from '../core/GridManager';
import { WorldMap } from '../simulation/WorldMap';
import { ZoneManager } from '../core/ZoneManager';
import { CameraManager } from '../graphics/CameraManager';
import { TrainManager } from '../simulation/TrainManager';

const SIZE_PX = 190;
const BG_SAMPLE_STEP_PX = 1; // 背景地形サンプリング間隔(px)。1回だけ焼き込むためコストは無視できる。

export class MiniMap {
  private container: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bgCanvas: HTMLCanvasElement;
  private staticCanvas: HTMLCanvasElement;
  private staticCtx: CanvasRenderingContext2D;
  private lastStaticUpdate: number = 0;
  private staticUpdateInterval: number = 400; // 400ms間隔（毎秒2.5回）で線路・駅・ゾーンをキャッシュ更新
  private staticDirty: boolean = true;

  private gridManager: GridManager;
  private worldMap: WorldMap;
  private zoneManager: ZoneManager;
  private cameraManager: CameraManager;
  private trainManager: TrainManager;

  public isLogisticsMode: boolean = false; // 物流サプライチェーンオーバーレイ表示フラグ

  public onJumpWorld: (worldX: number, worldZ: number) => void = () => {};

  constructor(deps: {
    gridManager: GridManager;
    worldMap: WorldMap;
    zoneManager: ZoneManager;
    cameraManager: CameraManager;
    trainManager: TrainManager;
  }) {
    this.gridManager = deps.gridManager;
    this.worldMap = deps.worldMap;
    this.zoneManager = deps.zoneManager;
    this.cameraManager = deps.cameraManager;
    this.trainManager = deps.trainManager;

    this.injectStyle();

    this.container = document.createElement('div');
    this.container.id = 'minimap-container';

    // 路線図ヘッダーバー（タイトル＋物流切替ボタン＋閉じるボタン）
    const headerBar = document.createElement('div');
    headerBar.id = 'minimap-header-bar';

    const label = document.createElement('div');
    label.id = 'minimap-label';
    label.textContent = '路線図';
    headerBar.appendChild(label);

    const cargoBtn = document.createElement('button');
    cargoBtn.id = 'minimap-cargo-btn';
    cargoBtn.className = 'minimap-header-btn';
    cargoBtn.textContent = '📦 物流';
    cargoBtn.title = '物流サプライチェーン（物資在庫・需要先・貨物列車）強調表示の切替';
    cargoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.isLogisticsMode = !this.isLogisticsMode;
      cargoBtn.classList.toggle('active', this.isLogisticsMode);
      this.requestStaticUpdate();
    });
    headerBar.appendChild(cargoBtn);

    const closeBtn = document.createElement('button');
    closeBtn.id = 'minimap-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.title = '路線図を閉じる';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setVisible(false);
      const toggleBtn = document.getElementById('btn-minimap-toggle');
      if (toggleBtn) toggleBtn.classList.remove('active');
    });
    headerBar.appendChild(closeBtn);

    this.container.appendChild(headerBar);

    this.canvas = document.createElement('canvas');
    this.canvas.id = 'minimap-canvas';
    this.canvas.width = SIZE_PX;
    this.canvas.height = SIZE_PX;
    this.container.appendChild(this.canvas);

    document.body.appendChild(this.container);
    this.ctx = this.canvas.getContext('2d')!;

    this.bgCanvas = document.createElement('canvas');
    this.bgCanvas.width = SIZE_PX;
    this.bgCanvas.height = SIZE_PX;

    this.staticCanvas = document.createElement('canvas');
    this.staticCanvas.width = SIZE_PX;
    this.staticCanvas.height = SIZE_PX;
    this.staticCtx = this.staticCanvas.getContext('2d')!;

    this.canvas.addEventListener('click', (e) => this.handleClick(e));
    this.canvas.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length > 0) {
          e.preventDefault();
          const t = e.touches[0];
          this.handleClickAt(t.clientX, t.clientY);
        }
      },
      { passive: false }
    );

    this.rebuildBackground();
  }

  public setVisible(visible: boolean): void {
    this.container.classList.toggle('hidden', !visible);
  }

  public getVisible(): boolean {
    return !this.container.classList.contains('hidden');
  }

  private injectStyle(): void {
    if (document.getElementById('minimap-style')) return;
    const style = document.createElement('style');
    style.id = 'minimap-style';
    style.textContent = `
      #minimap-container {
        position: fixed;
        right: 14px;
        bottom: 14px;
        z-index: 40;
        background: rgba(15, 23, 42, 0.85);
        border: 1px solid rgba(148, 163, 184, 0.4);
        border-radius: 10px;
        padding: 6px;
        box-shadow: 0 4px 18px rgba(0,0,0,0.45);
        backdrop-filter: blur(8px);
        touch-action: none;
      }
      #minimap-header-bar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
        padding: 0 2px;
      }
      #minimap-label {
        color: #e2e8f0;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.05em;
      }
      .minimap-header-btn {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.15);
        color: #94a3b8;
        font-size: 10px;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 4px;
        line-height: 1.2;
        transition: all 0.15s ease;
      }
      .minimap-header-btn:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.18);
      }
      .minimap-header-btn.active {
        background: rgba(245, 158, 11, 0.25);
        border-color: #f59e0b;
        color: #fbbf24;
        font-weight: 700;
      }
      #minimap-close-btn {
        background: transparent;
        border: none;
        color: #94a3b8;
        font-size: 11px;
        cursor: pointer;
        padding: 2px 4px;
        border-radius: 4px;
        line-height: 1;
        transition: color 0.15s ease;
      }
      #minimap-close-btn:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.1);
      }
      #minimap-canvas {
        display: block;
        border-radius: 6px;
        cursor: pointer;
        image-rendering: pixelated;
      }
      @media (max-width: 768px) {
        #minimap-container {
          top: calc(52px + env(safe-area-inset-top, 0px));
          right: 8px;
          bottom: auto;
          left: auto;
          padding: 4px;
          z-index: 45;
        }
        #minimap-canvas {
          width: 110px;
          height: 110px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  /** マップサイズ・地形が変わった時（新規ゲーム開始・ロード時）に呼び出す */
  public setGridManager(gridManager: GridManager): void {
    this.gridManager = gridManager;
    this.rebuildBackground();
  }

  /** 地形背景をオフスクリーンキャンバスへ一度だけ焼き込む（毎フレーム再サンプリングしない） */
  public rebuildBackground(): void {
    const bgCtx = this.bgCanvas.getContext('2d')!;
    const mapSize = this.gridManager.mapSize;
    const half = mapSize / 2;

    bgCtx.fillStyle = '#1e293b';
    bgCtx.fillRect(0, 0, SIZE_PX, SIZE_PX);

    const img = bgCtx.createImageData(SIZE_PX, SIZE_PX);
    for (let py = 0; py < SIZE_PX; py += BG_SAMPLE_STEP_PX) {
      for (let px = 0; px < SIZE_PX; px += BG_SAMPLE_STEP_PX) {
        const tileX = Math.round((px / SIZE_PX) * mapSize - half);
        const tileZ = Math.round((py / SIZE_PX) * mapSize - half);
        const { elevation, isWater } = this.gridManager.sampleTerrain(tileX, tileZ);

        let r = 0x33, g = 0x66, b = 0x33; // 平地
        if (isWater) {
          r = 0x0c; g = 0x4a; b = 0x6e;
        } else if (elevation >= 3) {
          r = 0x57; g = 0x53; b = 0x4a;
        } else if (elevation === 2) {
          r = 0x4d; g = 0x7c; b = 0x0f;
        }

        for (let dy = 0; dy < BG_SAMPLE_STEP_PX && py + dy < SIZE_PX; dy++) {
          for (let dx = 0; dx < BG_SAMPLE_STEP_PX && px + dx < SIZE_PX; dx++) {
            const idx = ((py + dy) * SIZE_PX + (px + dx)) * 4;
            img.data[idx] = r;
            img.data[idx + 1] = g;
            img.data[idx + 2] = b;
            img.data[idx + 3] = 255;
          }
        }
      }
    }
    bgCtx.putImageData(img, 0, 0);
    this.requestStaticUpdate();
  }

  /** 線路やゾーンなどの変更があった際に、次フレームで静的オーバーレイを即時再描画する */
  public requestStaticUpdate(): void {
    this.staticDirty = true;
  }

  /** 線路・駅・ゾーンの静的要素をオフスクリーンCanvasへ描画してキャッシュする */
  private renderStaticOverlay(): void {
    const ctx = this.staticCtx;
    ctx.clearRect(0, 0, SIZE_PX, SIZE_PX);

    // ゾーン（住宅=緑/商業=青/工業=黄）
    for (const zone of this.zoneManager.getAllZones()) {
      const { px, py } = this.tileToPx(zone.x, zone.z);
      ctx.fillStyle =
        zone.type === 'residential' ? 'rgba(34,197,94,0.55)' :
        zone.type === 'commercial' ? 'rgba(59,130,246,0.55)' :
        'rgba(234,179,8,0.55)';
      ctx.fillRect(px - 0.5, py - 0.5, 1.5, 1.5);
    }

    // 線路・駅
    const tiles = this.worldMap.getAllTiles();
    ctx.fillStyle = '#f8fafc';
    for (const t of tiles) {
      if (t.type === 'empty' || t.type === 'nature' || t.type === 'residence' || t.type === 'commercial' || t.type === 'industrial' || t.type === 'farmland') continue;
      const { px, py } = this.tileToPx(t.x, t.z);
      if (WorldMap.isStationTileType(t.type)) {
        ctx.fillStyle = (t.isCargoYard || t.type.startsWith('cargo_station')) ? '#f97316' : '#fbbf24';
        ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
        ctx.fillStyle = '#f8fafc';
      } else {
        ctx.fillRect(px - 0.5, py - 0.5, 1, 1);
      }
    }
  }

  private tileToPx(tileX: number, tileZ: number): { px: number; py: number } {
    const mapSize = this.gridManager.mapSize;
    const half = mapSize / 2;
    return {
      px: ((tileX + half) / mapSize) * SIZE_PX,
      py: ((tileZ + half) / mapSize) * SIZE_PX
    };
  }

  private pxToTile(px: number, py: number): { x: number; z: number } {
    const mapSize = this.gridManager.mapSize;
    const half = mapSize / 2;
    return {
      x: Math.round((px / SIZE_PX) * mapSize - half),
      z: Math.round((py / SIZE_PX) * mapSize - half)
    };
  }

  private handleClick(e: MouseEvent): void {
    this.handleClickAt(e.clientX, e.clientY);
  }

  private handleClickAt(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * SIZE_PX;
    const py = ((clientY - rect.top) / rect.height) * SIZE_PX;
    const { x, z } = this.pxToTile(px, py);
    this.onJumpWorld(x * WorldMap.TILE_SIZE, z * WorldMap.TILE_SIZE);
  }

  /** 毎フレーム呼び出し、路線・駅・ゾーン・列車・視野範囲を再描画する */
  public update(): void {
    const now = performance.now();
    if (this.staticDirty || now - this.lastStaticUpdate > this.staticUpdateInterval) {
      this.renderStaticOverlay();
      this.lastStaticUpdate = now;
      this.staticDirty = false;
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, SIZE_PX, SIZE_PX);
    ctx.drawImage(this.bgCanvas, 0, 0);
    ctx.drawImage(this.staticCanvas, 0, 0);

    // 物流サプライチェーンオーバーレイ（物流表示モード有効時）
    if (this.isLogisticsMode) {
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.007);

      // 1. 工業ゾーン（生産拠点）: 在庫コンテナありマスの点滅強調
      // 2. 商業ゾーン（消費・需要先）: 受け入れ余力ありマスのシアン枠線強調
      for (const zone of this.zoneManager.getAllZones()) {
        if (zone.type === 'industrial' && (zone.industrialStock ?? 0) > 0) {
          const { px, py } = this.tileToPx(zone.x, zone.z);
          ctx.strokeStyle = `rgba(249, 115, 22, ${0.4 + 0.6 * pulse})`;
          ctx.lineWidth = 1;
          ctx.strokeRect(px - 1.5, py - 1.5, 3, 3);
          ctx.fillStyle = `rgba(249, 115, 22, ${0.35 * pulse})`;
          ctx.fillRect(px - 1, py - 1, 2, 2);
        } else if (zone.type === 'commercial' && (zone.commercialAttractiveness ?? 0) < 100) {
          const { px, py } = this.tileToPx(zone.x, zone.z);
          ctx.strokeStyle = '#06b6d4';
          ctx.lineWidth = 0.9;
          ctx.strokeRect(px - 1.5, py - 1.5, 3, 3);
        }
      }

      // 3. コンテナを保管中の貨物駅（コンテナヤード）のマーカー表示
      const allTiles = this.worldMap.getAllTiles();
      for (const t of allTiles) {
        if (t.isCargoYard || t.type.startsWith('cargo_station')) {
          const containers = t.cargoContainers ?? 0;
          if (containers > 0) {
            const { px, py } = this.tileToPx(t.x, t.z);
            ctx.fillStyle = '#f59e0b';
            ctx.fillRect(px - 2, py - 2, 4, 4);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 0.8;
            ctx.strokeRect(px - 2, py - 2, 4, 4);
          }
        }
      }
    }

    // 列車マーカー描画（物流モード時はコンテナ積載中貨物列車をアンバー/オレンジで強調）
    for (const train of this.trainManager.getTrains()) {
      const tileX = train.frontPosition.x / WorldMap.TILE_SIZE;
      const tileZ = train.frontPosition.z / WorldMap.TILE_SIZE;
      const { px, py } = this.tileToPx(tileX, tileZ);

      const isFreight = train.model.category === 'freight';
      const hasCargo = (train.cargoLoad ?? 0) > 0;

      if (this.isLogisticsMode && isFreight && hasCargo) {
        // コンテナ積載中の貨物列車: アンバー/オレンジ（#f59e0b）で拡大描画
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath();
        ctx.arc(px, py, 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      } else if (this.isLogisticsMode && isFreight) {
        // 回送中の貨物列車: 落ち着いたアンバー
        ctx.fillStyle = '#d97706';
        ctx.beginPath();
        ctx.arc(px, py, 1.8, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // 通常旅客列車
        ctx.fillStyle = this.isLogisticsMode ? 'rgba(239, 68, 68, 0.45)' : '#ef4444';
        ctx.beginPath();
        ctx.arc(px, py, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 【UIの嘘解消】カメラ視野範囲（クォータービューの幾何学的に正確な回転ひし形枠）
    const corners = this.cameraManager.getViewportGroundCorners();
    if (corners.length === 4) {
      const pxCorners = corners.map(c => this.tileToPx(c.x / WorldMap.TILE_SIZE, c.z / WorldMap.TILE_SIZE));
      ctx.beginPath();
      ctx.moveTo(pxCorners[0].px, pxCorners[0].py);
      ctx.lineTo(pxCorners[1].px, pxCorners[1].py);
      ctx.lineTo(pxCorners[2].px, pxCorners[2].py);
      ctx.lineTo(pxCorners[3].px, pxCorners[3].py);
      ctx.closePath();

      // 半透明の視界ハイライト塗り
      ctx.fillStyle = 'rgba(56, 189, 248, 0.08)';
      ctx.fill();

      // 視界外枠線
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }
}
