// =====================================================================
// hud.js — HUD and visual feedback functions
// =====================================================================

import * as THREE from 'three';
import { player, sprites, appMode, profileUsername } from './state.js';
import { roomScene, roomCamera, controls } from './scene.js';
import { icon } from './icons.js';

const SPRITE_WORLD_H = 2.2;  // world-space height used for all sprites
const HP_BAR_W = 0.85;
const HP_BAR_H = 0.07;

// ─────────────────────────────────────────────
// PLAYER HUD ELEMENTS
// ─────────────────────────────────────────────

const statsHudEl         = document.getElementById('stats-hud');
const hudLevelEl         = document.getElementById('hud-level');
const hudPlayerNameEl    = document.getElementById('hud-playername');
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

// Target frame
const targetFrameEl = document.getElementById('target-frame');
const tfNameEl      = document.getElementById('tf-name');
const tfBadgeEl     = document.getElementById('tf-badge');
const tfHpFillEl    = document.getElementById('tf-hp-fill');
const tfHpValEl     = document.getElementById('tf-hp-val');
const tfIconEl      = document.getElementById('tf-icon');

// Combat feed
const combatFeedEl    = document.getElementById('combat-feed');
const combatLinesEl   = document.getElementById('combat-feed-lines');
const ACTION_BAR_EL   = document.getElementById('action-bar');
const MAX_FEED_LINES  = 6;

// Export statsHudEl so main.js can set data-visible
export { statsHudEl, hitFlashEl };

// ─────────────────────────────────────────────
// PLAYER HUD UPDATE
// ─────────────────────────────────────────────

export function updatePlayerHud() {
  hudLevelEl.textContent = player.level;
  if (hudPlayerNameEl) hudPlayerNameEl.textContent = profileUsername || '—';
  const hpPct = player.hp / player.maxHp;
  hudHpFillEl.style.width = `${(hpPct * 100).toFixed(1)}%`;
  // HP bar colour handled by .bar-fill.hp; tint red when low
  if (hpPct <= 0.25) {
    hudHpFillEl.style.background = '#cc2222';
  } else if (hpPct <= 0.5) {
    hudHpFillEl.style.background = '#cccc22';
  } else {
    hudHpFillEl.style.background = '';   // fallback to CSS .bar-fill.hp
  }
  hudHpValEl.textContent  = `${player.hp}/${player.maxHp}`;
  const xpPct = player.xp / player.xpToNext;
  hudXpFillEl.style.width = `${(xpPct * 100).toFixed(1)}%`;
  hudXpValEl.textContent  = `${player.xp}/${player.xpToNext}`;
}

// ─────────────────────────────────────────────
// TARGET FRAME
// ─────────────────────────────────────────────

export function updateTargetFrame(entity) {
  if (!targetFrameEl) return;
  if (!entity || entity.aiState === 'dead') {
    targetFrameEl.dataset.visible = 'false';
    return;
  }
  const name  = (entity.prompt || 'UNKNOWN').toUpperCase().slice(0, 32);
  const level = entity.stats?.level ?? 1;
  const hp    = entity.stats?.hp    ?? 0;
  const maxHp = entity.stats?.maxHp ?? 1;
  const pct   = Math.max(0, hp / maxHp);

  tfIconEl.innerHTML         = icon('skull', 13);
  tfNameEl.textContent       = name;
  tfBadgeEl.textContent      = `LV ${level}`;
  tfHpFillEl.style.width     = `${(pct * 100).toFixed(1)}%`;
  tfHpValEl.textContent      = `${hp}/${maxHp}`;
  targetFrameEl.dataset.visible = 'true';
}

// ─────────────────────────────────────────────
// COMBAT FEED
// ─────────────────────────────────────────────

export function addCombatLine(text, type = 'dealt') {
  if (!combatLinesEl) return;
  const el = document.createElement('div');
  el.className = `cf-line cf-${type}`;
  el.textContent = text;
  combatLinesEl.prepend(el);
  // Keep max lines
  while (combatLinesEl.children.length > MAX_FEED_LINES) {
    combatLinesEl.lastChild?.remove();
  }
}

// ─────────────────────────────────────────────
// ACTION BAR INIT
// ─────────────────────────────────────────────

export function initActionBar() {
  const slots = {
    'ab-q-icon':   icon('sword',  22),
    'ab-e-icon':   icon('bow',    22),
    'ab-f-icon':   icon('gem',    22),
    'ab-i-icon':   icon('bag',    22),
    'ab-esc-icon': icon('portal', 22),
  };
  for (const [id, svg] of Object.entries(slots)) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = svg;
  }
}

export function setHudInWorld(visible) {
  const v = visible ? 'true' : 'false';
  if (statsHudEl)    statsHudEl.dataset.visible    = v;
  if (ACTION_BAR_EL) ACTION_BAR_EL.dataset.visible = v;
  if (combatFeedEl)  combatFeedEl.dataset.visible  = v;
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
