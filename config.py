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
    # sprite_workflow: txt2img — generates the base character sprite.
    # variant_workflow: img2img/edit — modifies the original sprite to produce
    #   alternative poses/states while preserving character identity.
    "workflow": "qwen",
    "variant_workflow": "edit-qwen-rapid",

    # How strongly the edit workflow departs from the source sprite.
    # Lower = closer to original; higher = more freedom (but less consistent).
    "variant_strength": 0.65,

    # Number of frames in walk cycle sprite sheets (front + back).
    # Frames are rendered sequentially and stitched into a single horizontal sheet.
    "walk_frame_count": 4,

    # --- sprite prompt scaffolding ---
    # {user_prompt} is replaced with whatever the player typed.
    "sprite_prompt_template": (
        "{user_prompt}, "
        "single character full body, standing pose facing forward, "
        "centered composition, clean solid white background, "
        "no shadows on the floor, soft even lighting, "
        "retro fantasy game character illustration, "
        "clear silhouette, high contrast against the background"
    ),

    # --- variant state templates ---
    # All variants use the original sprite as init_image via the edit workflow.
    # Prompts describe ONLY the posture/pose change — no character description.
    # The init_image carries all identity; re-describing features causes drift.
    "walk_prompt_template": (
        "walking pose, mid-stride, one foot forward, weight shifted, "
        "full body visible, centered, clean solid white background"
    ),
    "corpse_prompt_template": (
        "lying dead on the ground, lifeless, collapsed posture, "
        "full body visible, centered, clean solid white background"
    ),
    "damage_prompt_template": (
        "recoiling from a hit, flinching, body twisting away from impact, "
        "full body visible, centered, clean solid white background"
    ),
    "back_prompt_template": (
        "turned around, facing away, rear view, back of body visible, "
        "full body visible, centered, clean solid white background"
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
