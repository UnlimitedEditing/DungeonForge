// =====================================================================
// hub-panels.js — All hub panels: Library, Entities, Pose Editor,
//                 Arcanum, Machinarium, Substance Lab, Terra Fabricator,
//                 Picker, Undercroft
// =====================================================================

import * as THREE from 'three';
import {
  player, profileId, activeExperience,
  setActiveExperience,
  liveXpMult, liveAgroRange, liveAttackRange, liveMeleeRange,
  liveEntityAttackCd, livePlayerAttackCd, liveDropChance, liveDropPool,
  setLiveXpMult, setLiveLevelHpGain, setLiveLevelAtkGain, setLiveLevelDefGain,
  setLiveAgroRange, setLiveAttackRange, setLiveMeleeRange,
  setLiveEntityAttackCd, setLivePlayerAttackCd, setLiveDropChance, setLiveDropPool,
  TYPE_COLORS,
} from './state.js';
import { controls } from './scene.js';
import { getEquipBonus, savePlayerStats } from './combat.js';
import {
  loadJobHistory, renderEntities as _renderEntities,
  loadWalkSheet, pollVariantJob, setEntitiesPanelRef,
  VARIANT_TYPES,
} from './entity.js';
import { escapeHtml } from './hud.js';
import {
  loadScaffold, generateScaffold,
  checkTriggers as checkScaffoldTriggers,
} from './lore-engine.js';
import { off, on } from './events.js';
import { snapshotState } from './world-state.js';
import { getLoadedTriggers } from './triggers.js';
import {
  fetchExperiences, fetchExperience, createFork, saveExperience,
  encodeShareCode, decodeShareCode, importFromCode, DEFAULT_EXPERIENCES,
} from './experiences.js';
import { generateLevel } from './level.js';

const FORGE_BASE = window.location.origin;

// ─────────────────────────────────────────────
// UTILITY (shared within this file)
// ─────────────────────────────────────────────

function setStatus(el, state, msg) { el.dataset.state = state; el.textContent = msg; }

// ─────────────────────────────────────────────
// LIBRARY PANEL
// ─────────────────────────────────────────────

const libraryPanelEl = document.getElementById('library-panel');
const loreTextarea   = document.getElementById('lore-textarea');
const loreStatus     = document.getElementById('lore-status');
const loreSaveBtn    = document.getElementById('lore-save-btn');

export function closeLibraryPanel() {
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

// Scaffold generation
const scaffoldStatusEl  = document.getElementById('scaffold-status');
const scaffoldPreviewEl = document.getElementById('scaffold-preview');
const scaffoldGenBtn    = document.getElementById('scaffold-generate-btn');

async function _loadScaffoldUI(expId) {
  try {
    const res = await fetch(`${FORGE_BASE}/scaffold/${expId}/status`);
    if (!res.ok) { scaffoldStatusEl.textContent = 'not generated'; return; }
    const data = await res.json();
    if (data.status === 'ready') {
      scaffoldStatusEl.textContent = `ready · ${new Date(data.generatedAt * 1000).toLocaleTimeString()}`;
      scaffoldStatusEl.dataset.state = 'ready';
      _renderScaffoldPreview(expId);
    } else if (data.status === 'queued') {
      scaffoldStatusEl.textContent = 'generating…';
      scaffoldStatusEl.dataset.state = 'queued';
      setTimeout(() => _loadScaffoldUI(expId), 3000);
    } else {
      scaffoldStatusEl.textContent = 'not generated';
      scaffoldStatusEl.dataset.state = '';
    }
  } catch { scaffoldStatusEl.textContent = 'not generated'; }
}

async function _renderScaffoldPreview(expId) {
  try {
    const res = await fetch(`${FORGE_BASE}/scaffold/${expId}`);
    if (!res.ok) return;
    const sc = await res.json();
    scaffoldPreviewEl.style.display = '';
    scaffoldPreviewEl.innerHTML = `
      <div class="scaffold-row"><span class="scaffold-label">TONE</span> ${(sc.toneVocabulary ?? []).join(', ')}</div>
      <div class="scaffold-row"><span class="scaffold-label">MODIFIER</span> ${sc.promptModifier ?? '—'}</div>
      <div class="scaffold-row"><span class="scaffold-label">ARCHETYPES</span>
        ${(sc.archetypes ?? []).map(a =>
          `<div class="scaffold-arch">${a.name} (tier ${a.tierRange?.[0]}–${a.tierRange?.[1]}, ×${a.statMultiplier}) — ${a.evolutionHint}</div>`
        ).join('')}
      </div>
      <div class="scaffold-row"><span class="scaffold-label">HOOKS</span>
        ${(sc.inferenceHooks ?? []).map(h =>
          `<div class="scaffold-hook">${h.id}: ${h.trigger?.key} ${h.trigger?.type === 'counter_gte' ? '≥' : '='} ${h.trigger?.value} → "${h.contextNote}"</div>`
        ).join('')}
      </div>
    `;
    // Push scaffold into lore-engine memory if this is the active experience
    if (activeExperience?.id === expId) loadScaffold(FORGE_BASE, expId);
  } catch { /* preview is optional */ }
}

scaffoldGenBtn.addEventListener('click', async () => {
  const expId = activeExperience?.id ?? 'latentcrawl';
  if (!profileId) { scaffoldStatusEl.textContent = 'log in first'; return; }
  scaffoldGenBtn.disabled = true;
  scaffoldStatusEl.textContent = 'queuing…';
  scaffoldStatusEl.dataset.state = 'queued';
  try {
    await generateScaffold(FORGE_BASE, expId, profileId);
    scaffoldStatusEl.textContent = 'generating…';
    setTimeout(() => _loadScaffoldUI(expId), 3000);
  } catch (e) {
    scaffoldStatusEl.textContent = `error: ${e.message}`;
    scaffoldStatusEl.dataset.state = 'error';
  } finally { scaffoldGenBtn.disabled = false; }
});

export function openLibraryPanel() {  // override to also load scaffold status
  libraryPanelEl.dataset.open = 'true';
  loadLore();
  loreTextarea.focus();
  const expId = activeExperience?.id ?? 'latentcrawl';
  _loadScaffoldUI(expId);
}

// ─────────────────────────────────────────────
// ENTITIES PANEL
// ─────────────────────────────────────────────

const entitiesPanelEl  = document.getElementById('entities-panel');
const entitiesBody     = document.getElementById('entities-body');

// Register entities panel ref with entity.js so pollVariantJob can trigger re-render
setEntitiesPanelRef(entitiesPanelEl, () => renderEntitiesLocal());

function renderEntitiesLocal() {
  _renderEntities(entitiesBody);
}

export async function openEntities() {
  entitiesPanelEl.dataset.open = 'true';
  await loadJobHistory();
  renderEntitiesLocal();
}
export function closeEntities() { entitiesPanelEl.dataset.open = 'false'; }

document.getElementById('entities-close-btn').addEventListener('click', closeEntities);
document.getElementById('entities-back-btn').addEventListener('click', () => {
  closeEntities();
  openLibraryPanel();
});
document.getElementById('entities-pose-btn').addEventListener('click', () => {
  closeEntities();
  openPoseEditor();
});

export function renderEntities() {
  renderEntitiesLocal();
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

export function openPoseEditor() {
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

export function closePoseEditor() {
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

export function openArcanumPanel() {
  arcanumPanelEl.dataset.open = 'true';
  loadArcanumConfig();
  renderArcanumSheet();
}
export function closeArcanumPanel() { arcanumPanelEl.dataset.open = 'false'; }

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
    setLiveXpMult(cfg.xp_multiplier);
    setLiveLevelHpGain(cfg.level_hp_gain);
    setLiveLevelAtkGain(cfg.level_atk_gain);
    setLiveLevelDefGain(cfg.level_def_gain);
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

export function openMachinariumPanel() {
  machinariumPanelEl.dataset.open = 'true';
  loadMachinariumConfig();
}
export function closeMachinariumPanel() { machinariumPanelEl.dataset.open = 'false'; }

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
    setLiveAgroRange(cfg.agro_range);
    setLiveAttackRange(cfg.attack_range);
    setLiveMeleeRange(cfg.melee_range);
    setLiveEntityAttackCd(cfg.entity_attack_cd);
    setLivePlayerAttackCd(cfg.player_attack_cd);
    setLiveDropChance(cfg.drop_chance);
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

export function openSubstancePanel() {
  substancePanelEl.dataset.open = 'true';
  loadSubstancePool();
}
export function closeSubstancePanel() { substancePanelEl.dataset.open = 'false'; }

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
    setLiveDropPool(substanceDropPool.map(item => ({
      name: item.name, type: item.type, subtype: item.subtype ?? '',
      stats: { [item.stat_key]: item.stat_val }, rarity: item.rarity,
      color: TYPE_COLORS[item.type] ?? 0xddaa00,
    })));
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
// EXPERIENCE PICKER
// ─────────────────────────────────────────────

const pickerPanelEl  = document.getElementById('picker-panel');
const pickerListEl   = document.getElementById('picker-list');
const pickerDetailEl = document.getElementById('picker-detail');
const pickerStatusEl = document.getElementById('picker-status');

let _pickerExperiences  = [];
let _pickerSelectedId   = null;

// launchExperience injected from main.js
let _launchExperience = null;
export function setLaunchExperience(fn) { _launchExperience = fn; }

// openTerraPanel cross-reference (defined below, forward referenced here)
// accessed at click-time so no circular issue

export function openPickerPanel() {
  pickerPanelEl.dataset.open = 'true';
  _loadPickerExperiences();
}
export function closePickerPanel() { pickerPanelEl.dataset.open = 'false'; }

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

  document.getElementById('pd-play-btn').addEventListener('click', () => {
    if (_launchExperience) _launchExperience(exp);
  });

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
    setActiveExperience(exp);
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

// Sync picked experiences list after terra save
export function syncPickerExperience(exp) {
  const idx = _pickerExperiences.findIndex(e => e.id === exp.id);
  if (idx !== -1) _pickerExperiences[idx] = exp;
}

// ─────────────────────────────────────────────
// TERRA FABRICATOR PANEL
// ─────────────────────────────────────────────

const terraPanelEl = document.getElementById('terra-panel');
const terraCanvas  = document.getElementById('terra-canvas');
const tCtx         = terraCanvas.getContext('2d');
const TC_SIZE      = 420;

export function openTerraPanel() {
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
export function closeTerraPanel() { terraPanelEl.dataset.open = 'false'; }

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
    const saved = await saveExperience(FORGE_BASE, updated);
    setActiveExperience(saved);
    // Refresh in picker list
    syncPickerExperience(saved);
    setStatus(document.getElementById('terra-status'), 'saved', 'saved');
    setTimeout(() => { document.getElementById('terra-status').dataset.state = 'idle'; }, 2500);
  } catch (e) {
    setStatus(document.getElementById('terra-status'), 'error', e.message);
  }
});

// ─────────────────────────────────────────────
// THE UNDERCROFT
// ─────────────────────────────────────────────

const undercroftPanelEl = document.getElementById('undercroft-panel');
let _ucMonitorHandler = null;

export function openUndercroftPanel() {
  undercroftPanelEl.dataset.open = 'true';
  _switchUcTab('registry');
}
export function closeUndercroftPanel() {
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
