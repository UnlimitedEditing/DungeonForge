// =====================================================================
// entity.js — Entity spawning, poll loop, roaming AI, walk animation
// =====================================================================

import * as THREE from 'three';
import {
  sprites, currentLevel, profileId,
  liveAgroRange, liveAttackRange, liveEntityAttackCd,
  player,
} from './state.js';
import { renderer, roomScene, roomCamera, brazier, controls } from './scene.js';
import {
  createEntityHpBar, refreshEntityHpBar, updateHpBarTransforms,
  refreshJobList, spawnDamageNumber, flashHit, updatePlayerHud,
  addCombatLine,
} from './hud.js';
import { getEquipBonus, onPlayerDeath, killEntity } from './combat.js';
import { getActivePromptModifier, getStatTier } from './lore-engine.js';
import { isWalkable, TILE_SIZE } from './level.js';

const FORGE_BASE = window.location.origin;

const ROAM_SPEED_MIN = 0.7;
const ROAM_SPEED_MAX = 1.3;
const ROAM_ARRIVE_D  = 0.25;
const ROAM_PAUSE_MIN = 1.0;
const ROAM_PAUSE_MAX = 3.0;
const ROAM_BOUND     = 20 / 2 - 1.8;  // ROOM_SIZE / 2 - 1.8

const WALK_STEP_DIST = 0.6;  // world units of movement per walk-cycle frame advance
const SPRITE_WORLD_H = 2.2;  // world-space height used for all sprites
const POLL_MS        = 3000;

const VARIANT_TYPES = ['corpse', 'damage', 'back'];

export { VARIANT_TYPES };

export const propColliders = new Set();
// Each entry: { entry, radius, mesh (the sprite mesh for position) }

export const textureLoader = new THREE.TextureLoader();

// ─────────────────────────────────────────────
// SPAWN RING
// ─────────────────────────────────────────────

const SPAWN_RING = [
  [ 0, -4], [ 3, -3], [ 4,  0], [ 3,  3],
  [ 0,  4], [-3,  3], [-4,  0], [-3, -3],
];
let spawnIndex = 0;

function nextSpawn() {
  const [x, z] = SPAWN_RING[spawnIndex % SPAWN_RING.length];
  spawnIndex++;
  return new THREE.Vector3(x, 0, z);
}

function randomRoamTarget(originX = 0, originZ = 0) {
  if (currentLevel) {
    const spread = TILE_SIZE * 0.45;
    for (let attempt = 0; attempt < 8; attempt++) {
      const tx = originX + (Math.random() * 2 - 1) * spread;
      const tz = originZ + (Math.random() * 2 - 1) * spread;
      if (isWalkable(tx, tz, currentLevel)) return new THREE.Vector3(tx, 0, tz);
    }
    return new THREE.Vector3(originX, 0, originZ);
  }
  return new THREE.Vector3(
    (Math.random() * 2 - 1) * ROAM_BOUND,
    0,
    (Math.random() * 2 - 1) * ROAM_BOUND,
  );
}

// ─────────────────────────────────────────────
// PLACEHOLDER
// ─────────────────────────────────────────────

function makePlaceholder(position) {
  const mat  = new THREE.MeshBasicMaterial({ color: 0xd99a2b, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.2), mat);
  mesh.position.copy(position); mesh.position.y = 1.1;
  mesh.userData.isPlaceholder = true;
  mesh.userData.spawnTime     = performance.now();
  roomScene.add(mesh);
  return mesh;
}

// ─────────────────────────────────────────────
// SPRITE CREATION
// ─────────────────────────────────────────────

function makeSprite(spriteName, position, onReady) {
  textureLoader.load(`${FORGE_BASE}/sprites/${spriteName}`, (tex) => {
    tex.magFilter  = THREE.NearestFilter;
    tex.minFilter  = THREE.LinearMipmapLinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const mat    = new THREE.MeshStandardMaterial({
      map: tex, transparent: true, alphaTest: 0.15, depthWrite: true,
      roughness: 1, metalness: 0, side: THREE.DoubleSide,
    });
    const h      = SPRITE_WORLD_H;
    const aspect = tex.image.width / tex.image.height;
    const mesh   = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.scale.set(h * aspect, h, 1);
    mesh.position.copy(position);
    mesh.position.y = h / 2;
    onReady(mesh, h / 2, tex, `${FORGE_BASE}/sprites/${spriteName}`);
  }, undefined, (err) => console.error('texture load failed', err));
}

function createShadowBlob() {
  const geo  = new THREE.CircleGeometry(0.44, 12);
  const mat  = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false });
  const blob = new THREE.Mesh(geo, mat);
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.016;
  roomScene.add(blob);
  return blob;
}

// ─────────────────────────────────────────────
// WALK SHEET
// ─────────────────────────────────────────────

export function loadWalkSheet(spriteName, frameCount, variantType, entry) {
  const url = `${FORGE_BASE}/sprites/${spriteName}`;
  textureLoader.load(url, (tex) => {
    tex.magFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(1 / frameCount, 1);
    tex.offset.set(0, 0);

    const frameAspect = (tex.image.width / frameCount) / tex.image.height;
    const mat = new THREE.MeshStandardMaterial({
      map: tex, transparent: true, alphaTest: 0.15, depthWrite: true,
      roughness: 1, metalness: 0, side: THREE.DoubleSide,
    });
    const sheet = { mat, tex, frameCount, frameAspect };

    if (variantType === 'walk') entry.walkSheet = sheet;
    if (variantType === 'back') entry.backSheet = sheet;
  }, undefined, (err) => console.error('walk sheet load failed', err));
}

// ─────────────────────────────────────────────
// ROTATION SHEET (props)
// ─────────────────────────────────────────────

export function loadRotationSheet(spriteName, frameCount, entry) {
  const url = `${FORGE_BASE}/sprites/${spriteName}`;
  textureLoader.load(url, (tex) => {
    tex.magFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(1 / frameCount, 1);
    tex.offset.set(0, 0);
    const frameAspect = (tex.image.width / frameCount) / tex.image.height;
    const mat = new THREE.MeshStandardMaterial({
      map: tex, transparent: true, alphaTest: 0.15, depthWrite: true,
      roughness: 1, metalness: 0, side: THREE.DoubleSide,
    });
    entry.rotationSheet    = { mat, tex, frameCount, frameAspect };
    entry.rotationFrameMap = null;  // populated by calibration if used
  }, undefined, (err) => console.error('rotation sheet load failed', err));
}

export async function pollRotationJob(rotJobId, entry) {
  while (true) {
    await new Promise(r => setTimeout(r, POLL_MS));
    let rj;
    try {
      const res = await fetch(`${FORGE_BASE}/rotation-jobs/${rotJobId}`);
      if (!res.ok) throw new Error(res.status);
      rj = await res.json();
    } catch (e) { console.warn('rotation poll error', rotJobId, e); continue; }
    if (rj.status === 'done' && rj.sprite_name) {
      loadRotationSheet(rj.sprite_name, rj.frame_count, entry);
      if (rj.frame_map?.length) entry.rotationFrameMap = rj.frame_map;
      return;
    }
    if (rj.status === 'failed') return;
  }
}

export function removePropCollider(entry) {
  propColliders.delete(entry);
}

export function initPropStats(entry, hp) {
  entry.stats = { hp, maxHp: hp, attack: 0, defense: 0, xpReward: 0, level: 1 };
  entry.aiState = 'static';
}

// ─────────────────────────────────────────────
// SPAWNING
// ─────────────────────────────────────────────

// termStatus reference — provided by main.js via setter
let _termStatus = null;
export function setTermStatus(el) { _termStatus = el; }

export async function spawnFromPrompt(promptText, jobType = 'entity') {
  if (!promptText || !profileId) return;
  let job;
  try {
    const spawnBody = {
      prompt:          promptText,
      profile_id:      profileId,
      prompt_modifier: getActivePromptModifier() || undefined,
      stat_tier:       getStatTier(promptText),
      job_type:        jobType,   // explicit, overrides server config
    };
    const res = await fetch(`${FORGE_BASE}/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spawnBody),
    });
    if (!res.ok) throw new Error(`forge returned ${res.status}`);
    job = await res.json();
  } catch (e) {
    console.error('spawn failed', e);
    if (_termStatus) _termStatus.textContent = 'link: ERROR';
    return;
  }

  const position    = nextSpawn();
  const placeholder = makePlaceholder(position);
  sprites.set(job.id, { jobId: job.id, status: job.status, mesh: placeholder, position, prompt: promptText, floorY: 1.1, roam: null });
  refreshJobList();
  pollJob(job.id);
}

export async function pollJob(jobId) {
  while (true) {
    await new Promise(r => setTimeout(r, POLL_MS));
    let job;
    try {
      const res = await fetch(`${FORGE_BASE}/jobs/${jobId}`);
      if (!res.ok) throw new Error(res.status);
      job = await res.json();
    } catch (e) { console.warn('poll error', jobId, e); continue; }
    const entry = sprites.get(jobId);
    if (!entry) return;
    entry.status = job.status;
    refreshJobList();
    if (job.status === 'done') {
      if (job.job_type === 'prop') {
        // ── PROP: static object, no AI, angle-aware rotation sheet ──
        entry.jobType = 'prop';
        entry.aiState = 'static';
        makeSprite(job.sprite_name, entry.position, (sprite, floorY, tex, src) => {
          roomScene.remove(entry.mesh);
          entry.mesh.material?.dispose(); entry.mesh.geometry?.dispose();
          roomScene.add(sprite);
          entry.mesh       = sprite;
          entry.floorY     = floorY;
          entry.frontMat   = sprite.material;
          entry.spriteSrc  = src;
          entry.shadowBlob = createShadowBlob();
          // Register a collision cylinder at the prop's base
          const radius = (SPRITE_WORLD_H * (entry.frontAspect ?? 1)) * 0.35;
          entry.colliderRadius = radius;
          propColliders.add(entry);
        });
        // Poll for WAN rotation sheet
        const rotJobId = job.variant_job_ids?.rotation;
        if (rotJobId) pollRotationJob(rotJobId, entry);
      } else {
        // ── CHARACTER: combat AI, walk variants ──
        if (job.entity_stats) {
          entry.stats = {
            hp:        job.entity_stats.hp,
            maxHp:     job.entity_stats.max_hp,
            attack:    job.entity_stats.attack,
            defense:   job.entity_stats.defense,
            xpReward:  job.entity_stats.xp_reward,
            level:     job.entity_stats.level,
          };
          entry.aiState        = 'roam';
          entry.lastAttackTime = 0;
        }
        makeSprite(job.sprite_name, entry.position, (sprite, floorY, tex, src) => {
          roomScene.remove(entry.mesh);
          entry.mesh.material?.dispose(); entry.mesh.geometry?.dispose();
          roomScene.add(sprite);
          entry.mesh        = sprite;
          entry.floorY      = floorY;
          entry.roam        = initRoam();
          entry.frontTex    = tex;
          entry.frontAspect = tex.image.width / tex.image.height;
          entry.frontMat    = sprite.material;
          entry.spriteSrc   = src;
          entry.shadowBlob  = createShadowBlob();
          if (entry.stats) {
            entry.hpBar = createEntityHpBar();
            refreshEntityHpBar(entry);
          }
        });
        if (job.variant_job_ids && Object.keys(job.variant_job_ids).length) {
          if (!entry.variants) entry.variants = {};
          for (const [vtype, vid] of Object.entries(job.variant_job_ids)) {
            entry.variants[vtype] = { jobId: vid, status: 'queued', spriteName: null };
            pollVariantJob(vid, vtype, entry);
          }
        }
      }
      return;
    }
    if (job.status === 'failed') {
      entry.mesh.material.color.set(0x8b1a1a); entry.mesh.material.opacity = 0.5; return;
    }
  }
}

// ─────────────────────────────────────────────
// VARIANT JOB POLLING
// ─────────────────────────────────────────────

// entitiesPanelEl reference — provided by hub-panels via setter
let _entitiesPanelEl = null;
let _renderEntitiesFn = null;
export function setEntitiesPanelRef(el, renderFn) {
  _entitiesPanelEl = el;
  _renderEntitiesFn = renderFn;
}

export async function pollVariantJob(varJobId, variantType, entry) {
  while (true) {
    await new Promise(r => setTimeout(r, POLL_MS));
    let vj;
    try {
      const res = await fetch(`${FORGE_BASE}/variant-jobs/${varJobId}`);
      if (!res.ok) throw new Error(res.status);
      vj = await res.json();
    } catch (e) { console.warn('variant poll error', e); continue; }

    if (!entry.variants) entry.variants = {};
    entry.variants[variantType] = { jobId: varJobId, status: vj.status, spriteName: vj.sprite_name, frameCount: vj.frame_count ?? 1 };

    refreshJobList();
    if (_entitiesPanelEl?.dataset.open === 'true' && _renderEntitiesFn) _renderEntitiesFn();

    if (vj.status === 'done' && vj.sprite_name) {
      const frameCount = vj.frame_count ?? 1;
      if ((variantType === 'walk' || variantType === 'back') && frameCount > 1) {
        loadWalkSheet(vj.sprite_name, frameCount, variantType, entry);
      }
      return;
    }
    if (vj.status === 'failed') return;
  }
}

// ─────────────────────────────────────────────
// JOB HISTORY
// ─────────────────────────────────────────────

export async function loadJobHistory() {
  try {
    const res = await fetch(`${FORGE_BASE}/jobs`);
    if (!res.ok) return;
    const jobs = await res.json();
    const variantFetches = [];
    for (const job of jobs) {
      if (job.status !== 'done' || sprites.has(job.id)) continue;
      const isProp = job.job_type === 'prop';
      sprites.set(job.id, {
        jobId: job.id, status: 'done', prompt: job.prompt,
        mesh: null, position: null, floorY: null, roam: null,
        jobType:  isProp ? 'prop' : 'entity',
        aiState:  isProp ? 'static' : null,
        spriteSrc: job.sprite_name ? `${FORGE_BASE}/sprites/${job.sprite_name}` : null,
        variants: {}, historical: true,
      });
      for (const [vtype, vid] of Object.entries(job.variant_job_ids ?? {})) {
        variantFetches.push({ jobId: job.id, vtype, vid, isProp });
      }
    }
    // Load variant/rotation metadata in parallel
    await Promise.all(variantFetches.map(async ({ jobId, vtype, vid, isProp }) => {
      const entry = sprites.get(jobId);
      if (!entry) return;
      try {
        if (vtype === 'rotation') {
          // Prop rotation sheets live at /rotation-jobs/, not /variant-jobs/
          const rres = await fetch(`${FORGE_BASE}/rotation-jobs/${vid}`);
          if (!rres.ok) return;
          const rj = await rres.json();
          if (rj.status === 'done' && rj.sprite_name) {
            loadRotationSheet(rj.sprite_name, rj.frame_count, entry);
            if (rj.frame_map?.length) entry.rotationFrameMap = rj.frame_map;
          } else if (rj.status !== 'failed') {
            // Still in progress — keep polling
            pollRotationJob(vid, entry);
          }
        } else {
          const vres = await fetch(`${FORGE_BASE}/variant-jobs/${vid}`);
          if (!vres.ok) return;
          const vj = await vres.json();
          entry.variants[vtype] = { jobId: vid, status: vj.status, spriteName: vj.sprite_name, frameCount: vj.frame_count ?? 1 };
          if (vj.status === 'done' && vj.sprite_name && (vtype === 'walk' || vtype === 'back') && (vj.frame_count ?? 1) > 1) {
            loadWalkSheet(vj.sprite_name, vj.frame_count, vtype, entry);
          }
        }
      } catch { /* silently skip broken variant */ }
    }));
    refreshJobList();
  } catch (e) { console.warn('history load failed', e); }
}

// ─────────────────────────────────────────────
// ENTITY AI + ANIMATION
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// ENTITY ATTACK PARTICLE BURST
// ─────────────────────────────────────────────

function _entityAttackParticles(fromPos, toPos) {
  const dir = new THREE.Vector3().subVectors(toPos, fromPos).normalize();
  const sparks = [];
  for (let i = 0; i < 7; i++) {
    const sGeo = new THREE.SphereGeometry(0.04, 3, 3);
    const sMat = new THREE.MeshBasicMaterial({ color: 0xcc3311, transparent: true });
    const s    = new THREE.Mesh(sGeo, sMat);
    s.position.set(
      fromPos.x + (Math.random() - 0.5) * 0.2,
      fromPos.y + 0.9 + Math.random() * 0.3,
      fromPos.z + (Math.random() - 0.5) * 0.2,
    );
    const spread = (Math.random() - 0.5) * 1.4;
    s.userData.vel = new THREE.Vector3(
      dir.x * 3.5 + spread,
      0.8 + Math.random() * 1.2,
      dir.z * 3.5 + spread,
    );
    roomScene.add(s);
    sparks.push({ mesh: s, geo: sGeo, mat: sMat });
  }
  const t0 = performance.now();
  let prev = t0;
  (function animate() {
    const now2 = performance.now();
    const fdt  = (now2 - prev) / 1000;
    prev = now2;
    const prog = (now2 - t0) / 380;
    if (prog >= 1) {
      for (const s of sparks) { roomScene.remove(s.mesh); s.geo.dispose(); s.mat.dispose(); }
      return;
    }
    for (const s of sparks) {
      s.mesh.position.addScaledVector(s.mesh.userData.vel, fdt);
      s.mesh.userData.vel.y -= 5 * fdt;
      s.mat.opacity = 1 - prog;
    }
    requestAnimationFrame(animate);
  })();
}

export function initRoam() {
  return { target: randomRoamTarget(), waitUntil: 0, speed: ROAM_SPEED_MIN + Math.random() * (ROAM_SPEED_MAX - ROAM_SPEED_MIN) };
}

export function updateEntities(dt) {
  const now       = performance.now() / 1000;
  const playerPos = roomCamera.position;
  const _camFwd   = new THREE.Vector3();

  for (const e of sprites.values()) {
    if (e.status !== 'done' || !e.mesh || e.mesh.userData.isPlaceholder) continue;
    if (e.aiState === 'dead') continue;

    // ── PROP: static object, angle-aware frame selection ─────────────
    if (e.jobType === 'prop') {
      // Bearing from prop toward player → select rotation sheet frame
      if (e.rotationSheet) {
        const rs  = e.rotationSheet;
        const dx  = playerPos.x - e.mesh.position.x;
        const dz  = playerPos.z - e.mesh.position.z;
        const raw = Math.atan2(dx, dz);                      // -π … π
        const t   = (((raw / (Math.PI * 2)) % 1) + 1) % 1;  // 0 … 1
        const fi  = Math.floor(t * rs.frameCount) % rs.frameCount;
        const mappedFi = e.rotationFrameMap?.length
          ? (e.rotationFrameMap[fi] ?? fi)
          : fi;
        rs.tex.offset.x = mappedFi / rs.frameCount;
        if (e.mesh.material !== rs.mat) {
          e.mesh.material = rs.mat;
          e.mesh.scale.x  = SPRITE_WORLD_H * rs.frameAspect;
        }
      }
      // Billboard (y-axis only, same as characters)
      const pdx = roomCamera.position.x - e.mesh.position.x;
      const pdz = roomCamera.position.z - e.mesh.position.z;
      e.mesh.rotation.y = Math.atan2(pdx, pdz);
      // Shadow blob
      if (e.shadowBlob) {
        const sx = e.mesh.position.x - brazier.position.x;
        const sz = e.mesh.position.z - brazier.position.z;
        const sd = Math.sqrt(sx * sx + sz * sz);
        const nx = sd > 0.01 ? sx / sd : 0;
        const nz = sd > 0.01 ? sz / sd : 1;
        e.shadowBlob.position.set(e.mesh.position.x + nx * 0.3, 0.016, e.mesh.position.z + nz * 0.3);
        e.shadowBlob.material.opacity = Math.max(0.04, 0.5 * (1 - sd / 13));
      }
      continue;  // props skip all AI / animation logic below
    }

    let moving = false;
    let dirX = 0, dirZ = 0;

    // ── AI STATE MACHINE ──────────────────────
    if (e.stats) {
      const distToPlayer = playerPos.distanceTo(e.mesh.position);

      if (e.aiState !== 'agro' && distToPlayer < liveAgroRange) {
        e.aiState = 'agro';
      } else if (e.aiState === 'agro' && distToPlayer > liveAgroRange * 1.6) {
        e.aiState = 'roam';
        if (!e.roam) e.roam = initRoam();
      }

      if (e.aiState === 'agro') {
        const dx   = playerPos.x - e.mesh.position.x;
        const dz   = playerPos.z - e.mesh.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist > liveAttackRange) {
          // Chase
          const spd = e.roam?.speed ?? ROAM_SPEED_MAX;
          dirX = dx / dist; dirZ = dz / dist;
          e.mesh.position.x += dirX * spd * 1.3 * dt;
          e.mesh.position.z += dirZ * spd * 1.3 * dt;
          e.mesh.position.y  = e.floorY;
          moving = true;
        } else {
          // Attack player
          if (now - (e.lastAttackTime ?? 0) >= liveEntityAttackCd) {
            e.lastAttackTime = now;
            const def = player.defense + getEquipBonus('defense');
            const dmg = Math.max(1, e.stats.attack - def + Math.floor(Math.random() * 7 - 3));
            player.hp = Math.max(0, player.hp - dmg);
            spawnDamageNumber(playerPos, dmg, true);
            flashHit();
            updatePlayerHud();
            _entityAttackParticles(e.mesh.position, playerPos);
            addCombatLine(`${(e.prompt || 'enemy').toLowerCase().slice(0, 22)} hits you for ${dmg}`, 'taken');
            if (player.hp <= 0) onPlayerDeath();
          }
        }
      }
    }

    // ── ROAMING (for roam state, or entities with no stats) ──
    if (!e.stats || e.aiState === 'roam') {
      if (!e.roam) continue;
      if (now >= e.roam.waitUntil) {
        const pos  = e.mesh.position;
        const dx   = e.roam.target.x - pos.x;
        const dz   = e.roam.target.z - pos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < ROAM_ARRIVE_D) {
          e.roam.waitUntil = now + ROAM_PAUSE_MIN + Math.random() * (ROAM_PAUSE_MAX - ROAM_PAUSE_MIN);
          e.roam.target    = randomRoamTarget(pos.x, pos.z);
        } else {
          dirX = dx / dist; dirZ = dz / dist;
          pos.x += dirX * e.roam.speed * dt;
          pos.z += dirZ * e.roam.speed * dt;
          pos.y  = e.floorY;
          moving = true;
        }
      }
    }

    // ── SPRITE SHEET ANIMATION ────────────────
    let movingAway = false;
    if (moving && (e.walkSheet || e.backSheet)) {
      roomCamera.getWorldDirection(_camFwd);
      movingAway = (dirX * _camFwd.x + dirZ * _camFwd.z) > 0.25;
    }

    const sheet = moving
      ? ((movingAway && e.backSheet) ? e.backSheet : (e.walkSheet ?? null))
      : null;

    if (sheet) {
      if (e.mesh.material !== sheet.mat) {
        e.mesh.material = sheet.mat;
        e.mesh.scale.x  = SPRITE_WORLD_H * sheet.frameAspect;
      }
      const speed = e.roam?.speed ?? ROAM_SPEED_MIN;
      e.walkFrameTimer = (e.walkFrameTimer ?? 0) + speed * dt;
      const frameIdx = Math.floor(e.walkFrameTimer / WALK_STEP_DIST) % sheet.frameCount;
      sheet.tex.offset.x = frameIdx / sheet.frameCount;
    } else if (e.frontMat) {
      e.walkFrameTimer = 0;
      if (e.mesh.material !== e.frontMat) {
        e.mesh.material = e.frontMat;
        e.mesh.scale.x  = SPRITE_WORLD_H * (e.frontAspect ?? 1);
      }
      const useTex = (moving && !e.walkSheet && !e.backSheet && e.backTex)
        ? (() => { roomCamera.getWorldDirection(_camFwd); return (dirX * _camFwd.x + dirZ * _camFwd.z) > 0.25 ? e.backTex : e.frontTex; })()
        : e.frontTex;
      if (useTex && e.frontMat.map !== useTex) {
        e.frontMat.map = useTex;
        e.frontMat.needsUpdate = true;
      }
    }

    // ── BOB (moving, no walk sheet) ───────────
    if (moving && !sheet) {
      e.mesh.position.y = e.floorY + Math.sin(now * 6.0 * (e.roam?.speed ?? 1)) * 0.055;
    }

    // ── FLINCH VISUAL ─────────────────────────
    if (e.flinchUntil && now < e.flinchUntil) {
      e.mesh.rotation.z = e.flinchRot ?? 0;
      if (e.mesh.material && e.mesh.material.color) {
        e.mesh.material.color.setHex(0xff3311);
      }
    } else if (e.flinchUntil) {
      e.flinchUntil = 0;
      e.mesh.rotation.z = 0;
      if (e.mesh.material && e.mesh.material.color) {
        e.mesh.material.color.setHex(0xffffff);
      }
    }

    // ── CYLINDRICAL BILLBOARD ─────────────────
    const bdx = roomCamera.position.x - e.mesh.position.x;
    const bdz = roomCamera.position.z - e.mesh.position.z;
    e.mesh.rotation.y = Math.atan2(bdx, bdz);

    // ── SHADOW BLOB ───────────────────────────
    if (e.shadowBlob) {
      const sx   = e.mesh.position.x - brazier.position.x;
      const sz   = e.mesh.position.z - brazier.position.z;
      const dist = Math.sqrt(sx * sx + sz * sz);
      const nx   = dist > 0.01 ? sx / dist : 0;
      const nz   = dist > 0.01 ? sz / dist : 1;
      e.shadowBlob.position.set(
        e.mesh.position.x + nx * 0.3,
        0.016,
        e.mesh.position.z + nz * 0.3,
      );
      e.shadowBlob.material.opacity = Math.max(0.04, 0.5 * (1 - dist / 13));
    }
  }

  // Update HP bar positions + orientations
  updateHpBarTransforms();
}

// ─────────────────────────────────────────────
// PLACEHOLDER PULSE
// ─────────────────────────────────────────────

export function pulsePlaceholders(now) {
  for (const e of sprites.values()) {
    const mesh = e.mesh;
    if (!mesh?.userData.isPlaceholder) continue;
    const t = (now - mesh.userData.spawnTime) / 1000;
    mesh.material.opacity = 0.10 + 0.12 * (0.5 + 0.5 * Math.sin(t * 3));
    mesh.lookAt(roomCamera.position.x, mesh.position.y, roomCamera.position.z);
  }
}

// ─────────────────────────────────────────────
// RENDER ENTITIES (for Entities panel)
// ─────────────────────────────────────────────

// This is exported for hub-panels.js to use
export function renderEntities(entitiesBody) {
  const entries = [...sprites.values()].filter(e => e.status === 'done');
  if (!entries.length) {
    entitiesBody.innerHTML = '<p class="muted entities-empty">No entities forged yet. Spawn something in the room.</p>';
    return;
  }
  entitiesBody.innerHTML = '';
  for (const e of entries) {
    const card = document.createElement('div');
    card.className = 'entity-card';
    card.dataset.jobId = e.jobId;

    // Thumbnail
    const thumbWrap = document.createElement('div');
    if (e.spriteSrc) {
      const img = document.createElement('img');
      img.className = 'entity-thumb'; img.src = e.spriteSrc; img.alt = e.prompt;
      thumbWrap.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'entity-thumb-placeholder'; ph.textContent = '?';
      thumbWrap.appendChild(ph);
    }
    card.appendChild(thumbWrap);

    // Info column
    const info = document.createElement('div');
    info.className = 'entity-info';

    const promptEl = document.createElement('div');
    promptEl.className = 'entity-prompt'; promptEl.textContent = e.prompt;
    info.appendChild(promptEl);

    // Variant badges
    const badges = document.createElement('div');
    badges.className = 'entity-variants';
    for (const vt of VARIANT_TYPES) {
      const vj = e.variants?.[vt];
      const badge = document.createElement('button');
      badge.className = 'entity-variant-badge';
      badge.textContent = vt.toUpperCase();
      badge.dataset.state = vj ? vj.status : 'none';
      if (vj?.status === 'done' && vj.spriteName) {
        badge.title = 'Click to preview';
        badge.addEventListener('click', () => window.open(`${FORGE_BASE}/sprites/${vj.spriteName}`, '_blank'));
      } else {
        badge.title = vj ? vj.status : 'not generated';
      }
      badges.appendChild(badge);
    }
    info.appendChild(badges);

    // Regen row
    const regenRow = document.createElement('div');
    regenRow.className = 'entity-regen-row';
    const regenInput = document.createElement('input');
    regenInput.className = 'entity-regen-input'; regenInput.type = 'text';
    regenInput.placeholder = 'regen prompt override (leave blank to use template)…';
    const regenSelect = document.createElement('select');
    regenSelect.style.cssText = 'background:var(--bg-deep);color:var(--amber);border:1px solid var(--rust);padding:3px 6px;font-family:VT323,monospace;font-size:18px;outline:none;';
    VARIANT_TYPES.forEach(vt => {
      const opt = document.createElement('option'); opt.value = vt; opt.textContent = vt;
      regenSelect.appendChild(opt);
    });
    const regenBtn = document.createElement('button');
    regenBtn.className = 'entity-regen-btn'; regenBtn.textContent = 'REGEN';
    regenBtn.addEventListener('click', async () => {
      regenBtn.disabled = true;
      const vt = regenSelect.value;
      const customPrompt = regenInput.value.trim() || null;
      try {
        const res = await fetch(`${FORGE_BASE}/jobs/${e.jobId}/variants/${vt}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile_id: profileId, prompt: customPrompt }),
        });
        if (!res.ok) throw new Error(await res.text());
        const vj = await res.json();
        if (!e.variants) e.variants = {};
        e.variants[vt] = { jobId: vj.id, status: vj.status, spriteName: null };
        pollVariantJob(vj.id, vt, e);
        refreshJobList();
        if (_renderEntitiesFn) _renderEntitiesFn();
      } catch (err) { console.error('regen failed', err); }
      finally { regenBtn.disabled = false; }
    });
    regenRow.append(regenInput, regenSelect, regenBtn);
    info.appendChild(regenRow);

    card.appendChild(info);
    entitiesBody.appendChild(card);
  }
}
