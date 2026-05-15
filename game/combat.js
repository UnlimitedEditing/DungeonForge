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
  escapeHtml,
} from './hud.js';
import { icon } from './icons.js';

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

export function meleeAttack() {
  if (!controls.isLocked || appMode !== 'room') return;
  const now = performance.now() / 1000;
  if (now - lastPlayerAttack < livePlayerAttackCd) return;
  setLastPlayerAttack(now);

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

  gainXp(entry.stats?.xpReward ?? 0);

  // configurable drop chance
  if (entry.mesh && Math.random() < liveDropChance) {
    const pos = entry.mesh.position.clone();
    pos.y = 0;
    spawnItemDrop(pos, entry.stats?.level ?? 1);
  }
}

export function onPlayerDeath() {
  player.hp = 1;  // survive at 1 HP for now; full death screen is future work
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
  }
  player.inventory.splice(index, 1);
  savePlayerStats();
  updatePlayerHud();
  renderInventory();
}
