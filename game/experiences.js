// ── Default experiences ───────────────────────────────────────────────────────
export const DEFAULT_EXPERIENCES = [
  {
    id:          'latentcrawl',
    name:        'LatentCrawl',
    description: 'Roguelike dungeon crawler. Fight your way through procedurally generated halls to reach the exit. How deep can you go?',
    version:     '0.1.0',
    baseId:      null,
    author:      'system',
    locked:      true,
    mode:        'roguelike',
    level: {
      seed:      42,
      roomCount: 18,
      gridSize:  12,
      tileset:   'dungeon-stone',
    },
    world: {
      skyboxPrompt: 'underground cavern ancient dungeon atmospheric dark fantasy',
      ambientColor: '0x3a2818',
      fogColor:     '0x000000',
      fogNear:      6,
      fogFar:       25,
    },
    entities: {
      enemiesPerRoom: 2,
      bossRoom:       true,
      spawnPool:      [],
    },
    rules: {
      playerSpeed:   4.5,
      playerHp:      100,
      friendlyFire:  false,
    },
    lore: {
      title:       'The Dungeon Beneath',
      description: 'Ancient halls, forgotten horrors.',
    },
  },
];

// ── fetchExperiences ──────────────────────────────────────────────────────────
export async function fetchExperiences(base) {
  try {
    const res = await fetch(`${base}/experiences`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    return DEFAULT_EXPERIENCES;
  }
}

// ── fetchExperience ───────────────────────────────────────────────────────────
export async function fetchExperience(base, id) {
  const res = await fetch(`${base}/experiences/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── createFork ────────────────────────────────────────────────────────────────
export async function createFork(base, exp) {
  const body = {
    ...exp,
    id:     crypto.randomUUID(),
    baseId: exp.id,
    locked: false,
    author: 'player',
  };
  const res = await fetch(`${base}/experiences`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── saveExperience ────────────────────────────────────────────────────────────
export async function saveExperience(base, exp) {
  const res = await fetch(`${base}/experiences/${exp.id}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(exp),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── encodeShareCode ───────────────────────────────────────────────────────────
export function encodeShareCode(exp) {
  return 'EXP:' + btoa(JSON.stringify(exp));
}

// ── decodeShareCode ───────────────────────────────────────────────────────────
export function decodeShareCode(code) {
  if (!code.startsWith('EXP:')) throw new Error('Invalid share code');
  return JSON.parse(atob(code.slice(4)));
}

// ── importFromCode ────────────────────────────────────────────────────────────
export async function importFromCode(base, code) {
  const decoded = decodeShareCode(code);
  const body = {
    ...decoded,
    id:     crypto.randomUUID(),
    baseId: decoded.id,
    locked: false,
    author: 'player',
  };
  const res = await fetch(`${base}/experiences`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
