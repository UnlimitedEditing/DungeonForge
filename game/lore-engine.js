// lore-engine.js — World scaffold fetch, inference hook evaluation, spawn enrichment.
//
// Two-phase flow:
//   1. loadScaffold() fetches the pre-generated scaffold for the active experience.
//      Non-blocking — spawn submissions degrade gracefully if it hasn't arrived yet.
//   2. checkTriggers() is called on every FLAG_CHANGED / COUNTER_CHANGED event.
//      When a hook's condition is met its promptModifier stacks onto active modifiers
//      and getActivePromptModifier() returns the combined string for the next spawn.

let _scaffold = null;
let _activeHooks = [];          // inference hooks not yet triggered this session
let _appliedModifiers = [];     // stacked modifiers, most recent first (max 3)

export function getScaffold() { return _scaffold; }

export async function loadScaffold(base, experienceId) {
  try {
    const res = await fetch(`${base}/scaffold/${experienceId}`);
    if (res.ok) {
      _scaffold = await res.json();
    } else {
      _scaffold = null;
    }
  } catch {
    _scaffold = null;
  }
  _activeHooks      = [...(_scaffold?.inferenceHooks ?? [])];
  _appliedModifiers = [];
}

export async function generateScaffold(base, experienceId, profileId) {
  const res = await fetch(`${base}/scaffold/${experienceId}`, {
    method: 'POST',
    headers: { 'X-Profile-Id': profileId },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();  // {status:'queued', experience_id}
}

export async function pollScaffoldStatus(base, experienceId) {
  const res = await fetch(`${base}/scaffold/${experienceId}/status`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();  // {status:'ready'|'queued'|'none', generatedAt?}
}

// checkTriggers — call on FLAG_CHANGED and COUNTER_CHANGED events.
// Returns array of newly-fired hook objects (empty if none triggered).
export function checkTriggers(flags, counters) {
  const fired = [];
  _activeHooks = _activeHooks.filter(hook => {
    const t = hook.trigger;
    let triggered = false;
    if (t.type === 'counter_gte') triggered = (counters[t.key] ?? 0) >= t.value;
    if (t.type === 'flag_eq')     triggered = flags[t.key] === t.value;
    if (triggered) {
      _appliedModifiers.unshift(hook.promptModifier);
      if (_appliedModifiers.length > 3) _appliedModifiers.pop();
      fired.push(hook);
    }
    return !triggered;
  });
  return fired;
}

// Returns a combined prompt modifier string from the most recent fired hooks.
// Empty string when no scaffold or no hooks have fired.
export function getActivePromptModifier() {
  return _appliedModifiers.join(', ');
}

// Infer a stat tier (0.0-1.0) from the entity description and active scaffold.
// Matches archetype names as keywords; defaults to 0.5 (mid-range) if no match.
export function getStatTier(entityDescription) {
  if (!_scaffold?.archetypes?.length) return 0.5;
  const desc = entityDescription.toLowerCase();
  // Check most powerful archetypes first so "ancient guardian" hits "ancient" not "guardian"
  for (const arch of [..._scaffold.archetypes].reverse()) {
    if (desc.includes(arch.name.toLowerCase())) return arch.statMultiplier;
  }
  return _scaffold.archetypes[0]?.statMultiplier ?? 0.5;
}

// Returns the evolution hint for the matched archetype, or null.
export function getEvolutionHint(entityDescription) {
  if (!_scaffold?.archetypes?.length) return null;
  const desc = entityDescription.toLowerCase();
  for (const arch of _scaffold.archetypes) {
    if (desc.includes(arch.name.toLowerCase())) return arch.evolutionHint;
  }
  return _scaffold.archetypes[0]?.evolutionHint ?? null;
}

// Call on returnToForge — resets fired-hook state for the next session.
// Scaffold itself is kept so it doesn't need refetching on re-entry.
export function resetSession() {
  _activeHooks      = [...(_scaffold?.inferenceHooks ?? [])];
  _appliedModifiers = [];
}
