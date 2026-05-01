import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const overlay = document.getElementById("overlay");
const btnPlayPause = document.getElementById("btnPlayPause");
const speedSelect = document.getElementById("speedSelect");

const video = document.createElement("video");
video.src = "./video.mp4";
video.loop = true;
video.muted = true;
video.playsInline = true;
video.setAttribute("playsinline", "");
video.setAttribute("webkit-playsinline", "");
video.playbackRate = 1;

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

const texture = new THREE.VideoTexture(video);
texture.colorSpace = THREE.SRGBColorSpace;
texture.minFilter = THREE.LinearFilter;
texture.magFilter = THREE.LinearFilter;

const material = new THREE.MeshBasicMaterial({ map: texture });
const sphere = new THREE.Mesh(geometry, material);
scene.add(sphere);

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

function syncPlayPauseLabel() {
  const playing = !video.paused;
  btnPlayPause.textContent = playing ? "Pause" : "Play";
  btnPlayPause.setAttribute("aria-pressed", playing ? "true" : "false");
}

function startPlayback() {
  video
    .play()
    .then(() => {
      overlay.classList.add("hidden");
      document.body.classList.add("started");
      syncPlayPauseLabel();
    })
    .catch(() => {
      overlay.querySelector("span").textContent =
        "Error: Unable to autoplay. Please try again or check the console.";
    });
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
  if (
    !video.paused &&
    video.readyState >= video.HAVE_CURRENT_DATA
  ) {
    texture.needsUpdate = true;
  }
  controls.update();
  renderer.render(scene, camera);
});
