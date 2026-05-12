"""
config.py — Runtime configuration store.

All forge behaviour that players might want to tune lives here.
Values are persisted to config.json so changes survive restarts.
New keys added to DEFAULTS automatically appear in existing configs
(the stored file is merged on top of defaults, not the other way around).

The lore field is currently stored and surfaced in the UI but not yet
consumed — it's the placeholder for the LLM-composer step that will
turn world lore + player behaviour into prompt modifiers.
"""

import json
import os
import threading
from typing import Any

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
_lock = threading.Lock()

DEFAULTS: dict[str, Any] = {
    # --- workflows (Graydient slug strings) ---
    "workflow": "qwen",
    "anim_workflow": "animate-wan22",

    # --- prompt scaffolding ---
    # {user_prompt} is replaced with whatever the player typed.
    "sprite_prompt_template": (
        "{user_prompt}, "
        "single character full body, standing pose facing forward, "
        "centered composition, clean solid white background, "
        "no shadows on the floor, soft even lighting, "
        "retro fantasy game character illustration, "
        "clear silhouette, high contrast against the background"
    ),
    "walk_prompt_template": (
        "{user_prompt}, "
        "walking forward, smooth natural gait cycle, "
        "looping walk animation, seamless motion"
    ),

    # --- lore source ---
    # Free-text world description. Currently stored only.
    # Next layer: feed into an LLM-composer that derives prompt modifiers
    # from lore + player behaviour, making every run feel like the same
    # world rather than a random sprite soup.
    "lore": "",
}

_data: dict[str, Any] = dict(DEFAULTS)


def _load() -> None:
    global _data
    if os.path.exists(_PATH):
        with open(_PATH) as f:
            stored = json.load(f)
        _data = {**DEFAULTS, **stored}


def _save() -> None:
    with open(_PATH, "w") as f:
        json.dump(_data, f, indent=2)


_load()


def get(key: str) -> Any:
    with _lock:
        return _data.get(key, DEFAULTS.get(key))


def get_all() -> dict:
    with _lock:
        return dict(_data)


def update(patch: dict[str, Any]) -> dict:
    """Replace all recognised keys in patch; ignore unknown ones."""
    with _lock:
        for k, v in patch.items():
            if k in DEFAULTS:
                _data[k] = v
        _save()
        return dict(_data)
