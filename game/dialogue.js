// =====================================================================
// dialogue.js — NPC dialogue camera, panel, and LLM inference.
//
// Flow:
//   startDialogue(entity, topic)
//     → unlock PointerLockControls
//     → tween roomCamera toward NPC sprite
//     → show dialogue panel + hide HUD
//     → POST /npc-dialogue to get opening speech + forked choices
//   Player clicks a choice
//     → append to history, POST /npc-dialogue again
//     → if action='farewell' → endDialogue()
//   endDialogue()
//     → hide panel, restore HUD
//     → tween camera back to saved position
//
// NPC state (flags, relationship score) is kept in-memory per session.
// Flags gate optional dialogue options; mood_delta adjusts relationship.
// =====================================================================

import * as THREE from 'three';
import { roomCamera, controls } from './scene.js';
import { profileId, activeExperience } from './state.js';
import { emit } from './events.js';
import { EVENTS } from './events.js';

const FORGE_BASE = window.location.origin;
const TWEEN_SPEED = 2.5;   // world units per second
const DIALOGUE_DIST = 1.4; // camera target: this many units in front of NPC

// ── Camera tween state ───────────────────────
let _tweening       = false;
let _tweenT         = 0;
let _tweenFrom      = new THREE.Vector3();
let _tweenFromQuat  = new THREE.Quaternion();
let _tweenTo        = new THREE.Vector3();
let _tweenToQuat    = new THREE.Quaternion();
let _tweenDone      = null;

// Saved camera transform for restoration
let _savedPos  = null;
let _savedQuat = null;

// ── Dialogue state ───────────────────────────
let _activeEntity = null;
let _history      = [];
let _loading      = false;

// Per-NPC state: npcKey → { flags: Set<string>, relationship: number }
const _npcState = {};

// ── DOM ──────────────────────────────────────
const _panelEl    = document.getElementById('dialogue-panel');
const _portraitEl = document.getElementById('dialogue-portrait');
const _nameEl     = document.getElementById('dialogue-npc-name');
const _speechEl   = document.getElementById('dialogue-speech');
const _choicesEl  = document.getElementById('dialogue-choices');
const _statusEl   = document.getElementById('dialogue-status');
const _closeBtn   = document.getElementById('dialogue-close-btn');
const _hudEl      = document.getElementById('hud');

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────

export function initDialogue() {
  _closeBtn?.addEventListener('click', endDialogue);

  window.addEventListener('keydown', e => {
    if (e.code === 'Escape' && _panelEl?.dataset.open === 'true') {
      e.stopImmediatePropagation();
      endDialogue();
    }
  });
}

export function startDialogue(entity, topic = 'greeting') {
  if (_activeEntity) endDialogue();
  _activeEntity = entity;
  _history      = [];

  controls.unlock();

  _setPortrait(entity);
  if (_nameEl) _nameEl.textContent = _displayName(entity);

  emit(EVENTS.DIALOGUE_START, { entity });

  _tweenCameraTo(entity, () => {
    if (_panelEl) _panelEl.dataset.open = 'true';
    if (_hudEl)   _hudEl.style.visibility = 'hidden';
    _fetchDialogue(topic, null);
  });
}

export function endDialogue() {
  if (!_activeEntity) return;
  const entity = _activeEntity;
  _activeEntity = null;
  _history      = [];
  _loading      = false;

  if (_panelEl) _panelEl.dataset.open = 'false';
  if (_hudEl)   _hudEl.style.visibility = '';

  emit(EVENTS.DIALOGUE_END, { entity });
  _tweenCameraBack();
}

// Called every frame from main.js tick loop.
export function tickDialogue(dt) {
  if (!_tweening) return;

  _tweenT = Math.min(1, _tweenT + dt * TWEEN_SPEED);
  const t = _easeInOut(_tweenT);

  roomCamera.position.lerpVectors(_tweenFrom, _tweenTo, t);
  roomCamera.quaternion.slerpQuaternions(_tweenFromQuat, _tweenToQuat, t);

  if (_tweenT >= 1) {
    _tweening = false;
    const cb = _tweenDone;
    _tweenDone = null;
    cb?.();
  }
}

// ─────────────────────────────────────────────
// CAMERA TWEEN
// ─────────────────────────────────────────────

function _tweenCameraTo(entity, onDone) {
  _savedPos  = roomCamera.position.clone();
  _savedQuat = roomCamera.quaternion.clone();

  const ePos = entity.position.clone();

  // Direction from entity toward player (so camera ends up in front of NPC)
  const dir = new THREE.Vector3()
    .subVectors(roomCamera.position, ePos)
    .setY(0)
    .normalize();

  const target = ePos.clone()
    .addScaledVector(dir, DIALOGUE_DIST)
    .setY(1.0);  // eye height

  // Compute look-at quaternion toward entity centre
  const lookAt = ePos.clone().setY(1.0);
  const dummy  = new THREE.Object3D();
  dummy.position.copy(target);
  dummy.lookAt(lookAt);

  _tweenFrom.copy(_savedPos);
  _tweenFromQuat.copy(_savedQuat);
  _tweenTo.copy(target);
  _tweenToQuat.copy(dummy.quaternion);
  _tweenT    = 0;
  _tweening  = true;
  _tweenDone = onDone;
}

function _tweenCameraBack() {
  if (!_savedPos) return;

  _tweenFrom.copy(roomCamera.position);
  _tweenFromQuat.copy(roomCamera.quaternion);
  _tweenTo.copy(_savedPos);
  _tweenToQuat.copy(_savedQuat);
  _tweenT    = 0;
  _tweening  = true;
  _tweenDone = null;

  _savedPos  = null;
  _savedQuat = null;
}

// ─────────────────────────────────────────────
// LLM DIALOGUE FETCH
// ─────────────────────────────────────────────

async function _fetchDialogue(topic, playerChoiceText) {
  if (!_activeEntity || _loading) return;
  _loading = true;
  _setStatus('…');
  if (_choicesEl) _choicesEl.innerHTML = '';

  const entity  = _activeEntity;
  const npcKey  = entity.npcId ?? entity.prompt ?? 'unknown';
  const state   = _getState(npcKey);

  try {
    const flags = Object.fromEntries(
      [...state.flags].map(f => [f, true])
    );
    flags.__relationship__ = state.relationship;

    const res = await fetch(`${FORGE_BASE}/npc-dialogue`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        npc_id:        npcKey,
        entity_prompt: entity.prompt ?? '',
        topic,
        history:       _history.slice(-8),
        player_flags:  flags,
        world_state: {
          experience_name: activeExperience?.name,
          dungeon_name:    activeExperience?.lore?.title,
        },
        profile_id: profileId,
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Append to history
    if (playerChoiceText) _history.push({ role: 'player', text: playerChoiceText });
    if (data.speech)      _history.push({ role: 'npc',    text: data.speech });

    // Apply flags and relationship delta
    if (Array.isArray(data.flags_set)) {
      for (const flag of data.flags_set) {
        state.flags.add(flag);
        emit(EVENTS.NPC_FLAG_SET, { npcId: npcKey, flag });
      }
    }
    if (data.mood_delta) {
      state.relationship = Math.max(0, Math.min(100,
        state.relationship + (data.mood_delta ?? 0)));
      emit(EVENTS.NPC_RELATIONSHIP, { npcId: npcKey, relationship: state.relationship });
    }

    _renderDialogue(data, npcKey, state);
  } catch (err) {
    _setStatus(`error: ${err.message}`);
    // Ensure there's always a way out
    _renderFallback();
  } finally {
    _loading = false;
    _setStatus('');
  }
}

// ─────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────

function _renderDialogue(data, npcKey, state) {
  if (_speechEl) _speechEl.textContent = data.speech ?? '';
  if (!_choicesEl) return;

  _choicesEl.innerHTML = '';
  const options = Array.isArray(data.options) ? data.options : [];
  let hasExit = false;

  for (const opt of options) {
    if (opt.requires_flag && !state.flags.has(opt.requires_flag)) continue;
    if (opt.action === 'farewell') hasExit = true;

    const btn = document.createElement('button');
    btn.className = 'dialogue-choice-btn';
    btn.textContent = `> ${opt.text}`;
    btn.addEventListener('click', () => {
      if (_loading) return;
      emit(EVENTS.DIALOGUE_CHOICE, { npcId: npcKey, choice: opt });
      if (opt.action === 'farewell') {
        endDialogue();
      } else {
        _fetchDialogue(opt.action ?? 'chat', opt.text);
      }
    });
    _choicesEl.appendChild(btn);
  }

  // Always guarantee an exit
  if (!hasExit) {
    const bye = document.createElement('button');
    bye.className = 'dialogue-choice-btn dialogue-choice-exit';
    bye.textContent = '> Farewell.';
    bye.addEventListener('click', endDialogue);
    _choicesEl.appendChild(bye);
  }
}

function _renderFallback() {
  if (!_choicesEl) return;
  _choicesEl.innerHTML = '';
  const btn = document.createElement('button');
  btn.className = 'dialogue-choice-btn dialogue-choice-exit';
  btn.textContent = '> Farewell.';
  btn.addEventListener('click', endDialogue);
  _choicesEl.appendChild(btn);
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function _getState(npcKey) {
  if (!_npcState[npcKey]) _npcState[npcKey] = { flags: new Set(), relationship: 50 };
  return _npcState[npcKey];
}

function _setPortrait(entity) {
  if (!_portraitEl) return;
  if (entity.spriteSrc) {
    _portraitEl.src = entity.spriteSrc;
    _portraitEl.style.display = '';
  } else {
    _portraitEl.style.display = 'none';
  }
}

function _setStatus(msg) {
  if (_statusEl) _statusEl.textContent = msg;
}

function _displayName(entity) {
  const raw = entity.prompt ?? 'Stranger';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function _easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}
