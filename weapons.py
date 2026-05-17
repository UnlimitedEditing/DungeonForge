"""weapons.py — Weapon type registry (file-backed).

Each weapon type defines:
  - id, name, attack_type (slash | stab | ranged)
  - stats: damage, speed, range
  - reference_image: filename in sprites/ used as init_image for img2img renders
  - sprite_name: last successfully rendered canonical sprite for this type
  - prompt_template: optional per-type prompt override
"""

import json
import os
import threading

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "weapons.json")
_lock = threading.Lock()
_data: dict = {}   # id → weapon_type dict


def _load() -> None:
    global _data
    if os.path.exists(_PATH):
        try:
            with open(_PATH) as f:
                _data = json.load(f)
        except Exception:
            _data = {}


def _save() -> None:
    with open(_PATH, "w") as f:
        json.dump(_data, f, indent=2)


_load()


def get_all() -> list:
    with _lock:
        return list(_data.values())


def get(wt_id: str) -> dict | None:
    with _lock:
        return _data.get(wt_id)


def upsert(wt: dict) -> dict:
    with _lock:
        _data[wt["id"]] = wt
        _save()
    return wt


def delete(wt_id: str) -> bool:
    with _lock:
        if wt_id not in _data:
            return False
        del _data[wt_id]
        _save()
        return True


def set_sprite(wt_id: str, sprite_name: str) -> None:
    """Update the canonical sprite for a weapon type after a successful render."""
    with _lock:
        if wt_id in _data:
            _data[wt_id]["sprite_name"] = sprite_name
            _save()
