// =====================================================================
// console.js — Dev/admin console overlay.
//
// Toggled with backtick (`). Provides a command registry, scrollable
// output log, and command history (↑/↓). Game modules register their
// own commands via registerCommand(); core builtins (help, clear) live
// here. All async commands that hit the server use fetch directly.
// =====================================================================

const FORGE_BASE = window.location.origin;

const _commands = new Map();   // name → { description, handler }
const _history  = [];          // most-recent first
let _histIdx    = -1;
let _open       = false;

let _overlay = null;
let _output  = null;
let _input   = null;

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────

export function initConsole() {
  _overlay = document.getElementById('dev-console');
  _output  = document.getElementById('dev-console-output');
  _input   = document.getElementById('dev-console-input');
  if (!_overlay || !_input) return;

  _input.addEventListener('keydown', _onInputKey);
  _registerBuiltins();

  log('DungeonForge dev console — type help for commands', 'muted');
}

export function isConsoleOpen() { return _open; }

export function openConsole() {
  if (_open) return;
  _open = true;
  if (_overlay) _overlay.dataset.open = 'true';
  _histIdx = -1;
  setTimeout(() => _input?.focus(), 40);
}

export function closeConsole() {
  if (!_open) return;
  _open = false;
  if (_overlay) _overlay.dataset.open = 'false';
}

export function toggleConsole() {
  _open ? closeConsole() : openConsole();
}

export function registerCommand(name, description, handler) {
  _commands.set(name.toLowerCase(), { description, handler });
}

export function log(msg, type = 'info') {
  if (!_output) return;
  const line = document.createElement('div');
  line.className = `con-line con-${type}`;
  line.textContent = msg;
  _output.appendChild(line);
  _output.scrollTop = _output.scrollHeight;
}

// ─────────────────────────────────────────────
// INPUT
// ─────────────────────────────────────────────

function _onInputKey(e) {
  if (e.code === 'Enter') {
    e.preventDefault();
    const raw = _input.value.trim();
    if (!raw) return;
    _history.unshift(raw);
    if (_history.length > 80) _history.pop();
    _histIdx = -1;
    _input.value = '';
    log(`> ${raw}`, 'cmd');
    _dispatch(raw);
    return;
  }

  if (e.code === 'ArrowUp') {
    e.preventDefault();
    if (_histIdx < _history.length - 1) {
      _histIdx++;
      _input.value = _history[_histIdx];
      setTimeout(() => _input.setSelectionRange(_input.value.length, _input.value.length), 0);
    }
    return;
  }

  if (e.code === 'ArrowDown') {
    e.preventDefault();
    if (_histIdx > 0) {
      _histIdx--;
      _input.value = _history[_histIdx];
    } else {
      _histIdx = -1;
      _input.value = '';
    }
    return;
  }

  if (e.code === 'Escape') {
    e.stopPropagation();
    closeConsole();
  }
}

function _dispatch(raw) {
  const parts = raw.trim().split(/\s+/);
  const name  = parts[0].toLowerCase();
  const args  = parts.slice(1);
  const cmd   = _commands.get(name);
  if (!cmd) {
    log(`unknown: ${name}  (try 'help')`, 'error');
    return;
  }
  try {
    const result = cmd.handler(args);
    if (result instanceof Promise) {
      result.catch(err => log(`error: ${err.message}`, 'error'));
    }
  } catch (err) {
    log(`error: ${err.message}`, 'error');
  }
}

// ─────────────────────────────────────────────
// BUILT-IN COMMANDS
// ─────────────────────────────────────────────

function _registerBuiltins() {
  registerCommand('help', '[command] — list commands or describe one', (args) => {
    if (args[0]) {
      const cmd = _commands.get(args[0].toLowerCase());
      if (!cmd) { log(`no command: ${args[0]}`, 'error'); return; }
      log(cmd.description, 'info');
      return;
    }
    const entries = [..._commands.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    log('── commands ──────────────────────────────────', 'muted');
    for (const [n, { description }] of entries) {
      log(`  ${n.padEnd(16)} ${description}`, 'info');
    }
  });

  registerCommand('clear', '— clear console output', () => {
    if (_output) _output.innerHTML = '';
  });

  registerCommand('config', 'get [key] | set <key> <value> — read/write server config', async (args) => {
    const sub = args[0]?.toLowerCase();
    if (sub === 'set') {
      if (args.length < 3) { log('usage: config set <key> <value>', 'warn'); return; }
      const key = args[1];
      let val;
      try { val = JSON.parse(args.slice(2).join(' ')); } catch { val = args.slice(2).join(' '); }
      const res = await fetch(`${FORGE_BASE}/config`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: val }),
      });
      if (!res.ok) { log(`server error ${res.status}`, 'error'); return; }
      log(`config.${key} = ${JSON.stringify(val)}`, 'success');
      return;
    }
    // get
    const res  = await fetch(`${FORGE_BASE}/config`);
    const data = await res.json();
    if (args[0] && args[0] !== 'get') {
      const key = args[0];
      log(`${key}: ${JSON.stringify(data[key] ?? '(not found)')}`, 'info');
    } else if (sub === 'get' && args[1]) {
      log(`${args[1]}: ${JSON.stringify(data[args[1]] ?? '(not found)')}`, 'info');
    } else {
      log('── config ────────────────────────────────────', 'muted');
      for (const [k, v] of Object.entries(data)) {
        const vs = String(JSON.stringify(v));
        log(`  ${k.padEnd(28)} ${vs.length > 60 ? vs.slice(0, 57) + '…' : vs}`, 'info');
      }
    }
  });

  registerCommand('jobs', '— list render job statuses', async () => {
    const res  = await fetch(`${FORGE_BASE}/jobs`);
    const jobs = await res.json();
    if (!jobs.length) { log('no jobs', 'muted'); return; }
    log('── jobs ──────────────────────────────────────', 'muted');
    for (const j of jobs) {
      log(`  ${j.id}  ${j.job_type.padEnd(6)}  ${j.status.padEnd(12)}  ${j.prompt.slice(0, 40)}`, 'info');
    }
  });

  registerCommand('npc', 'list | card <id> — NPC card registry', async (args) => {
    const sub = args[0]?.toLowerCase();
    if (sub === 'card' && args[1]) {
      const res  = await fetch(`${FORGE_BASE}/npc-cards`);
      const list = await res.json();
      const card = list.find(c => c.id === args[1] || c.name?.toLowerCase().includes(args[1].toLowerCase()));
      if (!card) { log(`no card matching: ${args[1]}`, 'error'); return; }
      for (const [k, v] of Object.entries(card)) {
        log(`  ${k.padEnd(14)} ${JSON.stringify(v)}`, 'info');
      }
      return;
    }
    const res  = await fetch(`${FORGE_BASE}/npc-cards`);
    const list = await res.json();
    if (!list.length) { log('no npc cards registered', 'muted'); return; }
    log('── npc cards ─────────────────────────────────', 'muted');
    for (const c of list) {
      log(`  ${(c.id ?? '?').padEnd(10)}  ${c.disposition.padEnd(8)}  ${c.name}`, 'info');
    }
  });

  registerCommand('categories', '— entity category scale averages', async () => {
    const res  = await fetch(`${FORGE_BASE}/entity-categories`);
    const data = await res.json();
    const keys = Object.keys(data);
    if (!keys.length) { log('no categories yet', 'muted'); return; }
    log('── categories ────────────────────────────────', 'muted');
    for (const k of keys.sort()) {
      const { avg_scale, count } = data[k];
      log(`  ${k.padEnd(20)}  avg ${String(avg_scale).padEnd(6)}  (${count} entities)`, 'info');
    }
  });
}
