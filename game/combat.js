// =====================================================================
// combat.js — Combat, item drops, XP/levelling, inventory logic
// =====================================================================

import * as THREE from 'three';
import {
  player, sprites, worldItems, appMode,
  liveDropChance, liveDropPool, liveXpMult,
  liveLevelHpGain, liveLevelAtkGain, liveLevelDefGain,
  liveMeleeRange, livePlayerAttackCd,
  lastPlayerAttack, setLastPlayerAttack,
  pendingPickup, setPendingPickup,
  profileId,
  DROP_POOL, EQUIPMENT_SLOTS,
} from './state.js';
import { roomScene, roomCamera, controls } from './scene.js';
import {
  updatePlayerHud, flashHit, spawnDamageNumber,
  refreshEntityHpBar, pickupPromptEl, pickupItemNameEl,
  hitFlashEl, showLevelUpNotification,
  escapeHtml, addCombatLine,
} from './hud.js';
import { icon } from './icons.js';
import { propColliders } from './entity.js';
import { emit, EVENTS } from './events.js';

const FORGE_BASE   = window.location.origin;
const PICKUP_RANGE = 1.2;

const RARITY_PREFIXES = { 2: 'Fine', 3: 'Forged', 4: 'Enchanted', 5: 'Legendary' };

// ─────────────────────────────────────────────
// EQUIPMENT BONUS
// ─────────────────────────────────────────────

export function getEquipBonus(stat) {
  let total = 0;
  for (const item of Object.values(player.equipment)) {
    total += (item?.stats?.[stat] ?? 0);
  }
  return total;
}

// ─────────────────────────────────────────────
// COMBAT
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// MELEE VFX — swing arc + strike flash
// ─────────────────────────────────────────────

function _swingArc() {
  const origin = roomCamera.position.clone();
  origin.y = 0.5;

  const forward = new THREE.Vector3();
  roomCamera.getWorldDirection(forward);
  forward.y = 0;
  forward.normalize();

  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const range    = liveMeleeRange;
  const halfArc  = Math.PI * 0.42;   // ±76°
  const segments = 10;

  // Fan mesh (filled area)
  const verts = [origin.x, origin.y, origin.z];
  for (let i = 0; i <= segments; i++) {
    const a   = -halfArc + (i / segments) * halfArc * 2;
    const cos = Math.cos(a), sin = Math.sin(a);
    verts.push(
      origin.x + (forward.x * cos + right.x * sin) * range,
      origin.y,
      origin.z + (forward.z * cos + right.z * sin) * range,
    );
  }
  const indices = [];
  for (let i = 1; i <= segments; i++) indices.push(0, i, i + 1);

  const fanGeo = new THREE.BufferGeometry();
  fanGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  fanGeo.setIndex(indices);
  const fanMat = new THREE.MeshBasicMaterial({
    color: 0xffc04a, transparent: true, opacity: 0.22,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const fan = new THREE.Mesh(fanGeo, fanMat);
  roomScene.add(fan);

  // Arc outline
  const arcPts = [];
  for (let i = 0; i <= segments; i++) {
    const a   = -halfArc + (i / segments) * halfArc * 2;
    const cos = Math.cos(a), sin = Math.sin(a);
    arcPts.push(new THREE.Vector3(
      origin.x + (forward.x * cos + right.x * sin) * range,
      origin.y,
      origin.z + (forward.z * cos + right.z * sin) * range,
    ));
  }
  const arcGeo = new THREE.BufferGeometry().setFromPoints(arcPts);
  const arcMat = new THREE.LineBasicMaterial({ color: 0xffc04a, transparent: true, opacity: 0.9 });
  const arc    = new THREE.Line(arcGeo, arcMat);
  roomScene.add(arc);

  // Fade out over 220 ms
  const t0 = performance.now();
  function fade() {
    const p = (performance.now() - t0) / 220;
    if (p >= 1) {
      roomScene.remove(fan, arc);
      fanGeo.dispose(); fanMat.dispose();
      arcGeo.dispose(); arcMat.dispose();
      return;
    }
    const q = 1 - p;
    fanMat.opacity = 0.22 * q;
    arcMat.opacity = 0.9  * q;
    requestAnimationFrame(fade);
  }
  requestAnimationFrame(fade);
}

function _strikeFlash(worldPos) {
  // Point light burst
  const light = new THREE.PointLight(0xffc04a, 5.0, 2.8, 2.0);
  light.position.set(worldPos.x, 1.1, worldPos.z);
  roomScene.add(light);

  // Flying sparks
  const sparks = [];
  for (let i = 0; i < 7; i++) {
    const sGeo = new THREE.SphereGeometry(0.045, 4, 4);
    const sMat = new THREE.MeshBasicMaterial({ color: 0xffc04a, transparent: true });
    const s    = new THREE.Mesh(sGeo, sMat);
    const ang  = (i / 7) * Math.PI * 2;
    s.position.set(worldPos.x + Math.cos(ang) * 0.15, 0.9 + Math.random() * 0.3, worldPos.z + Math.sin(ang) * 0.15);
    s.userData.vel = new THREE.Vector3(Math.cos(ang) * 2.5, 1.5 + Math.random() * 2, Math.sin(ang) * 2.5);
    roomScene.add(s);
    sparks.push({ mesh: s, geo: sGeo, mat: sMat });
  }

  const t0 = performance.now();
  let prev = t0;
  function animate() {
    const now  = performance.now();
    const dt   = (now - prev) / 1000;
    prev = now;
    const prog = (now - t0) / 300;
    if (prog >= 1) {
      roomScene.remove(light);
      for (const s of sparks) { roomScene.remove(s.mesh); s.geo.dispose(); s.mat.dispose(); }
      return;
    }
    light.intensity = 5 * (1 - prog);
    for (const s of sparks) {
      s.mesh.position.addScaledVector(s.mesh.userData.vel, dt);
      s.mesh.userData.vel.y -= 6 * dt;
      s.mat.opacity = 1 - prog;
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
}

export function meleeAttack() {
  if (!controls.isLocked || appMode !== 'room') return;
  const now = performance.now() / 1000;
  if (now - lastPlayerAttack < livePlayerAttackCd) return;
  setLastPlayerAttack(now);

  _swingArc();   // always show the swing visual

  const playerPos = roomCamera.position;
  let nearest = null, nearestDist = liveMeleeRange;

  for (const e of sprites.values()) {
    if (e.status !== 'done' || !e.mesh || e.mesh.userData.isPlaceholder) continue;
    if (e.aiState === 'dead' || e.aiState === 'destroyed' || !e.stats) continue;
    const d = playerPos.distanceTo(e.mesh.position);
    if (d < nearestDist) { nearest = e; nearestDist = d; }
  }

  if (!nearest) return;

  const atk  = player.attack + getEquipBonus('attack');
  const dmg  = Math.max(1, atk - nearest.stats.defense + Math.floor(Math.random() * 7 - 3));
  _strikeFlash(nearest.mesh.position);
  addCombatLine(`you strike ${(nearest.prompt || 'enemy').toLowerCase().slice(0, 24)} for ${dmg}`, 'dealt');
  damageEntity(nearest, dmg);
}

export function killEntity(entry) {
  entry.aiState = 'dead';
  entry.roam    = null;

  // Lay flat on the floor
  entry.mesh.rotation.set(-Math.PI / 2, 0, 0);
  entry.mesh.position.y = 0.02;

  // Swap to corpse sprite if available; otherwise tint red
  const corpseVar = entry.variants?.corpse;
  if (corpseVar?.status === 'done' && corpseVar.spriteName) {
    const textureLoader = new THREE.TextureLoader();
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

  addCombatLine(`${(entry.prompt || 'enemy').toLowerCase().slice(0, 24)} falls`, 'lore');
  gainXp(entry.stats?.xpReward ?? 0);

  if (entry.isBoss) {
    emit(EVENTS.BOSS_DIED, { entityId: entry.jobId, prompt: entry.prompt });
  }

  // configurable drop chance
  if (entry.mesh && (entry.isBoss || Math.random() < liveDropChance)) {
    const pos = entry.mesh.position.clone();
    pos.y = 0;
    spawnItemDrop(pos, entry.stats?.level ?? 1);
  }
}

function destroyProp(entry) {
  entry.aiState = 'destroyed';
  propColliders.delete(entry);
  // Particle burst
  const pos = entry.mesh.position.clone();
  _strikeFlash(pos);  // reuse strike flash for visual feedback
  // Fade out mesh
  entry.mesh.material.transparent = true;
  const t0 = performance.now();
  (function fade() {
    const p = (performance.now() - t0) / 600;
    if (p >= 1) { roomScene.remove(entry.mesh); return; }
    entry.mesh.material.opacity = 1 - p;
    requestAnimationFrame(fade);
  })();
  if (entry.hpBar) { roomScene.remove(entry.hpBar); entry.hpBar = null; }
  if (entry.shadowBlob) { roomScene.remove(entry.shadowBlob); entry.shadowBlob = null; }
  addCombatLine(`${(entry.prompt || 'prop').slice(0, 24)} destroyed`, 'lore');
}

export function damageEntity(entry, dmg) {
  if (!entry.stats || entry.aiState === 'destroyed' || entry.aiState === 'dead') return;
  entry.stats.hp = Math.max(0, entry.stats.hp - dmg);
  if (entry.jobType === 'prop') {
    if (entry.stats.hp <= 0) destroyProp(entry);
    return;
  }
  entry.flinchUntil = performance.now() / 1000 + 0.18;
  entry.flinchRot   = (Math.random() - 0.5) * 0.3;
  spawnDamageNumber(entry.mesh.position, dmg, false);
  refreshEntityHpBar(entry);
  if (entry.stats.hp <= 0) killEntity(entry);
}

export function onPlayerDeath() {
  player.hp = 1;  // survive at 1 HP for now; full death screen is future work
  addCombatLine('you are brought low — barely surviving', 'taken');
  updatePlayerHud();
  // Simple feedback — flash stays red longer
  hitFlashEl.classList.add('active');
  setTimeout(() => hitFlashEl.classList.remove('active'), 600);
}

// ─────────────────────────────────────────────
// XP + LEVELLING
// ─────────────────────────────────────────────

export function gainXp(amount) {
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
  showLevelUpNotification(prev, player.level, liveLevelHpGain, liveLevelAtkGain, liveLevelDefGain);
  updatePlayerHud();
}

// ─────────────────────────────────────────────
// WORLD ITEM DROPS
// ─────────────────────────────────────────────

export function spawnItemDrop(position, entityLevel) {
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

export function updateWorldItems(t) {
  const playerPos = roomCamera.position;
  setPendingPickup(null);
  let nearestDist = PICKUP_RANGE;

  for (const [, drop] of worldItems) {
    // Bob + spin
    drop.mesh.position.y = 0.22 + Math.sin(t * 2.4 + drop.spawnT) * 0.07;
    drop.mesh.rotation.y += 0.018;
    drop.glow.position.copy(drop.mesh.position);

    if (!controls.isLocked) continue;
    const d = playerPos.distanceTo(drop.mesh.position);
    if (d < nearestDist) { setPendingPickup(drop); nearestDist = d; }
  }

  // Re-read pendingPickup after possible mutation above
  const _pickup = pendingPickup;
  if (_pickup && appMode === 'room') {
    pickupPromptEl.dataset.visible = 'true';
    pickupItemNameEl.textContent   = _pickup.item.name.toUpperCase();
  } else {
    pickupPromptEl.dataset.visible = 'false';
  }
}

export function pickupItem() {
  const _pickup = pendingPickup;
  if (!_pickup) return;
  const { item, mesh, glow } = _pickup;

  // Find the id stored in the Map key
  let mapKey = null;
  for (const [k, v] of worldItems) { if (v === _pickup) { mapKey = k; break; } }
  if (!mapKey) return;

  roomScene.remove(mesh, glow);
  worldItems.delete(mapKey);
  setPendingPickup(null);
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
// PLAYER STATS PERSISTENCE
// ─────────────────────────────────────────────

export async function savePlayerStats() {
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
// INVENTORY PANEL
// ─────────────────────────────────────────────

export const inventoryPanelEl = document.getElementById('inventory-panel');
const invStatsDisplay  = document.getElementById('inv-stats-display');
const equipmentSlotsEl = document.getElementById('equipment-slots');
const inventoryGridEl  = document.getElementById('inventory-grid');
const invDetailEl      = document.getElementById('inv-detail');

document.getElementById('inventory-close-btn').addEventListener('click', closeInventory);

// ─────────────────────────────────────────────
// ITEM TYPE → ICON NAME
// ─────────────────────────────────────────────

const ITEM_ICON = {
  weapon:     'sword',
  armor:      'shield',
  accessory:  'gem',
  consumable: 'potion',
  potion:     'potion',
  scroll:     'scroll',
  key:        'key',
  currency:   'coin',
  mat:        'spark',
};

const RARITY_COLOR = {
  legendary: 'var(--legendary)',
  rare:      'var(--rare)',
  uncommon:  'var(--uncommon)',
  common:    'var(--common)',
};

// ─────────────────────────────────────────────
// ITEM DETAIL PANEL
// ─────────────────────────────────────────────

function renderItemDetail(item, bagIndex) {
  if (!invDetailEl) return;
  if (!item) {
    invDetailEl.innerHTML = `
      <div class="card-label">// SELECT ITEM</div>
      <div class="inv-detail-empty">click an item to inspect</div>`;
    return;
  }

  const ico       = ITEM_ICON[item.subtype] ?? ITEM_ICON[item.type] ?? 'gem';
  const rColor    = RARITY_COLOR[item.rarity ?? 'common'] ?? 'var(--amber-dim)';
  const statHtml  = item.stats
    ? Object.entries(item.stats)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k.replace('_', ' ')} <span style="color:var(--amber)">+${v}</span>`)
        .join(' &nbsp;·&nbsp; ')
    : '';

  const hasBagIdx = typeof bagIndex === 'number';
  const canEquip  = hasBagIdx && ['weapon', 'armor', 'accessory'].includes(item.type);
  const canUse    = hasBagIdx && item.type === 'consumable';

  invDetailEl.innerHTML = `
    <div class="card-label">// SELECTED</div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:10px">
      <div class="inv-detail-icon-cell" style="color:${rColor}">${icon(ico, 22)}</div>
      <div style="min-width:0">
        <div class="inv-detail-badge" style="color:${rColor}">${item.rarity ?? 'common'} · ${item.subtype || item.type}</div>
        <div class="inv-detail-name">${escapeHtml(item.name)}</div>
      </div>
    </div>
    ${statHtml ? `<div class="inv-detail-stats">${statHtml}</div>` : ''}
    <div class="inv-detail-actions">
      ${canEquip ? `<button class="btn-ghost" id="idb-equip">EQUIP</button>` : ''}
      ${canUse   ? `<button class="btn-quiet" id="idb-use">USE</button>` : ''}
      ${hasBagIdx ? `<button class="btn-danger" id="idb-drop">DROP</button>` : ''}
    </div>`;

  if (canEquip)  document.getElementById('idb-equip').addEventListener('click', () => { equipFromBag(bagIndex); renderItemDetail(null); });
  if (canUse)    document.getElementById('idb-use').addEventListener('click',   () => { useConsumable(bagIndex); renderItemDetail(null); });
  if (hasBagIdx) document.getElementById('idb-drop').addEventListener('click',  () => {
    player.inventory.splice(bagIndex, 1);
    savePlayerStats();
    renderInventory();
    renderItemDetail(null);
  });
}

export function openInventory() {
  inventoryPanelEl.dataset.open = 'true';
  if (controls.isLocked) controls.unlock();
  renderItemDetail(null);
  renderInventory();
}

export function closeInventory() {
  inventoryPanelEl.dataset.open = 'false';
}

export function renderInventory() {
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
  renderItemDetail(item, index);
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
    addCombatLine(`consumed ${escapeHtml(item.name)} · +${item.stats.hp_restore} HP`, 'heal');
  }
  player.inventory.splice(index, 1);
  savePlayerStats();
  updatePlayerHud();
  renderInventory();
}

// =====================================================================
// PROJECTILE SYSTEM
// =====================================================================

const PROJ_SPEED    = 14;
const PROJ_MAX_DIST = 20;
const PROJ_COOLDOWN = 0.55;   // seconds between shots
const PROJ_DAMAGE   = 12;
const MAX_DECALS    = 24;

const _projectiles = [];
const _decals      = [];
let   _lastShot    = 0;

// ─── Damage decal (floor splat where projectile lands) ────────────────

function _spawnDecal(pos, isBlood = false) {
  const size = 0.18 + Math.random() * 0.14;
  const geo  = new THREE.CircleGeometry(size, 8);
  const mat  = new THREE.MeshBasicMaterial({
    color: isBlood ? 0x5a0a0a : 0x8a5a10,
    transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(pos.x, 0.012, pos.z);
  roomScene.add(mesh);
  _decals.push({ mesh, geo, mat, born: performance.now() / 1000 });

  if (_decals.length > MAX_DECALS) {
    const old = _decals.shift();
    roomScene.remove(old.mesh);
    old.geo.dispose(); old.mat.dispose();
  }
}

// ─── Projectile impact flash ──────────────────────────────────────────

function _projImpact(pos, hitEntity) {
  const col   = hitEntity ? 0xff6633 : 0xffc04a;
  const light = new THREE.PointLight(col, 4.0, 2.5, 2.0);
  light.position.set(pos.x, Math.max(pos.y, 0.5), pos.z);
  roomScene.add(light);
  const t0 = performance.now();
  (function fade() {
    const p = (performance.now() - t0) / 200;
    if (p >= 1) { roomScene.remove(light); return; }
    light.intensity = 4 * (1 - p);
    requestAnimationFrame(fade);
  })();
  _spawnDecal(pos, !!hitEntity);
}

// ─── Fire a projectile ────────────────────────────────────────────────

export function fireProjectile() {
  if (!controls.isLocked || appMode !== 'room') return;
  const now = performance.now() / 1000;
  if (now - _lastShot < PROJ_COOLDOWN) return;
  _lastShot = now;

  const origin = roomCamera.position.clone();
  const dir    = new THREE.Vector3();
  roomCamera.getWorldDirection(dir);

  // Start slightly in front of camera at eye height
  origin.addScaledVector(dir, 0.4);
  origin.y = Math.max(0.6, roomCamera.position.y - 0.1);

  const geo  = new THREE.SphereGeometry(0.07, 6, 4);
  const mat  = new THREE.MeshBasicMaterial({ color: 0xffc04a });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(origin);

  const glow = new THREE.PointLight(0xffc04a, 1.8, 1.8, 2.0);
  glow.position.copy(origin);

  roomScene.add(mesh, glow);
  _projectiles.push({ mesh, glow, geo, mat, dir: dir.clone(), traveled: 0 });
}

// ─── Per-frame projectile update (call from main loop) ───────────────

export function updateProjectiles(dt) {
  for (let i = _projectiles.length - 1; i >= 0; i--) {
    const p    = _projectiles[i];
    const move = PROJ_SPEED * dt;
    p.mesh.position.addScaledVector(p.dir, move);
    p.glow.position.copy(p.mesh.position);
    p.traveled += move;

    let remove = false;

    // Entity collision (sphere test, radius 0.55)
    for (const e of sprites.values()) {
      if (!e.mesh || e.aiState === 'dead' || e.aiState === 'destroyed' || !e.stats) continue;
      if (e.mesh.userData.isPlaceholder) continue;
      if (p.mesh.position.distanceTo(e.mesh.position) < 0.55) {
        const def = e.stats.defense ?? 0;
        const dmg = Math.max(1, PROJ_DAMAGE + (player.attack >> 1) - def + Math.floor(Math.random() * 5));
        addCombatLine(`bolt hits ${(e.prompt || 'enemy').toLowerCase().slice(0, 22)} for ${dmg}`, 'dealt');
        _projImpact(p.mesh.position.clone(), true);
        damageEntity(e, dmg);
        remove = true;
        break;
      }
    }

    // Max range — spawn wall decal at last position
    if (!remove && p.traveled >= PROJ_MAX_DIST) {
      _projImpact(p.mesh.position.clone(), false);
      remove = true;
    }

    if (remove) {
      roomScene.remove(p.mesh, p.glow);
      p.geo.dispose(); p.mat.dispose();
      _projectiles.splice(i, 1);
    }
  }
}

// ─── Decal fade (call from main loop) ────────────────────────────────

export function updateDecals(t) {
  const FADE_START = 10, FADE_DUR = 5;
  for (const d of _decals) {
    const age = t - d.born;
    if (age > FADE_START) {
      d.mat.opacity = 0.55 * Math.max(0, 1 - (age - FADE_START) / FADE_DUR);
    }
  }
}

// ─── Cleanup on returning to forge ───────────────────────────────────

export function clearProjectilesAndDecals() {
  for (const p of _projectiles) {
    roomScene.remove(p.mesh, p.glow);
    p.geo.dispose(); p.mat.dispose();
  }
  _projectiles.length = 0;
  for (const d of _decals) {
    roomScene.remove(d.mesh);
    d.geo.dispose(); d.mat.dispose();
  }
  _decals.length = 0;
}
