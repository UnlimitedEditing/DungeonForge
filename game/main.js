// =====================================================================
// dungeon-forge / main.js
//
// Two scenes, one renderer:
//   FORGE — The hub. Slow drifting camera, ember particles, wisp
//           geometry, forge structure. Menu overlays for lore, config,
//           and experience launch. Shown after login, returned to via
//           the terminal back button.
//   ROOM  — The existing FPS sandbox. PointerLockControls, WASD,
//           spawn terminal, roaming sprites.
//
// Scene manager switches which scene the renderer draws each tick.
// =====================================================================

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const FORGE_BASE  = window.location.origin;

// Room
const ROOM_SIZE   = 20;
const WALL_HEIGHT = 4.5;
const PLAYER_EYE  = 1.7;
const MOVE_SPEED  = 4.5;
const FRICTION    = 10;
const POLL_MS     = 3000;

const ROAM_SPEED_MIN = 0.7;
const ROAM_SPEED_MAX = 1.3;
const ROAM_ARRIVE_D  = 0.25;
const ROAM_PAUSE_MIN = 1.0;
const ROAM_PAUSE_MAX = 3.0;
const ROAM_BOUND     = ROOM_SIZE / 2 - 1.8;

const SPAWN_RING = [
  [ 0, -4], [ 3, -3], [ 4,  0], [ 3,  3],
  [ 0,  4], [-3,  3], [-4,  0], [-3, -3],
];
let spawnIndex = 0;
function nextSpawn() {
  const [x, z] = SPAWN_RING[spawnIndex % SPAWN_RING.length];
  spawnIndex++;
  return new THREE.Vector3(x, 0, z);
}
function randomRoamTarget() {
  return new THREE.Vector3(
    (Math.random() * 2 - 1) * ROAM_BOUND,
    0,
    (Math.random() * 2 - 1) * ROAM_BOUND,
  );
}

// ─────────────────────────────────────────────
// SCENE MANAGER
// ─────────────────────────────────────────────

let appMode = 'forge'; // 'forge' | 'room'

const forgeHubEl = document.getElementById('forge-hub');
const terminal   = document.getElementById('terminal');
const crosshair  = document.getElementById('crosshair');

function showForgeHub() {
  forgeHubEl.dataset.active = 'true';
  document.getElementById('forge-player-name').textContent = profileUsername || '—';
}
function hideForgeHub() {
  forgeHubEl.dataset.active = 'false';
}

function enterRoom() {
  appMode = 'room';
  hideForgeHub();
  closeLorePanel();
  terminal.dataset.open = 'true';
  crosshair.dataset.visible = 'false';
}

function returnToForge() {
  appMode = 'forge';
  if (controls.isLocked) controls.unlock();
  terminal.dataset.open = 'false';
  crosshair.dataset.visible = 'false';
  showForgeHub();
}

// ─────────────────────────────────────────────
// PROFILE / AUTH
// ─────────────────────────────────────────────

const setupScreen  = document.getElementById('setup-screen');
const setupTabBtns = document.querySelectorAll('.setup-tab-btn');
const setupPanels  = document.querySelectorAll('.setup-panel');

const regUsername = document.getElementById('reg-username');
const regApiKey   = document.getElementById('reg-apikey');
const regPassword = document.getElementById('reg-password');
const regConfirm  = document.getElementById('reg-confirm');
const regBtn      = document.getElementById('reg-btn');
const regStatus   = document.getElementById('reg-status');

const loginUsername = document.getElementById('login-username');
const loginPassword = document.getElementById('login-password');
const loginBtn      = document.getElementById('login-btn');
const loginStatus   = document.getElementById('login-status');

let profileId       = null;
let profileUsername = null;

setupTabBtns.forEach(btn => btn.addEventListener('click', () => {
  const t = btn.dataset.setupTab;
  setupTabBtns.forEach(b => b.classList.toggle('active', b.dataset.setupTab === t));
  setupPanels.forEach(p => p.style.display = p.dataset.setupPanel === t ? '' : 'none');
  if (t === 'login') loginUsername.focus(); else regUsername.focus();
}));

function switchSetupTab(tab) {
  setupTabBtns.forEach(b => b.classList.toggle('active', b.dataset.setupTab === tab));
  setupPanels.forEach(p => p.style.display = p.dataset.setupPanel === tab ? '' : 'none');
}
function showSetup(tab = 'register') {
  switchSetupTab(tab);
  setupScreen.dataset.active = 'true';
  setTimeout(() => { if (tab === 'login') loginUsername.focus(); else regUsername.focus(); }, 50);
}
function hideSetup() {
  setupScreen.dataset.active = 'false';
  showForgeHub();
}

function setStatus(el, state, msg) { el.dataset.state = state; el.textContent = msg; }

async function onSessionReady(p) {
  profileId = p.profile_id; profileUsername = p.username;
  localStorage.setItem('profile_id', p.profile_id);
  localStorage.setItem('profile_username', p.username);
}

async function doRegister() {
  const username = regUsername.value.trim();
  const apiKey   = regApiKey.value.trim();
  const password = regPassword.value;
  const confirm  = regConfirm.value;
  if (!username || !apiKey || !password) { setStatus(regStatus, 'error', 'all fields required'); return; }
  if (password !== confirm)              { setStatus(regStatus, 'error', 'passwords do not match'); return; }
  regBtn.disabled = true;
  setStatus(regStatus, 'working', 'validating key and creating profile…');
  try {
    const res = await fetch(`${FORGE_BASE}/profiles/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, api_key: apiKey }),
    });
    if (!res.ok) throw new Error(await res.text());
    const p = await res.json();
    await onSessionReady(p);
    setStatus(regStatus, 'ok', `registered as ${p.username}`);
    setTimeout(hideSetup, 900);
  } catch (e) {
    setStatus(regStatus, 'error', e.message.replace(/^"(.*)"$/, '$1'));
  } finally { regBtn.disabled = false; }
}

async function doLogin() {
  const username = loginUsername.value.trim();
  const password = loginPassword.value;
  if (!username || !password) { setStatus(loginStatus, 'error', 'all fields required'); return; }
  loginBtn.disabled = true;
  setStatus(loginStatus, 'working', 'authenticating…');
  try {
    const res = await fetch(`${FORGE_BASE}/profiles/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error(await res.text());
    const p = await res.json();
    await onSessionReady(p);
    setStatus(loginStatus, 'ok', `welcome back, ${p.username}`);
    setTimeout(hideSetup, 900);
  } catch (e) {
    setStatus(loginStatus, 'error', e.message.replace(/^"(.*)"$/, '$1'));
  } finally { loginBtn.disabled = false; }
}

regBtn.addEventListener('click', doRegister);
[regUsername, regApiKey, regPassword, regConfirm].forEach(el =>
  el.addEventListener('keydown', e => { if (e.code === 'Enter') { e.preventDefault(); doRegister(); } })
);
loginBtn.addEventListener('click', doLogin);
[loginUsername, loginPassword].forEach(el =>
  el.addEventListener('keydown', e => { if (e.code === 'Enter') { e.preventDefault(); doLogin(); } })
);

async function initProfile() {
  const storedId   = localStorage.getItem('profile_id');
  const storedName = localStorage.getItem('profile_username');
  if (storedId) {
    try {
      const res = await fetch(`${FORGE_BASE}/profiles/${storedId}`);
      if (res.ok) {
        const p = await res.json();
        if (p.active_session) {
          profileId = p.profile_id; profileUsername = p.username;
          hideSetup(); return;
        }
        if (storedName) loginUsername.value = storedName;
        showSetup('login'); return;
      }
    } catch (_) {}
  }
  showSetup('register');
}

// ─────────────────────────────────────────────
// RENDERER  (shared by both scenes)
// ─────────────────────────────────────────────

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.NoToneMapping;
document.getElementById('viewport').appendChild(renderer.domElement);

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  forgeCamera.aspect = w / h;
  forgeCamera.updateProjectionMatrix();
  roomCamera.aspect = w / h;
  roomCamera.updateProjectionMatrix();
});

// ─────────────────────────────────────────────
// THE FORGE SCENE
// ─────────────────────────────────────────────

const forgeScene = new THREE.Scene();
forgeScene.background = new THREE.Color(0x040200);
forgeScene.fog = new THREE.Fog(0x040200, 5, 18);

const forgeCamera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.05, 50);
forgeCamera.position.set(0, 2.4, 5.5);
forgeCamera.lookAt(0, 1.2, 0);

// Lighting
forgeScene.add(new THREE.AmbientLight(0x120800, 0.4));
const forgeLight = new THREE.PointLight(0xff5510, 4.0, 14, 1.8);
forgeLight.position.set(0, 1.8, 0);
forgeScene.add(forgeLight);
// Subtle fill from behind camera to keep far walls readable
const fillLight = new THREE.PointLight(0x200e04, 0.8, 20, 1.2);
fillLight.position.set(0, 3, 7);
forgeScene.add(fillLight);

// Floor
forgeScene.add(Object.assign(
  new THREE.Mesh(
    new THREE.PlaneGeometry(18, 18),
    new THREE.MeshStandardMaterial({ color: 0x110800, roughness: 1 }),
  ),
  { rotation: new THREE.Euler(-Math.PI / 2, 0, 0) }
));

// Walls
const forgWallMat = new THREE.MeshStandardMaterial({ color: 0x1a0e06, roughness: 1 });
function addForgeWall(x, z, rotY) {
  const w = new THREE.Mesh(new THREE.PlaneGeometry(18, 8), forgWallMat);
  w.position.set(x, 3, z); w.rotation.y = rotY;
  forgeScene.add(w);
}
addForgeWall(0,   -9,  0);
addForgeWall(0,    9,  Math.PI);
addForgeWall(-9,   0,  Math.PI / 2);
addForgeWall( 9,   0, -Math.PI / 2);

const stoneMat = new THREE.MeshStandardMaterial({ color: 0x1e1008, roughness: 0.95 });

// Forge platform
forgeScene.add(Object.assign(
  new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.2, 0.4, 20), stoneMat),
  { position: new THREE.Vector3(0, 0.2, 0) }
));

// Basin ring
const basinRing = new THREE.Mesh(
  new THREE.TorusGeometry(1.4, 0.18, 8, 28),
  new THREE.MeshStandardMaterial({ color: 0x2a1808, roughness: 0.9 }),
);
basinRing.rotation.x = -Math.PI / 2;
basinRing.position.set(0, 0.42, 0);
forgeScene.add(basinRing);

// Anvil block
forgeScene.add(Object.assign(
  new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.55, 0.45),
    new THREE.MeshStandardMaterial({ color: 0x252015, roughness: 0.7, metalness: 0.35 }),
  ),
  { position: new THREE.Vector3(0, 0.9, 0) }
));
// Anvil horn
forgeScene.add(Object.assign(
  new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.15, 0.4, 8),
    new THREE.MeshStandardMaterial({ color: 0x252015, roughness: 0.7, metalness: 0.35 }),
  ),
  { position: new THREE.Vector3(0.52, 0.8, 0), rotation: new THREE.Euler(0, 0, -Math.PI / 2) }
));

// Stone pillars at corners
const pillarMat = new THREE.MeshStandardMaterial({ color: 0x160c04, roughness: 1 });
[[-6, -6], [6, -6], [-6, 6], [6, 6]].forEach(([x, z]) => {
  const p = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 7, 10), pillarMat);
  p.position.set(x, 3.5, z);
  forgeScene.add(p);
});

// ── Ember particle system ──
const EMBER_COUNT = 140;
const ePos  = new Float32Array(EMBER_COUNT * 3);
const eVel  = [];

for (let i = 0; i < EMBER_COUNT; i++) {
  const angle = Math.random() * Math.PI * 2;
  const r     = Math.random() * 1.3;
  ePos[i*3]   = Math.cos(angle) * r;
  ePos[i*3+1] = 0.4 + Math.random() * 3.5;
  ePos[i*3+2] = Math.sin(angle) * r;
  eVel.push({
    x: (Math.random() - 0.5) * 0.25,
    y: 0.35 + Math.random() * 0.7,
    z: (Math.random() - 0.5) * 0.25,
  });
}

const emberGeo = new THREE.BufferGeometry();
emberGeo.setAttribute('position', new THREE.BufferAttribute(ePos, 3));
const embers = new THREE.Points(emberGeo, new THREE.PointsMaterial({
  color: 0xff6010, size: 0.055, transparent: true, opacity: 0.85,
  sizeAttenuation: true, depthWrite: false,
}));
forgeScene.add(embers);

// ── Wispy floating geometry ──
const wispMat = new THREE.MeshBasicMaterial({
  color: 0x9070ff, transparent: true, opacity: 0.12, wireframe: true,
});
const wisps = [];
for (let i = 0; i < 6; i++) {
  const angle  = (i / 6) * Math.PI * 2;
  const radius = 2.2 + Math.random() * 1.4;
  const wisp   = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.12 + Math.random() * 0.18, 0),
    wispMat.clone(),
  );
  wisp.position.set(Math.cos(angle) * radius, 1.4 + Math.random() * 1.6, Math.sin(angle) * radius);
  wisp.userData = {
    orbitAngle:  angle,
    orbitRadius: radius,
    orbitSpeed:  (0.08 + Math.random() * 0.12) * (Math.random() > 0.5 ? 1 : -1),
    bobOffset:   Math.random() * Math.PI * 2,
    bobSpeed:    0.4 + Math.random() * 0.3,
    baseY:       wisp.position.y,
  };
  forgeScene.add(wisp);
  wisps.push(wisp);
}

function updateForge(dt, t) {
  // Ember physics
  for (let i = 0; i < EMBER_COUNT; i++) {
    eVel[i].x += (Math.random() - 0.5) * 0.4 * dt;
    eVel[i].z += (Math.random() - 0.5) * 0.4 * dt;
    ePos[i*3]   += eVel[i].x * dt;
    ePos[i*3+1] += eVel[i].y * dt;
    ePos[i*3+2] += eVel[i].z * dt;
    if (ePos[i*3+1] > 5.5 || Math.abs(ePos[i*3]) > 3 || Math.abs(ePos[i*3+2]) > 3) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 1.3;
      ePos[i*3]   = Math.cos(a) * r;
      ePos[i*3+1] = 0.4 + Math.random() * 0.3;
      ePos[i*3+2] = Math.sin(a) * r;
      eVel[i]     = { x: (Math.random()-0.5)*0.2, y: 0.35+Math.random()*0.7, z: (Math.random()-0.5)*0.2 };
    }
  }
  emberGeo.attributes.position.needsUpdate = true;

  // Wisp orbit
  for (const w of wisps) {
    const d = w.userData;
    d.orbitAngle += d.orbitSpeed * dt;
    w.position.x  = Math.cos(d.orbitAngle) * d.orbitRadius;
    w.position.z  = Math.sin(d.orbitAngle) * d.orbitRadius;
    w.position.y  = d.baseY + Math.sin(t * d.bobSpeed + d.bobOffset) * 0.25;
    w.rotation.x += dt * 0.4;
    w.rotation.y += dt * 0.6;
  }

  // Forge light flicker
  forgeLight.intensity = 3.6 + Math.sin(t * 7.3) * 0.3 + Math.sin(t * 13.1) * 0.15;

  // Slow camera drift
  forgeCamera.position.x = Math.sin(t * 0.09) * 1.2;
  forgeCamera.position.z = 5.5 + Math.cos(t * 0.07) * 0.4;
  forgeCamera.position.y = 2.4 + Math.sin(t * 0.11) * 0.15;
  forgeCamera.lookAt(0, 1.2 + Math.sin(t * 0.13) * 0.08, 0);
}

// ─────────────────────────────────────────────
// FORGE HUB UI
// ─────────────────────────────────────────────

document.getElementById('forge-enter-btn').addEventListener('click', enterRoom);

// Config button — opens the config tab in the terminal
document.getElementById('forge-config-btn').addEventListener('click', () => {
  enterRoom();
  // Switch terminal to config tab after a tick so the panel is visible
  setTimeout(() => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'config'));
    document.querySelectorAll('.tab-panel').forEach(p => p.style.display = p.dataset.panel === 'config' ? '' : 'none');
    loadConfig();
  }, 50);
});

// Lore book
const lorePanelEl    = document.getElementById('lore-panel');
const loreTextarea   = document.getElementById('lore-textarea');
const loreStatus     = document.getElementById('lore-status');
const loreSaveBtn    = document.getElementById('lore-save-btn');
const loreCloseBtn   = document.getElementById('lore-close-btn');

function openLorePanel() {
  lorePanelEl.dataset.open = 'true';
  loadLore();
  loreTextarea.focus();
}
function closeLorePanel() {
  lorePanelEl.dataset.open = 'false';
}

async function loadLore() {
  try {
    const res = await fetch(`${FORGE_BASE}/config`);
    if (res.ok) loreTextarea.value = (await res.json()).lore ?? '';
  } catch (_) {}
}

async function saveLore() {
  loreSaveBtn.disabled = true;
  setStatus(loreStatus, 'saving', 'inscribing…');
  try {
    // Fetch current config so we only change the lore field
    const cfgRes = await fetch(`${FORGE_BASE}/config`);
    if (!cfgRes.ok) throw new Error('could not fetch config');
    const cfg = await cfgRes.json();
    cfg.lore = loreTextarea.value;
    const res = await fetch(`${FORGE_BASE}/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    if (!res.ok) throw new Error(await res.text());
    setStatus(loreStatus, 'saved', 'inscribed');
    setTimeout(() => { loreStatus.dataset.state = 'idle'; }, 2500);
  } catch (e) {
    setStatus(loreStatus, 'error', e.message);
  } finally { loreSaveBtn.disabled = false; }
}

document.getElementById('forge-lore-btn').addEventListener('click', openLorePanel);
loreCloseBtn.addEventListener('click', closeLorePanel);
loreSaveBtn.addEventListener('click', saveLore);

// ─────────────────────────────────────────────
// ROOM SCENE
// ─────────────────────────────────────────────

const roomScene = new THREE.Scene();
roomScene.background = new THREE.Color(0x000000);
roomScene.fog = new THREE.Fog(0x000000, 6, 22);

const roomCamera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.05, 200);
roomCamera.position.set(0, PLAYER_EYE, 6);

roomScene.add(new THREE.AmbientLight(0x2a1e10, 0.35));
const brazier = new THREE.PointLight(0xff8030, 1.2, 14, 1.6);
brazier.position.set(0, 2.5, 0);
roomScene.add(brazier);
const torch = new THREE.PointLight(0xffb060, 1.5, 10, 1.5);
roomScene.add(torch);

const floorMat   = new THREE.MeshStandardMaterial({ color: 0x3a2820, roughness: 0.95, metalness: 0.0 });
const ceilingMat = new THREE.MeshStandardMaterial({ color: 0x1a1208, roughness: 1 });
const wallMat    = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.95 });

const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SIZE, ROOM_SIZE), floorMat);
floor.rotation.x = -Math.PI / 2;
roomScene.add(floor);

const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SIZE, ROOM_SIZE), ceilingMat);
ceiling.rotation.x = Math.PI / 2;
ceiling.position.y = WALL_HEIGHT;
roomScene.add(ceiling);

function addWall(x, z, rotY) {
  const w = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SIZE, WALL_HEIGHT), wallMat);
  w.position.set(x, WALL_HEIGHT / 2, z); w.rotation.y = rotY;
  roomScene.add(w);
}
addWall(0, -ROOM_SIZE/2, 0); addWall(0, ROOM_SIZE/2, Math.PI);
addWall(-ROOM_SIZE/2, 0, Math.PI/2); addWall(ROOM_SIZE/2, 0, -Math.PI/2);

const dais = new THREE.Mesh(
  new THREE.CylinderGeometry(1.2, 1.4, 0.4, 12),
  new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 1 }),
);
dais.position.set(0, 0.2, 0);
roomScene.add(dais);

// ─────────────────────────────────────────────
// CONTROLS  (room only)
// ─────────────────────────────────────────────

const controls  = new PointerLockControls(roomCamera, renderer.domElement);
const termStatus = document.getElementById('terminal-status');

function openTerminal()  { terminal.dataset.open = 'true';  crosshair.dataset.visible = 'false'; }
function closeTerminal() { terminal.dataset.open = 'false'; crosshair.dataset.visible = 'true';  }

controls.addEventListener('lock',   () => { closeTerminal(); termStatus.textContent = 'link: locked'; });
controls.addEventListener('unlock', () => { openTerminal();  termStatus.textContent = 'link: idle';   });

renderer.domElement.addEventListener('click', () => {
  if (appMode !== 'room') return;
  if (terminal.dataset.open === 'true' && setupScreen.dataset.active !== 'true') controls.lock();
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Tab') {
    e.preventDefault();
    if (setupScreen.dataset.active === 'true' || appMode !== 'room') return;
    if (controls.isLocked) controls.unlock(); else controls.lock();
  }
  if (e.code === 'Escape' && appMode === 'room' && !controls.isLocked) {
    // Second ESC when already unlocked → back to Forge
    returnToForge();
  }
});

// ─────────────────────────────────────────────
// MOVEMENT
// ─────────────────────────────────────────────

const keys     = Object.create(null);
const velocity = new THREE.Vector3();
const moveDir  = new THREE.Vector3();

window.addEventListener('keydown', (e) => { keys[e.code] = true;  });
window.addEventListener('keyup',   (e) => { keys[e.code] = false; });

function updateMovement(dt) {
  if (!controls.isLocked) { velocity.set(0, 0, 0); return; }
  moveDir.z = (keys['KeyW'] ? 1 : 0) - (keys['KeyS'] ? 1 : 0);
  moveDir.x = (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0);
  if (moveDir.lengthSq() > 0) moveDir.normalize();
  velocity.x -= velocity.x * FRICTION * dt;
  velocity.z -= velocity.z * FRICTION * dt;
  velocity.x += moveDir.x * MOVE_SPEED * FRICTION * dt;
  velocity.z += moveDir.z * MOVE_SPEED * FRICTION * dt;
  controls.moveRight(velocity.x * dt);
  controls.moveForward(velocity.z * dt);
  const half = ROOM_SIZE / 2 - 0.4;
  const p = controls.object.position;
  p.x = Math.max(-half, Math.min(half, p.x));
  p.z = Math.max(-half, Math.min(half, p.z));
  p.y = PLAYER_EYE;
  torch.position.set(p.x, p.y + 0.2, p.z);
}

// ─────────────────────────────────────────────
// SPRITE SPAWNING
// ─────────────────────────────────────────────

const sprites       = new Map();
const textureLoader = new THREE.TextureLoader();

function makePlaceholder(position) {
  const mat  = new THREE.MeshBasicMaterial({ color: 0xd99a2b, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.2), mat);
  mesh.position.copy(position); mesh.position.y = 1.1;
  mesh.userData.isPlaceholder = true;
  mesh.userData.spawnTime     = performance.now();
  roomScene.add(mesh);
  return mesh;
}

function makeSprite(spriteName, position, onReady) {
  textureLoader.load(`${FORGE_BASE}/sprites/${spriteName}`, (tex) => {
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const mat    = new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.15, depthWrite: true });
    const sprite = new THREE.Sprite(mat);
    const h      = 2.2;
    sprite.scale.set(h * (tex.image.width / tex.image.height), h, 1);
    sprite.position.copy(position);
    sprite.position.y = h / 2;
    onReady(sprite, h / 2);
  }, undefined, (err) => console.error('texture load failed', err));
}

function applyWalkAnim(entry, animName) {
  const video = document.createElement('video');
  video.src = `${FORGE_BASE}/anims/${animName}`;
  video.loop = true; video.muted = true; video.playsInline = true; video.crossOrigin = 'anonymous';
  video.play().catch(() => {});
  const tex = new THREE.VideoTexture(video);
  tex.magFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
  const mat = entry.mesh.material;
  mat.map?.dispose(); mat.map = tex; mat.needsUpdate = true;
  entry.walkVideo = video; entry.walkAnimReady = true;
}

async function spawnFromPrompt(promptText) {
  if (!promptText || !profileId) return;
  let job;
  try {
    const res = await fetch(`${FORGE_BASE}/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptText, profile_id: profileId }),
    });
    if (!res.ok) throw new Error(`forge returned ${res.status}`);
    job = await res.json();
  } catch (e) { console.error('spawn failed', e); termStatus.textContent = 'link: ERROR'; return; }

  const position    = nextSpawn();
  const placeholder = makePlaceholder(position);
  sprites.set(job.id, { jobId: job.id, status: job.status, mesh: placeholder, position, prompt: promptText, floorY: 1.1, animJobId: null, walkAnimReady: false, walkVideo: null, roam: null });
  refreshJobList();
  pollJob(job.id);
}

async function pollJob(jobId) {
  while (true) {
    await new Promise(r => setTimeout(r, POLL_MS));
    let job;
    try {
      const res = await fetch(`${FORGE_BASE}/jobs/${jobId}`);
      if (!res.ok) throw new Error(res.status);
      job = await res.json();
    } catch (e) { console.warn('poll error', jobId, e); continue; }
    const entry = sprites.get(jobId);
    if (!entry) return;
    entry.status = job.status;
    refreshJobList();
    if (job.status === 'done') {
      makeSprite(job.sprite_name, entry.position, (sprite, floorY) => {
        roomScene.remove(entry.mesh);
        entry.mesh.material?.dispose(); entry.mesh.geometry?.dispose();
        roomScene.add(sprite);
        entry.mesh = sprite; entry.floorY = floorY; entry.roam = initRoam();
      });
      if (job.anim_job_id) { entry.animJobId = job.anim_job_id; pollWalkAnim(job.anim_job_id, entry); }
      return;
    }
    if (job.status === 'failed') {
      entry.mesh.material.color.set(0x8b1a1a); entry.mesh.material.opacity = 0.5; return;
    }
  }
}

async function pollWalkAnim(animJobId, entry) {
  while (true) {
    await new Promise(r => setTimeout(r, POLL_MS));
    let animJob;
    try {
      const res = await fetch(`${FORGE_BASE}/anim-jobs/${animJobId}`);
      if (!res.ok) throw new Error(res.status);
      animJob = await res.json();
    } catch (e) { console.warn('anim poll error', e); continue; }
    if (animJob.status === 'done' && animJob.anim_name && entry.mesh) {
      applyWalkAnim(entry, animJob.anim_name); refreshJobList(); return;
    }
    if (animJob.status === 'failed') { console.warn('walk anim failed', animJobId); return; }
  }
}

// ─────────────────────────────────────────────
// ROAMING
// ─────────────────────────────────────────────

function initRoam() {
  return { target: randomRoamTarget(), waitUntil: 0, speed: ROAM_SPEED_MIN + Math.random() * (ROAM_SPEED_MAX - ROAM_SPEED_MIN) };
}

function updateRoaming(dt) {
  const now = performance.now() / 1000;
  for (const e of sprites.values()) {
    if (e.status !== 'done' || !e.roam || !e.mesh) continue;
    if (now < e.roam.waitUntil) continue;
    const pos  = e.mesh.position;
    const dx   = e.roam.target.x - pos.x;
    const dz   = e.roam.target.z - pos.z;
    const dist = Math.sqrt(dx*dx + dz*dz);
    if (dist < ROAM_ARRIVE_D) {
      e.roam.waitUntil = now + ROAM_PAUSE_MIN + Math.random() * (ROAM_PAUSE_MAX - ROAM_PAUSE_MIN);
      e.roam.target    = randomRoamTarget();
    } else {
      pos.x += (dx / dist) * e.roam.speed * dt;
      pos.z += (dz / dist) * e.roam.speed * dt;
      pos.y  = e.floorY;
    }
  }
}

// ─────────────────────────────────────────────
// HUD
// ─────────────────────────────────────────────

const hudStatus  = document.getElementById('hud-status');
const hudSprites = document.getElementById('hud-sprite-count');
const hudQueue   = document.getElementById('hud-queue-count');
const hudPlayer  = document.getElementById('hud-player');
const hudPos     = document.getElementById('hud-pos');
const jobsListEl = document.getElementById('jobs-list');

function updateHudPlayer() { hudPlayer.textContent = profileUsername || '—'; }

function refreshHud() {
  let ready = 0, inflight = 0;
  for (const e of sprites.values()) {
    if (e.status === 'done') ready++; else if (e.status !== 'failed') inflight++;
  }
  hudSprites.textContent = ready;
  hudQueue.textContent   = inflight;
  hudStatus.textContent  = appMode === 'forge' ? 'THE FORGE' : controls.isLocked ? 'IN-WORLD' : 'TERMINAL';
  const p = roomCamera.position;
  hudPos.textContent = `${p.x.toFixed(1)},${p.z.toFixed(1)}`;
}

function refreshJobList() {
  if (sprites.size === 0) { jobsListEl.innerHTML = '<div class="muted">no jobs.</div>'; return; }
  const rows = [];
  for (const e of sprites.values()) {
    const animTag = e.walkAnimReady
      ? '<span class="job-anim" data-s="done">walk</span>'
      : e.animJobId ? '<span class="job-anim" data-s="pending">walk…</span>' : '';
    rows.push(`<div class="job-row">
      <span class="job-id">${e.jobId}</span>
      <span class="job-prompt">${escapeHtml(e.prompt)}</span>
      ${animTag}
      <span class="job-status" data-s="${e.status}">${e.status}</span>
    </div>`);
  }
  jobsListEl.innerHTML = rows.join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ─────────────────────────────────────────────
// CONFIG PANEL (terminal tab, also from forge)
// ─────────────────────────────────────────────

const tabBtns       = document.querySelectorAll('.tab-btn');
const tabPanels     = document.querySelectorAll('.tab-panel');
const cfgWorkflow   = document.getElementById('cfg-workflow');
const cfgAnimWf     = document.getElementById('cfg-anim-workflow');
const cfgSpriteTmpl = document.getElementById('cfg-sprite-template');
const cfgWalkTmpl   = document.getElementById('cfg-walk-template');
const cfgLore       = document.getElementById('cfg-lore');
const cfgSaveBtn    = document.getElementById('cfg-save-btn');
const cfgStatus     = document.getElementById('config-status');

tabBtns.forEach(btn => btn.addEventListener('click', () => {
  const t = btn.dataset.tab;
  tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  tabPanels.forEach(p => p.style.display = p.dataset.panel === t ? '' : 'none');
  if (t === 'config') loadConfig();
}));

async function loadConfig() {
  try {
    const res = await fetch(`${FORGE_BASE}/config`);
    if (!res.ok) return;
    const cfg = await res.json();
    cfgWorkflow.value   = cfg.workflow ?? '';
    cfgAnimWf.value     = cfg.anim_workflow ?? '';
    cfgSpriteTmpl.value = cfg.sprite_prompt_template ?? '';
    cfgWalkTmpl.value   = cfg.walk_prompt_template ?? '';
    cfgLore.value       = cfg.lore ?? '';
  } catch (e) { console.warn('config load failed', e); }
}

async function saveConfig() {
  cfgSaveBtn.disabled = true;
  setStatus(cfgStatus, 'saving', 'saving…');
  try {
    const res = await fetch(`${FORGE_BASE}/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflow: cfgWorkflow.value.trim(), anim_workflow: cfgAnimWf.value.trim(),
        sprite_prompt_template: cfgSpriteTmpl.value, walk_prompt_template: cfgWalkTmpl.value,
        lore: cfgLore.value,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    setStatus(cfgStatus, 'saved', 'config saved');
    setTimeout(() => { cfgStatus.dataset.state = 'idle'; }, 2500);
  } catch (e) {
    setStatus(cfgStatus, 'error', `save failed: ${e.message}`);
  } finally { cfgSaveBtn.disabled = false; }
}

cfgSaveBtn.addEventListener('click', saveConfig);

// ─────────────────────────────────────────────
// SPAWN TERMINAL WIRING
// ─────────────────────────────────────────────

const spawnInput = document.getElementById('spawn-input');
const spawnBtn   = document.getElementById('spawn-btn');

// Back to Forge button in terminal header
const backToForgeBtn = document.getElementById('back-to-forge-btn');
if (backToForgeBtn) backToForgeBtn.addEventListener('click', returnToForge);

function doSpawn() {
  const v = spawnInput.value.trim();
  if (!v) return;
  spawnFromPrompt(v);
  spawnInput.value = ''; spawnInput.focus();
}
spawnBtn.addEventListener('click', doSpawn);
spawnInput.addEventListener('keydown', e => { if (e.code === 'Enter') { e.preventDefault(); doSpawn(); } });

// ─────────────────────────────────────────────
// PLACEHOLDER PULSE
// ─────────────────────────────────────────────

function pulsePlaceholders(now) {
  for (const e of sprites.values()) {
    const mesh = e.mesh;
    if (!mesh?.userData.isPlaceholder) continue;
    const t = (now - mesh.userData.spawnTime) / 1000;
    mesh.material.opacity = 0.10 + 0.12 * (0.5 + 0.5 * Math.sin(t * 3));
    mesh.lookAt(roomCamera.position.x, mesh.position.y, roomCamera.position.z);
  }
}

// ─────────────────────────────────────────────
// MAIN LOOP
// ─────────────────────────────────────────────

const clock = new THREE.Clock();

function tick() {
  requestAnimationFrame(tick);
  const dt  = Math.min(clock.getDelta(), 0.05);
  const t   = clock.elapsedTime;
  const now = performance.now();

  refreshHud();

  if (appMode === 'forge') {
    updateForge(dt, t);
    renderer.render(forgeScene, forgeCamera);
  } else {
    updateMovement(dt);
    updateRoaming(dt);
    pulsePlaceholders(now);
    renderer.render(roomScene, roomCamera);
  }
}
tick();

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────

initProfile();
