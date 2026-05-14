import { on, off, emit, EVENTS } from './events.js';
import { getFlag, getCounter, setFlag, increment } from './world-state.js';

let _boundHandlers = [];
const _firedOnce = new Set();
let _loadedTriggers = [];

export function loadTriggers(tiles) {
  unloadTriggers();
  for (const tile of tiles) {
    for (const trigger of (tile.triggers ?? [])) {
      _registerTrigger(trigger);
      _loadedTriggers.push(trigger);
    }
  }
}

export function unloadTriggers() {
  for (const { eventName, handler } of _boundHandlers) off(eventName, handler);
  _boundHandlers = [];
  _loadedTriggers = [];
}

export function getLoadedTriggers() { return [..._loadedTriggers]; }

function _registerTrigger(trigger) {
  const listenOn = trigger.on ?? EVENTS.ROOM_ENTERED;
  const handler = (payload) => {
    if (trigger.once && _firedOnce.has(trigger.id)) return;
    if (!_evalCondition(trigger.condition, payload)) return;
    if (trigger.once) _firedOnce.add(trigger.id);
    for (const action of (trigger.actions ?? [])) _runAction(action, payload);
    emit(EVENTS.TRIGGER_FIRED, { triggerId: trigger.id, payload });
  };
  on(listenOn, handler);
  _boundHandlers.push({ eventName: listenOn, handler });
}

function _evalCondition(cond, payload) {
  if (!cond || cond.type === 'always') return true;
  if (cond.type === 'flag_eq') return getFlag(cond.key) === cond.value;
  if (cond.type === 'counter_gte') return getCounter(cond.key) >= cond.value;
  return false;
}

function _runAction(action, payload) {
  if (action.type === 'set_flag') setFlag(action.key, action.value);
  else if (action.type === 'increment') increment(action.key, action.amount ?? 1);
  else if (action.type === 'emit_event') emit(action.event, action.payload ?? {});
  else if (action.type === 'show_lore') emit(EVENTS.TRIGGER_FIRED, { lore: action.text, triggerId: action.id });
  // spawn_entity handled by main.js listener on 'entity:spawn_request'
  else if (action.type === 'spawn_entity') emit('entity:spawn_request', { entityId: action.entityId, pos: action.pos });
}
