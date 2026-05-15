// =====================================================================
// state.js — All shared mutable game state
// =====================================================================

// ─────────────────────────────────────────────
// CONSTANTS (shared with multiple modules)
// ─────────────────────────────────────────────

export const AGRO_RANGE             = 6.0;
export const ATTACK_RANGE           = 1.8;
export const MELEE_RANGE            = 2.5;
export const ENTITY_ATTACK_COOLDOWN = 2.5;
export const PLAYER_ATTACK_COOLDOWN = 0.55;

export const DROP_POOL = [
  { name: 'Health Potion',    type: 'consumable', subtype: '',       stats: { hp_restore: 30 }, rarity: 'common',   color: 0xdd3333 },
  { name: 'Iron Sword',       type: 'weapon',     subtype: 'melee',  stats: { attack: 5 },       rarity: 'common',   color: 0x888899 },
  { name: 'Wooden Shield',    type: 'armor',       subtype: 'offhand',stats: { defense: 3 },      rarity: 'common',   color: 0x885522 },
  { name: 'Leather Vest',     type: 'armor',       subtype: 'body',   stats: { defense: 5 },      rarity: 'common',   color: 0x664422 },
  { name: 'Ring of Swiftness',type: 'accessory',   subtype: '',       stats: { attack: 2, defense: 1 }, rarity: 'uncommon', color: 0xddaa00 },
  { name: 'Hunter\'s Bow',    type: 'weapon',     subtype: 'ranged', stats: { attack: 4, range: 15 }, rarity: 'uncommon', color: 0x997733 },
];

export const TYPE_COLORS = { weapon: 0x888899, armor: 0x664422, consumable: 0xdd3333, accessory: 0xddaa00 };

export const EQUIPMENT_SLOTS = ['weapon', 'offhand', 'helmet', 'body', 'boots', 'accessory'];

// ─────────────────────────────────────────────
// PLAYER STATE
// ─────────────────────────────────────────────

// The player object — mutated in-place everywhere, reference never reassigned
export const player = {
  hp: 100, maxHp: 100,
  attack: 10, defense: 5,
  level: 1, xp: 0, xpToNext: 100,
  inventory: [],    // array of item objects
  equipment: {},    // slot -> item object
};

// ─────────────────────────────────────────────
// ENTITY / WORLD MAPS
// ─────────────────────────────────────────────

// Entity sprites map — keys added/removed, reference never reassigned
export const sprites = new Map();

// World item drops map
export const worldItems = new Map();

// ─────────────────────────────────────────────
// SCENE / EXPERIENCE STATE
// ─────────────────────────────────────────────

export let appMode = 'forge'; // 'forge' | 'room'
export let activeExperience  = null;   // the experience JSON currently loaded
export let currentLevel      = null;   // generated level data
export let levelComplete     = false;

export function setAppMode(v)          { appMode = v; }
export function setActiveExperience(v) { activeExperience = v; }
export function setCurrentLevel(v)     { currentLevel = v; }
export function setLevelComplete(v)    { levelComplete = v; }

// ─────────────────────────────────────────────
// PROFILE STATE
// ─────────────────────────────────────────────

export let profileId       = null;
export let profileUsername = null;

export function setProfileId(v)       { profileId = v; }
export function setProfileUsername(v) { profileUsername = v; }

// ─────────────────────────────────────────────
// COMBAT TIMING
// ─────────────────────────────────────────────

export let lastPlayerAttack = 0;
export let pendingPickup    = null;   // world-item drop the player is standing near

export function setLastPlayerAttack(v) { lastPlayerAttack = v; }
export function setPendingPickup(v)    { pendingPickup = v; }

// ─────────────────────────────────────────────
// LIVE CONFIG VARS
// ─────────────────────────────────────────────

// Mutable game constants — defaults match hardcoded values; overwritten from config on room entry
export let liveAgroRange      = AGRO_RANGE;
export let liveAttackRange    = ATTACK_RANGE;
export let liveMeleeRange     = MELEE_RANGE;
export let liveEntityAttackCd = ENTITY_ATTACK_COOLDOWN;
export let livePlayerAttackCd = PLAYER_ATTACK_COOLDOWN;
export let liveDropChance     = 0.30;
export let liveXpMult         = 1.0;
export let liveLevelHpGain    = 10;
export let liveLevelAtkGain   = 2;
export let liveLevelDefGain   = 1;
export let liveDropPool       = [...DROP_POOL];

export function applyLiveConfig(cfg) {
  if (cfg.agro_range        !== undefined) liveAgroRange      = cfg.agro_range;
  if (cfg.attack_range      !== undefined) liveAttackRange    = cfg.attack_range;
  if (cfg.melee_range       !== undefined) liveMeleeRange     = cfg.melee_range;
  if (cfg.entity_attack_cd  !== undefined) liveEntityAttackCd = cfg.entity_attack_cd;
  if (cfg.player_attack_cd  !== undefined) livePlayerAttackCd = cfg.player_attack_cd;
  if (cfg.drop_chance       !== undefined) liveDropChance     = cfg.drop_chance;
  if (cfg.xp_multiplier     !== undefined) liveXpMult         = cfg.xp_multiplier;
  if (cfg.level_hp_gain     !== undefined) liveLevelHpGain    = cfg.level_hp_gain;
  if (cfg.level_atk_gain    !== undefined) liveLevelAtkGain   = cfg.level_atk_gain;
  if (cfg.level_def_gain    !== undefined) liveLevelDefGain   = cfg.level_def_gain;
  if (cfg.drop_pool         !== undefined) liveDropPool       = cfg.drop_pool;
}

export function setLiveAgroRange(v)      { liveAgroRange = v; }
export function setLiveAttackRange(v)    { liveAttackRange = v; }
export function setLiveMeleeRange(v)     { liveMeleeRange = v; }
export function setLiveEntityAttackCd(v) { liveEntityAttackCd = v; }
export function setLivePlayerAttackCd(v) { livePlayerAttackCd = v; }
export function setLiveDropChance(v)     { liveDropChance = v; }
export function setLiveXpMult(v)         { liveXpMult = v; }
export function setLiveLevelHpGain(v)    { liveLevelHpGain = v; }
export function setLiveLevelAtkGain(v)   { liveLevelAtkGain = v; }
export function setLiveLevelDefGain(v)   { liveLevelDefGain = v; }
export function setLiveDropPool(v)       { liveDropPool = v; }
