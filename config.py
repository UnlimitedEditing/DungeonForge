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
        "(character turnaround sheet, front view on left half back view on right half, "
        "full body standing pose, centered composition, "
        "clean solid white background, no floor shadows, soft even lighting, "
        "retro fantasy game character illustration, clear silhouette, "
        "high contrast against background), "
        "{user_prompt}, "
        "[multiple subjects, different characters, more than two views, "
        "low quality, blurry, low contrast, monochromatic, "
        "cropped body, partial figure, busy background]"
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

    # --- pose reference slugs (ControlNet) ---
    # Populated by POST /tools/pose/register. Keys are frame indices ("f0"…"f3"),
    # values are the Graydient slug strings used in /image1:{slug} at render time.
    "walk_pose_slugs": {},
    "back_pose_slugs": {},

    # --- item rendering templates ---
    # Used when generating item sprites via POST /items.
    # {item_description} is replaced with the player-supplied item description.
    "item_prompt_template": (
        "{item_description}, "
        "fantasy game item, isolated object, clean solid white background, "
        "retro pixel art item illustration, clear silhouette, high contrast against the background"
    ),
    # Variant templates for item jobs (used like entity variant templates).
    # init_image carries the item identity; prompts describe only the presentation context.
    "icon_prompt_template": (
        "inventory icon, small detailed item portrait, "
        "clean black background, centered composition, no text, no frame, "
        "pixel art style, high detail, clear readability at small size"
    ),
    "world_prompt_template": (
        "item lying on dungeon stone floor, slightly angled three-quarter view, "
        "clean solid white background, clear silhouette, drop shadow"
    ),

    # --- lore source ---
    # Free-text world description fed into the scaffold LLM call.
    "lore": "",

    # --- scaffold / LLM inference ---
    # Graydient persona slug used for scaffold generation.
    # kimi-k2 and qwen3-235b are strong instruction followers good for structured JSON output.
    "scaffold_persona": "kimi-k2",

    # System prompt sent with every scaffold generation request.
    # The user prompt is built from experience.lore + rules summary at request time.
    "scaffold_system_prompt": (
        "You are a world scaffolding engine for a procedurally generated dungeon crawler. "
        "Given a lore description and experience rules, output a JSON object with exactly these fields: "
        "toneVocabulary (array of 5-8 short image-prompt adjectives/phrases), "
        "promptModifier (string of 15-20 words describing visual aesthetic for image generation), "
        "archetypes (array of 3-5 objects each with: name, tierRange [min,max] where values are 1-5, "
        "statMultiplier float 0.2-1.0, evolutionHint string describing what a stronger version looks like), "
        "inferenceHooks (array of objects each with: id string, "
        "trigger object with type ('counter_gte' or 'flag_eq'), key string, value, "
        "promptModifier string, statShift float 0.0-0.3, contextNote string shown to player). "
        "Generate one hook for enemies_killed reaching 10, one for boss_defeated becoming true, "
        "and one or two more based on the world lore. "
        "Respond ONLY with valid JSON. No explanation, no markdown, no code fences."
    ),

    # --- Prop rendering pipeline ---
    # spawn_pipeline: 'turnaround' = character (rembg + front/back split, default)
    #                 'prop'       = environmental object (luminance mask + WAN 360° rotation)
    "spawn_pipeline": "turnaround",

    # Prompt template for prop renders — Qwen positive/negative format.
    # {user_prompt} is replaced with whatever the player typed.
    "prop_prompt_template": (
        "(environmental prop asset, single object centered on clean solid white background, "
        "soft even studio lighting, clear silhouette, high contrast against background, "
        "suitable for 360 degree turntable rotation), "
        "{user_prompt}, "
        "[characters, people, creatures, multiple objects, "
        "complex backgrounds, shadows, reflections, low quality, blurry]"
    ),

    # Graydient workflow slug for prop sprite renders.
    # Falls back to the entity 'workflow' key if empty.
    "prop_workflow": "qwen",

    # HSV Value threshold (0–255) for white-background masking.
    # Pixels brighter than this are candidates for removal.
    # Lower = more aggressive removal of near-white areas.
    "prop_luma_threshold": 230,

    # HSV Saturation threshold (0–1) for white-background masking.
    # Pixels with saturation below this value are considered background.
    # Raise to catch more off-white; lower to protect desaturated prop colours.
    "prop_luma_sat_threshold": 0.18,

    # Number of frames extracted from the WAN rotation video.
    # Must divide evenly into 360 for clean angle mapping (4, 8, or 16).
    "prop_frame_count": 8,

    # Graydient workflow slug for 360° rotation video generation.
    "prop_rotation_workflow": "animate-wan22",

    # Prompt sent to the WAN rotation workflow. Inline LoRA weights and
    # Graydient /fps /length flags are supported inside this string.
    "prop_rotation_prompt": (
        "((EXACTLY one 360 degree rotation, subject rotates once, singular rotating view)) "
        "subject steadily rotates 360 degrees in one full rotation at a slow, even rate. "
        "Subject does not breathe, rotating while frozen stiff. "
        "[multiple rotations, acceleration, variable speed rotation, "
        "breathing, looking around, idle, movement, subtle movement] "
        "/fps:30 /length:90 <360-rotation-high-wan:1> <360-rotation-low-wan:0.5>"
    ),

    # Extra options appended to the Graydient options string for rotation renders.
    # Use this for /size:, /seed: overrides, etc. Leave empty for workflow defaults.
    "prop_rotation_options": "/size:640x640",

    # --- Arcanum: progression tuning ---
    "xp_multiplier":   1.0,   # multiplied on every XP gain
    "level_hp_gain":   10,    # max_hp increase per level-up
    "level_atk_gain":  2,     # attack increase per level-up
    "level_def_gain":  1,     # defense increase per level-up

    # --- Machinarium: combat rules ---
    "agro_range":         6.0,
    "attack_range":       1.8,
    "melee_range":        2.5,
    "entity_attack_cd":   2.5,
    "player_attack_cd":   0.55,
    "entity_level_min":   1,
    "entity_level_max":   5,
    "drop_chance":        0.30,

    # --- Substance Lab: drop pool ---
    # List of item templates available as entity death drops.
    # Each entry: {name, type, subtype, stat_key, stat_val, rarity}
    # type: weapon | armor | consumable | accessory
    # rarity: common | uncommon | rare | legendary
    "drop_pool": [
        {"name": "Health Potion",     "type": "consumable", "subtype": "",        "stat_key": "hp_restore", "stat_val": 30, "rarity": "common"},
        {"name": "Iron Sword",        "type": "weapon",     "subtype": "melee",   "stat_key": "attack",     "stat_val": 5,  "rarity": "common"},
        {"name": "Wooden Shield",     "type": "armor",      "subtype": "offhand", "stat_key": "defense",    "stat_val": 3,  "rarity": "common"},
        {"name": "Leather Vest",      "type": "armor",      "subtype": "body",    "stat_key": "defense",    "stat_val": 5,  "rarity": "common"},
        {"name": "Ring of Swiftness", "type": "accessory",  "subtype": "",        "stat_key": "attack",     "stat_val": 2,  "rarity": "uncommon"},
        {"name": "Hunter's Bow",      "type": "weapon",     "subtype": "ranged",  "stat_key": "attack",     "stat_val": 4,  "rarity": "uncommon"},
    ],
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
