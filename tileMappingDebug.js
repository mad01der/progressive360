/**
 * 核查「视口预测 tile 序号」与「本地 8×8 ERP 划分 / manifest」是否一致。
 * 浏览器控制台：__tileMapDebug.snap()、__tileMapDebug.manifestCheck(0, 27)
 */

import { tileIdxToErpRect } from "./erpSphereCompositor.js";

const COLS = 8;
const ROWS = 8;

/**
 * 与 viewportPredictor 里 tileYawPitchBounds 一致：视线中心落在哪一格（0..63）。
 */
export function centerTileIndexFromYawPitch(yaw, pitch) {
  const dx = (2 * Math.PI) / COLS;
  const dy = Math.PI / ROWS;
  const col = Math.min(COLS - 1, Math.max(0, Math.floor((yaw + Math.PI) / dx)));
  const row = Math.min(ROWS - 1, Math.max(0, Math.floor((Math.PI / 2 - pitch) / dy)));
  return row * COLS + col;
}

/**
 * 当前相机 + 预测结果一览，用于核对「中心射线 tile」是否在预测列表内。
 */
export function debugSnapshot(camera, viewportPredictor) {
  const cur = viewportPredictor.currentYawPitch(camera);
  const currentCenterTile = centerTileIndexFromYawPitch(cur.yaw, cur.pitch);

  const pred = viewportPredictor.computePredictedTiles(camera);
  const predCenterTile = centerTileIndexFromYawPitch(pred.predYaw, pred.predPitch);

  return {
    currentRayDeg: {
      yaw: (cur.yaw * 180) / Math.PI,
      pitch: (cur.pitch * 180) / Math.PI,
    },
    currentCenterTile,
    currentErpRectPx: tileIdxToErpRect(currentCenterTile),
    predicted200ms: {
      predYawDeg: (pred.predYaw * 180) / Math.PI,
      predPitchDeg: (pred.predPitch * 180) / Math.PI,
      centerTile: predCenterTile,
      erpRectPx: tileIdxToErpRect(predCenterTile),
      tileList: pred.tileIndices.slice(),
      /** 预测中心所在格应在视锥相交集合里（大视场下几乎恒为 true） */
      listContainsPredCenter: pred.tileIndices.includes(predCenterTile),
    },
  };
}

/**
 * 对照 manifest 里某个 chunk 的 tile 条目的 start_position 是否与公式 grid 一致。
 */
export async function compareManifestTile(manifestUrl, chunkIdx, tileIdx) {
  const res = await fetch(manifestUrl, { mode: "cors", credentials: "omit" });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  const m = await res.json();
  const c = String(chunkIdx).padStart(4, "0");
  const t = String(tileIdx).padStart(3, "0");
  const key = `chunk_${c}_tile_${t}`;
  const seg = m[key]?.user_video_spec?.segment_info;
  const start = seg?.start_position;
  const out = seg?.segment_out_info;
  const formula = tileIdxToErpRect(tileIdx);
  const match =
    !!start &&
    Number(start.width) === formula.x &&
    Number(start.height) === formula.y &&
    Number(out?.width) === formula.w &&
    Number(out?.height) === formula.h;
  return {
    manifestKey: key,
    manifestStart: start,
    manifestOut: out,
    formulaErpRectPx: formula,
    gridMatchesManifest: match,
  };
}
