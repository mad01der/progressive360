/**
 * 线性视口预测：基于最近 HISTORY_MS 内的朝向采样，外推 PREDICT_MS 后的 yaw/pitch，
 * 按 E3PO 约定（ERP 8×8，3840×1920）计算与预测视锥相交的 tile 序号（行优先 row*8+col）。
 *
 * 优先用 Raycaster 击中贴图球面得到的 UV 换算 yaw/pitch，与 GPU 采样、画布叠 tile 一致；
 * 解析 atan2 易与 scale(-1,1,1)、flipY 产生系统性横向错位。
 */

import * as THREE from "three";

export const HISTORY_MS = 100;
export const PREDICT_MS = 200;

const TILES_W = 8;
const TILES_H = 8;

/**
 * 球面 UV → 与 tileYawPitchBounds 一致的 yaw/pitch（ERP u∈[0,1] 从左到右对应 yaw -π→π）
 */
export function erpUvToYawPitch(uv) {
  const yaw = -Math.PI + uv.x * 2 * Math.PI;
  const pitch = Math.PI / 2 - uv.y * Math.PI;
  return { yaw, pitch };
}

/**
 * 兜底：无球面相交时用世界方向估算（可能与渲染差半圈，仅作 fallback）
 */
export function directionToYawPitch(dir) {
  const yaw = Math.atan2(-dir.x, -dir.z);
  const pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
  return { yaw, pitch };
}

/**
 * 从相机射线击中带贴图的球体，取交点 UV（与渲染一致）
 */
export function yawPitchFromSphereRay(origin, direction, sphereMesh, raycaster) {
  raycaster.ray.origin.copy(origin);
  raycaster.ray.direction.copy(direction).normalize();
  const hits = raycaster.intersectObject(sphereMesh, false);
  if (!hits.length || !hits[0].uv) {
    return null;
  }
  return erpUvToYawPitch(hits[0].uv);
}

function unwrapYawDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** ERP 下单个 tile 在 yaw/pitch 上的包围盒（弧度） */
function tileYawPitchBounds(row, col) {
  const dx = (2 * Math.PI) / TILES_W;
  const dy = Math.PI / TILES_H;
  const yawLo = -Math.PI + col * dx;
  const yawHi = yawLo + dx;
  const pitchTop = Math.PI / 2 - row * dy;
  const pitchBot = pitchTop - dy;
  return { yawLo, yawHi, pitchBot, pitchTop };
}

/** 最短弧长下的 yaw 差是否在 [-half, half] 内（相对于 center） */
function yawWithinHalf(center, yaw, half) {
  const d = unwrapYawDelta(center, yaw);
  return Math.abs(d) <= half + 1e-9;
}

/** 预测视锥：中心 (yaw,pitch)，半角 hx、hy；与 tile 轴对齐包围盒是否相交（采样角点） */
export function tilesIntersectingViewCone(predYaw, predPitch, halfYaw, halfPitch) {
  const indices = [];
  for (let row = 0; row < TILES_H; row++) {
    for (let col = 0; col < TILES_W; col++) {
      const { yawLo, yawHi, pitchBot, pitchTop } = tileYawPitchBounds(row, col);
      const corners = [
        [yawLo, pitchBot],
        [yawLo, pitchTop],
        [yawHi, pitchBot],
        [yawHi, pitchTop],
        [(yawLo + yawHi) * 0.5, (pitchBot + pitchTop) * 0.5],
      ];
      let hit = false;
      for (const [yw, pt] of corners) {
        if (
          yawWithinHalf(predYaw, yw, halfYaw) &&
          Math.abs(pt - predPitch) <= halfPitch + 1e-9
        ) {
          hit = true;
          break;
        }
      }
      if (!hit) {
        const centerYaw = (yawLo + yawHi) * 0.5;
        const centerPitch = (pitchBot + pitchTop) * 0.5;
        if (
          yawWithinHalf(predYaw, centerYaw, halfYaw) &&
          Math.abs(centerPitch - predPitch) <= halfPitch + 1e-9
        ) {
          hit = true;
        }
      }
      if (!hit && pointInYawPitchTile(predYaw, predPitch, row, col)) {
        hit = true;
      }
      if (hit) indices.push(row * TILES_W + col);
    }
  }
  return indices;
}

/** 由 PerspectiveCamera 得到垂直/水平半角（弧度） */
export function cameraHalfAnglesRad(camera) {
  const vFov = (camera.fov * Math.PI) / 180;
  const halfY = vFov * 0.5;
  const halfX = Math.atan(Math.tan(halfY) * camera.aspect);
  return { halfYaw: halfX, halfPitch: halfY };
}

function pointInYawPitchTile(yaw, pitch, row, col) {
  const { yawLo, yawHi, pitchBot, pitchTop } = tileYawPitchBounds(row, col);
  if (pitch < pitchBot - 1e-9 || pitch > pitchTop + 1e-9) return false;
  const yc = (yawLo + yawHi) * 0.5;
  const hw = (yawHi - yawLo) * 0.5;
  return Math.abs(unwrapYawDelta(yc, yaw)) <= hw + 1e-9;
}

export class ViewportPredictor {
  constructor() {
    /** @type {{ t: number, yaw: number, pitch: number }[]} */
    this._samples = [];
    /** @type {THREE.Mesh | null} */
    this._sphereMesh = null;
    this._raycaster = new THREE.Raycaster();
  }

  /** 传入与 CanvasTexture 一致的贴图球（main 里的 sphere） */
  setSphereMesh(mesh) {
    this._sphereMesh = mesh;
  }

  /** 与 pushSample 一致，供调试或外部读取 */
  currentYawPitch(camera) {
    return this._yawPitchFromCamera(camera);
  }

  _yawPitchFromCamera(camera) {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const origin = new THREE.Vector3();
    camera.getWorldPosition(origin);
    if (this._sphereMesh) {
      const yp = yawPitchFromSphereRay(origin, dir, this._sphereMesh, this._raycaster);
      if (yp) return yp;
    }
    return directionToYawPitch(dir);
  }

  /**
   * 每帧调用：记录当前相机朝向（应在 controls.update 之后）
   * @param {THREE.Camera} camera
   */
  pushSample(camera) {
    const { yaw, pitch } = this._yawPitchFromCamera(camera);
    const t = performance.now();
    this._samples.push({ t, yaw, pitch });
    const cutoff = t - HISTORY_MS;
    while (this._samples.length > 0 && this._samples[0].t < cutoff) {
      this._samples.shift();
    }
  }

  /**
   * 线性外推 PREDICT_MS 后的 yaw/pitch；样本不足时退回当前朝向
   * @param {THREE.Camera} camera
   */
  predictYawPitch(camera) {
    const cur = this._yawPitchFromCamera(camera);
    const now = performance.now();
    const windowStart = now - HISTORY_MS;
    const inWin = this._samples.filter((s) => s.t >= windowStart);
    if (inWin.length < 2) {
      return { yaw: cur.yaw, pitch: cur.pitch };
    }
    const first = inWin[0];
    const last = inWin[inWin.length - 1];
    const dtSec = (last.t - first.t) / 1000;
    if (dtSec < 1e-4) {
      return { yaw: cur.yaw, pitch: cur.pitch };
    }
    const vy = unwrapYawDelta(first.yaw, last.yaw) / dtSec;
    const vp = (last.pitch - first.pitch) / dtSec;
    let yaw = last.yaw + vy * (PREDICT_MS / 1000);
    let pitch = last.pitch + vp * (PREDICT_MS / 1000);
    yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    pitch = clamp(pitch, -Math.PI / 2 + 1e-6, Math.PI / 2 - 1e-6);
    return { yaw, pitch };
  }

  /**
   * @param {THREE.Camera} camera
   * @returns {{ tileIndices: number[], predYaw: number, predPitch: number, halfYaw: number, halfPitch: number }}
   */
  computePredictedTiles(camera) {
    const { yaw, pitch } = this.predictYawPitch(camera);
    const { halfYaw, halfPitch } = cameraHalfAnglesRad(camera);
    const tileIndices = tilesIntersectingViewCone(yaw, pitch, halfYaw, halfPitch);
    return {
      tileIndices,
      predYaw: yaw,
      predPitch: pitch,
      halfYaw,
      halfPitch,
    };
  }
}
