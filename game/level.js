import * as THREE from 'three';

// ── Constants ────────────────────────────────────────────────────────────────
export const TILE_SIZE = 20;
export const WALL_H    = 4.5;
export const DOOR_W    = 5;
export const DOOR_H    = 3.5;

// ── Module-level grid helpers ─────────────────────────────────────────────────
const DIRS = { n:[0,-1], s:[0,1], e:[1,0], w:[-1,0] };
const OPP  = { n:'s', s:'n', e:'w', w:'e' };

// ── Seeded PRNG (mulberry32) ──────────────────────────────────────────────────
function mkRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── generateLevel ─────────────────────────────────────────────────────────────
export function generateLevel(seed, roomCount = 18, gridSize = 12) {
  const rng = mkRng(seed >>> 0);

  const tileMap = new Map(); // key: 'x,y' → tile object
  const dirKeys = Object.keys(DIRS);

  const startX = gridSize / 2 | 0;
  const startY = gridSize / 2 | 0;

  const startTile = { x: startX, y: startY, type: 'start', connections: new Set() };
  tileMap.set(`${startX},${startY}`, startTile);

  let cursor = startTile;
  let placed = 1;
  let iters  = 0;

  while (placed < roomCount && iters < roomCount * 40) {
    iters++;
    const dir  = dirKeys[Math.floor(rng() * dirKeys.length)];
    const [dx, dy] = DIRS[dir];
    const nx = cursor.x + dx;
    const ny = cursor.y + dy;

    if (nx < 0 || ny < 0 || nx >= gridSize || ny >= gridSize) continue;

    const key = `${nx},${ny}`;
    let neighbor = tileMap.get(key);

    if (!neighbor) {
      neighbor = { x: nx, y: ny, type: 'room', connections: new Set() };
      tileMap.set(key, neighbor);
      placed++;
    }

    // Connect cursor ↔ neighbor
    cursor.connections.add(dir);
    neighbor.connections.add(OPP[dir]);

    cursor = neighbor;
  }

  // BFS from start to find furthest tile → mark as 'end'
  const visited  = new Map();
  const queue    = [startTile];
  visited.set(`${startX},${startY}`, 0);
  let furthestTile = startTile;
  let furthestDist = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    const dist    = visited.get(`${current.x},${current.y}`);

    if (dist > furthestDist) {
      furthestDist = dist;
      furthestTile = current;
    }

    for (const dir of current.connections) {
      const [dx, dy] = DIRS[dir];
      const nx = current.x + dx;
      const ny = current.y + dy;
      const nk = `${nx},${ny}`;
      if (!visited.has(nk) && tileMap.has(nk)) {
        visited.set(nk, dist + 1);
        queue.push(tileMap.get(nk));
      }
    }
  }

  if (furthestTile !== startTile) {
    furthestTile.type = 'end';
  }

  // Serialise — convert Sets to Arrays
  const tiles = [];
  for (const tile of tileMap.values()) {
    tiles.push({
      x: tile.x,
      y: tile.y,
      type: tile.type,
      connections: [...tile.connections],
    });
  }

  return {
    seed,
    gridSize,
    roomCount: placed,
    tiles,
    start: { x: startX, y: startY },
    end:   { x: furthestTile.x, y: furthestTile.y },
  };
}

// ── tileToWorld ───────────────────────────────────────────────────────────────
export function tileToWorld(tx, ty, level) {
  return {
    x: (tx - level.start.x) * TILE_SIZE,
    z: (ty - level.start.y) * TILE_SIZE,
  };
}

// ── isWalkable ────────────────────────────────────────────────────────────────
export function isWalkable(wx, wz, level, margin = 0.4) {
  const half = TILE_SIZE / 2 - margin;

  for (const tile of level.tiles) {
    const { x: cx, z: cz } = tileToWorld(tile.x, tile.y, level);

    // Room interior check
    if (wx > cx - half && wx < cx + half && wz > cz - half && wz < cz + half) {
      return true;
    }

    // Doorway strip check for each connection
    const dHalf     = DOOR_W / 2 - margin * 0.5;
    const stripHalf = 0.6;

    for (const dir of tile.connections) {
      const [dx, dy] = DIRS[dir];
      const wallCx = cx + dx * (TILE_SIZE / 2);
      const wallCz = cz + dy * (TILE_SIZE / 2);
      const isNS   = dir === 'n' || dir === 's';

      if (isNS) {
        if (Math.abs(wx - wallCx) < dHalf && Math.abs(wz - wallCz) < stripHalf) return true;
      } else {
        if (Math.abs(wz - wallCz) < dHalf && Math.abs(wx - wallCx) < stripHalf) return true;
      }
    }
  }

  return false;
}

// ── getSpawnPoints ────────────────────────────────────────────────────────────
export function getSpawnPoints(level) {
  const rng    = mkRng((level.seed * 7 + 13) >>> 0);
  const points = [];

  for (const tile of level.tiles) {
    if (tile.type === 'start') continue;

    const { x: cx, z: cz } = tileToWorld(tile.x, tile.y, level);
    const count = tile.type === 'end' ? 3 : 2;

    for (let i = 0; i < count; i++) {
      points.push({
        x:        cx + (rng() - 0.5) * (TILE_SIZE * 0.6),
        z:        cz + (rng() - 0.5) * (TILE_SIZE * 0.6),
        tileType: tile.type,
      });
    }
  }

  return points;
}

// ── buildLevelGeometry ────────────────────────────────────────────────────────
export function buildLevelGeometry(level) {
  const group = new THREE.Group();

  // Materials
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x3a2820, roughness: 0.9 });
  const ceilMat  = new THREE.MeshStandardMaterial({ color: 0x1a1208, roughness: 0.9 });
  const wallMat  = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.85 });
  const endFloor = new THREE.MeshStandardMaterial({ color: 0x201828, roughness: 0.9 });
  const endWall  = new THREE.MeshStandardMaterial({ color: 0x2a1c30, roughness: 0.85 });
  const startFlr = new THREE.MeshStandardMaterial({ color: 0x28201a, roughness: 0.9 });

  // Build lookup map
  const tileMap = new Map();
  for (const tile of level.tiles) {
    tileMap.set(`${tile.x},${tile.y}`, tile);
  }

  const WALL_ROT = { n: 0, s: Math.PI, e: -Math.PI / 2, w: Math.PI / 2 };

  for (const tile of level.tiles) {
    const { x: cx, z: cz } = tileToWorld(tile.x, tile.y, level);
    const wMat = tile.type === 'end' ? endWall : wallMat;
    const priority = tile.x * 1000 + tile.y;

    // Floor
    const fGeo  = new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE);
    const fMesh = new THREE.Mesh(fGeo, tile.type === 'start' ? startFlr : tile.type === 'end' ? endFloor : floorMat);
    fMesh.rotation.x = -Math.PI / 2;
    fMesh.position.set(cx, 0, cz);
    group.add(fMesh);

    // Ceiling
    const cGeo  = new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE);
    const cMesh = new THREE.Mesh(cGeo, ceilMat);
    cMesh.rotation.x = Math.PI / 2;
    cMesh.position.set(cx, WALL_H, cz);
    group.add(cMesh);

    // Walls
    for (const dir of ['n', 's', 'e', 'w']) {
      const [dx, dy] = DIRS[dir];
      const nx = tile.x + dx;
      const ny = tile.y + dy;
      const nk = `${nx},${ny}`;
      const neighbor = tileMap.get(nk);

      // Wall position
      let wallX, wallY, wallZ;
      wallY = WALL_H / 2;
      if (dir === 'n') { wallX = cx;               wallZ = cz - TILE_SIZE / 2; }
      else if (dir === 's') { wallX = cx;           wallZ = cz + TILE_SIZE / 2; }
      else if (dir === 'e') { wallX = cx + TILE_SIZE / 2; wallZ = cz; }
      else                  { wallX = cx - TILE_SIZE / 2; wallZ = cz; }

      const rotY = WALL_ROT[dir];

      if (!neighbor) {
        // Solid wall
        const geo  = new THREE.PlaneGeometry(TILE_SIZE, WALL_H);
        const mesh = new THREE.Mesh(geo, wMat);
        mesh.rotation.y = rotY;
        mesh.position.set(wallX, wallY, wallZ);
        group.add(mesh);
      } else {
        const nPriority  = nx * 1000 + ny;
        const isLower    = priority < nPriority;
        const connected  = tile.connections.includes(dir);

        if (connected) {
          // Doorway wall — only from lower-priority tile
          if (isLower) {
            const sw      = (TILE_SIZE - DOOR_W) / 2;
            const lo      = -(DOOR_W / 2 + sw / 2);
            const ro      =   DOOR_W / 2 + sw / 2;
            const lintelY = DOOR_H + (WALL_H - DOOR_H) / 2;
            const isNS    = dir === 'n' || dir === 's';

            const leftGeo   = new THREE.PlaneGeometry(sw, WALL_H);
            const rightGeo  = new THREE.PlaneGeometry(sw, WALL_H);
            const lintelGeo = new THREE.PlaneGeometry(DOOR_W, WALL_H - DOOR_H);

            const leftMesh   = new THREE.Mesh(leftGeo,   wMat);
            const rightMesh  = new THREE.Mesh(rightGeo,  wMat);
            const lintelMesh = new THREE.Mesh(lintelGeo, wMat);

            leftMesh.rotation.y   = rotY;
            rightMesh.rotation.y  = rotY;
            lintelMesh.rotation.y = rotY;

            if (isNS) {
              leftMesh.position.set(wallX + lo, wallY, wallZ);
              rightMesh.position.set(wallX + ro, wallY, wallZ);
            } else {
              leftMesh.position.set(wallX, wallY, wallZ + lo);
              rightMesh.position.set(wallX, wallY, wallZ + ro);
            }
            lintelMesh.position.set(wallX, lintelY, wallZ);

            group.add(leftMesh, rightMesh, lintelMesh);
          }
        } else {
          // Solid wall between unconnected neighbors — only from lower-priority tile
          if (isLower) {
            const geo  = new THREE.PlaneGeometry(TILE_SIZE, WALL_H);
            const mesh = new THREE.Mesh(geo, wMat);
            mesh.rotation.y = rotY;
            mesh.position.set(wallX, wallY, wallZ);
            group.add(mesh);
          }
        }
      }
    }
  }

  // End-room marker
  const endTile = level.tiles.find(t => t.type === 'end');
  if (endTile) {
    const { x: endCx, z: endCz } = tileToWorld(endTile.x, endTile.y, level);

    const pillarGeo  = new THREE.CylinderGeometry(0.15, 0.25, 3.0, 8);
    const pillarMat  = new THREE.MeshStandardMaterial({
      color: 0x9040ff,
      emissive: 0x6020cc,
      emissiveIntensity: 1.2,
    });
    const pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.set(endCx, 1.5, endCz);
    group.add(pillar);

    const exitLight = new THREE.PointLight(0x8030ff, 3.0, 8, 2.0);
    exitLight.position.set(endCx, 2.0, endCz);
    group.add(exitLight);

    group.userData.endWorldPos = { x: endCx, z: endCz };
  }

  return group;
}

// ── buildLevelLights ──────────────────────────────────────────────────────────
export function buildLevelLights(level) {
  const lights = [];

  for (const tile of level.tiles) {
    const { x: cx, z: cz } = tileToWorld(tile.x, tile.y, level);
    let light;

    if (tile.type === 'start') {
      light = new THREE.PointLight(0xff9040, 1.6, TILE_SIZE * 1.1, 1.8);
    } else if (tile.type === 'end') {
      light = new THREE.PointLight(0x8030ff, 2.4, TILE_SIZE * 1.2, 1.8);
    } else {
      light = new THREE.PointLight(0xff8030, 1.8, TILE_SIZE * 1.0, 1.8);
    }

    light.position.set(cx, 2.5, cz);
    lights.push(light);
  }

  return lights;
}
