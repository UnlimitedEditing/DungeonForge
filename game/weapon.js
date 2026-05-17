// =====================================================================
// weapon.js — Weapon HUD: 2D overlay sprite + attack animations.
//
// The weapon is a PNG plane fixed to the bottom-right of the viewport,
// angled to look held. On attack, a CSS animation sweeps it across the
// screen. Attack types drive which animation plays:
//   "slash"  — broad arc from rest inward and back
//   "stab"   — forward thrust toward centre and snap back
// =====================================================================

const FORGE_BASE = window.location.origin;

const hudEl    = document.getElementById('weapon-hud');
const imgEl    = document.getElementById('weapon-img');

// Currently equipped weapon type metadata.
let _weaponType = null;
let _animLocked = false;

export function initWeapon() {
  hudEl.dataset.visible = 'false';
}

// Show a weapon type's sprite in the HUD.
// wt: weapon type object from GET /weapon-types, or null to hide.
export function setWeaponType(wt) {
  _weaponType = wt;
  if (!wt) {
    hudEl.dataset.visible = 'false';
    return;
  }
  if (wt.sprite_name) {
    imgEl.src = `${FORGE_BASE}/sprites/${wt.sprite_name}`;
    imgEl.style.display = '';
    hudEl.dataset.placeholder = 'false';
  } else {
    imgEl.src = '';
    imgEl.style.display = 'none';
    hudEl.dataset.placeholder = 'true';
  }
  hudEl.dataset.visible = 'true';
}

// Refresh the sprite URL for the currently held weapon type
// (called after a weapon render job completes).
export function refreshWeaponSprite(spriteName) {
  if (!_weaponType) return;
  _weaponType.sprite_name = spriteName;
  imgEl.src = `${FORGE_BASE}/sprites/${spriteName}`;
  imgEl.style.display = '';
  hudEl.dataset.placeholder = 'false';
}

// Play the attack animation appropriate for the current weapon type.
// Can be called from combat.js on every melee swing.
export function triggerWeaponAttack() {
  if (_animLocked || !hudEl || hudEl.dataset.visible !== 'true') return;
  const attackType = _weaponType?.attack_type ?? 'slash';
  _animLocked = true;
  hudEl.dataset.attacking = attackType;
  hudEl.addEventListener('animationend', _onAnimEnd, { once: true });
}

function _onAnimEnd() {
  delete hudEl.dataset.attacking;
  _animLocked = false;
}

export function showWeapon() { hudEl.dataset.visible = 'true'; }
export function hideWeapon() { hudEl.dataset.visible = 'false'; }

export function getWeaponType() { return _weaponType; }
