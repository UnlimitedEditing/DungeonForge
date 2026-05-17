// spawn-manager.js — Dungeon theme inference and automatic entity population.
import * as THREE from 'three';
import { spawnFromPrompt, spawnFromExistingSprite } from './entity.js';
import { spriteCache, activeExperience, profileId, currentLevel } from './state.js';
import { EVENTS } from './events.js';
import { on, emit } from './events.js';
import { tileToWorld } from './level.js';

const FORGE_BASE = window.location.origin;

const TIER_DESCRIPTORS = {
  1: ['scrawny', 'mangy', 'hunched', 'bedraggled'],
  2: ['wiry', 'scarred', 'feral'],
  3: ['muscular', 'armored', 'battle-hardened'],
  4: ['imposing', 'heavily armored', 'fierce'],
  5: ['massive', 'terrifying', 'ornate', 'legendary'],
};

let _currentTheme   = null;
let _spawnDensity   = 0.4;

export function getTheme()             { return _currentTheme; }
export function setSpawnDensity(v)     { _spawnDensity = v; }

export function initSpawnManager() {
  on(EVENTS.LEVEL_LOADED, ({ seed }) => _spawnLevel(seed));
}

async function _spawnLevel(seed) {
  if (!activeExperience?.id || !profileId) return;
  _currentTheme = null;

  const theme = await _fetchTheme(seed);
  if (!theme) {
    console.warn('[spawn-manager] no dungeon theme — skipping auto-spawn');
    return;
  }
  _currentTheme = theme;
  emit(EVENTS.DUNGEON_THEME_READY, theme);
  await _populate(theme, currentLevel);
}

async function _fetchTheme(seed) {
  try {
    const res = await fetch(`${FORGE_BASE}/dungeon-theme`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Profile-Id': profileId },
      body:    JSON.stringify({ seed, experience_id: activeExperience.id }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error('[spawn-manager] theme fetch failed:', e);
    return null;
  }
}

function _bfsDistances(level) {
  const DIRS    = { n: [0,-1], s: [0,1], e: [1,0], w: [-1,0] };
  const tileMap = new Map(level.tiles.map(t => [`${t.x},${t.y}`, t]));
  const start   = level.tiles.find(t => t.type === 'start');
  if (!start) return new Map();

  const dist  = new Map();
  const queue = [start];
  dist.set(`${start.x},${start.y}`, 0);

  while (queue.length) {
    const tile = queue.shift();
    const d    = dist.get(`${tile.x},${tile.y}`);
    for (const dir of (tile.connections ?? [])) {
      const [dx, dy] = DIRS[dir] ?? [0, 0];
      const key = `${tile.x + dx},${tile.y + dy}`;
      if (!dist.has(key) && tileMap.has(key)) {
        dist.set(key, d + 1);
        queue.push(tileMap.get(key));
      }
    }
  }
  return dist;
}

function _pickDescriptor(tier) {
  const opts = TIER_DESCRIPTORS[tier] ?? TIER_DESCRIPTORS[3];
  return opts[Math.floor(Math.random() * opts.length)];
}

async function _spawnCreature(description, options) {
  if (spriteCache.has(description)) {
    spawnFromExistingSprite(description, options);
  } else {
    await spawnFromPrompt(description, 'entity', options);
  }
}

async function _populate(theme, level) {
  if (!level) return;

  const distMap = _bfsDistances(level);
  const maxDist = distMap.size ? Math.max(...distMap.values()) : 1;

  const startTile = level.tiles.find(t => t.type === 'start');
  const endTile   = level.tiles.find(t => t.type === 'end');

  // Collect all planned spawns grouped by description to render each unique type once
  const spawnPlan = [];   // [{description, tier, isBoss, position}]
  const seen      = new Set();

  for (const tile of level.tiles) {
    if (tile === startTile) continue;

    const { x: wx, z: wz } = tileToWorld(tile.x, tile.y, level);
    const position = new THREE.Vector3(wx, 0, wz);

    if (tile === endTile) {
      spawnPlan.push({ description: theme.boss?.name ?? 'dungeon guardian', tier: 5, isBoss: true, position });
      continue;
    }

    if (Math.random() > _spawnDensity) continue;

    const dist = distMap.get(`${tile.x},${tile.y}`) ?? 1;
    const tier = Math.max(1, Math.min(4, Math.ceil((dist / Math.max(maxDist, 1)) * 4)));

    const candidates = (theme.creatures ?? []).filter(c => Math.abs((c.tier ?? 1) - tier) <= 1);
    if (!candidates.length) continue;

    const creature = candidates[Math.floor(Math.random() * candidates.length)];
    const description = `${_pickDescriptor(tier)} ${creature.name}`;
    spawnPlan.push({ description, tier, isBoss: false, position });
  }

  // Render one instance of each unique description; reuse for duplicates
  for (const plan of spawnPlan) {
    if (!seen.has(plan.description)) {
      seen.add(plan.description);
      await _spawnCreature(plan.description, { tier: plan.tier, isBoss: plan.isBoss, position: plan.position });
      // Stagger unique renders to avoid overwhelming the queue
      if (!spriteCache.has(plan.description)) {
        await new Promise(r => setTimeout(r, 400));
      }
    } else {
      // Duplicate — reuse cache or fall back to a new render if cache not ready
      await _spawnCreature(plan.description, { tier: plan.tier, isBoss: plan.isBoss, position: plan.position });
    }
  }
}
