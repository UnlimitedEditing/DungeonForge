"""
npcs.py — NPC character card registry.

Thread-safe JSON store. Each card defines how an NPC speaks, what they
know, and how they relate to the world. Cards are referenced by npc_id
on experience spawn pool entries.
"""

import json
import os
import threading
import uuid

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "npcs.json")
_lock = threading.Lock()


def _load() -> dict:
    try:
        with open(_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save(data: dict) -> None:
    with open(_PATH, "w") as f:
        json.dump(data, f, indent=2)


def get_all() -> list:
    with _lock:
        return list(_load().values())


def get(npc_id: str) -> dict | None:
    with _lock:
        return _load().get(npc_id)


def upsert(card: dict) -> dict:
    if not card.get("id"):
        card["id"] = str(uuid.uuid4())[:8]
    with _lock:
        data = _load()
        data[card["id"]] = card
        _save(data)
    return card


def delete(npc_id: str) -> bool:
    with _lock:
        data = _load()
        if npc_id not in data:
            return False
        del data[npc_id]
        _save(data)
    return True
