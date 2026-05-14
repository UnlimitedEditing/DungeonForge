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

const WALK_STEP_DIST = 0.6;  // world units of movement per walk-cycle frame advance
const SPRITE_WORLD_H = 2.2;  // world-space height used for all sprites

// Combat
const MELEE_RANGE            = 2.5;   // max melee attack distance
const AGRO_RANGE             = 6.0;   // distance at which entity notices player
const ATTACK_RANGE           = 1.8;   // distance at which entity can strike player
const ENTITY_ATTACK_COOLDOWN = 2.5;   // seconds between entity attacks
const PLAYER_ATTACK_COOLDOWN = 0.55;  // seconds between player attacks
const PICKUP_RANGE           = 1.2;   // distance for item pickup

// Item drop pool — used when entities die
const DROP_POOL = [
  { name: 'Health Potion',    type: 'consumable', subtype: '',       stats: { hp_restore: 30 }, rarity: 'common',   color: 0xdd3333 },
  { name: 'Iron Sword',       type: 'weapon',     subtype: 'melee',  stats: { attack: 5 },       rarity: 'common',   color: 0x888899 },
  { name: 'Wooden Shield',    type: 'armor',       subtype: 'offhand',stats: { defense: 3 },      rarity: 'common',   color: 0x885522 },
  { name: 'Leather Vest',     type: 'armor',       subtype: 'body',   stats: { defense: 5 },      rarity: 'common',   color: 0x664422 },
  { name: 'Ring of Swiftness',type: 'accessory',   subtype: '',       stats: { attack: 2, defense: 1 }, rarity: 'uncommon', color: 0xddaa00 },
  { name: 'Hunter\'s Bow',    type: 'weapon',     subtype: 'ranged', stats: { attack: 4, range: 15 }, rarity: 'uncommon', color: 0x997733 },
];
const RARITY_PREFIXES = { 2: 'Fine', 3: 'Forged', 4: 'Enchanted', 5: 'Legendary' };

const EQUIPMENT_SLOTS = ['weapon', 'offhand', 'helmet', 'body', 'boots', 'accessory'];

// Mutable game constants — defaults match hardcoded values; overwritten from config on room entry
let liveAgroRange      = AGRO_RANGE;
let liveAttackRange    = ATTACK_RANGE;
let liveMeleeRange     = MELEE_RANGE;
let liveEntityAttackCd = ENTITY_ATTACK_COOLDOWN;
let livePlayerAttackCd = PLAYER_ATTACK_COOLDOWN;
let liveDropChance     = 0.30;
let liveXpMult         = 1.0;
let liveLevelHpGain    = 10;
let liveLevelAtkGain   = 2;
let liveLevelDefGain   = 1;
let liveDropPool       = [...DROP_POOL];

const TYPE_COLORS = { weapon: 0x888899, armor: 0x664422, consumable: 0xdd3333, accessory: 0xddaa00 };

async function applyGameConfig() {
  try {
    const res = await fetch(`${FORGE_BASE}/config`);
    if (!res.ok) return;
    const cfg = await res.json();
    liveAgroRange      = cfg.agro_range        ?? AGRO_RANGE;
    liveAttackRange    = cfg.attack_range       ?? ATTACK_RANGE;
    liveMeleeRange     = cfg.melee_range        ?? MELEE_RANGE;
    liveEntityAttackCd = cfg.entity_attack_cd   ?? ENTITY_ATTACK_COOLDOWN;
    livePlayerAttackCd = cfg.player_attack_cd   ?? PLAYER_ATTACK_COOLDOWN;
    liveDropChance     = cfg.drop_chance        ?? 0.30;
    liveXpMult         = cfg.xp_multiplier      ?? 1.0;
    liveLevelHpGain    = cfg.level_hp_gain      ?? 10;
    liveLevelAtkGain   = cfg.level_atk_gain     ?? 2;
    liveLevelDefGain   = cfg.level_def_gain     ?? 1;
    if (Array.isArray(cfg.drop_pool) && cfg.drop_pool.length > 0) {
      liveDropPool = cfg.drop_pool.map(item => ({
        name:    item.name,
        type:    item.type,
        subtype: item.subtype ?? '',
        stats:   { [item.stat_key]: item.stat_val },
        rarity:  item.rarity,
        color:   TYPE_COLORS[item.type] ?? 0xddaa00,
      }));
    }
  } catch (e) { console.warn('config apply failed', e); }
}

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
function randomRoamTarget(originX = 0, originZ = 0) {
  // If a level is active, pick a random walkable point near the entity's current tile
  if (currentLevel) {
    const spread = TILE_SIZE * 0.45;
    for (let attempt = 0; attempt < 8; attempt++) {
      const tx = originX + (Math.random() * 2 - 1) * spread;
      const tz = originZ + (Math.random() * 2 - 1) * spread;
      if (isWalkable(tx, tz, currentLevel)) return new THREE.Vector3(tx, 0, tz);
    }
    // Fallback: stay near origin
    return new THREE.Vector3(originX, 0, originZ);
  }
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

// Active experience + level state
let activeExperience  = null;   // the experience JSON currently loaded
let currentLevel      = null;   // generated level data
let levelGroup        = null;   // THREE.Group of level geometry (added to roomScene)
let levelLights       = [];     // PointLights added to roomScene for the level
let levelEndPos       = null;   // {x,z} world position of the exit pillar
let levelComplete     = false;

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
  // Now opens experience picker instead of going straight to the room.
  openPickerPanel();
}

async function launchExperience(exp) {
  activeExperience = exp;
  appMode = 'room';
  closePickerPanel();
  hideForgeHub();
  closeLibraryPanel();
  terminal.dataset.open = 'true';
  crosshair.dataset.visible = 'false';
  statsHudEl.dataset.visible = 'true';
  document.getElementById('minimap').dataset.visible = 'true';
  levelComplete = false;
  initWorldState(exp.state ?? {});
  await applyGameConfig();
  _buildLevel(exp);
  applyExperienceRules(exp);
  updatePlayerHud();
  emit(EVENTS.EXPERIENCE_LOADED, { id: exp.id, name: exp.name });
}

function applyExperienceRules(exp) {
  const rules = exp?.rules ?? {};
  player.maxHp = rules.playerHp ?? 100;
  if (player.hp > player.maxHp) player.hp = player.maxHp;
  updatePlayerHud();
}

function _buildLevel(exp) {
  // Tear down previous level geometry and lights
  if (levelGroup) { roomScene.remove(levelGroup); levelGroup = null; }
  levelLights.forEach(l => roomScene.remove(l));
  levelLights = [];

  const lvlCfg = exp.level || {};
  const seed      = (lvlCfg.seed      ?? 42) >>> 0;
  const roomCount = lvlCfg.roomCount  ?? 18;
  const gridSize  = lvlCfg.gridSize   ?? 12;

  currentLevel  = generateLevel(seed, roomCount, gridSize);
  levelGroup    = buildLevelGeometry(currentLevel);
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
  // Spawn points from level — entities come from existing sprite jobs
  // This seeds roaming positions for already-spawned sprites.
  // New entities will still be spawned via the terminal as before.
  // (Future: auto-populate enemies from entity pool here.)
}

function returnToForge() {
  appMode = 'forge';
  if (controls.isLocked) controls.unlock();
  unloadTriggers();
  resetWorldState();
  applyExperienceRules(null);
  terminal.dataset.open = 'false';
  crosshair.dataset.visible = 'false';
  statsHudEl.dataset.visible = 'false';
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

let profileId       = null;
let profileUsername = null;

// ─────────────────────────────────────────────
// PLAYER STATE
// ─────────────────────────────────────────────

const player = {
  hp: 100, maxHp: 100,
  attack: 10, defense: 5,
  level: 1, xp: 0, xpToNext: 100,
  inventory: [],    // array of item objects
  equipment: {},    // slot -> item object
};

let lastPlayerAttack = 0;
let pendingPickup    = null;   // world-item drop the player is standing near

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
// PLAYER STATS PERSISTENCE
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

async function savePlayerStats() {
  if (!profileId) return;
  try {
    await fetch(`${FORGE_BASE}/profiles/${profileId}/stats`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level: player.level, xp: player.xp, xp_to_next: player.xpToNext,
        max_hp: player.maxHp, attack: player.attack, defense: player.defense,
        inventory: player.inventory, equipment: player.equipment,
      }),
    });
  } catch (_) {}
}

// ─────────────────────────────────────────────
// PLAYER HUD UPDATE
// ─────────────────────────────────────────────

const statsHudEl         = document.getElementById('stats-hud');
const hudLevelEl         = document.getElementById('hud-level');
const hudHpFillEl        = document.getElementById('hud-hp-fill');
const hudHpValEl         = document.getElementById('hud-hp-val');
const hudXpFillEl        = document.getElementById('hud-xp-fill');
const hudXpValEl         = document.getElementById('hud-xp-val');
const hitFlashEl         = document.getElementById('hit-flash');
const levelupEl          = document.getElementById('levelup-notification');
const levelupSubEl       = document.getElementById('levelup-sub');
const pickupPromptEl     = document.getElementById('pickup-prompt');
const pickupItemNameEl   = document.getElementById('pickup-item-name');

function updatePlayerHud() {
  hudLevelEl.textContent = player.level;
  const hpPct = player.hp / player.maxHp;
  hudHpFillEl.style.width      = `${(hpPct * 100).toFixed(1)}%`;
  hudHpFillEl.style.background = hpPct > 0.5 ? '#22bb22' : hpPct > 0.25 ? '#cccc22' : '#cc2222';
  hudHpValEl.textContent       = `${player.hp}/${player.maxHp}`;
  const xpPct = player.xp / player.xpToNext;
  hudXpFillEl.style.width = `${(xpPct * 100).toFixed(1)}%`;
  hudXpValEl.textContent  = `${player.xp}/${player.xpToNext}`;
}

function flashHit() {
  hitFlashEl.classList.add('active');
  setTimeout(() => hitFlashEl.classList.remove('active'), 180);
}

// ─────────────────────────────────────────────
// FLOATING DAMAGE NUMBERS
// ─────────────────────────────────────────────

function spawnDamageNumber(worldPos, amount, isPlayerHit) {
  const v = worldPos.clone();
  v.y = SPRITE_WORLD_H;
  const projected = v.project(roomCamera);
  if (projected.z > 1) return;  // behind camera
  const x = (projected.x *  0.5 + 0.5) * window.innerWidth;
  const y = (projected.y * -0.5 + 0.5) * window.innerHeight;
  const el = document.createElement('div');
  el.className = `damage-number ${isPlayerHit ? 'player-hit' : 'enemy-hit'}`;
  el.textContent = `-${amount}`;
  el.style.left = `${x - 16}px`;
  el.style.top  = `${y - 24}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

// ─────────────────────────────────────────────
// ENTITY HP BARS  (Three.js planes above sprites)
// ─────────────────────────────────────────────

const HP_BAR_W = 0.85;
const HP_BAR_H = 0.07;

function createEntityHpBar() {
  const bgMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(HP_BAR_W, HP_BAR_H),
    new THREE.MeshBasicMaterial({ color: 0x111111, depthTest: false, depthWrite: false }),
  );
  const fgMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(HP_BAR_W, HP_BAR_H),
    new THREE.MeshBasicMaterial({ color: 0x22bb22, depthTest: false, depthWrite: false }),
  );
  fgMesh.position.z = 0.001;
  bgMesh.renderOrder = fgMesh.renderOrder = 999;
  const group = new THREE.Group();
  group.add(bgMesh, fgMesh);
  group.userData.fg = fgMesh;
  roomScene.add(group);
  return group;
}

function refreshEntityHpBar(entry) {
  if (!entry.hpBar || !entry.stats) return;
  const pct = Math.max(0, entry.stats.hp / entry.stats.maxHp);
  const fg  = entry.hpBar.userData.fg;
  fg.scale.x         = pct;
  fg.position.x      = HP_BAR_W * (pct - 1) / 2;
  fg.material.color.setHex(pct > 0.5 ? 0x22bb22 : pct > 0.25 ? 0xcccc00 : 0xcc2222);
}

function updateHpBarTransforms() {
  for (const e of sprites.values()) {
    if (!e.hpBar || !e.mesh || e.aiState === 'dead') continue;
    const p = e.mesh.position;
    e.hpBar.position.set(p.x, SPRITE_WORLD_H + 0.28, p.z);
    e.hpBar.quaternion.copy(roomCamera.quaternion);
  }
}

// ─────────────────────────────────────────────
// COMBAT
// ─────────────────────────────────────────────

function getEquipBonus(stat) {
  let total = 0;
  for (const item of Object.values(player.equipment)) {
    total += (item?.stats?.[stat] ?? 0);
  }
  return total;
}

function meleeAttack() {
  if (!controls.isLocked || appMode !== 'room') return;
  const now = performance.now() / 1000;
  if (now - lastPlayerAttack < livePlayerAttackCd) return;
  lastPlayerAttack = now;

  const playerPos = roomCamera.position;
  let nearest = null, nearestDist = liveMeleeRange;

  for (const e of sprites.values()) {
    if (e.status !== 'done' || !e.mesh || e.mesh.userData.isPlaceholder) continue;
    if (e.aiState === 'dead' || !e.stats) continue;
    const d = playerPos.distanceTo(e.mesh.position);
    if (d < nearestDist) { nearest = e; nearestDist = d; }
  }

  if (!nearest) return;

  const atk  = player.attack + getEquipBonus('attack');
  const dmg  = Math.max(1, atk - nearest.stats.defense + Math.floor(Math.random() * 7 - 3));
  nearest.stats.hp = Math.max(0, nearest.stats.hp - dmg);
  spawnDamageNumber(nearest.mesh.position, dmg, false);
  refreshEntityHpBar(nearest);
  if (nearest.stats.hp <= 0) killEntity(nearest);
}

function killEntity(entry) {
  entry.aiState = 'dead';
  entry.roam    = null;

  // Lay flat on the floor
  entry.mesh.rotation.set(-Math.PI / 2, 0, 0);
  entry.mesh.position.y = 0.02;

  // Swap to corpse sprite if available; otherwise tint red
  const corpseVar = entry.variants?.corpse;
  if (corpseVar?.status === 'done' && corpseVar.spriteName) {
    textureLoader.load(`${FORGE_BASE}/sprites/${corpseVar.spriteName}`, (tex) => {
      tex.magFilter  = THREE.NearestFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      entry.mesh.material = new THREE.MeshStandardMaterial({
        map: tex, transparent: true, alphaTest: 0.15,
        roughness: 1, metalness: 0, side: THREE.DoubleSide,
      });
    });
  } else if (entry.mesh.material) {
    entry.mesh.material.color.set(0x661111);
    entry.mesh.material.opacity = 0.7;
  }

  // Remove HP bar and shadow
  if (entry.hpBar)    { roomScene.remove(entry.hpBar);    entry.hpBar    = null; }
  if (entry.shadowBlob) { roomScene.remove(entry.shadowBlob); entry.shadowBlob = null; }

  gainXp(entry.stats?.xpReward ?? 0);

  // configurable drop chance
  if (entry.mesh && Math.random() < liveDropChance) {
    const pos = entry.mesh.position.clone();
    pos.y = 0;
    spawnItemDrop(pos, entry.stats?.level ?? 1);
  }
}

function onPlayerDeath() {
  player.hp = 1;  // survive at 1 HP for now; full death screen is future work
  updatePlayerHud();
  // Simple feedback — flash stays red longer
  hitFlashEl.classList.add('active');
  setTimeout(() => hitFlashEl.classList.remove('active'), 600);
}

// ─────────────────────────────────────────────
// XP + LEVELLING
// ─────────────────────────────────────────────

function gainXp(amount) {
  if (amount <= 0) return;
  const gained = Math.round(amount * liveXpMult);
  player.xp += gained;
  while (player.xp >= player.xpToNext) {
    player.xp -= player.xpToNext;
    levelUp();
  }
  updatePlayerHud();
  savePlayerStats();
}

function levelUp() {
  const prev = player.level;
  player.level++;
  player.xpToNext  = player.level * 100;
  player.maxHp    += liveLevelHpGain;
  player.hp        = Math.min(player.hp + 15, player.maxHp);
  player.attack   += liveLevelAtkGain;
  player.defense  += liveLevelDefGain;
  showLevelUpNotification(prev, player.level);
  updatePlayerHud();
}

function showLevelUpNotification(from, to) {
  levelupSubEl.textContent = `${from} → ${to}  |  +${liveLevelHpGain} HP  +${liveLevelAtkGain} ATK  +${liveLevelDefGain} DEF`;
  levelupEl.dataset.visible = 'true';
  setTimeout(() => { levelupEl.dataset.visible = 'false'; }, 2800);
}

// ─────────────────────────────────────────────
// WORLD ITEM DROPS
// ─────────────────────────────────────────────

const worldItems = new Map();   // id -> { mesh, glow, item }

function spawnItemDrop(position, entityLevel) {
  const pool  = liveDropPool.length > 0 ? liveDropPool : DROP_POOL;
  const tpl   = pool[Math.floor(Math.random() * pool.length)];
  const scale = 1 + (entityLevel - 1) * 0.35;
  const prefix = RARITY_PREFIXES[Math.min(entityLevel, 5)] ?? '';
  const item = {
    id:      Math.random().toString(36).slice(2, 10),
    name:    prefix ? `${prefix} ${tpl.name}` : tpl.name,
    type:    tpl.type,
    subtype: tpl.subtype,
    rarity:  entityLevel >= 4 ? 'rare' : entityLevel >= 2 ? 'uncommon' : 'common',
    stats:   Object.fromEntries(
               Object.entries(tpl.stats).map(([k, v]) => [k, Math.floor(v * scale)])
             ),
    color:   tpl.color,
  };

  const geo  = new THREE.OctahedronGeometry(0.18, 0);
  const mat  = new THREE.MeshBasicMaterial({ color: item.color });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(position.x, 0.22, position.z);

  const glow = new THREE.PointLight(item.color, 0.7, 1.8, 2.0);
  glow.position.copy(mesh.position);

  roomScene.add(mesh, glow);
  worldItems.set(item.id, { mesh, glow, item, spawnT: performance.now() / 1000 });
}

function updateWorldItems(t) {
  const playerPos = roomCamera.position;
  pendingPickup   = null;
  let nearestDist = PICKUP_RANGE;

  for (const [id, drop] of worldItems) {
    // Bob + spin
    drop.mesh.position.y = 0.22 + Math.sin(t * 2.4 + drop.spawnT) * 0.07;
    drop.mesh.rotation.y += 0.018;
    drop.glow.position.copy(drop.mesh.position);

    if (!controls.isLocked) continue;
    const d = playerPos.distanceTo(drop.mesh.position);
    if (d < nearestDist) { pendingPickup = drop; nearestDist = d; }
  }

  if (pendingPickup && appMode === 'room') {
    pickupPromptEl.dataset.visible = 'true';
    pickupItemNameEl.textContent   = pendingPickup.item.name.toUpperCase();
  } else {
    pickupPromptEl.dataset.visible = 'false';
  }
}

function pickupItem() {
  if (!pendingPickup) return;
  const { item, mesh, glow, id: dropId } = pendingPickup;

  // Find the id stored in the Map key
  let mapKey = null;
  for (const [k, v] of worldItems) { if (v === pendingPickup) { mapKey = k; break; } }
  if (!mapKey) return;

  roomScene.remove(mesh, glow);
  worldItems.delete(mapKey);
  pendingPickup = null;
  pickupPromptEl.dataset.visible = 'false';

  player.inventory.push(item);
  savePlayerStats();

  // Brief pick-up flash in the HUD
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:50%;bottom:130px;transform:translateX(-50%);z-index:36;font-family:"Press Start 2P",monospace;font-size:8px;color:var(--ok);pointer-events:none;animation:damage-float 1.2s ease-out forwards;white-space:nowrap;';
  el.textContent = `PICKED UP: ${item.name.toUpperCase()}`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1300);
}

// ─────────────────────────────────────────────
// INVENTORY PANEL
// ─────────────────────────────────────────────

const inventoryPanelEl = document.getElementById('inventory-panel');
const invStatsDisplay  = document.getElementById('inv-stats-display');
const equipmentSlotsEl = document.getElementById('equipment-slots');
const inventoryGridEl  = document.getElementById('inventory-grid');

document.getElementById('inventory-close-btn').addEventListener('click', closeInventory);

function openInventory() {
  inventoryPanelEl.dataset.open = 'true';
  if (controls.isLocked) controls.unlock();
  renderInventory();
}

function closeInventory() {
  inventoryPanelEl.dataset.open = 'false';
}

function renderInventory() {
  const totalAtk = player.attack + getEquipBonus('attack');
  const totalDef = player.defense + getEquipBonus('defense');
  invStatsDisplay.textContent = `LVL ${player.level}  |  ATK ${totalAtk}  |  DEF ${totalDef}  |  HP ${player.hp}/${player.maxHp}`;

  // Equipment slots
  equipmentSlotsEl.innerHTML = '';
  for (const slot of EQUIPMENT_SLOTS) {
    const item = player.equipment[slot];
    const el   = document.createElement('div');
    el.className = `equipment-slot${item ? ' equipment-slot-filled' : ''}`;
    el.dataset.slot = slot;

    const labelDiv = document.createElement('div');
    labelDiv.className = 'slot-label';
    labelDiv.textContent = slot.toUpperCase();
    el.appendChild(labelDiv);

    if (item) {
      const nameDiv = document.createElement('div');
      nameDiv.className = 'slot-item';
      nameDiv.textContent = item.name;
      el.appendChild(nameDiv);
      const statsDiv = document.createElement('div');
      statsDiv.className = 'slot-item-stats';
      statsDiv.textContent = formatItemStats(item.stats);
      el.appendChild(statsDiv);
      el.title = `Click to unequip ${item.name}`;
      el.addEventListener('click', () => unequipItem(slot));
    } else {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'slot-empty';
      emptyDiv.textContent = '—';
      el.appendChild(emptyDiv);
    }
    equipmentSlotsEl.appendChild(el);
  }

  // Bag grid (24 slots)
  inventoryGridEl.innerHTML = '';
  for (let i = 0; i < 24; i++) {
    const item = player.inventory[i];
    const cell = document.createElement('div');
    cell.className = `inv-cell${item ? ' inv-cell-filled' : ''}`;

    if (item) {
      const rarityClass = `rarity-${item.rarity ?? 'common'}`;
      cell.innerHTML = `
        <div class="inv-item-rarity ${rarityClass}">${rarityGlyph(item.rarity)}</div>
        <div class="inv-item-name">${escapeHtml(item.name)}</div>
        <div class="inv-item-type">${item.type}</div>`;
      cell.title = `${item.name}\n${formatItemStats(item.stats)}\nClick to equip/use`;
      cell.addEventListener('click', () => onItemClick(i));
    }
    inventoryGridEl.appendChild(cell);
  }
}

function rarityGlyph(rarity) {
  return { common: '◌', uncommon: '◆', rare: '✦', legendary: '★' }[rarity] ?? '◌';
}

function formatItemStats(stats) {
  if (!stats) return '';
  return Object.entries(stats)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k.replace('_', ' ')} +${v}`)
    .join('  ');
}

function onItemClick(index) {
  const item = player.inventory[index];
  if (!item) return;

  if (item.type === 'consumable') {
    useConsumable(index);
  } else if (['weapon','armor','accessory'].includes(item.type)) {
    equipFromBag(index);
  }
}

function equipFromBag(index) {
  const item = player.inventory[index];
  if (!item) return;

  // Determine slot
  const slot = item.subtype || item.type;
  const validSlots = EQUIPMENT_SLOTS;
  const targetSlot = validSlots.includes(slot) ? slot : item.type === 'weapon' ? 'weapon' : item.type;

  if (!EQUIPMENT_SLOTS.includes(targetSlot)) return;

  // Swap current equipped back to bag
  const current = player.equipment[targetSlot];
  player.inventory.splice(index, 1);
  if (current) player.inventory.push(current);

  player.equipment[targetSlot] = item;
  savePlayerStats();
  renderInventory();
  updatePlayerHud();
}

function unequipItem(slot) {
  const item = player.equipment[slot];
  if (!item) return;
  if (player.inventory.length >= 24) return;  // bag full
  delete player.equipment[slot];
  player.inventory.push(item);
  savePlayerStats();
  renderInventory();
  updatePlayerHud();
}

function useConsumable(index) {
  const item = player.inventory[index];
  if (!item) return;
  if (item.stats?.hp_restore) {
    player.hp = Math.min(player.maxHp, player.hp + item.stats.hp_restore);
  }
  player.inventory.splice(index, 1);
  savePlayerStats();
  updatePlayerHud();
  renderInventory();
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

// ─────────────────────────────────────────────
// LIBRARY PANEL
// ─────────────────────────────────────────────

const libraryPanelEl = document.getElementById('library-panel');
const loreTextarea   = document.getElementById('lore-textarea');
const loreStatus     = document.getElementById('lore-status');
const loreSaveBtn    = document.getElementById('lore-save-btn');

function openLibraryPanel() {
  libraryPanelEl.dataset.open = 'true';
  loadLore();
  loreTextarea.focus();
}
function closeLibraryPanel() {
  libraryPanelEl.dataset.open = 'false';
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

document.getElementById('library-close-btn').addEventListener('click', closeLibraryPanel);
loreSaveBtn.addEventListener('click', saveLore);
document.getElementById('library-entities-btn').addEventListener('click', () => {
  closeLibraryPanel();
  openEntities();
});

// ─────────────────────────────────────────────
// ENTITIES
// ─────────────────────────────────────────────

const VARIANT_TYPES = ['corpse', 'damage', 'back'];

const entitiesPanelEl  = document.getElementById('entities-panel');
const entitiesBody     = document.getElementById('entities-body');

async function loadJobHistory() {
  try {
    const res = await fetch(`${FORGE_BASE}/jobs`);
    if (!res.ok) return;
    const jobs = await res.json();
    const variantFetches = [];
    for (const job of jobs) {
      if (job.status !== 'done' || sprites.has(job.id)) continue;
      sprites.set(job.id, {
        jobId: job.id, status: 'done', prompt: job.prompt,
        mesh: null, position: null, floorY: null, roam: null,
        spriteSrc: job.sprite_name ? `${FORGE_BASE}/sprites/${job.sprite_name}` : null,
        variants: {}, historical: true,
      });
      for (const [vtype, vid] of Object.entries(job.variant_job_ids ?? {})) {
        variantFetches.push({ jobId: job.id, vtype, vid });
      }
    }
    // Load variant metadata in parallel
    await Promise.all(variantFetches.map(async ({ jobId, vtype, vid }) => {
      try {
        const vres = await fetch(`${FORGE_BASE}/variant-jobs/${vid}`);
        if (!vres.ok) return;
        const vj = await vres.json();
        const entry = sprites.get(jobId);
        if (!entry) return;
        entry.variants[vtype] = { jobId: vid, status: vj.status, spriteName: vj.sprite_name, frameCount: vj.frame_count ?? 1 };
        if (vj.status === 'done' && vj.sprite_name && (vtype === 'walk' || vtype === 'back') && (vj.frame_count ?? 1) > 1) {
          loadWalkSheet(vj.sprite_name, vj.frame_count, vtype, entry);
        }
      } catch { /* silently skip broken variant */ }
    }));
    refreshJobList();
  } catch (e) { console.warn('history load failed', e); }
}

async function openEntities() {
  entitiesPanelEl.dataset.open = 'true';
  await loadJobHistory();
  renderEntities();
}
function closeEntities() { entitiesPanelEl.dataset.open = 'false'; }

document.getElementById('entities-close-btn').addEventListener('click', closeEntities);
document.getElementById('entities-back-btn').addEventListener('click', () => {
  closeEntities();
  openLibraryPanel();
});
document.getElementById('entities-pose-btn').addEventListener('click', () => {
  closeEntities();
  openPoseEditor();
});

function renderEntities() {
  const entries = [...sprites.values()].filter(e => e.status === 'done');
  if (!entries.length) {
    entitiesBody.innerHTML = '<p class="muted entities-empty">No entities forged yet. Spawn something in the room.</p>';
    return;
  }
  entitiesBody.innerHTML = '';
  for (const e of entries) {
    const card = document.createElement('div');
    card.className = 'entity-card';
    card.dataset.jobId = e.jobId;

    // Thumbnail
    const thumbWrap = document.createElement('div');
    if (e.spriteSrc) {
      const img = document.createElement('img');
      img.className = 'entity-thumb'; img.src = e.spriteSrc; img.alt = e.prompt;
      thumbWrap.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'entity-thumb-placeholder'; ph.textContent = '?';
      thumbWrap.appendChild(ph);
    }
    card.appendChild(thumbWrap);

    // Info column
    const info = document.createElement('div');
    info.className = 'entity-info';

    const promptEl = document.createElement('div');
    promptEl.className = 'entity-prompt'; promptEl.textContent = e.prompt;
    info.appendChild(promptEl);

    // Variant badges
    const badges = document.createElement('div');
    badges.className = 'entity-variants';
    for (const vt of VARIANT_TYPES) {
      const vj = e.variants?.[vt];
      const badge = document.createElement('button');
      badge.className = 'entity-variant-badge';
      badge.textContent = vt.toUpperCase();
      badge.dataset.state = vj ? vj.status : 'none';
      if (vj?.status === 'done' && vj.spriteName) {
        badge.title = 'Click to preview';
        badge.addEventListener('click', () => window.open(`${FORGE_BASE}/sprites/${vj.spriteName}`, '_blank'));
      } else {
        badge.title = vj ? vj.status : 'not generated';
      }
      badges.appendChild(badge);
    }
    info.appendChild(badges);

    // Regen row
    const regenRow = document.createElement('div');
    regenRow.className = 'entity-regen-row';
    const regenInput = document.createElement('input');
    regenInput.className = 'entity-regen-input'; regenInput.type = 'text';
    regenInput.placeholder = 'regen prompt override (leave blank to use template)…';
    const regenSelect = document.createElement('select');
    regenSelect.style.cssText = 'background:var(--bg-deep);color:var(--amber);border:1px solid var(--rust);padding:3px 6px;font-family:VT323,monospace;font-size:18px;outline:none;';
    VARIANT_TYPES.forEach(vt => {
      const opt = document.createElement('option'); opt.value = vt; opt.textContent = vt;
      regenSelect.appendChild(opt);
    });
    const regenBtn = document.createElement('button');
    regenBtn.className = 'entity-regen-btn'; regenBtn.textContent = 'REGEN';
    regenBtn.addEventListener('click', async () => {
      regenBtn.disabled = true;
      const vt = regenSelect.value;
      const customPrompt = regenInput.value.trim() || null;
      try {
        const res = await fetch(`${FORGE_BASE}/jobs/${e.jobId}/variants/${vt}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile_id: profileId, prompt: customPrompt }),
        });
        if (!res.ok) throw new Error(await res.text());
        const vj = await res.json();
        if (!e.variants) e.variants = {};
        e.variants[vt] = { jobId: vj.id, status: vj.status, spriteName: null };
        pollVariantJob(vj.id, vt, e);
        refreshJobList();
        renderEntities();
      } catch (err) { console.error('regen failed', err); }
      finally { regenBtn.disabled = false; }
    });
    regenRow.append(regenInput, regenSelect, regenBtn);
    info.appendChild(regenRow);

    card.appendChild(info);
    entitiesBody.appendChild(card);
  }
}

function loadWalkSheet(spriteName, frameCount, variantType, entry) {
  const url = `${FORGE_BASE}/sprites/${spriteName}`;
  textureLoader.load(url, (tex) => {
    tex.magFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(1 / frameCount, 1);
    tex.offset.set(0, 0);

    const frameAspect = (tex.image.width / frameCount) / tex.image.height;
    const mat = new THREE.MeshStandardMaterial({
      map: tex, transparent: true, alphaTest: 0.15, depthWrite: true,
      roughness: 1, metalness: 0, side: THREE.DoubleSide,
    });
    const sheet = { mat, tex, frameCount, frameAspect };

    if (variantType === 'walk') entry.walkSheet = sheet;
    if (variantType === 'back') entry.backSheet = sheet;
  }, undefined, (err) => console.error('walk sheet load failed', err));
}

async function pollVariantJob(varJobId, variantType, entry) {
  while (true) {
    await new Promise(r => setTimeout(r, POLL_MS));
    let vj;
    try {
      const res = await fetch(`${FORGE_BASE}/variant-jobs/${varJobId}`);
      if (!res.ok) throw new Error(res.status);
      vj = await res.json();
    } catch (e) { console.warn('variant poll error', e); continue; }

    if (!entry.variants) entry.variants = {};
    entry.variants[variantType] = { jobId: varJobId, status: vj.status, spriteName: vj.sprite_name, frameCount: vj.frame_count ?? 1 };

    refreshJobList();
    if (entitiesPanelEl.dataset.open === 'true') renderEntities();

    if (vj.status === 'done' && vj.sprite_name) {
      const frameCount = vj.frame_count ?? 1;
      if ((variantType === 'walk' || variantType === 'back') && frameCount > 1) {
        loadWalkSheet(vj.sprite_name, frameCount, variantType, entry);
      }
      return;
    }
    if (vj.status === 'failed') return;
  }
}

// ─────────────────────────────────────────────
// ROOM SCENE
// ─────────────────────────────────────────────

const roomScene = new THREE.Scene();
roomScene.background = new THREE.Color(0x000000);
roomScene.fog = new THREE.Fog(0x000000, 6, 22);

const roomCamera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.05, 200);
roomCamera.position.set(0, PLAYER_EYE, 6);

// Persistent room-scene lights (level geometry and tile lights added dynamically by _buildLevel)
roomScene.add(new THREE.AmbientLight(0x3a2818, 0.4));
const torch = new THREE.PointLight(0xffb060, 2.0, 13, 1.5);
roomScene.add(torch);
// Fallback brazier at origin — overridden per-room by level lights
const brazier = new THREE.PointLight(0xff8030, 1.0, 18, 1.8);
brazier.position.set(0, 2.5, 0);
roomScene.add(brazier);

// ─────────────────────────────────────────────
// CONTROLS  (room only)
// ─────────────────────────────────────────────

const controls  = new PointerLockControls(roomCamera, renderer.domElement);
controls.pointerSpeed = 0; // disable built-in rotation — we handle it ourselves below

const termStatus = document.getElementById('terminal-status');

function openTerminal()  { terminal.dataset.open = 'true';  crosshair.dataset.visible = 'false'; }
function closeTerminal() { terminal.dataset.open = 'false'; crosshair.dataset.visible = 'true';  }

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
  _yaw   -= e.movementX * LOOK_SPEED;
  _pitch -= e.movementY * LOOK_SPEED;
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
    returnToForge();
  }
  if (e.code === 'KeyQ' && appMode === 'room') {
    e.preventDefault();
    meleeAttack();
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
    tex.magFilter  = THREE.NearestFilter;
    tex.minFilter  = THREE.LinearMipmapLinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const mat    = new THREE.MeshStandardMaterial({
      map: tex, transparent: true, alphaTest: 0.15, depthWrite: true,
      roughness: 1, metalness: 0, side: THREE.DoubleSide,
    });
    const h      = SPRITE_WORLD_H;
    const aspect = tex.image.width / tex.image.height;
    const mesh   = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.scale.set(h * aspect, h, 1);
    mesh.position.copy(position);
    mesh.position.y = h / 2;
    onReady(mesh, h / 2, tex, `${FORGE_BASE}/sprites/${spriteName}`);
  }, undefined, (err) => console.error('texture load failed', err));
}

function createShadowBlob() {
  const geo  = new THREE.CircleGeometry(0.44, 12);
  const mat  = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false });
  const blob = new THREE.Mesh(geo, mat);
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.016;
  roomScene.add(blob);
  return blob;
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
  sprites.set(job.id, { jobId: job.id, status: job.status, mesh: placeholder, position, prompt: promptText, floorY: 1.1, roam: null });
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
      // Read combat stats from job (rolled server-side at creation time)
      if (job.entity_stats) {
        entry.stats = {
          hp:        job.entity_stats.hp,
          maxHp:     job.entity_stats.max_hp,
          attack:    job.entity_stats.attack,
          defense:   job.entity_stats.defense,
          xpReward:  job.entity_stats.xp_reward,
          level:     job.entity_stats.level,
        };
        entry.aiState       = 'roam';
        entry.lastAttackTime = 0;
      }
      makeSprite(job.sprite_name, entry.position, (sprite, floorY, tex, src) => {
        roomScene.remove(entry.mesh);
        entry.mesh.material?.dispose(); entry.mesh.geometry?.dispose();
        roomScene.add(sprite);
        entry.mesh    = sprite;
        entry.floorY  = floorY;
        entry.roam    = initRoam();
        entry.frontTex    = tex;
        entry.frontAspect = tex.image.width / tex.image.height;
        entry.frontMat    = sprite.material;
        entry.spriteSrc   = src;
        entry.shadowBlob  = createShadowBlob();
        if (entry.stats) {
          entry.hpBar = createEntityHpBar();
          refreshEntityHpBar(entry);
        }
      });
      if (job.variant_job_ids && Object.keys(job.variant_job_ids).length) {
        if (!entry.variants) entry.variants = {};
        for (const [vtype, vid] of Object.entries(job.variant_job_ids)) {
          entry.variants[vtype] = { jobId: vid, status: 'queued', spriteName: null };
          pollVariantJob(vid, vtype, entry);
        }
      }
      return;
    }
    if (job.status === 'failed') {
      entry.mesh.material.color.set(0x8b1a1a); entry.mesh.material.opacity = 0.5; return;
    }
  }
}

// ─────────────────────────────────────────────
// ENTITY UPDATE  (roaming + AI + animation)
// ─────────────────────────────────────────────

function initRoam() {
  return { target: randomRoamTarget(), waitUntil: 0, speed: ROAM_SPEED_MIN + Math.random() * (ROAM_SPEED_MAX - ROAM_SPEED_MIN) };
}

function updateEntities(dt) {
  const now       = performance.now() / 1000;
  const playerPos = roomCamera.position;
  const _camFwd   = new THREE.Vector3();

  for (const e of sprites.values()) {
    if (e.status !== 'done' || !e.mesh || e.mesh.userData.isPlaceholder) continue;
    if (e.aiState === 'dead') continue;

    let moving = false;
    let dirX = 0, dirZ = 0;

    // ── AI STATE MACHINE ──────────────────────
    if (e.stats) {
      const distToPlayer = playerPos.distanceTo(e.mesh.position);

      if (e.aiState !== 'agro' && distToPlayer < liveAgroRange) {
        e.aiState = 'agro';
      } else if (e.aiState === 'agro' && distToPlayer > liveAgroRange * 1.6) {
        e.aiState = 'roam';
        if (!e.roam) e.roam = initRoam();
      }

      if (e.aiState === 'agro') {
        const dx   = playerPos.x - e.mesh.position.x;
        const dz   = playerPos.z - e.mesh.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist > liveAttackRange) {
          // Chase
          const spd = e.roam?.speed ?? ROAM_SPEED_MAX;
          dirX = dx / dist; dirZ = dz / dist;
          e.mesh.position.x += dirX * spd * 1.3 * dt;
          e.mesh.position.z += dirZ * spd * 1.3 * dt;
          e.mesh.position.y  = e.floorY;
          moving = true;
        } else {
          // Attack player
          if (now - (e.lastAttackTime ?? 0) >= liveEntityAttackCd) {
            e.lastAttackTime = now;
            const def = player.defense + getEquipBonus('defense');
            const dmg = Math.max(1, e.stats.attack - def + Math.floor(Math.random() * 7 - 3));
            player.hp = Math.max(0, player.hp - dmg);
            spawnDamageNumber(playerPos, dmg, true);
            flashHit();
            updatePlayerHud();
            if (player.hp <= 0) onPlayerDeath();
          }
        }
      }
    }

    // ── ROAMING (for roam state, or entities with no stats) ──
    if (!e.stats || e.aiState === 'roam') {
      if (!e.roam) continue;
      if (now >= e.roam.waitUntil) {
        const pos  = e.mesh.position;
        const dx   = e.roam.target.x - pos.x;
        const dz   = e.roam.target.z - pos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < ROAM_ARRIVE_D) {
          e.roam.waitUntil = now + ROAM_PAUSE_MIN + Math.random() * (ROAM_PAUSE_MAX - ROAM_PAUSE_MIN);
          e.roam.target    = randomRoamTarget(pos.x, pos.z);
        } else {
          dirX = dx / dist; dirZ = dz / dist;
          pos.x += dirX * e.roam.speed * dt;
          pos.z += dirZ * e.roam.speed * dt;
          pos.y  = e.floorY;
          moving = true;
        }
      }
    }

    // ── SPRITE SHEET ANIMATION ────────────────
    let movingAway = false;
    if (moving && (e.walkSheet || e.backSheet)) {
      roomCamera.getWorldDirection(_camFwd);
      movingAway = (dirX * _camFwd.x + dirZ * _camFwd.z) > 0.25;
    }

    const sheet = moving
      ? ((movingAway && e.backSheet) ? e.backSheet : (e.walkSheet ?? null))
      : null;

    if (sheet) {
      if (e.mesh.material !== sheet.mat) {
        e.mesh.material = sheet.mat;
        e.mesh.scale.x  = SPRITE_WORLD_H * sheet.frameAspect;
      }
      const speed = e.roam?.speed ?? ROAM_SPEED_MIN;
      e.walkFrameTimer = (e.walkFrameTimer ?? 0) + speed * dt;
      const frameIdx = Math.floor(e.walkFrameTimer / WALK_STEP_DIST) % sheet.frameCount;
      sheet.tex.offset.x = frameIdx / sheet.frameCount;
    } else if (e.frontMat) {
      e.walkFrameTimer = 0;
      if (e.mesh.material !== e.frontMat) {
        e.mesh.material = e.frontMat;
        e.mesh.scale.x  = SPRITE_WORLD_H * (e.frontAspect ?? 1);
      }
      const useTex = (moving && !e.walkSheet && !e.backSheet && e.backTex)
        ? (() => { roomCamera.getWorldDirection(_camFwd); return (dirX * _camFwd.x + dirZ * _camFwd.z) > 0.25 ? e.backTex : e.frontTex; })()
        : e.frontTex;
      if (useTex && e.frontMat.map !== useTex) {
        e.frontMat.map = useTex;
        e.frontMat.needsUpdate = true;
      }
    }

    // ── CYLINDRICAL BILLBOARD ─────────────────
    const bdx = roomCamera.position.x - e.mesh.position.x;
    const bdz = roomCamera.position.z - e.mesh.position.z;
    e.mesh.rotation.y = Math.atan2(bdx, bdz);

    // ── SHADOW BLOB ───────────────────────────
    if (e.shadowBlob) {
      const sx   = e.mesh.position.x - brazier.position.x;
      const sz   = e.mesh.position.z - brazier.position.z;
      const dist = Math.sqrt(sx * sx + sz * sz);
      const nx   = dist > 0.01 ? sx / dist : 0;
      const nz   = dist > 0.01 ? sz / dist : 1;
      e.shadowBlob.position.set(
        e.mesh.position.x + nx * 0.3,
        0.016,
        e.mesh.position.z + nz * 0.3,
      );
      e.shadowBlob.material.opacity = Math.max(0.04, 0.5 * (1 - dist / 13));
    }
  }

  // Update HP bar positions + orientations
  updateHpBarTransforms();
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
    if (e.historical) continue;
    if (e.status === 'done') ready++; else if (e.status !== 'failed') inflight++;
  }
  hudSprites.textContent = ready;
  hudQueue.textContent   = inflight;
  hudStatus.textContent  = appMode === 'forge' ? 'THE FORGE' : controls.isLocked ? 'IN-WORLD' : 'TERMINAL';
  const p = roomCamera.position;
  hudPos.textContent = `${p.x.toFixed(1)},${p.z.toFixed(1)}`;
}

function refreshJobList() {
  const active = [...sprites.values()].filter(e => !e.historical);
  if (active.length === 0) { jobsListEl.innerHTML = '<div class="muted">no jobs.</div>'; return; }
  const rows = [];
  for (const e of active) {
    let variantTags = '';
    if (e.variants) {
      for (const [vt, vj] of Object.entries(e.variants)) {
        const s = vj.status;
        const label = s === 'done' ? vt : s === 'failed' ? `${vt}!` : `${vt}…`;
        variantTags += `<span class="job-anim" data-s="${s === 'done' ? 'done' : s === 'failed' ? 'failed' : 'pending'}">${label}</span>`;
      }
    }
    rows.push(`<div class="job-row">
      <span class="job-id">${e.jobId}</span>
      <span class="job-prompt">${escapeHtml(e.prompt)}</span>
      ${variantTags}
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
// POSE EDITOR
// ─────────────────────────────────────────────

const poseEditorPanelEl  = document.getElementById('pose-editor-panel');
const poseCanvas         = document.getElementById('pose-canvas');
const poseFrameGrid      = document.getElementById('pose-frame-grid');
const poseJointNameEl    = document.getElementById('pose-joint-name');
const poseRotRow         = document.getElementById('pose-rot-row');
const poseRotX           = document.getElementById('pose-rot-x');
const poseRotXVal        = document.getElementById('pose-rot-x-val');
const poseResetBtn       = document.getElementById('pose-reset-btn');
const poseUploadBtn      = document.getElementById('pose-upload-btn');
const poseStatusEl       = document.getElementById('pose-status');
const poseRefsEl         = document.getElementById('pose-refs');

document.getElementById('pose-back-btn').addEventListener('click', () => { closePoseEditor(); openEntities(); });
document.getElementById('pose-close-btn').addEventListener('click', closePoseEditor);

// ── Pose editor Three.js state (dedicated renderer + scene) ──

let poseRenderer = null;       // created lazily on first open
let poseAnimId = null;
let poseBuilt = false;

const poseScene3  = new THREE.Scene();
const poseCamera3 = new THREE.PerspectiveCamera(28, 260 / 380, 0.1, 20);
poseCamera3.position.set(0, 1.0, 4.5);
poseCamera3.lookAt(0, 0.9, 0);
poseScene3.background = new THREE.Color(0xffffff);
poseScene3.add(new THREE.AmbientLight(0xffffff, 0.9));
const _poseDirLight = new THREE.DirectionalLight(0xffeedd, 0.6);
_poseDirLight.position.set(1.5, 3, 3);
poseScene3.add(_poseDirLight);

let poseJoints      = {};   // name → Object3D pivot
let poseJointMeshes = [];   // clickable spheres
let selectedJoint   = null;
let activeFrame     = 'walk_f0';
let poseSlugs       = {};   // frameType → slug

const POSE_FRAMES = [
  'walk_f0','walk_f1','walk_f2','walk_f3',
  'back_f0','back_f1','back_f2','back_f3',
];

const JOINT_DEFS = [
  // [name, parent, [dx,dy,dz], boneLen]
  ['root',       null,          [0,    0,     0],  0.18],
  ['spine',      'root',        [0,    0.18,  0],  0.22],
  ['chest',      'spine',       [0,    0.22,  0],  0.14],
  ['neck',       'chest',       [0,    0.14,  0],  0.13],
  ['head',       'neck',        [0,    0.13,  0],  0   ],
  ['l_shoulder', 'chest',       [-0.20, 0.02, 0],  0.28],
  ['r_shoulder', 'chest',       [ 0.20, 0.02, 0],  0.28],
  ['l_elbow',    'l_shoulder',  [0,   -0.28,  0],  0.24],
  ['r_elbow',    'r_shoulder',  [0,   -0.28,  0],  0.24],
  ['l_wrist',    'l_elbow',     [0,   -0.24,  0],  0   ],
  ['r_wrist',    'r_elbow',     [0,   -0.24,  0],  0   ],
  ['l_hip',      'root',        [-0.10,-0.05, 0],  0.42],
  ['r_hip',      'root',        [ 0.10,-0.05, 0],  0.42],
  ['l_knee',     'l_hip',       [0,   -0.42,  0],  0.40],
  ['r_knee',     'r_hip',       [0,   -0.42,  0],  0.40],
  ['l_ankle',    'l_knee',      [0,   -0.40,  0],  0   ],
  ['r_ankle',    'r_knee',      [0,   -0.40,  0],  0   ],
];

const ROTATABLE_JOINTS = new Set([
  'spine','neck','l_shoulder','r_shoulder','l_elbow','r_elbow',
  'l_hip','r_hip','l_knee','r_knee',
]);

const ROT_LIMITS = {
  spine:      [-0.3,  0.4],
  neck:       [-0.3,  0.3],
  l_shoulder: [-1.0,  0.6],
  r_shoulder: [-0.6,  1.0],
  l_elbow:    [-2.4,  0.0],
  r_elbow:    [-2.4,  0.0],
  l_hip:      [-0.7,  0.5],
  r_hip:      [-0.5,  0.7],
  l_knee:     [ 0.0,  1.5],
  r_knee:     [ 0.0,  1.5],
};

const POSE_PRESETS = {
  walk_f0: { spine:{x:0.05}, l_hip:{x:-0.55}, r_hip:{x:0.40}, l_knee:{x:0.08}, r_knee:{x:0.45}, l_shoulder:{x:0.40}, r_shoulder:{x:-0.50}, l_elbow:{x:-0.45}, r_elbow:{x:-0.55} },
  walk_f1: { spine:{x:0.02}, l_hip:{x:-0.08}, r_hip:{x:0.05}, l_knee:{x:0.28}, r_knee:{x:0.70}, l_shoulder:{x:0.12}, r_shoulder:{x:-0.15}, l_elbow:{x:-0.32}, r_elbow:{x:-0.38} },
  walk_f2: { spine:{x:0.05}, l_hip:{x:0.40},  r_hip:{x:-0.55},l_knee:{x:0.45}, r_knee:{x:0.08}, l_shoulder:{x:-0.50},r_shoulder:{x:0.40},  l_elbow:{x:-0.55}, r_elbow:{x:-0.45} },
  walk_f3: { spine:{x:0.02}, l_hip:{x:0.05},  r_hip:{x:-0.08},l_knee:{x:0.70}, r_knee:{x:0.28}, l_shoulder:{x:-0.15},r_shoulder:{x:0.12},  l_elbow:{x:-0.38}, r_elbow:{x:-0.32} },
};
['f0','f1','f2','f3'].forEach(f => { POSE_PRESETS[`back_${f}`] = { ...POSE_PRESETS[`walk_${f}`] }; });

function buildMannequin() {
  poseJoints = {};
  poseJointMeshes = [];
  const boneMat  = new THREE.MeshLambertMaterial({ color: 0x7a5c28 });
  const jointMat = new THREE.MeshLambertMaterial({ color: 0xd4a843 });

  for (const [name, parent, offset, boneLen] of JOINT_DEFS) {
    const pivot = new THREE.Object3D();
    pivot.position.set(...offset);

    const isHead = name === 'head';
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(isHead ? 0.105 : 0.044, 10, 7),
      jointMat.clone()
    );
    sphere.userData.jointName = name;
    pivot.add(sphere);
    if (ROTATABLE_JOINTS.has(name)) poseJointMeshes.push(sphere);

    if (boneLen > 0) {
      const boneGeo = new THREE.CylinderGeometry(0.024, 0.024, boneLen, 6);
      boneGeo.translate(0, -boneLen / 2, 0);
      pivot.add(new THREE.Mesh(boneGeo, boneMat));
    }

    poseJoints[name] = pivot;
    if (parent) {
      poseJoints[parent].add(pivot);
    } else {
      pivot.position.set(0, 0.85, 0);
      poseScene3.add(pivot);
    }
  }

  // Ground plane
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0xeeeee8 })
  );
  ground.rotation.x = -Math.PI / 2;
  poseScene3.add(ground);
}

function applyPreset(frameType) {
  const preset = POSE_PRESETS[frameType] ?? POSE_PRESETS['walk_f0'];
  for (const [name] of JOINT_DEFS) {
    const j = poseJoints[name];
    if (!j) continue;
    const r = preset[name];
    j.rotation.x = r?.x ?? 0;
    if (name === 'root') j.rotation.y = frameType.startsWith('back') ? Math.PI : 0;
  }
}

function setSelectedJoint(name) {
  if (selectedJoint) {
    const prev = poseJoints[selectedJoint];
    if (prev) prev.children[0].material.color.set(0xd4a843);
  }
  selectedJoint = name;
  if (!name) {
    poseJointNameEl.textContent = '—';
    poseRotRow.style.display = 'none';
    return;
  }
  const j = poseJoints[name];
  if (j) j.children[0].material.color.set(0xff6030);
  poseJointNameEl.textContent = name.replace('_', ' ');
  poseRotRow.style.display = '';
  const deg = Math.round(THREE.MathUtils.radToDeg(j.rotation.x));
  poseRotX.value = deg;
  poseRotXVal.textContent = `${deg}°`;
}

poseRotX.addEventListener('input', () => {
  if (!selectedJoint) return;
  const rad = THREE.MathUtils.degToRad(Number(poseRotX.value));
  poseJoints[selectedJoint].rotation.x = rad;
  poseRotXVal.textContent = `${poseRotX.value}°`;
});

// Drag rotation on canvas
const _poseRay  = new THREE.Raycaster();
const _poseMouse = new THREE.Vector2();
let _poseDragY = 0;

poseCanvas.addEventListener('mousedown', (e) => {
  const rect = poseCanvas.getBoundingClientRect();
  _poseMouse.set(
    ((e.clientX - rect.left)  / poseCanvas.width)  * 2 - 1,
    -((e.clientY - rect.top) / poseCanvas.height) * 2 + 1
  );
  _poseRay.setFromCamera(_poseMouse, poseCamera3);
  const hits = _poseRay.intersectObjects(poseJointMeshes);
  if (hits.length) {
    setSelectedJoint(hits[0].object.userData.jointName);
    _poseDragY = e.clientY;
    e.preventDefault();
  }
});

window.addEventListener('mousemove', (e) => {
  if (!selectedJoint || poseEditorPanelEl.dataset.open !== 'true') return;
  if (e.buttons !== 1) return;
  const delta = (e.clientY - _poseDragY) * 0.015;
  _poseDragY = e.clientY;
  const j = poseJoints[selectedJoint];
  const [min, max] = ROT_LIMITS[selectedJoint] ?? [-Math.PI, Math.PI];
  j.rotation.x = Math.max(min, Math.min(max, j.rotation.x - delta));
  const deg = Math.round(THREE.MathUtils.radToDeg(j.rotation.x));
  poseRotX.value = deg;
  poseRotXVal.textContent = `${deg}°`;
});

poseResetBtn.addEventListener('click', () => { applyPreset(activeFrame); setSelectedJoint(null); });

// ── Frame button grid ──

function buildFrameGrid() {
  poseFrameGrid.innerHTML = '';
  for (const ft of POSE_FRAMES) {
    const btn = document.createElement('button');
    btn.className = 'pose-frame-btn';
    btn.dataset.frame = ft;
    btn.textContent = ft.replace('_f', ' f').toUpperCase();
    btn.addEventListener('click', () => {
      activeFrame = ft;
      applyPreset(ft);
      setSelectedJoint(null);
      refreshFrameGrid();
    });
    poseFrameGrid.appendChild(btn);
  }
  refreshFrameGrid();
}

function refreshFrameGrid() {
  poseFrameGrid.querySelectorAll('.pose-frame-btn').forEach(btn => {
    btn.dataset.active   = btn.dataset.frame === activeFrame ? 'true' : 'false';
    btn.dataset.hasRef   = poseSlugs[btn.dataset.frame] ? 'true' : 'false';
  });
  refreshPoseRefs();
}

function refreshPoseRefs() {
  poseRefsEl.innerHTML = '';
  let any = false;
  for (const ft of POSE_FRAMES) {
    if (!poseSlugs[ft]) continue;
    any = true;
    const row = document.createElement('div');
    row.className = 'pose-ref-item';
    row.innerHTML = `<span>${ft}</span><span>${poseSlugs[ft]}</span>`;
    poseRefsEl.appendChild(row);
  }
  if (!any) poseRefsEl.innerHTML = '<div class="muted" style="font-family:VT323,monospace;font-size:15px">none uploaded yet</div>';
}

async function loadPoseSlugs() {
  try {
    const res = await fetch(`${FORGE_BASE}/tools/pose/slugs`);
    if (!res.ok) return;
    const data = await res.json();
    poseSlugs = {};
    for (const [fi, slug] of Object.entries(data.walk_pose_slugs ?? {})) poseSlugs[`walk_${fi}`] = slug;
    for (const [fi, slug] of Object.entries(data.back_pose_slugs ?? {})) poseSlugs[`back_${fi}`] = slug;
    refreshFrameGrid();
  } catch { /* ignore */ }
}

poseUploadBtn.addEventListener('click', async () => {
  if (!profileId) return;
  poseUploadBtn.disabled = true;
  setStatus(poseStatusEl, 'uploading', 'uploading…');
  try {
    // Render current pose to JPEG data URI
    poseRenderer.render(poseScene3, poseCamera3);
    const imageData = poseCanvas.toDataURL('image/jpeg', 0.92);

    const res = await fetch(`${FORGE_BASE}/tools/pose/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId, frame_type: activeFrame, image_data: imageData }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    poseSlugs[activeFrame] = data.slug;
    refreshFrameGrid();
    setStatus(poseStatusEl, 'done', `registered: ${data.slug}`);
    setTimeout(() => { poseStatusEl.dataset.state = 'idle'; poseStatusEl.textContent = ''; }, 3000);
  } catch (e) {
    setStatus(poseStatusEl, 'error', `failed: ${e.message}`);
  } finally {
    poseUploadBtn.disabled = false;
  }
});

// ── Panel open / close ──

function openPoseEditor() {
  poseEditorPanelEl.dataset.open = 'true';
  if (!poseBuilt) {
    // Lazy-init renderer
    poseRenderer = new THREE.WebGLRenderer({ canvas: poseCanvas, antialias: true });
    poseRenderer.setPixelRatio(1);
    poseRenderer.setSize(260, 380);
    buildMannequin();
    buildFrameGrid();
    applyPreset(activeFrame);
    poseBuilt = true;
  }
  loadPoseSlugs();
  startPoseLoop();
}

function closePoseEditor() {
  poseEditorPanelEl.dataset.open = 'false';
  stopPoseLoop();
  setSelectedJoint(null);
}

function startPoseLoop() { if (!poseAnimId) poseStep(); }
function stopPoseLoop()  { if (poseAnimId) { cancelAnimationFrame(poseAnimId); poseAnimId = null; } }

function poseStep() {
  poseAnimId = requestAnimationFrame(poseStep);
  poseRenderer.render(poseScene3, poseCamera3);
}

// ─────────────────────────────────────────────
// ARCANUM PANEL
// ─────────────────────────────────────────────

const arcanumPanelEl = document.getElementById('arcanum-panel');

function openArcanumPanel() {
  arcanumPanelEl.dataset.open = 'true';
  loadArcanumConfig();
  renderArcanumSheet();
}
function closeArcanumPanel() { arcanumPanelEl.dataset.open = 'false'; }

function renderArcanumSheet() {
  const el = document.getElementById('arcanum-sheet');
  const stats = [
    { k: 'LVL',     v: player.level },
    { k: 'HP',      v: `${player.hp}/${player.maxHp}` },
    { k: 'XP',      v: `${player.xp}/${player.xpToNext}` },
    { k: 'ATK',     v: player.attack + getEquipBonus('attack') },
    { k: 'DEF',     v: player.defense + getEquipBonus('defense') },
  ];
  el.innerHTML = stats.map(s =>
    `<div class="arcanum-sheet-stat"><span class="arcanum-sheet-key">${s.k}</span><span class="arcanum-sheet-val">${s.v}</span></div>`
  ).join('');
}

async function loadArcanumConfig() {
  try {
    const res = await fetch(`${FORGE_BASE}/config`);
    if (!res.ok) return;
    const cfg = await res.json();
    document.getElementById('arc-xp-mult').value  = cfg.xp_multiplier  ?? 1.0;
    document.getElementById('arc-hp-gain').value   = cfg.level_hp_gain  ?? 10;
    document.getElementById('arc-atk-gain').value  = cfg.level_atk_gain ?? 2;
    document.getElementById('arc-def-gain').value  = cfg.level_def_gain ?? 1;
  } catch (_) {}
}

async function saveArcanumConfig() {
  const btn = document.getElementById('arc-save-btn');
  const statusEl = document.getElementById('arc-status');
  btn.disabled = true;
  setStatus(statusEl, 'saving', 'inscribing…');
  try {
    const cfgRes = await fetch(`${FORGE_BASE}/config`);
    if (!cfgRes.ok) throw new Error('could not fetch config');
    const cfg = await cfgRes.json();
    cfg.xp_multiplier  = parseFloat(document.getElementById('arc-xp-mult').value);
    cfg.level_hp_gain  = parseInt(document.getElementById('arc-hp-gain').value);
    cfg.level_atk_gain = parseInt(document.getElementById('arc-atk-gain').value);
    cfg.level_def_gain = parseInt(document.getElementById('arc-def-gain').value);
    const res = await fetch(`${FORGE_BASE}/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    if (!res.ok) throw new Error(await res.text());
    liveXpMult = cfg.xp_multiplier; liveLevelHpGain = cfg.level_hp_gain;
    liveLevelAtkGain = cfg.level_atk_gain; liveLevelDefGain = cfg.level_def_gain;
    setStatus(statusEl, 'saved', 'inscribed');
    setTimeout(() => { statusEl.dataset.state = 'idle'; }, 2500);
  } catch (e) { setStatus(statusEl, 'error', e.message); }
  finally { btn.disabled = false; }
}

document.getElementById('arcanum-close-btn').addEventListener('click', closeArcanumPanel);
document.getElementById('arc-save-btn').addEventListener('click', saveArcanumConfig);

// ─────────────────────────────────────────────
// MACHINARIUM PANEL
// ─────────────────────────────────────────────

const machinariumPanelEl = document.getElementById('machinarium-panel');

function openMachinariumPanel() {
  machinariumPanelEl.dataset.open = 'true';
  loadMachinariumConfig();
}
function closeMachinariumPanel() { machinariumPanelEl.dataset.open = 'false'; }

async function loadMachinariumConfig() {
  try {
    const res = await fetch(`${FORGE_BASE}/config`);
    if (!res.ok) return;
    const cfg = await res.json();
    document.getElementById('mac-agro-range').value  = cfg.agro_range        ?? 6.0;
    document.getElementById('mac-attack-range').value= cfg.attack_range       ?? 1.8;
    document.getElementById('mac-melee-range').value = cfg.melee_range        ?? 2.5;
    document.getElementById('mac-entity-cd').value   = cfg.entity_attack_cd   ?? 2.5;
    document.getElementById('mac-player-cd').value   = cfg.player_attack_cd   ?? 0.55;
    document.getElementById('mac-level-min').value   = cfg.entity_level_min   ?? 1;
    document.getElementById('mac-level-max').value   = cfg.entity_level_max   ?? 5;
    document.getElementById('mac-drop-chance').value = Math.round((cfg.drop_chance ?? 0.30) * 100);
  } catch (_) {}
}

async function saveMachinariumConfig() {
  const btn = document.getElementById('mac-save-btn');
  const statusEl = document.getElementById('mac-status');
  btn.disabled = true;
  setStatus(statusEl, 'saving', 'inscribing…');
  try {
    const cfgRes = await fetch(`${FORGE_BASE}/config`);
    if (!cfgRes.ok) throw new Error('could not fetch config');
    const cfg = await cfgRes.json();
    cfg.agro_range       = parseFloat(document.getElementById('mac-agro-range').value);
    cfg.attack_range     = parseFloat(document.getElementById('mac-attack-range').value);
    cfg.melee_range      = parseFloat(document.getElementById('mac-melee-range').value);
    cfg.entity_attack_cd = parseFloat(document.getElementById('mac-entity-cd').value);
    cfg.player_attack_cd = parseFloat(document.getElementById('mac-player-cd').value);
    cfg.entity_level_min = parseInt(document.getElementById('mac-level-min').value);
    cfg.entity_level_max = parseInt(document.getElementById('mac-level-max').value);
    cfg.drop_chance      = parseInt(document.getElementById('mac-drop-chance').value) / 100;
    const res = await fetch(`${FORGE_BASE}/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    if (!res.ok) throw new Error(await res.text());
    // Apply immediately to live session
    liveAgroRange = cfg.agro_range; liveAttackRange = cfg.attack_range;
    liveMeleeRange = cfg.melee_range; liveEntityAttackCd = cfg.entity_attack_cd;
    livePlayerAttackCd = cfg.player_attack_cd; liveDropChance = cfg.drop_chance;
    setStatus(statusEl, 'saved', 'inscribed');
    setTimeout(() => { statusEl.dataset.state = 'idle'; }, 2500);
  } catch (e) { setStatus(statusEl, 'error', e.message); }
  finally { btn.disabled = false; }
}

document.getElementById('machinarium-close-btn').addEventListener('click', closeMachinariumPanel);
document.getElementById('mac-save-btn').addEventListener('click', saveMachinariumConfig);

// ─────────────────────────────────────────────
// SUBSTANCE LABORATORY PANEL
// ─────────────────────────────────────────────

const substancePanelEl = document.getElementById('substance-panel');
let substanceDropPool  = [];   // working copy while panel is open

function openSubstancePanel() {
  substancePanelEl.dataset.open = 'true';
  loadSubstancePool();
}
function closeSubstancePanel() { substancePanelEl.dataset.open = 'false'; }

async function loadSubstancePool() {
  try {
    const res = await fetch(`${FORGE_BASE}/config`);
    if (!res.ok) return;
    const cfg = await res.json();
    substanceDropPool = Array.isArray(cfg.drop_pool) ? cfg.drop_pool.map(i => ({...i})) : [];
  } catch (_) { substanceDropPool = []; }
  renderSubstancePool();
}

function renderSubstancePool() {
  const el = document.getElementById('substance-drop-pool');
  if (substanceDropPool.length === 0) {
    el.innerHTML = '<div class="muted" style="padding:6px 8px;font-size:16px">Pool is empty — all entities will drop nothing.</div>';
    return;
  }
  el.innerHTML = substanceDropPool.map((item, idx) => `
    <div class="sub-drop-row">
      <span class="sub-drop-row-name">${escapeHtml(item.name)}</span>
      <span class="sub-drop-row-type">${item.type}${item.subtype ? '/' + item.subtype : ''}</span>
      <span class="sub-drop-row-stat">${item.stat_key} +${item.stat_val}</span>
      <span class="sub-drop-row-rarity rarity-${item.rarity}">${item.rarity}</span>
      <button class="sub-drop-remove-btn" data-idx="${idx}">REMOVE</button>
    </div>
  `).join('');
  el.querySelectorAll('.sub-drop-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      substanceDropPool.splice(parseInt(btn.dataset.idx), 1);
      renderSubstancePool();
    });
  });
}

async function saveSubstancePool() {
  const btn = document.getElementById('sub-pool-save-btn');
  const statusEl = document.getElementById('sub-pool-status');
  btn.disabled = true;
  setStatus(statusEl, 'saving', 'saving…');
  try {
    const cfgRes = await fetch(`${FORGE_BASE}/config`);
    if (!cfgRes.ok) throw new Error('could not fetch config');
    const cfg = await cfgRes.json();
    cfg.drop_pool = substanceDropPool;
    const res = await fetch(`${FORGE_BASE}/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    if (!res.ok) throw new Error(await res.text());
    // Update live pool
    liveDropPool = substanceDropPool.map(item => ({
      name: item.name, type: item.type, subtype: item.subtype ?? '',
      stats: { [item.stat_key]: item.stat_val }, rarity: item.rarity,
      color: TYPE_COLORS[item.type] ?? 0xddaa00,
    }));
    setStatus(statusEl, 'saved', 'saved');
    setTimeout(() => { statusEl.dataset.state = 'idle'; }, 2500);
  } catch (e) { setStatus(statusEl, 'error', e.message); }
  finally { btn.disabled = false; }
}

document.getElementById('sub-add-btn').addEventListener('click', () => {
  const name    = document.getElementById('sub-new-name').value.trim();
  if (!name) return;
  const item = {
    name,
    type:     document.getElementById('sub-new-type').value,
    subtype:  document.getElementById('sub-new-subtype').value.trim(),
    stat_key: document.getElementById('sub-new-stat-key').value,
    stat_val: parseInt(document.getElementById('sub-new-stat-val').value) || 1,
    rarity:   document.getElementById('sub-new-rarity').value,
  };
  substanceDropPool.push(item);
  renderSubstancePool();
  document.getElementById('sub-new-name').value    = '';
  document.getElementById('sub-new-subtype').value = '';
  document.getElementById('sub-new-stat-val').value= '';
});

document.getElementById('sub-pool-save-btn').addEventListener('click', saveSubstancePool);

document.getElementById('sub-forge-btn').addEventListener('click', async () => {
  const input    = document.getElementById('sub-forge-input');
  const statusEl = document.getElementById('sub-forge-status');
  const desc = input.value.trim();
  if (!desc || !profileId) return;
  const btn = document.getElementById('sub-forge-btn');
  btn.disabled = true;
  setStatus(statusEl, 'saving', 'forging…');
  try {
    const res = await fetch(`${FORGE_BASE}/items`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: desc, profile_id: profileId,
        name: desc, type: 'weapon', subtype: '', rarity: 'common',
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const job = await res.json();
    setStatus(statusEl, 'saved', `queued — job ${job.id}`);
    input.value = '';
    setTimeout(() => { statusEl.dataset.state = 'idle'; }, 4000);
  } catch (e) { setStatus(statusEl, 'error', e.message); }
  finally { btn.disabled = false; }
});

document.getElementById('substance-close-btn').addEventListener('click', closeSubstancePanel);

// ─────────────────────────────────────────────
// LEVEL COMPLETE
// ─────────────────────────────────────────────

function _triggerLevelComplete() {
  levelComplete = true;
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
      activeExperience = { ...activeExperience, level: { ...activeExperience.level, seed: nextSeed } };
      levelComplete = false;
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
    updateWorldItems(t);
    pulsePlaceholders(now);
    renderer.render(roomScene, roomCamera);
    drawMinimap();
  }
}
tick();

// ─────────────────────────────────────────────
// EXPERIENCE PICKER
// ─────────────────────────────────────────────

const pickerPanelEl  = document.getElementById('picker-panel');
const pickerListEl   = document.getElementById('picker-list');
const pickerDetailEl = document.getElementById('picker-detail');
const pickerStatusEl = document.getElementById('picker-status');

let _pickerExperiences  = [];
let _pickerSelectedId   = null;

function openPickerPanel() {
  pickerPanelEl.dataset.open = 'true';
  _loadPickerExperiences();
}
function closePickerPanel() { pickerPanelEl.dataset.open = 'false'; }

async function _loadPickerExperiences() {
  pickerListEl.innerHTML = '<div class="picker-loading">scanning archives…</div>';
  try {
    _pickerExperiences = await fetchExperiences(FORGE_BASE);
  } catch (_) {
    _pickerExperiences = DEFAULT_EXPERIENCES;
  }
  _renderPickerList();
  if (_pickerExperiences.length > 0) {
    _selectPickerExperience(_pickerExperiences[0].id);
  }
}

function _renderPickerList() {
  let html = '';
  const sys  = _pickerExperiences.filter(e => e.locked || e.author === 'system');
  const user = _pickerExperiences.filter(e => !e.locked && e.author !== 'system');

  for (const e of sys) {
    html += _pickerRowHtml(e);
  }
  if (user.length) {
    html += '<hr class="picker-row-divider">';
    for (const e of user) html += _pickerRowHtml(e);
  }
  pickerListEl.innerHTML = html || '<div class="picker-loading muted">no experiences found</div>';
  pickerListEl.querySelectorAll('.picker-row').forEach(row => {
    row.addEventListener('click', () => _selectPickerExperience(row.dataset.id));
  });
}

function _pickerRowHtml(e) {
  const isFork = e.baseId != null;
  return `<div class="picker-row" data-id="${escapeHtml(e.id)}" data-selected="false">
    <div class="picker-row-name">${escapeHtml(e.name)}</div>
    <div class="picker-row-meta">${escapeHtml(e.mode ?? 'roguelike')} · v${escapeHtml(e.version ?? '?')}</div>
    ${isFork ? `<div class="picker-row-fork-tag">↩ ${escapeHtml(e.baseId)}</div>` : ''}
  </div>`;
}

function _selectPickerExperience(id) {
  _pickerSelectedId = id;
  pickerListEl.querySelectorAll('.picker-row').forEach(r => {
    r.dataset.selected = (r.dataset.id === id) ? 'true' : 'false';
  });
  const exp = _pickerExperiences.find(e => e.id === id);
  if (!exp) return;
  _renderPickerDetail(exp);
}

function _renderPickerDetail(exp) {
  const isFork   = exp.baseId != null;
  const isLocked = exp.locked;
  const code     = encodeShareCode(exp);

  pickerDetailEl.innerHTML = `
    <div class="picker-detail-name">${escapeHtml(exp.name)}</div>
    <div class="picker-detail-desc">${escapeHtml(exp.description ?? '')}</div>
    <div class="picker-detail-meta">
      <div class="picker-detail-meta-row">mode<span>${escapeHtml(exp.mode ?? 'roguelike')}</span></div>
      <div class="picker-detail-meta-row">seed<span>${exp.level?.seed ?? '—'}</span></div>
      <div class="picker-detail-meta-row">rooms<span>${exp.level?.roomCount ?? '—'}</span></div>
      ${isFork ? `<div class="picker-detail-meta-row">based on<span>${escapeHtml(exp.baseId)}</span></div>` : ''}
      ${isLocked ? '<div class="picker-detail-meta-row" style="color:var(--amber-dim)">system experience · fork to edit</div>' : ''}
    </div>
    <div class="picker-detail-actions">
      <button class="picker-action-btn primary" id="pd-play-btn">▶ PLAY</button>
      ${isLocked
        ? '<button class="picker-action-btn" id="pd-fork-btn">⊕ FORK &amp; EDIT</button>'
        : '<button class="picker-action-btn" id="pd-edit-btn">✏ EDIT</button>'
      }
    </div>
    <div>
      <div class="picker-detail-meta-row" style="margin-bottom:6px">share code</div>
      <div class="picker-detail-code-row">
        <input class="picker-detail-code" id="pd-code-input" readonly value="${escapeHtml(code)}" />
        <button class="picker-action-btn" id="pd-copy-btn">COPY</button>
      </div>
    </div>
  `;

  document.getElementById('pd-play-btn').addEventListener('click', () => launchExperience(exp));

  const forkBtn = document.getElementById('pd-fork-btn');
  if (forkBtn) forkBtn.addEventListener('click', async () => {
    setStatus(pickerStatusEl, 'saving', 'forking…');
    try {
      const fork = await createFork(FORGE_BASE, exp);
      _pickerExperiences.push(fork);
      _renderPickerList();
      _selectPickerExperience(fork.id);
      setStatus(pickerStatusEl, 'saved', `fork created: ${fork.id.slice(0,8)}…`);
    } catch (e) { setStatus(pickerStatusEl, 'error', e.message); }
  });

  const editBtn = document.getElementById('pd-edit-btn');
  if (editBtn) editBtn.addEventListener('click', () => {
    activeExperience = exp;
    closePickerPanel();
    openTerraPanel();
  });

  document.getElementById('pd-copy-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(code).catch(() => {});
    document.getElementById('pd-copy-btn').textContent = 'COPIED';
    setTimeout(() => { const b = document.getElementById('pd-copy-btn'); if (b) b.textContent = 'COPY'; }, 1800);
  });
}

document.getElementById('picker-close-btn').addEventListener('click', closePickerPanel);
document.getElementById('picker-import-btn').addEventListener('click', async () => {
  const code = document.getElementById('picker-import-input').value.trim();
  if (!code) return;
  setStatus(pickerStatusEl, 'saving', 'importing…');
  try {
    const exp = await importFromCode(FORGE_BASE, code);
    _pickerExperiences.push(exp);
    _renderPickerList();
    _selectPickerExperience(exp.id);
    document.getElementById('picker-import-input').value = '';
    setStatus(pickerStatusEl, 'saved', 'imported');
  } catch (e) { setStatus(pickerStatusEl, 'error', e.message); }
});

// ─────────────────────────────────────────────
// TERRA FABRICATOR PANEL
// ─────────────────────────────────────────────

const terraPanelEl = document.getElementById('terra-panel');
const terraCanvas  = document.getElementById('terra-canvas');
const tCtx         = terraCanvas.getContext('2d');
const TC_SIZE      = 420;

function openTerraPanel() {
  terraPanelEl.dataset.open = 'true';
  const exp = activeExperience;
  document.getElementById('terra-exp-name').textContent = exp?.name ?? '—';
  const isFork = exp && !exp.locked;
  document.getElementById('terra-fork-badge').style.display = isFork ? 'inline' : 'none';

  if (exp?.level) {
    document.getElementById('terra-seed').value  = exp.level.seed  ?? 42;
    document.getElementById('terra-rooms').value = exp.level.roomCount ?? 18;
    document.getElementById('terra-grid').value  = exp.level.gridSize  ?? 12;
    document.getElementById('terra-rooms-val').textContent = exp.level.roomCount ?? 18;
    document.getElementById('terra-grid-val').textContent  = exp.level.gridSize  ?? 12;
  }
  _previewTerraMap();
}
function closeTerraPanel() { terraPanelEl.dataset.open = 'false'; }

function _previewTerraMap() {
  const seed  = (parseInt(document.getElementById('terra-seed').value)  || 42) >>> 0;
  const rooms = parseInt(document.getElementById('terra-rooms').value)  || 18;
  const grid  = parseInt(document.getElementById('terra-grid').value)   || 12;
  const lvl   = generateLevel(seed, rooms, grid);
  _drawTerraMap(lvl);
}

function _drawTerraMap(lvl) {
  tCtx.clearRect(0, 0, TC_SIZE, TC_SIZE);
  const pad = 20;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const t of lvl.tiles) {
    if (t.x < minX) minX = t.x; if (t.x > maxX) maxX = t.x;
    if (t.y < minY) minY = t.y; if (t.y > maxY) maxY = t.y;
  }
  const gW = maxX - minX + 1, gH = maxY - minY + 1;
  const cell = Math.min((TC_SIZE - pad*2) / gW, (TC_SIZE - pad*2) / gH);
  const ox = pad + ((TC_SIZE - pad*2) - gW*cell) / 2;
  const oy = pad + ((TC_SIZE - pad*2) - gH*cell) / 2;

  const DIRS_T = { n:[0,-1], s:[0,1], e:[1,0], w:[-1,0] };

  for (const t of lvl.tiles) {
    const sx = ox + (t.x - minX) * cell, sy = oy + (t.y - minY) * cell;
    const p = 2;
    if (t.type === 'start')     tCtx.fillStyle = 'rgba(255,160,64,0.65)';
    else if (t.type === 'end')  tCtx.fillStyle = 'rgba(148,64,255,0.65)';
    else                        tCtx.fillStyle = 'rgba(180,130,60,0.3)';
    tCtx.fillRect(sx+p, sy+p, cell-p*2, cell-p*2);

    // Doorway corridors as small connectors
    tCtx.fillStyle = 'rgba(200,160,80,0.55)';
    for (const dir of t.connections) {
      const [dx, dy] = DIRS_T[dir];
      const nPri = (t.x + dx)*1000 + (t.y + dy);
      if (t.x*1000 + t.y > nPri) continue; // draw from lower-priority side only
      const cw = Math.max(2, cell * 0.28);
      const corridorX = sx + cell/2 - cw/2 + dx*cell/2;
      const corridorY = sy + cell/2 - cw/2 + dy*cell/2;
      const cLen = cell * 0.5 + cw;
      if (dx !== 0) tCtx.fillRect(corridorX, sy + cell/2 - cw/2, cLen, cw);
      else          tCtx.fillRect(sx + cell/2 - cw/2, corridorY, cw, cLen);
    }

    // Room label
    tCtx.fillStyle = t.type === 'start' ? '#ffa040' : t.type === 'end' ? '#b060ff' : 'rgba(217,154,43,0.7)';
    tCtx.font = `${Math.max(9, cell*0.28)}px VT323,monospace`;
    tCtx.textAlign = 'center';
    tCtx.textBaseline = 'middle';
    if (t.type === 'start') tCtx.fillText('S', sx+cell/2, sy+cell/2);
    else if (t.type === 'end') tCtx.fillText('X', sx+cell/2, sy+cell/2);
  }

  // Legend
  tCtx.font = '13px VT323,monospace';
  tCtx.textAlign = 'left';
  tCtx.fillStyle = 'rgba(255,160,64,0.7)';  tCtx.fillText('S = start', pad, TC_SIZE - pad + 4);
  tCtx.fillStyle = 'rgba(148,64,255,0.7)';  tCtx.fillText('X = exit', pad + 80, TC_SIZE - pad + 4);
  tCtx.fillStyle = 'rgba(180,130,60,0.6)'; tCtx.fillText(`${lvl.roomCount} rooms`, pad + 170, TC_SIZE - pad + 4);
}

document.getElementById('terra-close-btn').addEventListener('click', closeTerraPanel);
document.getElementById('terra-preview-btn').addEventListener('click', _previewTerraMap);

document.getElementById('terra-rooms').addEventListener('input', e => {
  document.getElementById('terra-rooms-val').textContent = e.target.value;
});
document.getElementById('terra-grid').addEventListener('input', e => {
  document.getElementById('terra-grid-val').textContent = e.target.value;
});

document.getElementById('terra-save-btn').addEventListener('click', async () => {
  if (!activeExperience) return;
  if (activeExperience.locked) {
    setStatus(document.getElementById('terra-status'), 'error', 'fork the experience first');
    return;
  }
  const seed  = (parseInt(document.getElementById('terra-seed').value)  || 42) >>> 0;
  const rooms = parseInt(document.getElementById('terra-rooms').value)  || 18;
  const grid  = parseInt(document.getElementById('terra-grid').value)   || 12;
  const updated = { ...activeExperience, level: { ...activeExperience.level, seed, roomCount: rooms, gridSize: grid } };
  setStatus(document.getElementById('terra-status'), 'saving', 'saving…');
  try {
    activeExperience = await saveExperience(FORGE_BASE, updated);
    // Refresh in picker list
    const idx = _pickerExperiences.findIndex(e => e.id === activeExperience.id);
    if (idx !== -1) _pickerExperiences[idx] = activeExperience;
    setStatus(document.getElementById('terra-status'), 'saved', 'saved');
    setTimeout(() => { document.getElementById('terra-status').dataset.state = 'idle'; }, 2500);
  } catch (e) {
    setStatus(document.getElementById('terra-status'), 'error', e.message);
  }
});

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
// THE UNDERCROFT
// ─────────────────────────────────────────────

const undercroftPanelEl = document.getElementById('undercroft-panel');
let _ucMonitorHandler = null;

function openUndercroftPanel() {
  undercroftPanelEl.dataset.open = 'true';
  _switchUcTab('registry');
}
function closeUndercroftPanel() {
  undercroftPanelEl.dataset.open = 'false';
  _detachMonitor();
}

function _detachMonitor() {
  if (_ucMonitorHandler) {
    off('*', _ucMonitorHandler);
    _ucMonitorHandler = null;
  }
}

function _switchUcTab(tab) {
  undercroftPanelEl.querySelectorAll('.uc-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  undercroftPanelEl.querySelectorAll('.undercroft-pane').forEach(pane => {
    pane.style.display = pane.id === `undercroft-${tab}` ? '' : 'none';
  });
  if (tab === 'registry')  _renderUndercroftRegistry();
  if (tab === 'monitor')   _renderUndercroftMonitor();
  if (tab === 'manifest')  _renderUndercroftManifest();
}

function _renderUndercroftRegistry() {
  const pane = document.getElementById('undercroft-registry');
  const state = snapshotState();
  const rows = (entries, label) => {
    const keys = Object.keys(entries);
    if (!keys.length) return `<tr><td colspan="2" class="uc-empty">${label}: none</td></tr>`;
    return keys.map(k => `<tr><td class="uc-key">${k}</td><td class="uc-val">${JSON.stringify(entries[k])}</td></tr>`).join('');
  };
  pane.innerHTML = `
    <table class="uc-registry-table">
      <thead><tr><th>KEY</th><th>VALUE</th></tr></thead>
      <tbody>
        <tr class="uc-section-row"><td colspan="2">— FLAGS —</td></tr>
        ${rows(state.flags, 'flags')}
        <tr class="uc-section-row"><td colspan="2">— COUNTERS —</td></tr>
        ${rows(state.counters, 'counters')}
        <tr class="uc-section-row"><td colspan="2">— ENTITY STATES —</td></tr>
        ${rows(state.entityStates, 'entity states')}
      </tbody>
    </table>
    <button class="uc-refresh-btn" id="uc-reg-refresh">↺ REFRESH</button>
  `;
  document.getElementById('uc-reg-refresh').addEventListener('click', _renderUndercroftRegistry);
}

function _renderUndercroftMonitor() {
  const pane = document.getElementById('undercroft-monitor');
  pane.innerHTML = `<div id="uc-event-log" class="uc-event-log"></div>
    <button class="uc-refresh-btn" id="uc-monitor-clear">✕ CLEAR</button>`;
  const log = document.getElementById('uc-event-log');

  document.getElementById('uc-monitor-clear').addEventListener('click', () => { log.innerHTML = ''; });

  // Remove previous handler if any
  _detachMonitor();

  _ucMonitorHandler = ({ event, payload }) => {
    const line = document.createElement('div');
    line.className = 'uc-log-line';
    const ts = new Date().toTimeString().slice(0, 8);
    line.textContent = `[${ts}] ${event}  ${JSON.stringify(payload)}`;
    log.appendChild(line);
    // Keep max 200 lines
    while (log.children.length > 200) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  };
  on('*', _ucMonitorHandler);
}

function _renderUndercroftManifest() {
  const pane = document.getElementById('undercroft-manifest');
  const triggers = getLoadedTriggers();
  if (!triggers.length) {
    pane.innerHTML = `<p class="uc-empty">No triggers loaded. Launch an experience to see its trigger manifest.</p>`;
    return;
  }
  const rows = triggers.map(t => `
    <tr>
      <td class="uc-key">${t.id ?? '—'}</td>
      <td class="uc-val">${t.on ?? 'room:entered'}</td>
      <td class="uc-val">${t.condition?.type ?? 'always'}</td>
      <td class="uc-val">${(t.actions ?? []).map(a => a.type).join(', ') || '—'}</td>
      <td class="uc-val">${t.once ? 'once' : 'repeating'}</td>
    </tr>
  `).join('');
  pane.innerHTML = `
    <table class="uc-registry-table">
      <thead><tr><th>ID</th><th>EVENT</th><th>CONDITION</th><th>ACTIONS</th><th>FIRE</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

undercroftPanelEl.querySelectorAll('.uc-tab').forEach(btn => {
  btn.addEventListener('click', () => _switchUcTab(btn.dataset.tab));
});
document.getElementById('undercroft-close-btn').addEventListener('click', closeUndercroftPanel);
document.getElementById('hub-undercroft-card').addEventListener('click', openUndercroftPanel);

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────

initProfile();
