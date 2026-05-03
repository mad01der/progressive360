/**
 * 视口预测命中 tile 后，按 E3PO 命名拉取对应 MP4（固定码率键，如 0.1M），
 * 用 Blob URL 绑定到隐藏的 <video> 上完成「加载到视频」。
 * 码率键与 manifest video_size 一致（如 0.1M）。
 * 与背景 fetch 独立；load 整批进行期间 isTransferring() 为 true。
 */

const LOG_PREFIX = "[tileVideo]";

async function fetchBlobWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      mode: "cors",
      credentials: "omit",
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

export class TileVideoLoader {
  /**
   * @param {{ chunkBaseUrl?: string, bitrateKey?: string }} options
   * chunkBaseUrl 与 BackgroundChunkPlayer.chunkBaseUrl 一致。
   */
  constructor(options = {}) {
    this.chunkBaseUrl = options.chunkBaseUrl ?? "./video_1s/dst_video_folder/";
    /** 固定码率档，与 manifest 里 video_size 键一致，如 "0.1M" */
    this.bitrateKey = options.bitrateKey ?? "0.1M";
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 20000;
    /** 当前是否有一批 tile fetch/bind 尚未结束 */
    this._transferDepth = 0;
    /** chunkIdx_tileIdx_bitrate -> { blobUrl, video } */
    this._cache = new Map();
    this._container = null;
  }

  isTransferring() {
    return this._transferDepth > 0;
  }

  _ensureContainer() {
    if (this._container) return;
    this._container = document.createElement("div");
    this._container.id = "tile-video-pool";
    this._container.setAttribute("aria-hidden", "true");
    Object.assign(this._container.style, {
      position: "absolute",
      width: "1px",
      height: "1px",
      overflow: "hidden",
      clip: "rect(0 0 0 0)",
      clipPath: "inset(50%)",
      pointerEvents: "none",
    });
    document.body.appendChild(this._container);
  }

  _tileHttpUrl(chunkIdx, tileIdx) {
    const c = String(chunkIdx).padStart(4, "0");
    const t = String(tileIdx).padStart(3, "0");
    const name = `chunk_${c}_tile_${t}_bitrate_${this.bitrateKey}`;
    const baseUrl = new URL(this.chunkBaseUrl, window.location.href);
    return new URL(`${name}.mp4`, baseUrl).href;
  }

  _cacheKey(chunkIdx, tileIdx) {
    return `${chunkIdx}_${tileIdx}_${this.bitrateKey}`;
  }

  /**
   * 当前 chunk 下已成功加载的 tile，供 ERP 合成贴球。
   * @param {number} chunkIdx
   * @returns {{ tileIdx: number, video: HTMLVideoElement }[]}
   */
  listLoadedTilesForChunk(chunkIdx) {
    const out = [];
    for (const [, v] of this._cache) {
      if (v.chunkIdx === chunkIdx && v.video) {
        out.push({ tileIdx: v.tileIdx, video: v.video });
      }
    }
    return out;
  }

  /**
   * @param {number} chunkIdx 与背景当前播放 chunk 序号对齐
   * @param {number[]} tileIndices 0..63
   * @param {{ prefetchNextChunk?: boolean, bgPlayer?: { getNextChunkIndexInPlaylist: (n:number)=>number } }} [opts]
   */
  async fetchAndBindVideos(chunkIdx, tileIndices, opts = {}) {
    if (this._transferDepth > 0) return;

    const unique = [...new Set(tileIndices)].filter(
      (i) => Number.isInteger(i) && i >= 0 && i <= 63
    );
    if (unique.length === 0) return;

    const needFetch = unique.filter(
      (tileIdx) => !this._cache.has(this._cacheKey(chunkIdx, tileIdx))
    );
    if (needFetch.length === 0) return;

    this._transferDepth += 1;
    this._ensureContainer();

    let ok = 0;
    let fail = 0;

    try {
      await Promise.all(
        needFetch.map(async (tileIdx) => {
          const key = this._cacheKey(chunkIdx, tileIdx);
          const url = this._tileHttpUrl(chunkIdx, tileIdx);
          try {
            const res = await fetchBlobWithTimeout(url, this.fetchTimeoutMs);
            if (!res.ok) {
              throw new Error(`HTTP ${res.status}`);
            }
            const blob = await res.blob();
            const blobUrl = URL.createObjectURL(blob);

            const prev = this._cache.get(key);
            if (prev?.blobUrl) {
              URL.revokeObjectURL(prev.blobUrl);
            }

            let video = prev?.video;
            if (!video) {
              video = document.createElement("video");
              video.muted = true;
              video.playsInline = true;
              video.setAttribute("playsinline", "");
              video.preload = "auto";
              this._container.appendChild(video);
            }
            video.src = blobUrl;
            video.load();
            this._cache.set(key, { blobUrl, video, chunkIdx, tileIdx });
            video.play().catch(() => {});
            ok += 1;
          } catch (e) {
            fail += 1;
            console.warn(LOG_PREFIX, `chunk ${chunkIdx} tile ${tileIdx}`, url, e);
          }
        })
      );

      if (ok === 0 && fail > 0) {
        console.warn(
          LOG_PREFIX,
          `本批 chunk ${chunkIdx} 共 ${fail} 个 tile 全部失败；画质不会提升。请确认 ${this.chunkBaseUrl} 下存在 chunk_${String(chunkIdx).padStart(4, "0")}_tile_XXX_bitrate_${this.bitrateKey}.mp4（且与网页同源或已配置 CORS）。`
        );
      } else if (ok > 0) {
        console.log(
          LOG_PREFIX,
          `chunk ${String(chunkIdx).padStart(4, "0")} 已就绪 tile 数 ${ok}/${needFetch.length}（缓存用于叠画）`
        );
      }
    } finally {
      this._transferDepth -= 1;
      const prefetchNextChunk = opts.prefetchNextChunk !== false;
      const bgPlayer = opts.bgPlayer;
      if (
        prefetchNextChunk &&
        bgPlayer &&
        typeof bgPlayer.getNextChunkIndexInPlaylist === "function"
      ) {
        const next = bgPlayer.getNextChunkIndexInPlaylist(chunkIdx);
        if (next >= 0 && next !== chunkIdx) {
          const tiles = tileIndices.slice();
          queueMicrotask(() => {
            void this.fetchAndBindVideos(next, tiles, {
              prefetchNextChunk: false,
              bgPlayer,
            });
          });
        }
      }
    }
  }

  destroy() {
    for (const [, v] of this._cache) {
      if (v.blobUrl) URL.revokeObjectURL(v.blobUrl);
      v.video?.remove();
    }
    this._cache.clear();
    this._container?.remove();
    this._container = null;
  }
}
