/**
 * 背景流：仅用前端拉取 Nginx 上的背景 chunk（不按 tile）。
 * - chunk_duration 秒/块（通常 1s）：由 manifest 推断。
 * - 起播：队列里「未播放已就绪」的时长 ≥ START_THRESHOLD_SEC 再 play。
 * - 播放中每 POLL_MS 检查一次：若当前播放时刻往后可用时长 < REBUFFER_THRESHOLD_SEC，则 fetch 下一块。
 *
 * 说明：各 chunk 为标准 MP4（非 fMP4）时不能用 MSE 无缝拼接；此处用 Blob URL 顺序播放，
 * chunk 之间可能有极短间隙；若日后预处理改为 fragmented MP4，可再换 MSE。
 *
 * loopPlayback：manifest 里有多少个背景 chunk 就顺序播多少段；播完最后一段后回到第一段。
 * 已播完的 chunk 会 revoke 释放内存；循环再需要时按原 URL 重新 fetch。
 */

const LOG_PREFIX = "[bgChunk]";

const DEFAULTS = {
  manifestUrl: "./video_1s/video_size.json",
  chunkBaseUrl: "./video_1s/dst_video_folder/",
  backgroundBitrateKey: "1M",
  pollMs: 10,
  startThresholdSec: 5,
  rebufferThresholdSec: 3,
  /** 播完最后一个背景 chunk 后是否从 chunk_0000 重新播放 */
  loopPlayback: true,
  /** 控制台每隔多少毫秒打印一次当前内存中缓存的 chunk 序号 */
  bufferReportIntervalMs: 5000,
};

function sortedBackgroundChunkIndices(manifest) {
  const keys = Object.keys(manifest || {}).filter((k) =>
    /^chunk_\d{4}_background$/.test(k)
  );
  keys.sort();
  return keys.map((k) => {
    const m = k.match(/^chunk_(\d{4})_background$/);
    return parseInt(m[1], 10);
  });
}

function chunkUrl(base, idx, bitrateKey) {
  const id = String(idx).padStart(4, "0");
  const name = `chunk_${id}_background_bitrate_${bitrateKey}`;
  const baseUrl = new URL(base, window.location.href);
  return new URL(`${name}.mp4`, baseUrl).href;
}

/** 当前时刻下，视频元素内时间轴上「可播」的剩余秒数（当前 buffered 段内） */
function inlineBufferedAheadSec(video) {
  const t = video.currentTime;
  const b = video.buffered;
  for (let i = 0; i < b.length; i++) {
    if (t >= b.start(i) && t <= b.end(i)) {
      return Math.max(0, b.end(i) - t);
    }
  }
  return 0;
}

export class BackgroundChunkPlayer {
  constructor(videoEl, options = {}) {
    this.video = videoEl;
    this.opts = { ...DEFAULTS, ...options };
    this._chunkIndices = [];
    this._chunkDurationSec = 1;
    this._currentPlayIdx = -1;
    this._blobUrls = new Map();
    this._pollTimer = null;
    this._bufferReportTimer = null;
    this._loadingInitial = false;
    this._started = false;
    /** 任意 chunk fetch 进行中（含初始 prefetch）；用于视口预测等空闲门控 */
    this._fetchInFlight = 0;
    this._onEnded = () => this._onChunkEnded();

    this._statusCb = typeof options.onStatus === "function" ? options.onStatus : () => {};

    this.video.playsInline = true;
    this.video.setAttribute("playsinline", "");
    this.video.setAttribute("webkit-playsinline", "");
    this.video.loop = false;
    this.video.removeAttribute("src");
    this.video.load();
  }

  _emit(msg, extra = {}) {
    this._statusCb({ message: msg, ...extra });
  }

  /** 每秒一次：打印内存中仍持有 Blob URL 的 chunk 序号（已 revoke 的不出现） */
  _printBufferChunkIndices() {
    if (!this._started) return;
    const ids = [...this._blobUrls.keys()].sort((a, b) => a - b);
    const cur = this._currentPlayIdx;
    const curStr = cur < 0 ? "----" : String(cur).padStart(4, "0");
    const listStr = ids.length
      ? ids.map((i) => String(i).padStart(4, "0")).join(", ")
      : "—";
    console.log(
      `${LOG_PREFIX} 缓冲区 chunk 序号: [ ${listStr} ]   当前播放: ${curStr}`
    );
  }

  async _loadManifest() {
    const res = await fetch(this.opts.manifestUrl, {
      mode: "cors",
      credentials: "omit",
    });
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const manifest = await res.json();
    this._chunkIndices = sortedBackgroundChunkIndices(manifest);
    if (this._chunkIndices.length === 0) {
      throw new Error("manifest 中未找到 chunk_XXXX_background");
    }
    const firstKey = `chunk_${String(this._chunkIndices[0]).padStart(4, "0")}_background`;
    const ci = manifest[firstKey]?.chunk_info;
    if (ci && typeof ci.chunk_duration === "number") {
      this._chunkDurationSec = ci.chunk_duration;
    }
    this._emit("manifest", {
      chunkCount: this._chunkIndices.length,
      chunkDurationSec: this._chunkDurationSec,
    });
  }

  async _fetchChunkBlobUrl(chunkIdx) {
    this._fetchInFlight += 1;
    try {
      const url = chunkUrl(
        this.opts.chunkBaseUrl,
        chunkIdx,
        this.opts.backgroundBitrateKey
      );
      const res = await fetch(url, { mode: "cors", credentials: "omit" });
      if (!res.ok) throw new Error(`chunk ${chunkIdx} HTTP ${res.status}`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      this._blobUrls.set(chunkIdx, blobUrl);
      return blobUrl;
    } finally {
      this._fetchInFlight -= 1;
    }
  }

  _queuedAheadSec() {
    if (this._currentPlayIdx < 0) return 0;
    let n = 0;
    for (const idx of this._chunkIndices) {
      if (idx > this._currentPlayIdx && this._blobUrls.has(idx)) n += 1;
    }
    return n * this._chunkDurationSec;
  }

  _approxAheadSec() {
    const inline = inlineBufferedAheadSec(this.video);
    const queued = this._queuedAheadSec();
    return inline + queued;
  }

  async _ensureFetchLowWatermark() {
    const ahead = this._approxAheadSec();
    if (ahead >= this.opts.rebufferThresholdSec) return;

    const missing = this._chunkIndices.find(
      (idx) => idx > this._currentPlayIdx && !this._blobUrls.has(idx)
    );
    if (missing === undefined) return;

    try {
      this._emit("fetch", { chunkIdx: missing });
      await this._fetchChunkBlobUrl(missing);
      this._emit("fetched", { chunkIdx: missing });
    } catch (e) {
      console.error(LOG_PREFIX, "fetch 失败", e);
      this._emit("error", { error: String(e) });
    }
  }

  async _prefetchInitialWindow() {
    const needSec = this.opts.startThresholdSec;
    let needChunks = Math.ceil(needSec / this._chunkDurationSec);
    needChunks = Math.min(needChunks, this._chunkIndices.length);

    this._emit("buffering", { needChunks });
    for (let i = 0; i < needChunks; i++) {
      const idx = this._chunkIndices[i];
      await this._fetchChunkBlobUrl(idx);
    }
  }

  _attachEnded() {
    this.video.removeEventListener("ended", this._onEnded);
    this.video.addEventListener("ended", this._onEnded);
  }

  async _restartFromFirstChunk(firstIdx) {
    let url = this._blobUrls.get(firstIdx);
    if (!url) {
      await this._fetchChunkBlobUrl(firstIdx);
      url = this._blobUrls.get(firstIdx);
    }
    if (!url) return;
    this.video.src = url;
    this._currentPlayIdx = firstIdx;
    await this.video.play().catch(() => {});
  }

  _onChunkEnded() {
    const prevIdx = this._currentPlayIdx;
    const nextIdx = this._currentPlayIdx + 1;
    if (!this._chunkIndices.includes(nextIdx)) {
      if (this.opts.loopPlayback) {
        const firstIdx = this._chunkIndices[0];
        if (prevIdx >= 0 && this._blobUrls.has(prevIdx)) {
          URL.revokeObjectURL(this._blobUrls.get(prevIdx));
          this._blobUrls.delete(prevIdx);
        }
        void this._restartFromFirstChunk(firstIdx);
        return;
      }
      this._emit("ended_all");
      return;
    }
    if (prevIdx >= 0 && this._blobUrls.has(prevIdx)) {
      URL.revokeObjectURL(this._blobUrls.get(prevIdx));
      this._blobUrls.delete(prevIdx);
    }

    const url = this._blobUrls.get(nextIdx);
    if (!url) {
      this._emit("stall", { waitingFor: nextIdx });
      const t = setInterval(() => {
        const u = this._blobUrls.get(nextIdx);
        if (u) {
          clearInterval(t);
          this.video.src = u;
          this._currentPlayIdx = nextIdx;
          this.video.play().catch(() => {});
        }
      }, 50);
      return;
    }
    this.video.src = url;
    this._currentPlayIdx = nextIdx;
    this.video.play().catch(() => {});
  }

  async start() {
    if (this._loadingInitial || this._started) return;
    this._loadingInitial = true;
    try {
      await this._loadManifest();
      await this._prefetchInitialWindow();

      const firstIdx = this._chunkIndices[0];
      const src = this._blobUrls.get(firstIdx);
      if (!src) throw new Error("初始缓冲失败");

      this.video.src = src;
      this._currentPlayIdx = firstIdx;
      this._attachEnded();

      await this.video.play();
      this._started = true;
      this._emit("playing");

      this._pollTimer = window.setInterval(() => {
        if (!this._started) return;
        if (!this.video.paused || this.video.readyState >= 2) {
          void this._ensureFetchLowWatermark();
        }
        const onIdle = this.opts.onIdlePoll;
        if (typeof onIdle === "function") {
          const ahead = this._approxAheadSec();
          const comfortable =
            ahead >= this.opts.rebufferThresholdSec &&
            this._fetchInFlight === 0;
          if (comfortable) {
            try {
              onIdle(performance.now());
            } catch (e) {
              console.error(LOG_PREFIX, "onIdlePoll", e);
            }
          }
        }
      }, this.opts.pollMs);

      const reportMs = this.opts.bufferReportIntervalMs;
      this._bufferReportTimer = window.setInterval(() => {
        this._printBufferChunkIndices();
      }, reportMs);
      this._printBufferChunkIndices();
    } catch (e) {
      console.error(e);
      this._emit("error", { error: String(e) });
      throw e;
    } finally {
      this._loadingInitial = false;
    }
  }

  /** 当前正在播放的背景 chunk 序号（与 tile 文件名 chunk_XXXX 对齐）；未起播时为 -1 */
  getCurrentChunkIndex() {
    return this._currentPlayIdx;
  }

  /**
   * manifest 顺序中的下一个 chunk（启用 loop 时，最后一个的下一个是列表首项）。
   * 用于 tile 预取与当前播放对齐。
   */
  getNextChunkIndexInPlaylist(currentIdx) {
    const list = this._chunkIndices;
    if (!list.length) return -1;
    const i = list.indexOf(currentIdx);
    if (i < 0) return list[0];
    if (i + 1 < list.length) return list[i + 1];
    return this.opts.loopPlayback ? list[0] : currentIdx;
  }

  destroy() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._bufferReportTimer) {
      clearInterval(this._bufferReportTimer);
      this._bufferReportTimer = null;
    }
    this.video.removeEventListener("ended", this._onEnded);
    for (const u of this._blobUrls.values()) {
      URL.revokeObjectURL(u);
    }
    this._blobUrls.clear();
    this._started = false;
  }
}
