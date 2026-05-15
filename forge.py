"""
forge.py — The render service.

Responsibilities:
  1. Manage player profiles (API key → persistent identity).
  2. Expose runtime config (workflows, prompt templates, lore) via /config.
  3. Accept render briefs (prompt + profile_id) from the game via HTTP.
  4. Submit sprite renders to Graydient (txt2img workflow).
  5. Auto-queue variant state jobs for every completed sprite — walk, corpse,
     damage, back — via an image-editing workflow (edit-qwen-rapid by default)
     using the original Graydient URL as init_image.
  6. Run all image results through rembg for clean alpha.
  7. Serve the Three.js game itself from the same origin.

All tunable values (workflows, prompt templates, lore) live in config.py
and are read at job-creation time so changes take effect without restart.
"""

import json
import logging
import os
import queue
import random
import threading
import time
import uuid
from io import BytesIO
from typing import Optional

import dotenv
import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel
from rembg import remove

import config
import graydient_client
import profiles

dotenv.load_dotenv()

# ---------- paths ----------

SPRITES_DIR = os.path.join(os.path.dirname(__file__), "sprites")
GAME_DIR    = os.path.join(os.path.dirname(__file__), "game")
HOST        = os.environ.get("FORGE_HOST", "127.0.0.1")
PORT        = int(os.environ.get("FORGE_PORT", "8000"))

os.makedirs(SPRITES_DIR, exist_ok=True)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("forge")

# ---------- prompt scaffolding ----------
# Templates are read from config at job-creation time so player edits
# in the config panel take effect immediately without a server restart.

ENTITY_VARIANT_TYPES = ("walk", "corpse", "damage", "back")
ITEM_VARIANT_TYPES   = ("icon", "world")
VARIANT_TYPES        = ENTITY_VARIANT_TYPES + ITEM_VARIANT_TYPES

# Key-pose suffixes for walk cycle frames.
# Appended to the user prompt when rendering each frame of a sprite sheet.
# Frame count can be 2 or 4; first N suffixes are used.
WALK_FRAME_SUFFIXES = [
    "walk cycle frame 1 of 4: left foot forward contact pose, right arm swinging forward, weight transferring, mid-stride",
    "walk cycle frame 2 of 4: passing position, weight on left leg, right leg swinging through, slight body dip",
    "walk cycle frame 3 of 4: right foot forward contact pose, left arm swinging forward, weight transferring, mid-stride",
    "walk cycle frame 4 of 4: passing position, weight on right leg, left leg swinging through, slight body dip",
]
BACK_FRAME_SUFFIXES = [
    "back view walk cycle frame 1 of 4: left foot forward seen from behind, right arm forward, mid-stride",
    "back view walk cycle frame 2 of 4: passing position from behind, weight on left leg, right leg swinging through, slight dip",
    "back view walk cycle frame 3 of 4: right foot forward seen from behind, left arm forward, mid-stride",
    "back view walk cycle frame 4 of 4: passing position from behind, weight on right leg, left leg swinging through, slight dip",
]

def build_sprite_prompt(user_prompt: str, active_modifier: str = "") -> str:
    base = config.get("sprite_prompt_template").format(user_prompt=user_prompt.strip())
    if active_modifier:
        base = f"{base}, {active_modifier}"
    return base

def build_variant_prompt(variant_type: str) -> str:
    """Return the prompt for a variant render. No subject description —
    the edit workflow's init_image already carries identity."""
    return config.get(f"{variant_type}_prompt_template") or ""

def build_frame_prompt(suffix: str) -> str:
    """Return the pose-only prompt for a single walk-cycle frame. No character
    description — re-stating features in an edit prompt causes identity drift."""
    return (
        f"{suffix}, "
        "full body visible, centered composition, clean solid white background, "
        "no shadows on the floor, clear silhouette"
    )

# ---------- stat generation ----------

def roll_entity_stats(stat_tier: float = 0.5) -> dict:
    """
    Roll combat stats for a newly created entity.

    stat_tier: 0.0–1.0 float from the world scaffold's archetype statMultiplier.
    Maps linearly onto the level range so lore-coherent concepts get
    appropriate power rather than random rolls.
    Defaults to 0.5 (mid-range) when no scaffold is active.
    """
    import config as _cfg
    level_min = int(_cfg.get("entity_level_min") or 1)
    level_max = int(_cfg.get("entity_level_max") or 5)
    # Clamp tier and derive a level deterministically from it
    tier   = max(0.0, min(1.0, stat_tier))
    level  = max(level_min, min(level_max, round(level_min + tier * (level_max - level_min))))
    max_hp = 20 + (level - 1) * 10
    return {
        "level":      level,
        "max_hp":     max_hp,
        "hp":         max_hp,
        "attack":     5 + (level - 1) * 3,
        "defense":    2 + (level - 1) * 2,
        "xp_reward":  level * 25,
    }


def generate_item_stats(item_type: str, subtype: str, rarity: str) -> dict:
    """Derive item stats from type, subtype, and rarity."""
    mult = {"common": 1.0, "uncommon": 1.5, "rare": 2.5, "legendary": 4.0}.get(rarity, 1.0)
    base: dict = {"attack": 0, "defense": 0, "range": 0, "hp_restore": 0}
    if item_type == "weapon":
        base["attack"]     = max(1, int(8 * mult))
        if subtype == "ranged":
            base["range"]  = 15
    elif item_type == "armor":
        base["defense"]    = max(1, int(5 * mult))
    elif item_type == "consumable":
        base["hp_restore"] = max(1, int(30 * mult))
    elif item_type == "accessory":
        base["attack"]     = max(1, int(2 * mult))
        base["defense"]    = max(1, int(2 * mult))
    return base


# ---------- models ----------

class RegisterRequest(BaseModel):
    username: str
    password: str
    api_key: str

class LoginRequest(BaseModel):
    username: str
    password: str

class ConfigUpdate(BaseModel):
    model_config = {"extra": "allow"}
    workflow: str = ""
    variant_workflow: str = ""
    variant_strength: float = 0.65
    sprite_prompt_template: str = ""
    lore: str = ""

    def full_dict(self) -> dict:
        """Return all fields including extras."""
        return {**self.model_dump(), **self.model_extra}

class JobRequest(BaseModel):
    prompt: str
    profile_id: str
    prompt_modifier: Optional[str] = None   # active scaffold modifier from lore-engine
    stat_tier: Optional[float] = None       # 0.0-1.0 from scaffold archetype; None = roll random

class VariantRequest(BaseModel):
    profile_id: str
    prompt: Optional[str] = None   # if provided, overrides the template for this regen

class ItemRequest(BaseModel):
    profile_id: str
    name: str
    description: str
    type: str       # weapon | armor | consumable | accessory
    subtype: str = ""   # melee | ranged (weapon); body | helmet | boots (armor)
    rarity: str = "common"

class EquipRequest(BaseModel):
    item: Optional[dict] = None   # None to unequip

class PoseRegisterRequest(BaseModel):
    profile_id: str
    frame_type: str   # e.g. "walk_f0", "back_f2"
    image_data: str   # base64 data URI of the rendered pose JPEG

class Job(BaseModel):
    id: str
    profile_id: str
    prompt: str
    full_prompt: str
    status: str           # queued | rendering | processing | done | failed
    sprite_name: Optional[str] = None
    source_url: Optional[str] = None   # pre-rembg Graydient URL; init_image for variants
    variant_job_ids: dict = {}         # variant_type -> job_id
    error: Optional[str] = None
    created_at: float
    finished_at: Optional[float] = None
    job_type: str = "entity"           # "entity" | "item"
    entity_stats: Optional[dict] = None   # combat stats, rolled for entity jobs
    item_meta: Optional[dict] = None      # {name, type, subtype, rarity, stats} for item jobs

class VariantJob(BaseModel):
    id: str
    sprite_job_id: str
    variant_type: str      # walk | corpse | damage | back
    prompt: str
    status: str            # queued | rendering | processing | done | failed
    sprite_name: Optional[str] = None
    frame_count: int = 1   # 1 for static variants; N for sprite-sheet walk/back cycles
    error: Optional[str] = None
    created_at: float
    finished_at: Optional[float] = None

JOBS:         dict[str, Job]        = {}
VARIANT_JOBS: dict[str, VariantJob] = {}

JOB_QUEUE:         "queue.Queue[str]" = queue.Queue()
VARIANT_JOB_QUEUE: "queue.Queue[str]" = queue.Queue()

JOBS_LOCK         = threading.Lock()
VARIANT_JOBS_LOCK = threading.Lock()
_PERSIST_LOCK     = threading.Lock()

_JOBS_PATH = os.path.join(os.path.dirname(__file__), "jobs.json")


def _persist_snapshot() -> None:
    """Write all completed jobs and variant jobs to disk. Called from worker
    threads after each completion — safe to call with no locks held."""
    with _PERSIST_LOCK:
        with JOBS_LOCK:
            done_jobs = [j.model_dump() for j in JOBS.values() if j.status == "done"]
        with VARIANT_JOBS_LOCK:
            done_variants = [v.model_dump() for v in VARIANT_JOBS.values() if v.status == "done"]
        try:
            with open(_JOBS_PATH, "w") as f:
                json.dump({"jobs": done_jobs, "variant_jobs": done_variants}, f, indent=2)
        except OSError:
            log.exception("failed to persist jobs snapshot")


def _load_snapshot() -> None:
    if not os.path.exists(_JOBS_PATH):
        return
    try:
        with open(_JOBS_PATH) as f:
            data = json.load(f)
        for jd in data.get("jobs", []):
            try:
                JOBS[jd["id"]] = Job(**jd)
            except Exception as e:
                log.warning("skipping corrupt job entry: %s", e)
        for vd in data.get("variant_jobs", []):
            try:
                VARIANT_JOBS[vd["id"]] = VariantJob(**vd)
            except Exception as e:
                log.warning("skipping corrupt variant entry: %s", e)
        log.info("restored %d jobs / %d variants from disk",
                 len(data.get("jobs", [])), len(data.get("variant_jobs", [])))
    except Exception:
        log.exception("failed to load jobs snapshot — starting fresh")


_load_snapshot()

# ---------- helpers ----------

def render_variant_frame(
    prompt: str,
    source_url: str,
    api_key: str,
    label: str,
    control_slug: Optional[str] = None,
) -> str:
    """Render one frame via the edit workflow. Returns the Graydient image URL."""
    collected: dict = {"url": None}

    def on_event(event, _label=label):
        if "rendering_done" in event:
            data = event["rendering_done"]
            info = graydient_client.render_info(data["render_hash"], api_key)
            collected["url"] = graydient_client.extract_image_url(info)
            log.info("[%s] frame url=%s", _label, collected["url"])

    graydient_client.render_create(
        prompt=prompt,
        workflow=config.get("variant_workflow"),
        api_key=api_key,
        on_event=on_event,
        init_image=source_url,
        strength=float(config.get("variant_strength")),
        control_slug=control_slug,
    )
    if not collected["url"]:
        raise RuntimeError("render stream closed with no URL")
    return collected["url"]


def stitch_frames(frame_paths: list[str]) -> Image.Image:
    """
    Combine rembg'd frames into a horizontal sprite sheet with uniform-width columns.
    Frames are padded to the same dimensions so UV frame boundaries are evenly spaced
    (frameIndex / N gives the exact left edge of each frame).
    """
    frames = [Image.open(p).convert("RGBA") for p in frame_paths]
    max_h = max(f.height for f in frames)
    max_w = max(f.width  for f in frames)
    n = len(frames)
    sheet = Image.new("RGBA", (max_w * n, max_h), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        # Scale up to max_h if shorter, preserving aspect ratio
        if f.height < max_h:
            new_w = max(1, int(f.width * max_h / f.height))
            f = f.resize((new_w, max_h), Image.LANCZOS)
        # Centre horizontally within its column slot
        x = i * max_w + (max_w - f.width) // 2
        sheet.paste(f, (x, 0), f)
    return sheet


# ---------- sprite worker ----------

def render_one(job: Job, api_key: str) -> str:
    """Submit a sprite render, block until URL returned."""
    collected = {"url": None}

    def on_event(event):
        if "rendering_done" in event:
            data = event["rendering_done"]
            info = graydient_client.render_info(data["render_hash"], api_key)
            collected["url"] = graydient_client.extract_image_url(info)
            log.info("[%s] sprite done, url=%s", job.id, collected["url"])

    workflow = config.get("workflow")
    log.info("[%s] submitting sprite (workflow=%s)", job.id, workflow)
    graydient_client.render_create(
        prompt=job.full_prompt,
        workflow=workflow,
        api_key=api_key,
        on_event=on_event,
    )

    if not collected["url"]:
        raise RuntimeError("graydient stream closed with no image URL")
    return collected["url"]

def process_sprite(raw_bytes: bytes, out_path: str) -> None:
    raw = Image.open(BytesIO(raw_bytes)).convert("RGBA")
    cleaned = remove(raw)
    bbox = cleaned.getbbox()
    if bbox:
        cleaned = cleaned.crop(bbox)
    cleaned.save(out_path, "PNG")

def render_worker():
    log.info("sprite worker started")
    while True:
        job_id = JOB_QUEUE.get()
        try:
            with JOBS_LOCK:
                job = JOBS[job_id]
                job.status = "rendering"

            api_key = profiles.get_api_key(job.profile_id)
            if not api_key:
                raise RuntimeError(f"no api key for profile {job.profile_id}")

            log.info("[%s] starting sprite: %s", job.id, job.prompt)
            url = render_one(job, api_key)

            # Store the original Graydient URL before rembg — variants use it as init_image.
            with JOBS_LOCK:
                job.source_url = url
                job.status = "processing"

            log.info("[%s] downloading sprite %s", job.id, url)
            resp = requests.get(url, timeout=120)
            resp.raise_for_status()

            sprite_name = f"{job.id}.png"
            process_sprite(resp.content, os.path.join(SPRITES_DIR, sprite_name))

            # Auto-queue variant states: entity jobs get combat poses,
            # item jobs get presentation variants (icon + world).
            auto_vtypes = ENTITY_VARIANT_TYPES if job.job_type == "entity" else ITEM_VARIANT_TYPES
            variant_ids: dict = {}
            for vtype in auto_vtypes:
                vid = uuid.uuid4().hex[:8]
                vprompt = build_variant_prompt(vtype)
                vj = VariantJob(
                    id=vid, sprite_job_id=job.id, variant_type=vtype,
                    prompt=vprompt, status="queued", created_at=time.time(),
                )
                with VARIANT_JOBS_LOCK:
                    VARIANT_JOBS[vid] = vj
                VARIANT_JOB_QUEUE.put(vid)
                variant_ids[vtype] = vid

            with JOBS_LOCK:
                job.sprite_name     = sprite_name
                job.variant_job_ids = variant_ids
                job.status          = "done"
                job.finished_at     = time.time()

            log.info("[%s] sprite saved, variants queued: %s", job.id, variant_ids)
            _persist_snapshot()

        except Exception:
            log.exception("[%s] sprite FAILED", job_id)
            with JOBS_LOCK:
                if job_id in JOBS:
                    JOBS[job_id].status = "failed"
                    JOBS[job_id].finished_at = time.time()
        finally:
            JOB_QUEUE.task_done()

def variant_worker():
    log.info("variant worker started")
    while True:
        var_id = VARIANT_JOB_QUEUE.get()
        try:
            with VARIANT_JOBS_LOCK:
                vj = VARIANT_JOBS[var_id]
                vj.status = "rendering"

            with JOBS_LOCK:
                sprite_job = JOBS[vj.sprite_job_id]

            api_key    = profiles.get_api_key(sprite_job.profile_id)
            source_url = sprite_job.source_url
            if not api_key or not source_url:
                raise RuntimeError("missing api key or source url for variant")

            if vj.variant_type in ("walk", "back"):
                # ── Sprite sheet: render N key-pose frames, rembg each, stitch ──
                frame_count = int(config.get("walk_frame_count"))
                suffixes = (WALK_FRAME_SUFFIXES if vj.variant_type == "walk"
                            else BACK_FRAME_SUFFIXES)[:frame_count]

                log.info("[variant %s] walk sheet: %d frames (type=%s)",
                         var_id, frame_count, vj.variant_type)

                slugs_key = "walk_pose_slugs" if vj.variant_type == "walk" else "back_pose_slugs"
                pose_slugs = config.get(slugs_key) or {}

                frame_paths: list[str] = []
                for i, suffix in enumerate(suffixes):
                    frame_prompt = build_frame_prompt(suffix)
                    label = f"{var_id}/{vj.variant_type}/f{i}"
                    log.info("[variant %s] rendering frame %d/%d", var_id, i + 1, frame_count)
                    control_slug = pose_slugs.get(f"f{i}")

                    frame_url = render_variant_frame(
                        frame_prompt, source_url, api_key, label, control_slug=control_slug
                    )

                    with VARIANT_JOBS_LOCK:
                        vj.status = "processing"

                    resp = requests.get(frame_url, timeout=120)
                    resp.raise_for_status()

                    frame_path = os.path.join(SPRITES_DIR, f"{var_id}_{vj.variant_type}_f{i}.png")
                    process_sprite(resp.content, frame_path)
                    frame_paths.append(frame_path)

                    with VARIANT_JOBS_LOCK:
                        vj.status = "rendering"  # back to rendering while more frames remain

                sheet_img  = stitch_frames(frame_paths)
                sprite_name = f"{var_id}_{vj.variant_type}_sheet.png"
                sheet_img.save(os.path.join(SPRITES_DIR, sprite_name), "PNG")

                # Clean up per-frame PNGs
                for p in frame_paths:
                    try:
                        os.remove(p)
                    except OSError:
                        pass

                with VARIANT_JOBS_LOCK:
                    vj.sprite_name = sprite_name
                    vj.frame_count = frame_count
                    vj.status      = "done"
                    vj.finished_at = time.time()

                log.info("[variant %s] sheet saved: %s (%d frames)", var_id, sprite_name, frame_count)
                _persist_snapshot()

            else:
                # ── Single-frame static variant (corpse, damage) ──
                log.info("[variant %s] submitting %s", var_id, vj.variant_type)
                url = render_variant_frame(vj.prompt, source_url, api_key, var_id)

                with VARIANT_JOBS_LOCK:
                    vj.status = "processing"

                resp = requests.get(url, timeout=120)
                resp.raise_for_status()

                sprite_name = f"{var_id}_{vj.variant_type}.png"
                process_sprite(resp.content, os.path.join(SPRITES_DIR, sprite_name))

                with VARIANT_JOBS_LOCK:
                    vj.sprite_name = sprite_name
                    vj.status      = "done"
                    vj.finished_at = time.time()

                log.info("[variant %s] saved %s", var_id, sprite_name)
                _persist_snapshot()

        except Exception:
            log.exception("[variant %s] FAILED", var_id)
            with VARIANT_JOBS_LOCK:
                if var_id in VARIANT_JOBS:
                    VARIANT_JOBS[var_id].status = "failed"
                    VARIANT_JOBS[var_id].finished_at = time.time()
        finally:
            VARIANT_JOB_QUEUE.task_done()

threading.Thread(target=render_worker,  daemon=True).start()
threading.Thread(target=variant_worker, daemon=True).start()

# ---------- API ----------

app = FastAPI(title="Dungeon Forge")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

# -- config --

@app.get("/config")
def get_config():
    return config.get_all()

@app.put("/config")
def set_config(cfg: ConfigUpdate):
    updated = config.update(cfg.full_dict())
    log.info("config updated: workflow=%s variant_workflow=%s strength=%.2f",
             updated["workflow"], updated["variant_workflow"], updated["variant_strength"])
    return updated

# -- profiles --

@app.post("/profiles/register")
def register_profile(req: RegisterRequest):
    api_key = req.api_key.strip()
    if not api_key:
        raise HTTPException(400, "api_key is empty")
    if not graydient_client.validate_key(api_key):
        raise HTTPException(401, "API key rejected by Graydient")
    try:
        return profiles.register(req.username, req.password, api_key)
    except profiles.AuthError as e:
        raise HTTPException(400, str(e))

@app.post("/profiles/login")
def login_profile(req: LoginRequest):
    try:
        return profiles.login(req.username, req.password)
    except profiles.AuthError as e:
        raise HTTPException(401, str(e))

@app.get("/profiles/{profile_id}")
def get_profile(profile_id: str):
    p = profiles.get_public(profile_id)
    if not p:
        raise HTTPException(404, "profile not found")
    return p

# -- sprite jobs --

@app.post("/jobs")
def create_job(req: JobRequest):
    prompt = req.prompt.strip()
    if not prompt:
        raise HTTPException(400, "prompt is empty")
    if not profiles.get_api_key(req.profile_id):
        raise HTTPException(401, "session expired — please log in again")
    job_id = uuid.uuid4().hex[:8]
    stat_tier = req.stat_tier if req.stat_tier is not None else 0.5
    job = Job(
        id=job_id,
        profile_id=req.profile_id,
        prompt=prompt,
        full_prompt=build_sprite_prompt(prompt, req.prompt_modifier or ""),
        status="queued",
        created_at=time.time(),
        job_type="entity",
        entity_stats=roll_entity_stats(stat_tier),
    )
    with JOBS_LOCK:
        JOBS[job_id] = job
    JOB_QUEUE.put(job_id)
    log.info("[%s] queued: %s", job_id, prompt)
    return job

@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    with JOBS_LOCK:
        if job_id not in JOBS:
            raise HTTPException(404, "no such job")
        return JOBS[job_id]

@app.get("/jobs")
def list_jobs():
    with JOBS_LOCK:
        return list(JOBS.values())

# -- variant jobs --

@app.get("/variant-jobs/{var_job_id}")
def get_variant_job(var_job_id: str):
    with VARIANT_JOBS_LOCK:
        if var_job_id not in VARIANT_JOBS:
            raise HTTPException(404, "no such variant job")
        return VARIANT_JOBS[var_job_id]

@app.post("/jobs/{sprite_job_id}/variants/{variant_type}")
def trigger_variant(sprite_job_id: str, variant_type: str, req: VariantRequest):
    if variant_type not in VARIANT_TYPES:
        raise HTTPException(400, f"unknown variant type; must be one of {VARIANT_TYPES}")
    if not profiles.get_api_key(req.profile_id):
        raise HTTPException(401, "session expired — please log in again")
    with JOBS_LOCK:
        if sprite_job_id not in JOBS:
            raise HTTPException(404, "sprite job not found")
        sprite_job = JOBS[sprite_job_id]
    if not sprite_job.source_url:
        raise HTTPException(400, "sprite has no source URL yet — still rendering?")

    # Caller may supply a custom pose override; otherwise use the standard pose template.
    # Never include the original character description — identity comes from init_image.
    prompt = req.prompt.strip() if req.prompt and req.prompt.strip() \
             else build_variant_prompt(variant_type)

    var_id = uuid.uuid4().hex[:8]
    vj = VariantJob(
        id=var_id, sprite_job_id=sprite_job_id, variant_type=variant_type,
        prompt=prompt, status="queued", created_at=time.time(),
    )
    with VARIANT_JOBS_LOCK:
        VARIANT_JOBS[var_id] = vj
    VARIANT_JOB_QUEUE.put(var_id)

    # Update the parent job's variant_job_ids so clients see the new ID
    with JOBS_LOCK:
        sprite_job.variant_job_ids[variant_type] = var_id

    log.info("[%s] variant %s re-queued as %s", sprite_job_id, variant_type, var_id)
    return vj

# -- items --

@app.post("/items")
def create_item(req: ItemRequest):
    if not profiles.get_api_key(req.profile_id):
        raise HTTPException(401, "session expired — please log in again")
    description = req.description.strip()
    if not description:
        raise HTTPException(400, "description is empty")

    stats = generate_item_stats(req.type, req.subtype, req.rarity)
    item_prompt = config.get("item_prompt_template").format(item_description=description)

    job_id = uuid.uuid4().hex[:8]
    job = Job(
        id=job_id,
        profile_id=req.profile_id,
        prompt=req.description,
        full_prompt=item_prompt,
        status="queued",
        created_at=time.time(),
        job_type="item",
        item_meta={
            "name":    req.name,
            "type":    req.type,
            "subtype": req.subtype,
            "rarity":  req.rarity,
            "stats":   stats,
        },
    )
    with JOBS_LOCK:
        JOBS[job_id] = job
    JOB_QUEUE.put(job_id)
    log.info("[%s] item queued: %s (%s/%s)", job_id, req.name, req.type, req.rarity)
    return job

@app.get("/items/{job_id}")
def get_item(job_id: str):
    with JOBS_LOCK:
        if job_id not in JOBS or JOBS[job_id].job_type != "item":
            raise HTTPException(404, "no such item")
        return JOBS[job_id]

@app.get("/items")
def list_items():
    with JOBS_LOCK:
        return [j for j in JOBS.values() if j.job_type == "item"]

# -- player stats --

@app.get("/profiles/{profile_id}/stats")
def get_profile_stats(profile_id: str):
    stats = profiles.get_stats(profile_id)
    if stats is None:
        raise HTTPException(404, "profile not found")
    return stats

@app.put("/profiles/{profile_id}/stats")
def put_profile_stats(profile_id: str, patch: dict):
    result = profiles.update_stats(profile_id, patch)
    if result is None:
        raise HTTPException(404, "profile not found")
    return result

@app.post("/profiles/{profile_id}/inventory")
def add_inventory(profile_id: str, item: dict):
    profiles.add_inventory_item(profile_id, item)
    return {"ok": True}

@app.delete("/profiles/{profile_id}/inventory/{item_id}")
def remove_inventory(profile_id: str, item_id: str):
    profiles.remove_inventory_item(profile_id, item_id)
    return {"ok": True}

@app.put("/profiles/{profile_id}/equipment/{slot}")
def equip_item_endpoint(profile_id: str, slot: str, body: EquipRequest):
    profiles.set_equipment(profile_id, slot, body.item)
    return {"ok": True}

# -- pose tools --

@app.get("/tools/pose/slugs")
def get_pose_slugs():
    return {
        "walk_pose_slugs": config.get("walk_pose_slugs") or {},
        "back_pose_slugs": config.get("back_pose_slugs") or {},
    }

@app.post("/tools/pose/register")
def register_pose(req: PoseRegisterRequest):
    api_key = profiles.get_api_key(req.profile_id)
    if not api_key:
        raise HTTPException(401, "session expired — please log in again")

    frame_type = req.frame_type.strip()   # e.g. "walk_f0" or "back_f2"
    slug = f"df_{frame_type}"

    # Persist the slug into config under the appropriate dict
    if frame_type.startswith("back_"):
        fi = frame_type[len("back_"):]   # "f0", "f1", …
        slugs = dict(config.get("back_pose_slugs") or {})
        slugs[fi] = slug
        config.update({"back_pose_slugs": slugs})
    else:
        fi = frame_type[len("walk_"):]   # "f0", "f1", …
        slugs = dict(config.get("walk_pose_slugs") or {})
        slugs[fi] = slug
        config.update({"walk_pose_slugs": slugs})

    # Upload in background — fire and forget
    def _upload():
        try:
            graydient_client.upload_control_image(req.image_data, slug, api_key)
            log.info("pose reference uploaded: slug=%s frame=%s", slug, frame_type)
        except Exception:
            log.exception("pose reference upload failed: slug=%s", slug)

    threading.Thread(target=_upload, daemon=True).start()

    log.info("pose register: frame_type=%s slug=%s profile=%s", frame_type, slug, req.profile_id)
    return {"slug": slug, "frame_type": frame_type}

# -- experiences --

_EXPERIENCES_PATH = os.path.join(os.path.dirname(__file__), "experiences.json")
_EXP_LOCK = threading.Lock()

_SYSTEM_EXPERIENCES = [
    {
        "id": "latentcrawl",
        "name": "LatentCrawl",
        "description": "Roguelike dungeon crawler. Fight your way through procedurally generated halls to reach the exit. How deep can you go?",
        "version": "0.1.0",
        "baseId": None,
        "author": "system",
        "locked": True,
        "mode": "roguelike",
        "level": {"seed": 42, "roomCount": 18, "gridSize": 12, "tileset": "dungeon-stone"},
        "world": {"skyboxPrompt": "underground cavern ancient dungeon atmospheric dark fantasy", "ambientColor": "0x3a2818", "fogColor": "0x000000", "fogNear": 6, "fogFar": 25},
        "entities": {"enemiesPerRoom": 2, "bossRoom": True, "spawnPool": []},
        "rules": {"playerSpeed": 4.5, "playerHp": 100, "friendlyFire": False},
        "lore": {"title": "The Dungeon Beneath", "description": "Ancient halls, forgotten horrors."},
    }
]

def _load_experiences() -> list:
    try:
        with open(_EXPERIENCES_PATH, "r") as f:
            stored = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        stored = []
    # Merge: system experiences always present, user forks from file
    sys_ids = {e["id"] for e in _SYSTEM_EXPERIENCES}
    user_exps = [e for e in stored if e.get("id") not in sys_ids]
    return _SYSTEM_EXPERIENCES + user_exps

def _save_experiences(exps: list) -> None:
    # Only persist non-system experiences
    user_exps = [e for e in exps if not e.get("locked")]
    with open(_EXPERIENCES_PATH, "w") as f:
        json.dump(user_exps, f, indent=2)

@app.get("/experiences")
def list_experiences():
    with _EXP_LOCK:
        return _load_experiences()

@app.get("/experiences/{exp_id}")
def get_experience(exp_id: str):
    with _EXP_LOCK:
        for e in _load_experiences():
            if e["id"] == exp_id:
                return e
    raise HTTPException(404, "experience not found")

@app.post("/experiences")
def create_experience(body: dict):
    if not body.get("id"):
        raise HTTPException(400, "id is required")
    with _EXP_LOCK:
        exps = _load_experiences()
        ids = {e["id"] for e in exps}
        if body["id"] in ids:
            raise HTTPException(409, "id already exists")
        exps.append(body)
        _save_experiences(exps)
    return body

@app.put("/experiences/{exp_id}")
def update_experience(exp_id: str, body: dict):
    with _EXP_LOCK:
        exps = _load_experiences()
        for i, e in enumerate(exps):
            if e["id"] == exp_id:
                if e.get("locked"):
                    raise HTTPException(403, "system experience is locked — fork it first")
                exps[i] = {**e, **body, "id": exp_id}
                _save_experiences(exps)
                return exps[i]
    raise HTTPException(404, "experience not found")

@app.get("/experiences/{exp_id}/base")
def get_base_experience(exp_id: str):
    with _EXP_LOCK:
        exps = _load_experiences()
        exp_map = {e["id"]: e for e in exps}
        cur = exp_map.get(exp_id)
        if not cur:
            raise HTTPException(404, "experience not found")
        while cur.get("baseId") and cur["baseId"] in exp_map:
            cur = exp_map[cur["baseId"]]
        return cur

@app.get("/experiences/{exp_id}/code")
def get_experience_code(exp_id: str):
    import base64
    exp = get_experience(exp_id)
    code = "EXP:" + base64.b64encode(json.dumps(exp).encode()).decode()
    return {"code": code}

@app.post("/experiences/import")
def import_experience(body: dict):
    import base64
    code = body.get("code", "")
    if not code.startswith("EXP:"):
        raise HTTPException(400, "invalid share code")
    try:
        exp = json.loads(base64.b64decode(code[4:]).decode())
    except Exception:
        raise HTTPException(400, "could not decode share code")
    exp["id"] = str(uuid.uuid4())
    exp["locked"] = False
    exp["author"] = "player"
    with _EXP_LOCK:
        exps = _load_experiences()
        exps.append(exp)
        _save_experiences(exps)
    return exp

# -- world scaffold --

_SCAFFOLDS_PATH = os.path.join(os.path.dirname(__file__), "scaffolds.json")
_SCAFFOLD_LOCK  = threading.Lock()
_SCAFFOLD_PENDING:  set[str] = set()    # experience_ids currently being generated
_SCAFFOLD_API_KEYS: dict[str, str] = {} # exp_id → api_key for in-flight scaffold jobs

def _load_scaffolds() -> dict:
    try:
        with open(_SCAFFOLDS_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

def _save_scaffolds(scaffolds: dict) -> None:
    with open(_SCAFFOLDS_PATH, "w") as f:
        json.dump(scaffolds, f, indent=2)

SCAFFOLD_QUEUE: "queue.Queue[str]" = queue.Queue()

def scaffold_worker():
    log.info("scaffold worker started")
    while True:
        exp_id = SCAFFOLD_QUEUE.get()
        try:
            # Resolve experience
            with _EXP_LOCK:
                exps = _load_experiences()
            exp = next((e for e in exps if e["id"] == exp_id), None)
            if not exp:
                log.warning("[scaffold:%s] experience not found", exp_id)
                continue

            # Resolve API key — use the requesting profile's key stored in pending meta,
            # falling back to any active session. Scaffold is low-priority; skip if none available.
            api_key = _SCAFFOLD_API_KEYS.pop(exp_id, None)
            if not api_key:
                log.warning("[scaffold:%s] no active session — scaffold skipped", exp_id)
                continue

            lore = exp.get("lore", {})
            rules = exp.get("rules", {})
            user_prompt = (
                f"Experience name: {exp.get('name', exp_id)}\n"
                f"World title: {lore.get('title', '')}\n"
                f"World description: {lore.get('description', '')}\n"
                f"Game rules summary: playerHp={rules.get('playerHp', 100)}, "
                f"enemyDamage={rules.get('enemyDamage', 10)}, "
                f"mode={exp.get('mode', 'roguelike')}"
            )

            system_prompt = config.get("scaffold_system_prompt")
            persona       = config.get("scaffold_persona") or "Polly"
            raw = graydient_client.llm_query(user_prompt, system_prompt, api_key, persona)

            try:
                scaffold = json.loads(raw)
            except json.JSONDecodeError:
                # Try to extract JSON substring if LLM added surrounding text
                import re
                match = re.search(r'\{.*\}', raw, re.DOTALL)
                if match:
                    scaffold = json.loads(match.group())
                else:
                    raise ValueError(f"LLM returned non-JSON: {raw[:200]}")

            scaffold["experienceId"] = exp_id
            scaffold["generatedAt"]  = int(time.time())

            with _SCAFFOLD_LOCK:
                scaffolds = _load_scaffolds()
                scaffolds[exp_id] = scaffold
                _save_scaffolds(scaffolds)

            log.info("[scaffold:%s] generated OK", exp_id)

        except Exception:
            log.exception("[scaffold:%s] FAILED", exp_id)
        finally:
            _SCAFFOLD_PENDING.discard(exp_id)
            SCAFFOLD_QUEUE.task_done()

threading.Thread(target=scaffold_worker, daemon=True).start()

@app.get("/scaffold/{exp_id}")
def get_scaffold(exp_id: str):
    with _SCAFFOLD_LOCK:
        scaffolds = _load_scaffolds()
    if exp_id not in scaffolds:
        raise HTTPException(404, "no scaffold generated yet for this experience")
    return scaffolds[exp_id]

@app.get("/scaffold/{exp_id}/status")
def scaffold_status(exp_id: str):
    with _SCAFFOLD_LOCK:
        scaffolds = _load_scaffolds()
    if exp_id in scaffolds:
        return {"status": "ready", "generatedAt": scaffolds[exp_id].get("generatedAt")}
    if exp_id in _SCAFFOLD_PENDING:
        return {"status": "queued"}
    return {"status": "none"}

@app.post("/scaffold/{exp_id}")
def generate_scaffold(exp_id: str, request: Request):
    profile_id = request.headers.get("X-Profile-Id", "")
    api_key = profiles.get_api_key(profile_id)
    if not api_key:
        raise HTTPException(401, "session expired — please log in again")
    _SCAFFOLD_PENDING.add(exp_id)
    _SCAFFOLD_API_KEYS[exp_id] = api_key
    SCAFFOLD_QUEUE.put(exp_id)
    log.info("[scaffold:%s] queued by %s", exp_id, profile_id)
    return {"status": "queued", "experience_id": exp_id}

# -- static assets --

@app.get("/sprites/{name}")
def get_sprite(name: str):
    if "/" in name or "\\" in name or ".." in name or not name.endswith(".png"):
        raise HTTPException(400, "bad sprite name")
    path = os.path.join(SPRITES_DIR, name)
    if not os.path.exists(path):
        raise HTTPException(404, "sprite not found")
    return FileResponse(path, media_type="image/png")

app.mount("/", StaticFiles(directory=GAME_DIR, html=True), name="game")

if __name__ == "__main__":
    import uvicorn
    log.info("forge listening on http://%s:%d", HOST, PORT)
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
