// =====================================================================
// interaction.js — Proximity detection and interaction menu for
// friendly / neutral NPCs.
//
// Each frame, tickInteraction() scans all entities for non-hostile units
// within INTERACT_RANGE. When one is found, an "E — INTERACT" prompt
// appears. Pressing E opens a radial menu (CHAT / TRADE / QUEST).
// Selecting CHAT hands off to dialogue.js; TRADE and QUEST are stubbed
// with informational messages until those systems are built.
// =====================================================================

import { sprites, player } from './state.js';
import { emit, on } from './events.js';
import { EVENTS } from './events.js';
import { startDialogue } from './dialogue.js';

const INTERACT_RANGE = 2.5;   // world units

const _promptEl   = document.getElementById('interact-prompt');
const _menuEl     = document.getElementById('interaction-menu');
const _menuNameEl = document.getElementById('interact-menu-name');
const _menuStubEl = document.getElementById('interact-menu-stub');

let _nearestFriendly = null;
let _menuOpen        = false;
let _dialogueActive  = false;

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────

export function initInteraction() {
  window.addEventListener('keydown', _onKey);

  _menuEl?.querySelectorAll('.interact-option-btn').forEach(btn => {
    btn.addEventListener('click', () => _chooseAction(btn.dataset.action));
  });

  on(EVENTS.DIALOGUE_START, () => { _dialogueActive = true; });
  on(EVENTS.DIALOGUE_END,   () => { _dialogueActive = false; });
}

// Called every frame from main.js tick loop (after updateEntities).
export function tickInteraction() {
  if (_menuOpen || _dialogueActive) return;

  const px = player.position?.x ?? 0;
  const pz = player.position?.z ?? 0;

  let nearest = null;
  let nearestDist = INTERACT_RANGE;

  for (const e of sprites.values()) {
    if (e.status !== 'done') continue;
    if (!e.disposition || e.disposition === 'hostile') continue;
    if (e.aiState === 'dead' || e.aiState === 'destroyed') continue;

    const dx   = e.position.x - px;
    const dz   = e.position.z - pz;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < nearestDist) { nearestDist = dist; nearest = e; }
  }

  _nearestFriendly = nearest;

  if (_promptEl) _promptEl.dataset.visible = nearest ? 'true' : 'false';
}

export function closeInteractionMenu() {
  if (!_menuOpen) return;
  _menuOpen = false;
  if (_menuEl)     _menuEl.dataset.open = 'false';
  if (_menuStubEl) _menuStubEl.style.display = 'none';
  emit(EVENTS.INTERACTION_END, {});
}

// ─────────────────────────────────────────────
// PRIVATE
// ─────────────────────────────────────────────

function _onKey(e) {
  if (e.code === 'KeyE' && _nearestFriendly && !_menuOpen && !_dialogueActive) {
    _openMenu(_nearestFriendly);
    return;
  }
  if (e.code === 'Escape' && _menuOpen) {
    closeInteractionMenu();
  }
}

function _openMenu(entity) {
  _menuOpen = true;
  if (_menuNameEl) _menuNameEl.textContent = _displayName(entity);
  if (_menuStubEl) _menuStubEl.style.display = 'none';
  if (_menuEl)     _menuEl.dataset.open = 'true';
  emit(EVENTS.INTERACTION_START, { entity });
}

function _chooseAction(action) {
  if (!_nearestFriendly) { closeInteractionMenu(); return; }
  const entity = _nearestFriendly;

  if (action === 'chat') {
    closeInteractionMenu();
    startDialogue(entity, 'greeting');
    return;
  }

  // TRADE and QUEST are scaffolded — show a stub message
  if (_menuStubEl) {
    _menuStubEl.textContent = action === 'trade'
      ? '[ TRADE ] — coming in a future update.'
      : '[ QUEST ] — no active quests.';
    _menuStubEl.style.display = '';
  }
}

function _displayName(entity) {
  const raw = entity.prompt ?? 'Stranger';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}
