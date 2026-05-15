// =====================================================================
// icons.js — DungeonForge SVG icon set (vanilla JS, no React)
//
// Usage:
//   import { icon } from './icons.js';
//   el.innerHTML = icon('sword', 20);          // returns SVG string
//   el.innerHTML = icon('close');              // default 24px
//
// All icons drawn at 24×24 viewBox, 2px stroke, square caps, crispEdges.
// They inherit currentColor — tint by setting CSS color on the container.
// =====================================================================

const S  = `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"`;
const SF = `fill="currentColor"`;

function svg(size, body) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" shape-rendering="crispEdges" aria-hidden="true">${body}</svg>`;
}

// ── System / chrome ────────────────────────────────────────────────
const PATHS = {
  settings: (s) => svg(s,
    `<circle cx="12" cy="12" r="3" ${S}/>` +
    `<path d="M12 2 v3 M12 19 v3 M2 12 h3 M19 12 h3 M5 5 l2 2 M17 17 l2 2 M5 19 l2 -2 M17 7 l2 -2" ${S}/>`
  ),
  close: (s) => svg(s,
    `<path d="M5 5 L19 19 M19 5 L5 19" ${S}/>`
  ),
  expand: (s) => svg(s,
    `<path d="M4 4 H10 M4 4 V10 M14 4 H20 M20 4 V10 M4 14 V20 M4 20 H10 M20 14 V20 M14 20 H20" ${S}/>`
  ),
  collapse: (s) => svg(s,
    `<path d="M9 9 H4 M9 9 V4 M15 9 H20 M15 9 V4 M9 15 V20 M9 15 H4 M15 15 V20 M15 15 H20" ${S}/>`
  ),
  menu: (s) => svg(s,
    `<path d="M4 6 H20 M4 12 H20 M4 18 H20" ${S}/>`
  ),
  'chev-right': (s) => svg(s,
    `<path d="M9 5 L16 12 L9 19" ${S}/>`
  ),
  'chev-left': (s) => svg(s,
    `<path d="M15 5 L8 12 L15 19" ${S}/>`
  ),
  'chev-down': (s) => svg(s,
    `<path d="M5 9 L12 16 L19 9" ${S}/>`
  ),
  refresh: (s) => svg(s,
    `<path d="M4 12 a8 8 0 0 1 14 -5 M20 12 a8 8 0 0 1 -14 5" ${S}/>` +
    `<path d="M18 3 V8 H13 M6 21 V16 H11" ${S}/>`
  ),
  save: (s) => svg(s,
    `<path d="M4 4 H17 L20 7 V20 H4 Z" ${S}/>` +
    `<path d="M7 4 V10 H15 V4 M8 14 H16" ${S}/>`
  ),
  search: (s) => svg(s,
    `<circle cx="10" cy="10" r="6" ${S}/>` +
    `<path d="M15 15 L21 21" ${S}/>`
  ),
  eye: (s) => svg(s,
    `<path d="M2 12 a10 10 0 0 1 20 0 a10 10 0 0 1 -20 0 Z" ${S}/>` +
    `<circle cx="12" cy="12" r="3" ${S}/>`
  ),
  'eye-off': (s) => svg(s,
    `<path d="M3 12 a10 10 0 0 1 18 0 M3 3 L21 21" ${S}/>` +
    `<path d="M9 9 a3 3 0 0 0 4 4 M14 14 a3 3 0 0 1 -4 -4" ${S}/>`
  ),
  lock: (s) => svg(s,
    `<rect x="5" y="11" width="14" height="10" ${S}/>` +
    `<path d="M8 11 V8 a4 4 0 0 1 8 0 V11" ${S}/>` +
    `<circle cx="12" cy="16" r="1" ${SF}/>`
  ),
  key: (s) => svg(s,
    `<circle cx="7" cy="12" r="4" ${S}/>` +
    `<path d="M11 12 H21 M18 12 V16 M21 12 V15" ${S}/>`
  ),
  copy: (s) => svg(s,
    `<rect x="4" y="4" width="12" height="14" ${S}/>` +
    `<path d="M8 8 V20 H20 V8 Z" ${S}/>`
  ),

  // ── Player / RPG ────────────────────────────────────────────────
  user: (s) => svg(s,
    `<circle cx="12" cy="8" r="4" ${S}/>` +
    `<path d="M4 21 a8 8 0 0 1 16 0" ${S}/>`
  ),
  heart: (s) => svg(s,
    `<path d="M12 20 L4 12 a4 4 0 0 1 8 -3 a4 4 0 0 1 8 3 L12 20 Z" ${S}/>`
  ),
  shield: (s) => svg(s,
    `<path d="M12 3 L20 6 V12 a8 10 0 0 1 -8 9 a8 10 0 0 1 -8 -9 V6 Z" ${S}/>`
  ),
  sword: (s) => svg(s,
    `<path d="M19 3 L21 5 L11 15 L9 13 Z" ${S}/>` +
    `<path d="M9 13 L5 17 L7 19 L11 15 M5 17 L3 19 L5 21 L7 19" ${S}/>`
  ),
  bow: (s) => svg(s,
    `<path d="M5 4 a14 14 0 0 1 0 16" ${S}/>` +
    `<path d="M5 4 L19 18 M5 20 L19 6" ${S}/>`
  ),
  wand: (s) => svg(s,
    `<path d="M4 20 L16 8 L18 10 L6 22 Z" ${S}/>` +
    `<path d="M19 3 V7 M17 5 H21 M20 9 L21 10 M14 4 L15 5" ${S}/>`
  ),
  potion: (s) => svg(s,
    `<path d="M10 3 H14 V6 L17 11 V20 H7 V11 L10 6 Z" ${S}/>` +
    `<path d="M7 15 H17" ${S}/>` +
    `<circle cx="11" cy="17" r="0.8" ${SF}/>` +
    `<circle cx="14" cy="17.5" r="0.6" ${SF}/>`
  ),
  gem: (s) => svg(s,
    `<path d="M4 9 L12 3 L20 9 L12 21 Z" ${S}/>` +
    `<path d="M4 9 H20 M9 9 L12 21 M15 9 L12 21" ${S}/>`
  ),
  coin: (s) => svg(s,
    `<circle cx="12" cy="12" r="9" ${S}/>` +
    `<circle cx="12" cy="12" r="5" ${S}/>` +
    `<path d="M12 7 V17" ${S}/>`
  ),
  bag: (s) => svg(s,
    `<path d="M5 8 H19 L18 20 H6 Z" ${S}/>` +
    `<path d="M9 8 V6 a3 3 0 0 1 6 0 V8" ${S}/>`
  ),
  map: (s) => svg(s,
    `<path d="M3 6 L9 4 L15 6 L21 4 V18 L15 20 L9 18 L3 20 Z" ${S}/>` +
    `<path d="M9 4 V18 M15 6 V20" ${S}/>`
  ),
  compass: (s) => svg(s,
    `<circle cx="12" cy="12" r="9" ${S}/>` +
    `<path d="M12 7 L14 12 L12 17 L10 12 Z" ${S}/>`
  ),
  crosshair: (s) => svg(s,
    `<circle cx="12" cy="12" r="7" ${S}/>` +
    `<path d="M12 2 V6 M12 18 V22 M2 12 H6 M18 12 H22 M12 9 V15 M9 12 H15" ${S}/>`
  ),
  skull: (s) => svg(s,
    `<path d="M5 10 a7 7 0 0 1 14 0 V15 L17 17 V20 H7 V17 L5 15 Z" ${S}/>` +
    `<circle cx="9" cy="12" r="1.5" ${SF}/>` +
    `<circle cx="15" cy="12" r="1.5" ${SF}/>` +
    `<path d="M10 17 V20 M14 17 V20 M12 15 V17" ${S}/>`
  ),
  scroll: (s) => svg(s,
    `<path d="M5 4 H17 a2 2 0 0 1 2 2 V18 a2 2 0 0 1 -2 2 H5 a2 2 0 0 0 0 -4 V8 a2 2 0 0 0 0 -4 Z" ${S}/>` +
    `<path d="M9 9 H15 M9 12 H15 M9 15 H13" ${S}/>`
  ),
  book: (s) => svg(s,
    `<path d="M4 4 H11 a3 3 0 0 1 3 3 V20 H7 a3 3 0 0 1 -3 -3 Z" ${S}/>` +
    `<path d="M14 7 a3 3 0 0 1 3 -3 H20 V17 a3 3 0 0 0 -3 3 H14 Z" ${S}/>`
  ),
  flag: (s) => svg(s,
    `<path d="M5 3 V21 M5 4 H18 L15 9 L18 14 H5" ${S}/>`
  ),
  star: (s) => svg(s,
    `<path d="M12 3 L14.5 9.5 L21 10 L16 14 L17.5 21 L12 17.5 L6.5 21 L8 14 L3 10 L9.5 9.5 Z" ${S} ${SF}/>`
  ),

  // ── Forge / pipeline ────────────────────────────────────────────
  forge: (s) => svg(s,
    `<path d="M4 18 H20 L18 22 H6 Z" ${S}/>` +
    `<path d="M6 18 V13 a6 6 0 0 1 12 0 V18" ${S}/>` +
    `<path d="M10 13 V8 M14 13 V6 M12 13 V9" ${S}/>`
  ),
  anvil: (s) => svg(s,
    `<path d="M3 8 L21 8 L19 13 H8 a3 3 0 0 0 -3 3 H4 Z" ${S}/>` +
    `<path d="M10 16 H14 V20 H7 V18 H10 Z" ${S}/>`
  ),
  spark: (s) => svg(s,
    `<path d="M12 3 L13 10 L20 11 L13 13 L12 21 L11 13 L4 11 L11 10 Z" ${S} ${SF}/>`
  ),
  cube: (s) => svg(s,
    `<path d="M12 3 L21 8 V16 L12 21 L3 16 V8 Z" ${S}/>` +
    `<path d="M3 8 L12 13 L21 8 M12 13 V21" ${S}/>`
  ),
  wirecube: (s) => svg(s,
    `<path d="M5 6 H17 V18 H5 Z" ${S}/>` +
    `<path d="M5 6 L9 3 H21 V15 L17 18 M17 6 L21 3 M5 18 L9 15 H21" ${S}/>`
  ),
  sprite: (s) => svg(s,
    `<rect x="3" y="3" width="18" height="18" ${S}/>` +
    `<path d="M9 9 H15 V15 H9 Z M11 7 H13 V9 H11 Z M11 15 H13 V17 H11 Z M7 11 H9 V13 H7 Z M15 11 H17 V13 H15 Z" ${S} fill="currentColor"/>`
  ),
  queue: (s) => svg(s,
    `<rect x="3" y="5" width="18" height="3" ${S}/>` +
    `<rect x="3" y="11" width="14" height="3" ${S}/>` +
    `<rect x="3" y="17" width="10" height="3" ${S}/>`
  ),
  terminal: (s) => svg(s,
    `<rect x="3" y="4" width="18" height="16" ${S}/>` +
    `<path d="M7 9 L10 12 L7 15 M12 15 H16" ${S}/>`
  ),
  portal: (s) => svg(s,
    `<ellipse cx="12" cy="12" rx="6" ry="9" ${S}/>` +
    `<ellipse cx="12" cy="12" rx="3" ry="6" ${S}/>`
  ),
  world: (s) => svg(s,
    `<circle cx="12" cy="12" r="9" ${S}/>` +
    `<path d="M3 12 H21 M12 3 a10 14 0 0 1 0 18 a10 14 0 0 1 0 -18" ${S}/>`
  ),

  // ── Action ──────────────────────────────────────────────────────
  play: (s) => svg(s,
    `<path d="M6 4 L20 12 L6 20 Z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"/>`
  ),
  pause: (s) => svg(s,
    `<path d="M7 4 V20 M17 4 V20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"/>`
  ),
  stop: (s) => svg(s,
    `<rect x="5" y="5" width="14" height="14" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"/>`
  ),
  plus: (s) => svg(s,
    `<path d="M12 4 V20 M4 12 H20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square"/>`
  ),
  minus: (s) => svg(s,
    `<path d="M4 12 H20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square"/>`
  ),
  upload: (s) => svg(s,
    `<path d="M12 4 V16 M6 10 L12 4 L18 10 M4 20 H20" ${S}/>`
  ),
  download: (s) => svg(s,
    `<path d="M12 4 V16 M6 10 L12 16 L18 10 M4 20 H20" ${S}/>`
  ),
  link: (s) => svg(s,
    `<path d="M10 14 L14 10 M9 7 a5 5 0 0 1 7 7 L14 16 M15 17 a5 5 0 0 1 -7 -7 L10 8" ${S}/>`
  ),
  share: (s) => svg(s,
    `<circle cx="6" cy="12" r="2.5" ${S}/>` +
    `<circle cx="18" cy="6" r="2.5" ${S}/>` +
    `<circle cx="18" cy="18" r="2.5" ${S}/>` +
    `<path d="M8 11 L16 7 M8 13 L16 17" ${S}/>`
  ),
  chat: (s) => svg(s,
    `<path d="M3 5 H21 V17 H13 L9 21 V17 H3 Z" ${S}/>` +
    `<path d="M7 10 H17 M7 13 H14" ${S}/>`
  ),
  bell: (s) => svg(s,
    `<path d="M6 16 V11 a6 6 0 0 1 12 0 V16 L20 18 H4 Z" ${S}/>` +
    `<path d="M10 18 a2 2 0 0 0 4 0" ${S}/>`
  ),
  check: (s) => svg(s,
    `<path d="M4 12 L10 18 L20 6" ${S}/>`
  ),
  warn: (s) => svg(s,
    `<path d="M12 3 L22 20 H2 Z" ${S}/>` +
    `<path d="M12 10 V14 M12 17 V17.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`
  ),
  info: (s) => svg(s,
    `<circle cx="12" cy="12" r="9" ${S}/>` +
    `<path d="M12 8 V8.01 M12 11 V17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`
  ),

  // ── Media ───────────────────────────────────────────────────────
  volume: (s) => svg(s,
    `<path d="M4 9 H8 L13 5 V19 L8 15 H4 Z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"/>` +
    `<path d="M16 9 a4 4 0 0 1 0 6 M18 6 a8 8 0 0 1 0 12" ${S}/>`
  ),
  'volume-mute': (s) => svg(s,
    `<path d="M4 9 H8 L13 5 V19 L8 15 H4 Z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"/>` +
    `<path d="M16 9 L22 15 M22 9 L16 15" ${S}/>`
  ),
  video: (s) => svg(s,
    `<rect x="2" y="6" width="14" height="12" ${S}/>` +
    `<path d="M16 10 L22 6 V18 L16 14 Z" ${S}/>`
  ),
  image: (s) => svg(s,
    `<rect x="3" y="3" width="18" height="18" ${S}/>` +
    `<circle cx="9" cy="9" r="2" ${S}/>` +
    `<path d="M3 17 L9 12 L14 17 L17 14 L21 18" ${S}/>`
  ),

  // ── Navigation ──────────────────────────────────────────────────
  'arrow-up':    (s) => svg(s, `<path d="M12 4 V20 M5 11 L12 4 L19 11" ${S}/>`),
  'arrow-down':  (s) => svg(s, `<path d="M12 4 V20 M5 13 L12 20 L19 13" ${S}/>`),
  'arrow-left':  (s) => svg(s, `<path d="M4 12 H20 M11 5 L4 12 L11 19" ${S}/>`),
  'arrow-right': (s) => svg(s, `<path d="M4 12 H20 M13 5 L20 12 L13 19" ${S}/>`),
  dpad: (s) => svg(s,
    `<path d="M10 3 H14 V8 H19 V14 H14 V19 H10 V14 H5 V8 H10 Z" ${S}/>`
  ),
  mouse: (s) => svg(s,
    `<rect x="6" y="3" width="12" height="18" rx="6" ${S}/>` +
    `<path d="M12 7 V11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square"/>`
  ),
  keyboard: (s) => svg(s,
    `<rect x="2" y="6" width="20" height="12" ${S}/>` +
    `<path d="M6 10 V10.01 M10 10 V10.01 M14 10 V10.01 M18 10 V10.01 M6 14 H18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`
  ),
};

/**
 * Returns an SVG string for the named icon at the given size.
 * Returns an empty string if the icon name is not found.
 * @param {string} name  — icon key (e.g. 'sword', 'close', 'forge')
 * @param {number} size  — pixel dimension (default 24)
 */
export function icon(name, size = 24) {
  const fn = PATHS[name];
  return fn ? fn(size) : '';
}

/** All icon names, grouped, for catalogue rendering. */
export const ICON_GROUPS = {
  system:   ['settings','close','menu','expand','collapse','chev-right','chev-left','chev-down','refresh','save','search','eye','eye-off','lock','key','copy'],
  rpg:      ['user','heart','shield','sword','bow','wand','potion','gem','coin','bag','map','compass','crosshair','skull','scroll','book','flag','star'],
  pipeline: ['forge','anvil','spark','cube','wirecube','sprite','queue','terminal','portal','world'],
  action:   ['play','pause','stop','plus','minus','upload','download','link','share','chat','bell','check','warn','info'],
  media:    ['volume','volume-mute','video','image'],
  nav:      ['arrow-up','arrow-down','arrow-left','arrow-right','dpad','mouse','keyboard'],
};
