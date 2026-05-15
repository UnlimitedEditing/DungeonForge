// =====================================================================
// hud.js — HUD and visual feedback functions
// =====================================================================

import * as THREE from 'three';
import { player, sprites, appMode, profileUsername } from './state.js';
import { roomScene, roomCamera, controls } from './scene.js';

const SPRITE_WORLD_H = 2.2;  // world-space height used for all sprites
const HP_BAR_W = 0.85;
const HP_BAR_H = 0.07;

// ─────────────────────────────────────────────
// PLAYER HUD ELEMENTS
// ─────────────────────────────────────────────

const statsHudEl         = document.getElementById('stats-hud');
const hudLevelEl         = document.getElementById('hud-level');
const hudHpFillEl        = document.getElementById('hud-hp-fill');
const hudHpValEl         = document.getElementById('hud-hp-val');
const hudXpFillEl        = document.getElementById('hud-xp-fill');
const hudXpValEl         = document.getElementById('hud-xp-val');
const hitFlashEl         = document.getElementById('hit-flash');
const levelupEl          = document.getElementById('levelup-notification');
export const levelupSubEl = document.getElementById('levelup-sub');
export const pickupPromptEl   = document.getElementById('pickup-prompt');
export const pickupItemNameEl = document.getElementById('pickup-item-name');

const hudStatus  = document.getElementById('hud-status');
const hudSprites = document.getElementById('hud-sprite-count');
const hudQueue   = document.getElementById('hud-queue-count');
const hudPlayer  = document.getElementById('hud-player');
const hudPos     = document.getElementById('hud-pos');
export const jobsListEl = document.getElementById('jobs-list');

// Export statsHudEl so main.js can set data-visible
export { statsHudEl, hitFlashEl };

// ─────────────────────────────────────────────
// PLAYER HUD UPDATE
// ─────────────────────────────────────────────

export function updatePlayerHud() {
  hudLevelEl.textContent = player.level;
  const hpPct = player.hp / player.maxHp;
  hudHpFillEl.style.width      = `${(hpPct * 100).toFixed(1)}%`;
  hudHpFillEl.style.background = hpPct > 0.5 ? '#22bb22' : hpPct > 0.25 ? '#cccc22' : '#cc2222';
  hudHpValEl.textContent       = `${player.hp}/${player.maxHp}`;
  const xpPct = player.xp / player.xpToNext;
  hudXpFillEl.style.width = `${(xpPct * 100).toFixed(1)}%`;
  hudXpValEl.textContent  = `${player.xp}/${player.xpToNext}`;
}

export function flashHit() {
  hitFlashEl.classList.add('active');
  setTimeout(() => hitFlashEl.classList.remove('active'), 180);
}

// ─────────────────────────────────────────────
// FLOATING DAMAGE NUMBERS
// ─────────────────────────────────────────────

export function spawnDamageNumber(worldPos, amount, isPlayerHit) {
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

export function createEntityHpBar() {
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

export function refreshEntityHpBar(entry) {
  if (!entry.hpBar || !entry.stats) return;
  const pct = Math.max(0, entry.stats.hp / entry.stats.maxHp);
  const fg  = entry.hpBar.userData.fg;
  fg.scale.x         = pct;
  fg.position.x      = HP_BAR_W * (pct - 1) / 2;
  fg.material.color.setHex(pct > 0.5 ? 0x22bb22 : pct > 0.25 ? 0xcccc00 : 0xcc2222);
}

export function updateHpBarTransforms() {
  for (const e of sprites.values()) {
    if (!e.hpBar || !e.mesh || e.aiState === 'dead') continue;
    const p = e.mesh.position;
    e.hpBar.position.set(p.x, SPRITE_WORLD_H + 0.28, p.z);
    e.hpBar.quaternion.copy(roomCamera.quaternion);
  }
}

// ─────────────────────────────────────────────
// HUD STATUS / JOB LIST
// ─────────────────────────────────────────────

export function updateHudPlayer() { hudPlayer.textContent = profileUsername || '—'; }

export function refreshHud() {
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

const JOB_BADGE = {
  queued:     'badge badge-dim',
  rendering:  'badge badge-hot',
  processing: 'badge badge-hot',
  done:       'badge badge-ok',
  failed:     'badge badge-blood',
};
const ANIM_BADGE = {
  done:    'badge badge-ok',
  failed:  'badge badge-blood',
  pending: 'badge badge-dim',
};

export function refreshJobList() {
  const active = [...sprites.values()].filter(e => !e.historical);
  if (active.length === 0) { jobsListEl.innerHTML = '<div class="muted">no jobs.</div>'; return; }
  const rows = [];
  for (const e of active) {
    let variantTags = '';
    if (e.variants) {
      for (const [vt, vj] of Object.entries(e.variants)) {
        const s = vj.status;
        const label = s === 'done' ? vt : s === 'failed' ? `${vt}!` : `${vt}…`;
        const cls = ANIM_BADGE[s === 'done' ? 'done' : s === 'failed' ? 'failed' : 'pending'];
        variantTags += `<span class="${cls}">${label}</span>`;
      }
    }
    const statusCls = JOB_BADGE[e.status] ?? 'badge badge-dim';
    rows.push(`<div class="job-row">
      <span class="job-id">${e.jobId}</span>
      <span class="job-prompt">${escapeHtml(e.prompt)}</span>
      ${variantTags}
      <span class="${statusCls}">${e.status}</span>
    </div>`);
  }
  jobsListEl.innerHTML = rows.join('');
}

// ─────────────────────────────────────────────
// LEVEL-UP NOTIFICATION
// ─────────────────────────────────────────────

export function showLevelUpNotification(from, to, hpGain, atkGain, defGain) {
  levelupSubEl.textContent = `${from} → ${to}  |  +${hpGain} HP  +${atkGain} ATK  +${defGain} DEF`;
  levelupEl.dataset.visible = 'true';
  setTimeout(() => { levelupEl.dataset.visible = 'false'; }, 2800);
}

// ─────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────

export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
