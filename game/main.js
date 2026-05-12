// =====================================================================
// dungeon-forge / main.js
//
// Architecture:
//   Profile   — localStorage profile_id; setup screen on first launch.
//   Spawn     — POST /jobs, placeholder drops immediately, polls until done.
//   Animation — when a sprite job completes it carries an anim_job_id.
//               A separate poll loop watches that job; when done the static
//               sprite texture is swapped for a THREE.VideoTexture.
//   Roaming   — each done sprite gets a simple wander AI: picks a random
//               room position, walks toward it, pauses, repeats.
// =====================================================================

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// ---------- config ----------
const ROOM_SIZE   = 20;
const WALL_HEIGHT = 4.5;
const PLAYER_EYE  = 1.7;
const MOVE_SPEED  = 4.5;
const FRICTION    = 10;
const POLL_MS     = 3000;
const FORGE_BASE  = window.location.origin;

const ROAM_SPEED_MIN  = 0.7;
const ROAM_SPEED_MAX  = 1.3;
const ROAM_ARRIVE_D   = 0.25;  // distance threshold to count as "arrived"
const ROAM_PAUSE_MIN  = 1.0;   // seconds to idle after arriving
const ROAM_PAUSE_MAX  = 3.0;
const ROAM_BOUND      = ROOM_SIZE / 2 - 1.8;  // keep monsters off walls

const SPAWN_RING = [
  [ 0,  -4], [ 3,  -3], [ 4,   0], [ 3,   3],
  [ 0,   4], [-3,   3], [-4,   0], [-3,  -3],
];
let spawnIndex = 0;
function nextSpawn() {
  const [x, z] = SPAWN_RING[spawnIndex % SPAWN_RING.length];
  spawnIndex += 1;
  return new THREE.Vector3(x, 0, z);
}

function randomRoamTarget() {
  return new THREE.Vector3(
    (Math.random() * 2 - 1) * ROAM_BOUND,
    0,
    (Math.random() * 2 - 1) * ROAM_BOUND,
  );
}

// ---------- profile / auth ----------

const setupScreen  = document.getElementById('setup-screen');
const setupTabBtns = document.querySelectorAll('.setup-tab-btn');
const setupPanels  = document.querySelectorAll('.setup-panel');

// register fields
const regUsername = document.getElementById('reg-username');
const regApiKey   = document.getElementById('reg-apikey');
const regPassword = document.getElementById('reg-password');
const regConfirm  = document.getElementById('reg-confirm');
const regBtn      = document.getElementById('reg-btn');
const regStatus   = document.getElementById('reg-status');

// login fields
const loginUsername = document.getElementById('login-username');
const loginPassword = document.getElementById('login-password');
const loginBtn      = document.getElementById('login-btn');
const loginStatus   = document.getElementById('login-status');

let profileId       = null;
let profileUsername = null;

// Tab switching within setup screen
setupTabBtns.forEach(btn => btn.addEventListener('click', () => {
  const target = btn.dataset.setupTab;
  setupTabBtns.forEach(b => b.classList.toggle('active', b.dataset.setupTab === target));
  setupPanels.forEach(p => p.style.display = p.dataset.setupPanel === target ? '' : 'none');
  if (target === 'register') regUsername.focus();
  else loginUsername.focus();
}));

function switchSetupTab(tab) {
  setupTabBtns.forEach(b => b.classList.toggle('active', b.dataset.setupTab === tab));
  setupPanels.forEach(p => p.style.display = p.dataset.setupPanel === tab ? '' : 'none');
}

function showSetup(tab = 'register') {
  switchSetupTab(tab);
  setupScreen.dataset.active = 'true';
  if (tab === 'login') loginUsername.focus();
  else regUsername.focus();
}

function hideSetup() {
  setupScreen.dataset.active = 'false';
  updateHudPlayer();
  spawnInput.focus();
}

function setStatus(el, state, msg) {
  el.dataset.state = state;
  el.textContent   = msg;
}

async function onSessionReady(p) {
  profileId       = p.profile_id;
  profileUsername = p.username;
  localStorage.setItem('profile_id', p.profile_id);
  localStorage.setItem('profile_username', p.username);
}

// --- register ---
async function doRegister() {
  const username = regUsername.value.trim();
  const apiKey   = regApiKey.value.trim();
  const password = regPassword.value;
  const confirm  = regConfirm.value;

  if (!username || !apiKey || !password) {
    setStatus(regStatus, 'error', 'all fields are required'); return;
  }
  if (password !== confirm) {
    setStatus(regStatus, 'error', 'passwords do not match'); return;
  }

  regBtn.disabled = true;
  setStatus(regStatus, 'working', 'validating key and creating profile…');
  try {
    const res = await fetch(`${FORGE_BASE}/profiles/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, api_key: apiKey }),
    });
    if (!res.ok) throw new Error(await res.text());
    const p = await res.json();
    await onSessionReady(p);
    setStatus(regStatus, 'ok', `registered as ${p.username}`);
    setTimeout(hideSetup, 900);
  } catch (e) {
    setStatus(regStatus, 'error', e.message.replace(/^"(.*)"$/, '$1'));
  } finally {
    regBtn.disabled = false;
  }
}

regBtn.addEventListener('click', doRegister);
[regUsername, regApiKey, regPassword, regConfirm].forEach(el =>
  el.addEventListener('keydown', e => { if (e.code === 'Enter') { e.preventDefault(); doRegister(); } })
);

// --- login ---
async function doLogin() {
  const username = loginUsername.value.trim();
  const password = loginPassword.value;

  if (!username || !password) {
    setStatus(loginStatus, 'error', 'username and password required'); return;
  }

  loginBtn.disabled = true;
  setStatus(loginStatus, 'working', 'authenticating…');
  try {
    const res = await fetch(`${FORGE_BASE}/profiles/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error(await res.text());
    const p = await res.json();
    await onSessionReady(p);
    setStatus(loginStatus, 'ok', `welcome back, ${p.username}`);
    setTimeout(hideSetup, 900);
  } catch (e) {
    setStatus(loginStatus, 'error', e.message.replace(/^"(.*)"$/, '$1'));
  } finally {
    loginBtn.disabled = false;
  }
}

loginBtn.addEventListener('click', doLogin);
[loginUsername, loginPassword].forEach(el =>
  el.addEventListener('keydown', e => { if (e.code === 'Enter') { e.preventDefault(); doLogin(); } })
);

// --- boot: check stored profile ---
async function initProfile() {
  const storedId   = localStorage.getItem('profile_id');
  const storedName = localStorage.getItem('profile_username');

  if (storedId) {
    try {
      const res = await fetch(`${FORGE_BASE}/profiles/${storedId}`);
      if (res.ok) {
        const p = await res.json();
        if (p.active_session) {
          // Server restarted but session survived (e.g. warm restart)
          profileId = p.profile_id; profileUsername = p.username;
          hideSetup(); return;
        }
        // Profile exists but session expired — go straight to login
        if (storedName) loginUsername.value = storedName;
        showSetup('login'); return;
      }
    } catch (_) {}
  }
  showSetup('register');
}

// ---------- config panel ----------

const tabBtns        = document.querySelectorAll('.tab-btn');
const tabPanels      = document.querySelectorAll('.tab-panel');
const cfgWorkflow    = document.getElementById('cfg-workflow');
const cfgAnimWf      = document.getElementById('cfg-anim-workflow');
const cfgSpriteTmpl  = document.getElementById('cfg-sprite-template');
const cfgWalkTmpl    = document.getElementById('cfg-walk-template');
const cfgLore        = document.getElementById('cfg-lore');
const cfgSaveBtn     = document.getElementById('cfg-save-btn');
const cfgStatus      = document.getElementById('config-status');

tabBtns.forEach(btn => btn.addEventListener('click', () => {
  const target = btn.dataset.tab;
  tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === target));
  tabPanels.forEach(p => p.style.display = p.dataset.panel === target ? '' : 'none');
  if (target === 'config') loadConfig();
}));

async function loadConfig() {
  try {
    const res = await fetch(`${FORGE_BASE}/config`);
    if (!res.ok) return;
    const cfg = await res.json();
    cfgWorkflow.value   = cfg.workflow        ?? '';
    cfgAnimWf.value     = cfg.anim_workflow   ?? '';
    cfgSpriteTmpl.value = cfg.sprite_prompt_template ?? '';
    cfgWalkTmpl.value   = cfg.walk_prompt_template   ?? '';
    cfgLore.value       = cfg.lore            ?? '';
  } catch (e) { console.warn('config load failed', e); }
}

async function saveConfig() {
  cfgSaveBtn.disabled     = true;
  cfgStatus.dataset.state = 'saving';
  cfgStatus.textContent   = 'saving…';
  try {
    const res = await fetch(`${FORGE_BASE}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflow:                cfgWorkflow.value.trim(),
        anim_workflow:           cfgAnimWf.value.trim(),
        sprite_prompt_template:  cfgSpriteTmpl.value,
        walk_prompt_template:    cfgWalkTmpl.value,
        lore:                    cfgLore.value,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    cfgStatus.dataset.state = 'saved';
    cfgStatus.textContent   = 'config saved';
    setTimeout(() => { cfgStatus.dataset.state = 'idle'; }, 2500);
  } catch (e) {
    cfgStatus.dataset.state = 'error';
    cfgStatus.textContent   = `save failed: ${e.message}`;
  } finally {
    cfgSaveBtn.disabled = false;
  }
}

cfgSaveBtn.addEventListener('click', saveConfig);

// ---------- scene ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.fog        = new THREE.Fog(0x000000, 6, 22);

const camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(0, PLAYER_EYE, 6);

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.NoToneMapping;
document.getElementById('viewport').appendChild(renderer.domElement);

// ---------- lights ----------
scene.add(new THREE.AmbientLight(0x2a1e10, 0.35));
const brazier = new THREE.PointLight(0xff8030, 1.2, 14, 1.6);
brazier.position.set(0, 2.5, 0);
scene.add(brazier);
const torch = new THREE.PointLight(0xffb060, 1.5, 10, 1.5);
scene.add(torch);

// ---------- room ----------
const floorMat   = new THREE.MeshStandardMaterial({ color: 0x3a2820, roughness: 0.95, metalness: 0.0 });
const ceilingMat = new THREE.MeshStandardMaterial({ color: 0x1a1208, roughness: 1 });
const wallMat    = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.95 });

const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SIZE, ROOM_SIZE), floorMat);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SIZE, ROOM_SIZE), ceilingMat);
ceiling.rotation.x = Math.PI / 2;
ceiling.position.y = WALL_HEIGHT;
scene.add(ceiling);

function addWall(x, z, rotY) {
  const w = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SIZE, WALL_HEIGHT), wallMat);
  w.position.set(x, WALL_HEIGHT / 2, z);
  w.rotation.y = rotY;
  scene.add(w);
}
addWall(0,            -ROOM_SIZE/2,  0);
addWall(0,             ROOM_SIZE/2,  Math.PI);
addWall(-ROOM_SIZE/2,  0,            Math.PI / 2);
addWall( ROOM_SIZE/2,  0,           -Math.PI / 2);

scene.add(Object.assign(
  new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.4, 0.4, 12),
    new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 1 }),
  ),
  { position: new THREE.Vector3(0, 0.2, 0) }
));

// ---------- controls ----------
const controls   = new PointerLockControls(camera, renderer.domElement);
const terminal   = document.getElementById('terminal');
const crosshair  = document.getElementById('crosshair');
const termStatus = document.getElementById('terminal-status');

function openTerminal()  { terminal.dataset.open = 'true';  crosshair.dataset.visible = 'false'; }
function closeTerminal() { terminal.dataset.open = 'false'; crosshair.dataset.visible = 'true';  }

controls.addEventListener('lock',   () => { closeTerminal(); termStatus.textContent = 'link: locked'; });
controls.addEventListener('unlock', () => { openTerminal();  termStatus.textContent = 'link: idle';   });

renderer.domElement.addEventListener('click', () => {
  if (terminal.dataset.open === 'true' && setupScreen.dataset.active !== 'true') controls.lock();
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Tab') {
    e.preventDefault();
    if (setupScreen.dataset.active === 'true') return;
    if (controls.isLocked) controls.unlock(); else controls.lock();
  }
});

// ---------- movement ----------
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
  controls.moveRight  (velocity.x * dt);
  controls.moveForward(velocity.z * dt);
  const half = ROOM_SIZE / 2 - 0.4;
  const p = controls.object.position;
  p.x = Math.max(-half, Math.min(half, p.x));
  p.z = Math.max(-half, Math.min(half, p.z));
  p.y = PLAYER_EYE;
  torch.position.set(p.x, p.y + 0.2, p.z);
}

// ---------- sprite spawning ----------
//
// Entry shape:
//   { jobId, status, mesh, position, prompt,
//     floorY,          -- y offset so feet stay on ground during roaming
//     animJobId,       -- populated once sprite job is done
//     walkAnimReady,   -- true once video texture is applied
//     walkVideo,       -- HTMLVideoElement (kept for cleanup)
//     roam: { target: Vector3, waitUntil: number, speed: number } }
//
const sprites       = new Map();
const textureLoader = new THREE.TextureLoader();

function makePlaceholder(position) {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xd99a2b, transparent: true, opacity: 0.18,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.2), mat);
  mesh.position.copy(position);
  mesh.position.y = 1.1;
  mesh.userData.isPlaceholder = true;
  mesh.userData.spawnTime     = performance.now();
  scene.add(mesh);
  return mesh;
}

function makeSprite(spriteName, position, onReady) {
  textureLoader.load(`${FORGE_BASE}/sprites/${spriteName}`, (tex) => {
    tex.magFilter  = THREE.NearestFilter;
    tex.minFilter  = THREE.LinearMipmapLinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const mat    = new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.15, depthWrite: true });
    const sprite = new THREE.Sprite(mat);
    const aspect = tex.image.width / tex.image.height;
    const h      = 2.2;
    sprite.scale.set(h * aspect, h, 1);
    sprite.position.copy(position);
    sprite.position.y = h / 2;
    onReady(sprite, h / 2);
  }, undefined, (err) => console.error('texture load failed', err));
}

function applyWalkAnim(entry, animName) {
  const video = document.createElement('video');
  video.src         = `${FORGE_BASE}/anims/${animName}`;
  video.loop        = true;
  video.muted       = true;
  video.playsInline = true;
  video.crossOrigin = 'anonymous';
  video.play().catch(() => {});

  const tex = new THREE.VideoTexture(video);
  tex.magFilter  = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;

  // Dispose old static texture, swap in video texture.
  const mat = entry.mesh.material;
  mat.map?.dispose();
  mat.map = tex;
  mat.needsUpdate = true;

  entry.walkVideo     = video;
  entry.walkAnimReady = true;
}

// ---------- spawn flow ----------

async function spawnFromPrompt(promptText) {
  if (!promptText || !profileId) return;
  let job;
  try {
    const res = await fetch(`${FORGE_BASE}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptText, profile_id: profileId }),
    });
    if (!res.ok) throw new Error(`forge returned ${res.status}`);
    job = await res.json();
  } catch (e) {
    console.error('spawn failed', e);
    termStatus.textContent = 'link: ERROR';
    return;
  }

  const position = nextSpawn();
  const placeholder = makePlaceholder(position);
  sprites.set(job.id, {
    jobId: job.id, status: job.status,
    mesh: placeholder, position, prompt: promptText,
    floorY: 1.1, animJobId: null, walkAnimReady: false, walkVideo: null, roam: null,
  });
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
        scene.remove(entry.mesh);
        entry.mesh.material?.dispose();
        entry.mesh.geometry?.dispose();
        scene.add(sprite);
        entry.mesh   = sprite;
        entry.floorY = floorY;
        entry.roam   = initRoam();
      });
      // Start watching the auto-queued animation job.
      if (job.anim_job_id) {
        entry.animJobId = job.anim_job_id;
        pollWalkAnim(job.anim_job_id, entry);
      }
      return;
    }
    if (job.status === 'failed') {
      entry.mesh.material.color.set(0x8b1a1a);
      entry.mesh.material.opacity = 0.5;
      return;
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
    } catch (e) { console.warn('anim poll error', animJobId, e); continue; }

    if (animJob.status === 'done' && animJob.anim_name && entry.mesh) {
      applyWalkAnim(entry, animJob.anim_name);
      refreshJobList();
      return;
    }
    if (animJob.status === 'failed') {
      console.warn('walk anim failed for', animJobId);
      return;
    }
  }
}

// ---------- roaming ----------

function initRoam() {
  return {
    target:    randomRoamTarget(),
    waitUntil: 0,
    speed:     ROAM_SPEED_MIN + Math.random() * (ROAM_SPEED_MAX - ROAM_SPEED_MIN),
  };
}

function updateRoaming(dt) {
  const now = performance.now() / 1000;
  for (const e of sprites.values()) {
    if (e.status !== 'done' || !e.roam || !e.mesh) continue;

    if (now < e.roam.waitUntil) continue;

    const pos = e.mesh.position;
    const dx  = e.roam.target.x - pos.x;
    const dz  = e.roam.target.z - pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < ROAM_ARRIVE_D) {
      e.roam.waitUntil = now + ROAM_PAUSE_MIN + Math.random() * (ROAM_PAUSE_MAX - ROAM_PAUSE_MIN);
      e.roam.target    = randomRoamTarget();
    } else {
      pos.x += (dx / dist) * e.roam.speed * dt;
      pos.z += (dz / dist) * e.roam.speed * dt;
      pos.y  = e.floorY;   // keep feet on the ground regardless of Three.js accumulation
    }
  }
}

// ---------- HUD ----------
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
    if (e.status === 'done') ready++;
    else if (e.status !== 'failed') inflight++;
  }
  hudSprites.textContent = ready;
  hudQueue.textContent   = inflight;
  hudStatus.textContent  = controls.isLocked ? 'IN-WORLD' : 'TERMINAL';
  const p = controls.object.position;
  hudPos.textContent = `${p.x.toFixed(1)},${p.z.toFixed(1)}`;
}

function refreshJobList() {
  if (sprites.size === 0) { jobsListEl.innerHTML = '<div class="muted">no jobs.</div>'; return; }
  const rows = [];
  for (const e of sprites.values()) {
    const animTag = e.walkAnimReady
      ? '<span class="job-anim" data-s="done">walk</span>'
      : e.animJobId
        ? '<span class="job-anim" data-s="pending">walk…</span>'
        : '';
    rows.push(
      `<div class="job-row">
         <span class="job-id">${e.jobId}</span>
         <span class="job-prompt">${escapeHtml(e.prompt)}</span>
         ${animTag}
         <span class="job-status" data-s="${e.status}">${e.status}</span>
       </div>`
    );
  }
  jobsListEl.innerHTML = rows.join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- spawn terminal wiring ----------
const spawnInput = document.getElementById('spawn-input');
const spawnBtn   = document.getElementById('spawn-btn');

function doSpawn() {
  const v = spawnInput.value.trim();
  if (!v) return;
  spawnFromPrompt(v);
  spawnInput.value = '';
  spawnInput.focus();
}
spawnBtn.addEventListener('click', doSpawn);
spawnInput.addEventListener('keydown', (e) => { if (e.code === 'Enter') { e.preventDefault(); doSpawn(); } });

// ---------- placeholder pulse ----------
function pulsePlaceholders(now) {
  for (const e of sprites.values()) {
    const mesh = e.mesh;
    if (!mesh?.userData.isPlaceholder) continue;
    const t = (now - mesh.userData.spawnTime) / 1000;
    mesh.material.opacity = 0.10 + 0.12 * (0.5 + 0.5 * Math.sin(t * 3));
    mesh.lookAt(camera.position.x, mesh.position.y, camera.position.z);
  }
}

// ---------- main loop ----------
const clock = new THREE.Clock();

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  updateMovement(dt);
  updateRoaming(dt);
  pulsePlaceholders(performance.now());
  refreshHud();
  renderer.render(scene, camera);
}
tick();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- boot ----------
initProfile();
