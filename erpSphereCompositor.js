/**
 * 将全幅 ERP 背景视频与多个 tile 视频块合成到一张 2:1 画布，再贴到球面。
 * Tile 在 ERP 上的布局与预处理一致：8×8，每块 480×240（3840×1920）。
 */

import * as THREE from "three";

const ERP_W = 3840;
const ERP_H = 1920;
const TILE_W = 480;
const TILE_H = 240;
const COLS = 8;

/** tile 序号 0..63 → ERP 像素矩形（左上原点，向右向下） */
export function tileIdxToErpRect(tileIdx) {
  const col = tileIdx % COLS;
  const row = Math.floor(tileIdx / COLS);
  return {
    x: col * TILE_W,
    y: row * TILE_H,
    w: TILE_W,
    h: TILE_H,
  };
}

export class ErpSphereCompositor {
  /**
   * @param {{ canvasMaxWidth?: number }} options
   */
  constructor(options = {}) {
    const maxW = options.canvasMaxWidth ?? 2048;
    this.canvasW = maxW;
    this.canvasH = Math.round(maxW / 2);

    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvasW;
    this.canvas.height = this.canvasH;
    this.ctx = this.canvas.getContext("2d", { alpha: false });

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
  }

  /**
   * 用列/行边界取整，保证相邻 tile 在画布上无缝衔接。
   * 视场朝前时，屏幕竖直中线常落在 ERP 水平中心 x=1920，即第 3/4 列分界——
   * 若用浮点 x/dw 各自缩放，易在中间出现 1px 缝或错层（你截图里整幅竖缝多源于此）。
   */
  _tileRectCanvasGrid(tileIdx) {
    const col = tileIdx % COLS;
    const row = Math.floor(tileIdx / COLS);
    const sx = this.canvasW / ERP_W;
    const sy = this.canvasH / ERP_H;
    const x0 = Math.round(col * TILE_W * sx);
    const x1 = Math.round((col + 1) * TILE_W * sx);
    const y0 = Math.round(row * TILE_H * sy);
    const y1 = Math.round((row + 1) * TILE_H * sy);
    return { dx: x0, dy: y0, dw: x1 - x0, dh: y1 - y0 };
  }

  /**
   * @param {HTMLVideoElement} bgVideo 背景全幅 ERP
   * @param {number} chunkIdx 当前 chunk，与 tile 缓存一致
   * @param {{ listLoadedTilesForChunk?: (n:number)=>{tileIdx:number,video:HTMLVideoElement}[] }} tileLoader
   */
  update(bgVideo, chunkIdx, tileLoader) {
    const ctx = this.ctx;
    const cw = this.canvasW;
    const ch = this.canvasH;

    if (bgVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      ctx.drawImage(bgVideo, 0, 0, cw, ch);
    } else {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, cw, ch);
    }

    if (chunkIdx < 0 || typeof tileLoader.listLoadedTilesForChunk !== "function") {
      this.texture.needsUpdate = true;
      return;
    }

    const entries = tileLoader.listLoadedTilesForChunk(chunkIdx);
    const tSrc = bgVideo.currentTime;
    const bgRate = bgVideo.playbackRate;

    for (const { tileIdx, video } of entries) {
      /** seek 过程中解码器常输出黑帧，叠上去会形成「黑洞」——这一帧不盖 tile，露出底层背景 */
      if (video.seeking) continue;
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) continue;

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) continue;

      if (video.playbackRate !== bgRate) {
        video.playbackRate = bgRate;
      }
      if (video.paused) {
        video.play().catch(() => {});
      }
      /**
       * 尽量少改 currentTime：每次 seek 都会黑一下并抖动。
       * 只在明显失步时再对齐（秒级）；细微漂移交给 playbackRate。
       */
      if (Number.isFinite(tSrc) && video.duration > 0) {
        const dt = Math.abs(video.currentTime - tSrc);
        if (dt > 0.35 && dt < video.duration - 0.05) {
          try {
            video.currentTime = tSrc;
          } catch (_) {
            /* ignore */
          }
          continue;
        }
      }

      const { dx, dy, dw, dh } = this._tileRectCanvasGrid(tileIdx);
      ctx.drawImage(video, 0, 0, vw, vh, dx, dy, dw, dh);
    }

    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
  }
}
