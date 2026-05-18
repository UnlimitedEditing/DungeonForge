// =====================================================================
// dungeon-forge / main.js  (refactored — was a single 3100-line file)
//
// Owns: constants, Three.js forge scene geometry + particles,
//       room scene setup, controls, movement, main loop, profile/auth,
//       scene manager (launchExperience / returnToForge), minimap, boot.
// Everything else lives in the modules imported below.
// =====================================================================

import * as THREE from 'three';
import {
  generateLevel, buildLevelGeometry, buildLevelLights,
  isWalkable, getSpawnPoints, tileToWorld, TILE_SIZE, WALL_H,
} from './level.js';
import {
  fetchExperiences, fetchExperience, createFork, saveExperience,
  encodeShareCode, decodeShareCode, importFromCode, DEFAULT_EXPERIENCES,
} from './experiences.js';
import { emit, on, off, EVENTS } from './events.js';
import { init as initWorldState, reset as resetWorldState, snapshot as snapshotState } from './world-state.js';
import { loadTriggers, unloadTriggers, getLoadedTriggers } from './triggers.js';
import {
  loadScaffold, generateScaffold, pollScaffoldStatus,
  checkTriggers as checkScaffoldTriggers, getActivePromptModifier,
  getStatTier, getEvolutionHint, resetSession as resetLoreSession,
} from './lore-engine.js';

// New modules
import {
  player, sprites, worldItems, appMode, activeExperience, currentLevel, levelComplete,
  setAppMode, setActiveExperience, setCurrentLevel, setLevelComplete,
  profileId, profileUsername, setProfileId, setProfileUsername,
  liveAgroRange, liveAttackRange, liveMeleeRange,
  liveEntityAttackCd, livePlayerAttackCd, liveDropChance, liveDropPool,
  applyLiveConfig,
} from './state.js';
import { renderer, forgeScene, forgeCamera, roomScene, roomCamera, controls, torch, brazier } from './scene.js';
import {
  updatePlayerHud, flashHit, spawnDamageNumber,
  createEntityHpBar, refreshEntityHpBar, updateHpBarTransforms,
  refreshHud, refreshJobList, updateHudPlayer, escapeHtml,
  statsHudEl, updateTargetFrame, initActionBar, setHudInWorld,
} from './hud.js';
import {
  meleeAttack, killEntity, getEquipBonus, gainXp,
  spawnItemDrop, updateWorldItems, pickupItem, onPlayerDeath,
  savePlayerStats, openInventory, closeInventory, renderInventory,
  inventoryPanelEl,
  fireProjectile, updateProjectiles, updateDecals, clearProjectilesAndDecals,
} from './combat.js';
import {
  spawnFromPrompt, updateEntities, pulsePlaceholders,
  loadJobHistory, loadWalkSheet, renderEntities,
  setTermStatus, propColliders,
} from './entity.js';
import { initSpawnManager, setSpawnDensity } from './spawn-manager.js';
import { initWeapon, setWeaponType, hideWeapon, showWeapon } from './weapon.js';
import { initInteraction, tickInteraction, closeInteractionMenu } from './interaction.js';
import { initDialogue, tickDialogue } from './dialogue.js';
import {
  openLibraryPanel, closeLibraryPanel,
  openEntities, closeEntities,
  openPoseEditor, closePoseEditor,
  openArcanumPanel, closeArcanumPanel,
  openMachinariumPanel, closeMachinariumPanel,
  openSubstancePanel, closeSubstancePanel,
  openPickerPanel, closePickerPanel,
  openTerraPanel, closeTerraPanel,
  openUndercroftPanel, closeUndercroftPanel,
  openPropCataloguePanel, closePropCataloguePanel,
  syncPickerExperience, setLaunchExperience,
} from './hub-panels.js';

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

// ─────────────────────────────────────────────
// SCENE MANAGER
// ─────────────────────────────────────────────

const forgeHubEl = document.getElementById('forge-hub');
const terminal   = document.getElementById('terminal');
const crosshair  = document.getElementById('crosshair');

function showForgeHub() {
  forgeHubEl.dataset.active = 'true';
  terminal.dataset.open = 'false';
  document.getElementById('forge-player-name').textContent = profileUsername || '—';
}
function hideForgeHub() {
  forgeHubEl.dataset.active = 'false';
}

function enterRoom() {
  // Opens experience picker instead of going straight to the room.
  openPickerPanel();
}

async function launchExperience(exp) {
  setActiveExperience(exp);
  setAppMode('room');
  closePickerPanel();
  hideForgeHub();
  showWeapon();
  closeLibraryPanel();
  terminal.dataset.open = 'true';
  crosshair.dataset.visible = 'false';
  setHudInWorld(true);
  document.getElementById('minimap').dataset.visible = 'true';
  setLevelComplete(false);
  initWorldState(exp.state ?? {});
  await applyGameConfig();
  _buildLevel(exp);
  applyExperienceRules(exp);
  updatePlayerHud();
  emit(EVENTS.EXPERIENCE_LOADED, { id: exp.id, name: exp.name });
  loadScaffold(FORGE_BASE, exp.id);  // non-blocking — enriches next spawn if ready in time
}

// Wire launchExperience into hub-panels
setLaunchExperience(launchExperience);

function applyExperienceRules(exp) {
  const rules = exp?.rules ?? {};
  player.maxHp = rules.playerHp ?? 100;
  if (player.hp > player.maxHp) player.hp = player.maxHp;
  updatePlayerHud();
}

// Level geometry state (local to main.js — not shared state)
let levelGroup   = null;   // THREE.Group of level geometry (added to roomScene)
let levelWallMap = null;   // Map<"tileX,tileY:dir", {mesh,tileX,tileY,dir}> for wall interactions
let levelLights  = [];     // PointLights added to roomScene for the level
let levelEndPos = null;   // {x,z} world position of the exit pillar

function _buildLevel(exp) {
  // Tear down previous level geometry and lights
  if (levelGroup) { roomScene.remove(levelGroup); levelGroup = null; }
  levelWallMap = null;
  levelLights.forEach(l => roomScene.remove(l));
  levelLights = [];

  const lvlCfg = exp.level || {};
  const seed      = (lvlCfg.seed      ?? 42) >>> 0;
  const roomCount = lvlCfg.roomCount  ?? 18;
  const gridSize  = lvlCfg.gridSize   ?? 12;

  setCurrentLevel(generateLevel(seed, roomCount, gridSize));
  ({ group: levelGroup, wallMap: levelWallMap } = buildLevelGeometry(currentLevel));
  levelEndPos   = levelGroup.userData.endWorldPos ?? null;
  levelLights   = buildLevelLights(currentLevel);

  roomScene.add(levelGroup);
  levelLights.forEach(l => roomScene.add(l));

  loadTriggers(currentLevel.tiles);
  emit(EVENTS.LEVEL_LOADED, { seed, roomCount: currentLevel.rooms.length });

  // Apply world config from experience
  const world = exp.world || {};
  roomScene.fog = new THREE.Fog(
    parseInt(world.fogColor ?? '0x000000'),
    world.fogNear ?? 6,
    world.fogFar  ?? 25,
  );

  // Place player at start tile centre
  const startW = tileToWorld(currentLevel.start.x, currentLevel.start.y, currentLevel);
  const p = controls.object.position;
  p.set(startW.x, WALL_H * 0.378, startW.z); // PLAYER_EYE
  _yaw = 0; _pitch = 0;
  roomCamera.quaternion.setFromEuler(new THREE.Euler(0, 0, 0, 'YXZ'));

  // Spawn entities from level spawn points
  _spawnLevelEntities(exp);
}

function _spawnLevelEntities(exp) {
  // Clear existing sprites
  for (const [, entry] of sprites) {
    if (entry.mesh) roomScene.remove(entry.mesh);
  }
  sprites.clear();
}

function returnToForge() {
  setAppMode('forge');
  hideWeapon();
  try { closeInteractionMenu(); } catch (_) {}
  if (controls.isLocked) controls.unlock();
  unloadTriggers();
  resetWorldState();
  resetLoreSession();
  applyExperienceRules(null);
  terminal.dataset.open = 'false';
  crosshair.dataset.visible = 'false';
  setHudInWorld(false);
  updateTargetFrame(null);
  clearProjectilesAndDecals();
  document.getElementById('minimap').dataset.visible = 'false';
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
  setProfileId(p.profile_id);
  setProfileUsername(p.username);
  localStorage.setItem('profile_id', p.profile_id);
  localStorage.setItem('profile_username', p.username);
  await loadPlayerStats();
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
          setProfileId(p.profile_id);
          setProfileUsername(p.username);
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
// PLAYER STATS PERSISTENCE (load side; save is in combat.js)
// ─────────────────────────────────────────────

async function loadPlayerStats() {
  if (!profileId) return;
  try {
    const res = await fetch(`${FORGE_BASE}/profiles/${profileId}/stats`);
    if (!res.ok) return;
    const s = await res.json();
    player.hp        = s.max_hp ?? 100;   // restore to full on session load
    player.maxHp     = s.max_hp ?? 100;
    player.attack    = s.attack ?? 10;
    player.defense   = s.defense ?? 5;
    player.level     = s.level ?? 1;
    player.xp        = s.xp ?? 0;
    player.xpToNext  = s.xp_to_next ?? 100;
    player.inventory = s.inventory ?? [];
    player.equipment = s.equipment ?? {};
  } catch (_) {}
}

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

const TYPE_COLORS = { weapon: 0x888899, armor: 0x664422, consumable: 0xdd3333, accessory: 0xddaa00 };

async function applyGameConfig() {
  try {
    const res = await fetch(`${FORGE_BASE}/config`);
    if (!res.ok) return;
    const cfg = await res.json();
    applyLiveConfig(cfg);
    // Also handle the drop_pool shape from config (flat items → richer objects)
    if (Array.isArray(cfg.drop_pool) && cfg.drop_pool.length > 0) {
      const richPool = cfg.drop_pool.map(item => ({
        name:    item.name,
        type:    item.type,
        subtype: item.subtype ?? '',
        stats:   { [item.stat_key]: item.stat_val },
        rarity:  item.rarity,
        color:   TYPE_COLORS[item.type] ?? 0xddaa00,
      }));
      applyLiveConfig({ drop_pool: richPool });
    }
  } catch (e) { console.warn('config apply failed', e); }
}

// ─────────────────────────────────────────────
// THE FORGE SCENE GEOMETRY + PARTICLES
// ─────────────────────────────────────────────

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
{
  const m = new THREE.Mesh(new THREE.PlaneGeometry(18, 18), new THREE.MeshStandardMaterial({ color: 0x110800, roughness: 1 }));
  m.rotation.x = -Math.PI / 2;
  forgeScene.add(m);
}

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
{
  const m = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.2, 0.4, 20), stoneMat);
  m.position.set(0, 0.2, 0);
  forgeScene.add(m);
}

// Basin ring
const basinRing = new THREE.Mesh(
  new THREE.TorusGeometry(1.4, 0.18, 8, 28),
  new THREE.MeshStandardMaterial({ color: 0x2a1808, roughness: 0.9 }),
);
basinRing.rotation.x = -Math.PI / 2;
basinRing.position.set(0, 0.42, 0);
forgeScene.add(basinRing);

// Anvil block
{
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 0.45), new THREE.MeshStandardMaterial({ color: 0x252015, roughness: 0.7, metalness: 0.35 }));
  m.position.set(0, 0.9, 0);
  forgeScene.add(m);
}
// Anvil horn
{
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.15, 0.4, 8), new THREE.MeshStandardMaterial({ color: 0x252015, roughness: 0.7, metalness: 0.35 }));
  m.position.set(0.52, 0.8, 0);
  m.rotation.z = -Math.PI / 2;
  forgeScene.add(m);
}

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

document.getElementById('hub-forge-card').addEventListener('click', enterRoom);
document.getElementById('hub-library-card').addEventListener('click', openLibraryPanel);
document.getElementById('hub-machinarium-card').addEventListener('click', openMachinariumPanel);
document.getElementById('hub-arcanum-card').addEventListener('click', openArcanumPanel);
document.getElementById('hub-substance-card').addEventListener('click', openSubstancePanel);
document.getElementById('hub-terra-card').addEventListener('click', () => {
  if (!activeExperience) {
    openPickerPanel(); // must select an experience first
  } else {
    openTerraPanel();
  }
});
document.addEventListener('open-terminal-prop-mode', () => {
  _spawnMode = 'prop';
  document.getElementById('spawn-mode-prop').classList.add('active');
  document.getElementById('spawn-mode-entity').classList.remove('active');
});

// ─────────────────────────────────────────────
// CONTROLS  (room only)
// ─────────────────────────────────────────────

const termStatus = document.getElementById('terminal-status');

// Register termStatus with entity.js
setTermStatus(termStatus);

function openTerminal()  { terminal.dataset.open = 'true';  crosshair.dataset.visible = 'false'; }
function closeTerminal() { terminal.dataset.open = 'false'; crosshair.dataset.visible = 'true'; document.activeElement?.blur(); }

controls.addEventListener('lock',   () => { closeTerminal(); termStatus.textContent = 'link: locked'; });
controls.addEventListener('unlock', () => { openTerminal();  termStatus.textContent = 'link: idle';   });

// Custom mouselook — accumulates yaw/pitch as plain floats to avoid
// the gimbal-lock snap that PointerLockControls' setFromQuaternion
// round-trip produces when pitch approaches ±90°.
let _yaw = 0, _pitch = 0;
const LOOK_SPEED   = 0.0018;
const PITCH_LIMIT  = Math.PI * 0.44; // ±~79° — keeps clear of gimbal lock

document.addEventListener('mousemove', (e) => {
  if (!controls.isLocked) return;
  // Clamp per-frame delta — browsers can spike movementX to thousands of pixels
  // when the physical cursor reaches the display edge, causing a camera jump.
  const MAX_DELTA = 80;
  const dx = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, e.movementX));
  const dy = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, e.movementY));
  _yaw   -= dx * LOOK_SPEED;
  _pitch -= dy * LOOK_SPEED;
  _pitch  = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, _pitch));
  roomCamera.quaternion.setFromEuler(new THREE.Euler(_pitch, _yaw, 0, 'YXZ'));
});

document.getElementById('viewport').addEventListener('click', () => {
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
    if (inventoryPanelEl.dataset.open === 'true') { closeInventory(); return; }
    if (terminal.dataset.open === 'true') { controls.lock(); return; }
    returnToForge();
  }
  // Don't steal keypresses from focused text inputs (e.g. spawn prompt, config fields)
  const _focused = document.activeElement?.tagName;
  if (_focused === 'INPUT' || _focused === 'TEXTAREA') return;

  if (e.code === 'KeyQ' && appMode === 'room') {
    e.preventDefault();
    meleeAttack();
  }
  if (e.code === 'KeyE' && appMode === 'room') {
    e.preventDefault();
    fireProjectile();
  }
  if (e.code === 'KeyF' && appMode === 'room' && controls.isLocked) {
    e.preventDefault();
    pickupItem();
  }
  if (e.code === 'KeyI' && appMode === 'room') {
    e.preventDefault();
    if (inventoryPanelEl.dataset.open === 'true') closeInventory(); else openInventory();
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
  const p = controls.object.position;
  const prevX = p.x, prevZ = p.z;
  controls.moveRight(velocity.x * dt);
  controls.moveForward(velocity.z * dt);

  if (currentLevel && !isWalkable(p.x, p.z, currentLevel)) {
    // Try sliding along each axis independently before fully blocking
    if (!isWalkable(p.x, prevZ, currentLevel)) p.x = prevX;
    if (!isWalkable(prevX, p.z, currentLevel)) p.z = prevZ;
    // If both axes blocked, restore both (corner case)
    if (!isWalkable(p.x, p.z, currentLevel)) { p.x = prevX; p.z = prevZ; }
    velocity.x *= 0.1; velocity.z *= 0.1;
  }

  // Prop collision — push player out of prop collider radius
  for (const e of propColliders) {
    if (!e.mesh || e.aiState === 'destroyed') continue;
    const px = p.x - e.mesh.position.x;
    const pz = p.z - e.mesh.position.z;
    const dist = Math.sqrt(px * px + pz * pz);
    const r = e.colliderRadius ?? 0.5;
    if (dist < r && dist > 0.001) {
      const push = (r - dist) / dist;
      p.x += px * push;
      p.z += pz * push;
    }
  }

  p.y = PLAYER_EYE;
  torch.position.set(p.x, p.y + 0.2, p.z);

  // Check end-room proximity
  if (currentLevel && levelEndPos && !levelComplete) {
    const dx = p.x - levelEndPos.x, dz = p.z - levelEndPos.z;
    if (dx*dx + dz*dz < 2.5 * 2.5) _triggerLevelComplete();
  }

  _checkRoomEntry();
}

// ─────────────────────────────────────────────
// LEVEL COMPLETE
// ─────────────────────────────────────────────

function _triggerLevelComplete() {
  setLevelComplete(true);
  emit(EVENTS.LEVEL_EXIT_REACHED, { seed: activeExperience?.level?.seed });
  if (controls.isLocked) controls.unlock();
  const notif = document.getElementById('levelup-notification');
  document.getElementById('levelup-sub').textContent = 'YOU REACHED THE EXIT';
  notif.dataset.visible = 'true';
  setTimeout(() => {
    notif.dataset.visible = 'false';
    // Advance seed for next level
    if (activeExperience) {
      unloadTriggers();
      const nextSeed = ((activeExperience.level?.seed ?? 42) + 1) & 0xFFFFFFFF;
      setActiveExperience({ ...activeExperience, level: { ...activeExperience.level, seed: nextSeed } });
      setLevelComplete(false);
      _buildLevel(activeExperience);
      setTimeout(() => controls.lock(), 400);
    }
  }, 3200);
}

// ─────────────────────────────────────────────
// MINIMAP
// ─────────────────────────────────────────────

const minimapCanvas = document.getElementById('minimap-canvas');
const mmCtx = minimapCanvas.getContext('2d');
const MM_SIZE = 160;
const MM_PAD  = 12;

function drawMinimap() {
  if (!currentLevel) return;
  mmCtx.clearRect(0, 0, MM_SIZE, MM_SIZE);

  const tiles = currentLevel.tiles;
  // Compute level bounding box in grid coords
  let minGX = Infinity, maxGX = -Infinity, minGY = Infinity, maxGY = -Infinity;
  for (const t of tiles) {
    if (t.x < minGX) minGX = t.x; if (t.x > maxGX) maxGX = t.x;
    if (t.y < minGY) minGY = t.y; if (t.y > maxGY) maxGY = t.y;
  }
  const gW = maxGX - minGX + 1, gH = maxGY - minGY + 1;
  const cellPx = Math.min((MM_SIZE - MM_PAD*2) / gW, (MM_SIZE - MM_PAD*2) / gH);
  const offX = MM_PAD + ((MM_SIZE - MM_PAD*2) - gW * cellPx) / 2;
  const offY = MM_PAD + ((MM_SIZE - MM_PAD*2) - gH * cellPx) / 2;

  const toScreen = (gx, gy) => ({
    sx: offX + (gx - minGX) * cellPx,
    sy: offY + (gy - minGY) * cellPx,
  });

  for (const t of tiles) {
    const { sx, sy } = toScreen(t.x, t.y);
    const pad = 1;
    if (t.type === 'start')       mmCtx.fillStyle = 'rgba(255,160,64,0.7)';
    else if (t.type === 'end')    mmCtx.fillStyle = 'rgba(148,64,255,0.7)';
    else                          mmCtx.fillStyle = 'rgba(180,130,60,0.35)';
    mmCtx.fillRect(sx + pad, sy + pad, cellPx - pad*2, cellPx - pad*2);

    // Draw doorway connectors
    mmCtx.fillStyle = 'rgba(180,130,60,0.5)';
    const DIRS_MM = { n:[0,-1], s:[0,1], e:[1,0], w:[-1,0] };
    for (const dir of t.connections) {
      const [dx, dy] = DIRS_MM[dir];
      const cx2 = sx + cellPx/2 + dx*cellPx/2 - 2;
      const cy2 = sy + cellPx/2 + dy*cellPx/2 - 2;
      mmCtx.fillRect(cx2, cy2, 4, 4);
    }
  }

  // Player dot — world pos → fractional grid coords → screen
  if (controls?.object) {
    const pp = controls.object.position;
    // world (0,0) is the start tile centre; convert to fractional grid coords
    const playerGX = currentLevel.start.x + pp.x / TILE_SIZE;
    const playerGY = currentLevel.start.y + pp.z / TILE_SIZE;
    const { sx: px, sy: py } = toScreen(playerGX, playerGY);
    mmCtx.fillStyle = '#ffd080';
    mmCtx.beginPath();
    mmCtx.arc(px + cellPx/2, py + cellPx/2, 3.5, 0, Math.PI*2);
    mmCtx.fill();
  }
}

// ─────────────────────────────────────────────
// CONFIG PANEL (terminal tab, also from forge)
// ─────────────────────────────────────────────

const tabBtns           = document.querySelectorAll('.tab-btn');
const tabPanels         = document.querySelectorAll('.tab-panel');
const cfgWorkflow       = document.getElementById('cfg-workflow');
const cfgVariantWf      = document.getElementById('cfg-variant-workflow');
const cfgVariantStrength = document.getElementById('cfg-variant-strength');
const cfgSpriteTmpl     = document.getElementById('cfg-sprite-template');
const cfgLore           = document.getElementById('cfg-lore');
const cfgSaveBtn        = document.getElementById('cfg-save-btn');
const cfgStatus         = document.getElementById('config-status');

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
    cfgWorkflow.value        = cfg.workflow ?? '';
    cfgVariantWf.value       = cfg.variant_workflow ?? '';
    cfgVariantStrength.value = cfg.variant_strength ?? 0.65;
    cfgSpriteTmpl.value      = cfg.sprite_prompt_template ?? '';
    cfgLore.value            = cfg.lore ?? '';
  } catch (e) { console.warn('config load failed', e); }
}

async function saveConfig() {
  cfgSaveBtn.disabled = true;
  setStatus(cfgStatus, 'saving', 'saving…');
  try {
    const res = await fetch(`${FORGE_BASE}/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflow: cfgWorkflow.value.trim(),
        variant_workflow: cfgVariantWf.value.trim(),
        variant_strength: parseFloat(cfgVariantStrength.value) || 0.65,
        sprite_prompt_template: cfgSpriteTmpl.value,
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

let _spawnMode = 'entity';  // 'entity' | 'prop'

const spawnInput       = document.getElementById('spawn-input');
const spawnBtn         = document.getElementById('spawn-btn');
const _spawnCategory   = document.getElementById('spawn-category');
const _spawnCatInfo    = document.getElementById('spawn-category-info');
const _spawnScaleInput = document.getElementById('spawn-scale');
const _spawnVariance   = document.getElementById('spawn-variance');
const _spawnScaleStats = document.getElementById('spawn-scale-stats');
const _spawnDisp       = document.getElementById('spawn-disposition');
const _spawnNpcIdRow   = document.getElementById('spawn-npcid-row');
const _spawnNpcId      = document.getElementById('spawn-npcid');
const _spawnStatTier   = document.getElementById('spawn-stat-tier');
const _spawnIsBoss     = document.getElementById('spawn-is-boss');
const _entityPresets   = document.getElementById('spawn-entity-presets');
const _propPresets     = document.getElementById('spawn-prop-presets');

// Default scale per mode
const _defaultScale = { entity: 1.0, prop: 0.35 };

function _setActivePreset(container, scale) {
  container?.querySelectorAll('.spawn-preset-btn').forEach(btn => {
    btn.classList.toggle('active', parseFloat(btn.dataset.scale) === scale);
  });
}

// Wire preset buttons — both sets share the same scale input
document.querySelectorAll('.spawn-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const sc = parseFloat(btn.dataset.scale);
    if (_spawnScaleInput) _spawnScaleInput.value = sc;
    const container = btn.closest('.spawn-field-row');
    container?.querySelectorAll('.spawn-preset-btn').forEach(b =>
      b.classList.toggle('active', b === btn));
  });
});

// Mode toggle — swap preset rows and reset scale default
document.getElementById('spawn-mode-entity').addEventListener('click', () => {
  _spawnMode = 'entity';
  document.getElementById('spawn-mode-entity').classList.add('active');
  document.getElementById('spawn-mode-prop').classList.remove('active');
  if (_entityPresets) _entityPresets.style.display = '';
  if (_propPresets)   _propPresets.style.display   = 'none';
  if (_spawnScaleInput && parseFloat(_spawnScaleInput.value) === _defaultScale.prop) {
    _spawnScaleInput.value = _defaultScale.entity;
    _setActivePreset(_entityPresets, _defaultScale.entity);
  }
});
document.getElementById('spawn-mode-prop').addEventListener('click', () => {
  _spawnMode = 'prop';
  document.getElementById('spawn-mode-prop').classList.add('active');
  document.getElementById('spawn-mode-entity').classList.remove('active');
  if (_propPresets)   _propPresets.style.display   = '';
  if (_entityPresets) _entityPresets.style.display = 'none';
  if (_spawnScaleInput && parseFloat(_spawnScaleInput.value) === _defaultScale.entity) {
    _spawnScaleInput.value = _defaultScale.prop;
    _setActivePreset(_propPresets, _defaultScale.prop);
  }
});

// Show NPC ID field only when disposition is friendly
_spawnDisp?.addEventListener('change', () => {
  if (_spawnNpcIdRow) _spawnNpcIdRow.style.display = _spawnDisp.value === 'friendly' ? '' : 'none';
});

// Category blur → fetch avg scale for this category
let _catFetchTimer = null;
_spawnCategory?.addEventListener('input', () => {
  clearTimeout(_catFetchTimer);
  const cat = _spawnCategory.value.trim();
  if (!cat) { if (_spawnCatInfo) _spawnCatInfo.textContent = ''; return; }
  _catFetchTimer = setTimeout(async () => {
    try {
      const res  = await fetch('/entity-categories');
      const data = await res.json();
      if (data[cat]) {
        const { avg_scale, count } = data[cat];
        if (_spawnCatInfo) _spawnCatInfo.textContent = `avg ${avg_scale}× (${count})`;
      } else {
        if (_spawnCatInfo) _spawnCatInfo.textContent = 'new category';
      }
    } catch { /* ignore */ }
  }, 400);
});

// Back to Forge button in terminal header
const backToForgeBtn = document.getElementById('back-to-forge-btn');
if (backToForgeBtn) backToForgeBtn.addEventListener('click', returnToForge);

function doSpawn() {
  const v = spawnInput.value.trim();
  if (!v) return;

  const rawScale   = parseFloat(_spawnScaleInput?.value ?? '1.0') || 1.0;
  const variance   = parseFloat(_spawnVariance?.value   ?? '0')   || 0;
  const actualScale = Math.max(0.01, rawScale + (Math.random() * 2 - 1) * variance);

  const options = {
    scale:            actualScale,
    category:         _spawnCategory?.value.trim() || undefined,
    scaleAffectsStats: _spawnScaleStats?.checked ?? false,
    disposition:      _spawnDisp?.value ?? 'hostile',
    npcId:            _spawnNpcId?.value.trim() || null,
    isBoss:           _spawnIsBoss?.checked ?? false,
    statTier:         _spawnStatTier?.value !== '' ? parseFloat(_spawnStatTier.value) : undefined,
  };

  spawnFromPrompt(v, _spawnMode, options);
  spawnInput.value = ''; spawnInput.focus();
}
spawnBtn.addEventListener('click', doSpawn);
spawnInput.addEventListener('keydown', e => { if (e.code === 'Enter') { e.preventDefault(); doSpawn(); } });

// ─────────────────────────────────────────────
// ROOM ENTRY DETECTION
// ─────────────────────────────────────────────

let _lastRoomTile = null;
function _checkRoomEntry() {
  if (!currentLevel) return;
  const p = roomCamera.position;
  const gx = Math.round(p.x / TILE_SIZE + currentLevel.start.x);
  const gz = Math.round(p.z / TILE_SIZE + currentLevel.start.y);
  const key = `${gx},${gz}`;
  if (key !== _lastRoomTile) {
    _lastRoomTile = key;
    emit(EVENTS.ROOM_ENTERED, { tileX: gx, tileZ: gz });
  }
}

// ─────────────────────────────────────────────
// LORE ENGINE — TRIGGER LISTENERS
// ─────────────────────────────────────────────

function _onInferenceFired(hooks) {
  for (const hook of hooks) {
    // Surface world narrative note in the terminal status bar with a timed reset
    const prev = termStatus.textContent;
    termStatus.textContent = `[WORLD] ${hook.contextNote}`;
    termStatus.dataset.state = 'world';
    setTimeout(() => {
      termStatus.textContent = prev;
      termStatus.dataset.state = '';
    }, 5000);
  }
}

on(EVENTS.FLAG_CHANGED, () => {
  const s = snapshotState();
  const fired = checkScaffoldTriggers(s.flags, s.counters);
  if (fired.length) _onInferenceFired(fired);
});
on(EVENTS.COUNTER_CHANGED, () => {
  const s = snapshotState();
  const fired = checkScaffoldTriggers(s.flags, s.counters);
  if (fired.length) _onInferenceFired(fired);
});

// ─────────────────────────────────────────────
// TARGET FRAME — nearest live enemy within range
// ─────────────────────────────────────────────

const TARGET_RANGE = 10;
let _lastTargetUpdate = 0;

function _updateTargetFrameNearby() {
  const now = performance.now();
  if (now - _lastTargetUpdate < 150) return;  // throttle to ~6fps
  _lastTargetUpdate = now;

  const playerPos = roomCamera.position;
  let nearest = null, nearestDist = TARGET_RANGE;

  for (const e of sprites.values()) {
    if (!e.mesh || e.aiState === 'dead' || !e.stats) continue;
    if (e.mesh.userData.isPlaceholder) continue;
    const d = playerPos.distanceTo(e.mesh.position);
    if (d < nearestDist) { nearest = e; nearestDist = d; }
  }
  updateTargetFrame(nearest);
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
    updateEntities(dt);
    tickInteraction();
    tickDialogue(dt);
    updateWorldItems(t);
    updateProjectiles(dt);
    updateDecals(t);
    pulsePlaceholders(now);
    _updateTargetFrameNearby();
    renderer.render(roomScene, roomCamera);
    drawMinimap();
  }
}
tick();

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────

async function applyIcons() {
  try {
    const { icon } = await import('./icons.js');

    // Close buttons — replace text with SVG + label
    document.querySelectorAll(
      '.library-close-btn, .entities-close-btn, .inventory-close-btn, ' +
      '.picker-close-btn, .terra-close-btn, .undercroft-close-btn, ' +
      '.hub-sub-close-btn, #pose-close-btn'
    ).forEach(btn => {
      btn.innerHTML = `<span class="panel-title-icon">${icon('close', 11)}</span> CLOSE`;
      btn.style.display = 'inline-flex';
      btn.style.alignItems = 'center';
      btn.style.gap = '4px';
    });

    // Panel title icons — prepend matching icon to each panel header title
    const TITLE_ICONS = [
      ['.library-title',                      'book'],
      ['.entities-title',                     'user'],
      ['.undercroft-title',                   'terminal'],
      ['.terminal-title',                     'forge'],
      ['.forge-title',                        'portal'],
      ['.inventory-title',                    'bag'],
      ['.picker-title',                       'portal'],
      ['.terra-title',                        'world'],
      ['.pose-title',                         'image'],
      ['#arcanum-panel .hub-sub-title',       'scroll'],
      ['#machinarium-panel .hub-sub-title',   'settings'],
      ['#substance-panel .hub-sub-title',     'potion'],
    ];
    TITLE_ICONS.forEach(([sel, name]) => {
      document.querySelectorAll(sel).forEach(el => {
        el.innerHTML = `<span class="panel-title-icon">${icon(name, 12)}</span>${el.textContent}`;
      });
    });
  } catch (_) {}
}

applyIcons();
initActionBar();
initSpawnManager();
try { initWeapon(); } catch (_) {}
try { initInteraction(); } catch (_) {}
try { initDialogue(); } catch (_) {}
initProfile();
