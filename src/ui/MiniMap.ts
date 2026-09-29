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

    // 路線図ヘッダーバー（タイトル＋閉じるボタン）
    const headerBar = document.createElement('div');
    headerBar.id = 'minimap-header-bar';

    const label = document.createElement('div');
    label.id = 'minimap-label';
    label.textContent = '路線図';
    headerBar.appendChild(label);

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
          right: 8px;
          bottom: calc(64px + env(safe-area-inset-bottom, 0px));
          padding: 4px;
        }
        #minimap-canvas {
          width: 130px;
          height: 130px;
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
      if (t.type === 'empty' || t.type === 'nature' || t.type === 'residence' || t.type === 'commercial') continue;
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

    // 列車
    ctx.fillStyle = '#ef4444';
    for (const train of this.trainManager.getTrains()) {
      const tileX = train.frontPosition.x / WorldMap.TILE_SIZE;
      const tileZ = train.frontPosition.z / WorldMap.TILE_SIZE;
      const { px, py } = this.tileToPx(tileX, tileZ);
      ctx.beginPath();
      ctx.arc(px, py, 1.6, 0, Math.PI * 2);
      ctx.fill();
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
