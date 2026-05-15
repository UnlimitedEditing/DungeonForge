// =====================================================================
// scene.js — Three.js renderer, scenes, cameras, shared lights, controls
// =====================================================================

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

const PLAYER_EYE = 1.7;

// ─────────────────────────────────────────────
// RENDERER  (shared by both scenes)
// ─────────────────────────────────────────────

export const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.NoToneMapping;
document.getElementById('viewport').appendChild(renderer.domElement);

// ─────────────────────────────────────────────
// FORGE SCENE
// ─────────────────────────────────────────────

export const forgeScene = new THREE.Scene();
forgeScene.background = new THREE.Color(0x040200);
forgeScene.fog = new THREE.Fog(0x040200, 5, 18);

export const forgeCamera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.05, 50);
forgeCamera.position.set(0, 2.4, 5.5);
forgeCamera.lookAt(0, 1.2, 0);

// ─────────────────────────────────────────────
// ROOM SCENE
// ─────────────────────────────────────────────

export const roomScene = new THREE.Scene();
roomScene.background = new THREE.Color(0x000000);
roomScene.fog = new THREE.Fog(0x000000, 6, 22);

export const roomCamera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.05, 200);
roomCamera.position.set(0, PLAYER_EYE, 6);

// Persistent room-scene lights (level geometry and tile lights added dynamically by _buildLevel)
roomScene.add(new THREE.AmbientLight(0x3a2818, 0.4));
export const torch = new THREE.PointLight(0xffb060, 2.0, 13, 1.5);
roomScene.add(torch);
// Fallback brazier at origin — overridden per-room by level lights
export const brazier = new THREE.PointLight(0xff8030, 1.0, 18, 1.8);
brazier.position.set(0, 2.5, 0);
roomScene.add(brazier);

// ─────────────────────────────────────────────
// CONTROLS  (room only)
// ─────────────────────────────────────────────

export const controls = new PointerLockControls(roomCamera, renderer.domElement);
controls.pointerSpeed = 0; // disable built-in rotation — we handle it ourselves

// ─────────────────────────────────────────────
// RESIZE HANDLER
// ─────────────────────────────────────────────

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  forgeCamera.aspect = w / h;
  forgeCamera.updateProjectionMatrix();
  roomCamera.aspect = w / h;
  roomCamera.updateProjectionMatrix();
});
