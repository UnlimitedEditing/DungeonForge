import { emit, EVENTS } from './events.js';

let _flags = {};
let _counters = {};
let _entityStates = {};

export function init(defaults = {}) {
  _flags = { ...(defaults.flags ?? {}) };
  _counters = { ...(defaults.counters ?? {}) };
  _entityStates = { ...(defaults.entityStates ?? {}) };
}

export function reset() { init({}); }

export function snapshot() {
  return {
    flags: { ..._flags },
    counters: { ..._counters },
    entityStates: { ..._entityStates },
  };
}

export function setFlag(key, value) {
  _flags[key] = value;
  emit(EVENTS.FLAG_CHANGED, { key, value });
}
export function getFlag(key) { return _flags[key]; }

export function increment(key, amount = 1) {
  _counters[key] = (_counters[key] ?? 0) + amount;
  emit(EVENTS.COUNTER_CHANGED, { key, value: _counters[key] });
}
export function getCounter(key) { return _counters[key] ?? 0; }

export function setEntityState(id, state) {
  _entityStates[id] = state;
  emit(EVENTS.ENTITY_STATE_CHANGED, { id, state });
}
export function getEntityState(id) { return _entityStates[id]; }
