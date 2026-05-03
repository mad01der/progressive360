import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { BackgroundChunkPlayer } from "./bgChunkPlayer.js";
import { ViewportPredictor } from "./viewportPredictor.js";
import { TileVideoLoader } from "./tileVideoLoader.js";
import { ErpSphereCompositor, tileIdxToErpRect } from "./erpSphereCompositor.js";
import {
  centerTileIndexFromYawPitch,
  compareManifestTile,
  debugSnapshot,
} from "./tileMappingDebug.js";

const overlay = document.getElementById("overlay");
const btnPlayPause = document.getElementById("btnPlayPause");
const speedSelect = document.getElementById("speedSelect");

const video = document.createElement("video");
video.muted = true;
video.playbackRate = 1;

const viewportPredictor = new ViewportPredictor();
const tileVideoLoader = new TileVideoLoader({
  chunkBaseUrl: "./video_1s/dst_video_folder/",
  bitrateKey: "0.1M",
});
const erpCompositor = new ErpSphereCompositor({ canvasMaxWidth: 2048 });
let lastPredictedTilesLogMs = 0;

/** 背景 chunk：video_1s/video_size.json + video_1s/dst_video_folder/chunk_XXXX_background_bitrate_1M.mp4 */
const bgPlayer = new BackgroundChunkPlayer(video, {
  manifestUrl: "./video_1s/video_size.json",
  chunkBaseUrl: "./video_1s/dst_video_folder/",
  backgroundBitrateKey: "1M",
  pollMs: 10,
  startThresholdSec: 5,
  rebufferThresholdSec: 3,
  /** 播完最后一段后从 chunk_0000 再播；已播段会 revoke，再需要时重新 fetch */
  loopPlayback: true,
  /**
   * 与背景流共用 10ms 问询：仅在缓冲充足（≥ rebufferThresholdSec）且无 fetch 时触发。
   * 线性预测 200ms 后视口对应 ERP 8×8 tile 序号。
   */
  onIdlePoll: () => {
    if (tileVideoLoader.isTransferring()) {
      return;
    }
    const chunkIdx = bgPlayer.getCurrentChunkIndex();
    if (chunkIdx < 0) {
      return;
    }

    const result = viewportPredictor.computePredictedTiles(camera);
    window.__lastPredictedViewportTiles = result.tileIndices.slice();
    window.__lastPredictedViewportMeta = {
      predYaw: result.predYaw,
      predPitch: result.predPitch,
      halfYaw: result.halfYaw,
      halfPitch: result.halfPitch,
    };
    const now = performance.now();
    if (now - lastPredictedTilesLogMs >= 5000) {
      lastPredictedTilesLogMs = now;
      console.log(
        "[viewportPred] tiles (200ms ahead, 8×8 ERP):",
        result.tileIndices.join(",")
      );
    }

    void tileVideoLoader.fetchAndBindVideos(chunkIdx, result.tileIndices, {
      prefetchNextChunk: true,
      bgPlayer,
    });
  },
  onStatus: (ev) => {
    const span = overlay.querySelector("span");
    if (!span) return;
    if (ev.message === "buffering") {
      span.textContent = `缓冲中…（目标 ≥5s，约 ${ev.needChunks} 个 chunk）`;
    } else if (ev.message === "fetch") {
      span.textContent = `加载 chunk ${String(ev.chunkIdx).padStart(4, "0")}…`;
    } else if (ev.error) {
      span.textContent = `错误：${ev.error}`;
    }
  },
});

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  2000
);
camera.position.set(0, 0, 0);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const geometry = new THREE.SphereGeometry(500, 48, 24);
geometry.scale(-1, 1, 1);

const sphereTexture = erpCompositor.texture;

const material = new THREE.MeshBasicMaterial({ map: sphereTexture });
material.side = THREE.DoubleSide;
const sphere = new THREE.Mesh(geometry, material);
scene.add(sphere);
viewportPredictor.setSphereMesh(sphere);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableZoom = false;
controls.enablePan = false;
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.rotateSpeed = -0.35;
controls.target.set(0, 0, -1);
controls.minDistance = 1;
controls.maxDistance = 1;
controls.minPolarAngle = 0.05;
controls.maxPolarAngle = Math.PI - 0.05;
controls.update();

/** 控制台核查 tile 映射：__tileMapDebug.snap()、__tileMapDebug.manifestCheck(0, 27) */
window.__tileMapDebug = {
  snap: () => console.log("[tileMapDebug]", debugSnapshot(camera, viewportPredictor)),
  manifestCheck: (chunkIdx = 0, tileIdx = 27) =>
    compareManifestTile("./video_1s/video_size.json", chunkIdx, tileIdx).then((x) =>
      console.log("[tileMapDebug] manifest vs 公式网格", x)
    ),
  erpRect: tileIdxToErpRect,
  centerTileFromYawPitch: centerTileIndexFromYawPitch,
};

function syncPlayPauseLabel() {
  const playing = !video.paused;
  btnPlayPause.textContent = playing ? "Pause" : "Play";
  btnPlayPause.setAttribute("aria-pressed", playing ? "true" : "false");
}

let playbackBusy = false;

async function startPlayback() {
  if (playbackBusy) return;
  playbackBusy = true;
  const span = overlay.querySelector("span");
  try {
    await bgPlayer.start();
    overlay.classList.add("hidden");
    document.body.classList.add("started");
    syncPlayPauseLabel();
  } catch {
    if (span) {
      span.textContent =
        "无法开始播放：请确认已通过 http 访问本页，且存在 ./video_1s/video_size.json 与背景 chunk。";
    }
  } finally {
    playbackBusy = false;
  }
}

overlay.addEventListener("click", startPlayback, { once: false });

btnPlayPause.addEventListener("click", () => {
  if (video.paused) {
    video.play().catch(() => {});
  } else {
    video.pause();
  }
  syncPlayPauseLabel();
});

speedSelect.addEventListener("change", () => {
  video.playbackRate = parseFloat(speedSelect.value) || 1;
});

video.addEventListener("play", syncPlayPauseLabel);
video.addEventListener("pause", syncPlayPauseLabel);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
  erpCompositor.update(
    video,
    bgPlayer.getCurrentChunkIndex(),
    tileVideoLoader
  );
  controls.update();
  viewportPredictor.pushSample(camera);
  renderer.render(scene, camera);
});
