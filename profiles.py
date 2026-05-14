"""
profiles.py — Player profile store with password-based encryption.

Security model:
  - Passwords are hashed with bcrypt (never stored in plaintext).
  - API keys are encrypted with Fernet using a key derived from the
    password via PBKDF2-HMAC-SHA256. This means:
      * profiles.json never contains a readable API key.
      * Even with access to the file an attacker needs the password.
      * We can't recover a key without the password — tell users this.
  - After login the decrypted API key lives in _session (in-memory only).
    Workers call get_api_key() which reads from the session cache; if the
    server restarts the cache is empty and users must log in again.

Persistent storage (profiles.json) schema per entry:
  {
    "username":          str,
    "password_hash":     str   (bcrypt),
    "api_key_encrypted": str   (base64 Fernet ciphertext),
    "api_key_salt":      str   (base64 PBKDF2 salt),
    "created_at":        float
  }
"""

import base64
import json
import os
import threading
import time
import uuid
from typing import Optional

import bcrypt
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "profiles.json")
_lock    = threading.Lock()
_profiles: dict = {}
_session: dict  = {}   # profile_id -> decrypted api_key (in-memory, lost on restart)

_DEFAULT_STATS: dict = {
    "level":      1,
    "xp":         0,
    "xp_to_next": 100,
    "max_hp":     100,
    "attack":     10,
    "defense":    5,
    "inventory":  [],   # list of item dicts
    "equipment":  {},   # slot -> item dict
}

PBKDF2_ITERATIONS = 100_000


class AuthError(Exception):
    pass


# ---------- crypto helpers ----------

def _derive_fernet_key(password: str, salt: bytes, iterations: int = PBKDF2_ITERATIONS) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=iterations,
    )
    return base64.urlsafe_b64encode(kdf.derive(password.encode()))


def _encrypt_key(api_key: str, password: str) -> tuple[str, str]:
    salt      = os.urandom(16)
    fkey      = _derive_fernet_key(password, salt)
    encrypted = Fernet(fkey).encrypt(api_key.encode())
    return base64.b64encode(encrypted).decode(), base64.b64encode(salt).decode()


def _decrypt_key(encrypted_b64: str, salt_b64: str, password: str, iterations: int = PBKDF2_ITERATIONS) -> str:
    fkey = _derive_fernet_key(password, base64.b64decode(salt_b64), iterations)
    try:
        return Fernet(fkey).decrypt(base64.b64decode(encrypted_b64)).decode()
    except InvalidToken:
        raise AuthError("decryption failed — password is incorrect")


# ---------- persistence ----------

def _load() -> None:
    global _profiles
    if os.path.exists(_PATH):
        with open(_PATH) as f:
            _profiles = json.load(f)


def _save() -> None:
    with open(_PATH, "w") as f:
        json.dump(_profiles, f, indent=2)


_load()


# ---------- public API ----------

def register(username: str, password: str, api_key: str) -> dict:
    """
    Create a new profile. Raises AuthError if the username is taken.
    Returns {profile_id, username}.
    """
    username = username.strip()
    if not username or not password or not api_key:
        raise AuthError("username, password, and api_key are all required")

    with _lock:
        for p in _profiles.values():
            if p["username"].lower() == username.lower():
                raise AuthError("username already taken")

        profile_id    = uuid.uuid4().hex[:12]
        password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
        enc_key, salt = _encrypt_key(api_key, password)

        _profiles[profile_id] = {
            "username":          username,
            "password_hash":     password_hash,
            "api_key_encrypted": enc_key,
            "api_key_salt":      salt,
            "kdf_iterations":    PBKDF2_ITERATIONS,
            "created_at":        time.time(),
        }
        _save()
        _session[profile_id] = api_key   # immediately active after register

    return {"profile_id": profile_id, "username": username}


def login(username: str, password: str) -> dict:
    """
    Verify credentials, decrypt API key into session cache.
    Returns {profile_id, username}. Raises AuthError on failure.
    """
    with _lock:
        profile_id, profile = next(
            ((pid, p) for pid, p in _profiles.items()
             if p["username"].lower() == username.strip().lower()),
            (None, None),
        )
        if not profile:
            raise AuthError("invalid username or password")

        if not bcrypt.checkpw(password.encode(), profile["password_hash"].encode()):
            raise AuthError("invalid username or password")

        iters = profile.get("kdf_iterations", 480_000)  # 480k = legacy default
        api_key = _decrypt_key(
            profile["api_key_encrypted"],
            profile["api_key_salt"],
            password,
            iters,
        )
        _session[profile_id] = api_key

    return {"profile_id": profile_id, "username": profile["username"]}


def get_api_key(profile_id: str) -> Optional[str]:
    """Returns the decrypted API key if the session is active, else None."""
    return _session.get(profile_id)


def get_public(profile_id: str) -> Optional[dict]:
    """Public profile data — never includes api_key or password_hash."""
    with _lock:
        p = _profiles.get(profile_id)
    if not p:
        return None
    return {
        "profile_id":     profile_id,
        "username":       p["username"],
        "created_at":     p["created_at"],
        "active_session": profile_id in _session,
    }


def get_stats(profile_id: str) -> Optional[dict]:
    """Return the player's game stats dict, creating defaults if absent."""
    with _lock:
        p = _profiles.get(profile_id)
        if not p:
            return None
        if "stats" not in p:
            p["stats"] = dict(_DEFAULT_STATS)
            p["stats"]["inventory"] = list(_DEFAULT_STATS["inventory"])
            p["stats"]["equipment"] = dict(_DEFAULT_STATS["equipment"])
            _save()
        return dict(p["stats"])


def update_stats(profile_id: str, patch: dict) -> Optional[dict]:
    """Merge allowed keys from patch into the player's stats. Returns updated stats."""
    allowed = set(_DEFAULT_STATS.keys())
    with _lock:
        if profile_id not in _profiles:
            return None
        p = _profiles[profile_id]
        if "stats" not in p:
            p["stats"] = dict(_DEFAULT_STATS)
            p["stats"]["inventory"] = list(_DEFAULT_STATS["inventory"])
            p["stats"]["equipment"] = dict(_DEFAULT_STATS["equipment"])
        for k, v in patch.items():
            if k in allowed:
                p["stats"][k] = v
        _save()
        return dict(p["stats"])


def add_inventory_item(profile_id: str, item: dict) -> None:
    with _lock:
        if profile_id not in _profiles:
            return
        p = _profiles[profile_id]
        if "stats" not in p:
            p["stats"] = dict(_DEFAULT_STATS)
            p["stats"]["inventory"] = []
            p["stats"]["equipment"] = {}
        p["stats"]["inventory"].append(item)
        _save()


def remove_inventory_item(profile_id: str, item_id: str) -> None:
    with _lock:
        if profile_id not in _profiles:
            return
        inv = _profiles[profile_id].get("stats", {}).get("inventory", [])
        _profiles[profile_id]["stats"]["inventory"] = [i for i in inv if i.get("id") != item_id]
        _save()


def set_equipment(profile_id: str, slot: str, item: Optional[dict]) -> None:
    with _lock:
        if profile_id not in _profiles:
            return
        p = _profiles[profile_id]
        if "stats" not in p:
            p["stats"] = dict(_DEFAULT_STATS)
            p["stats"]["inventory"] = []
            p["stats"]["equipment"] = {}
        if item is None:
            p["stats"]["equipment"].pop(slot, None)
        else:
            p["stats"]["equipment"][slot] = item
        _save()
