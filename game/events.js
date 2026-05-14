export const EVENTS = {
  ENTITY_DIED: 'entity:died',
  ENTITY_DAMAGED: 'entity:damaged',
  PLAYER_DAMAGED: 'player:damaged',
  PLAYER_DIED: 'player:died',
  ROOM_ENTERED: 'room:entered',
  LEVEL_LOADED: 'level:loaded',
  LEVEL_EXIT_REACHED: 'level:exit_reached',
  TRIGGER_FIRED: 'trigger:fired',
  ITEM_PICKED_UP: 'item:picked_up',
  ITEM_DROPPED: 'item:dropped',
  FLAG_CHANGED: 'state:flag_changed',
  COUNTER_CHANGED: 'state:counter_changed',
  ENTITY_STATE_CHANGED: 'state:entity_changed',
  EXPERIENCE_LOADED: 'experience:loaded',
  SYSTEM_ENABLED: 'system:enabled',
  SYSTEM_DISABLED: 'system:disabled',
};

const _listeners = {};
const _wildcardListeners = new Set();
const _knownNames = new Set(Object.values(EVENTS));

export function on(eventName, handler) {
  if (eventName === '*') { _wildcardListeners.add(handler); return; }
  if (!_listeners[eventName]) _listeners[eventName] = new Set();
  _listeners[eventName].add(handler);
}

export function off(eventName, handler) {
  if (eventName === '*') { _wildcardListeners.delete(handler); return; }
  _listeners[eventName]?.delete(handler);
}

export function once(eventName, handler) {
  const wrapper = (payload) => { handler(payload); off(eventName, wrapper); };
  on(eventName, wrapper);
}

export function emit(eventName, payload = {}) {
  if (location.hostname === 'localhost' && !_knownNames.has(eventName)) {
    console.warn(`[events] Unknown event: ${eventName}`);
  }
  _listeners[eventName]?.forEach(h => h(payload));
  _wildcardListeners.forEach(h => h({ event: eventName, payload }));
}
