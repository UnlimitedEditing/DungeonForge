"""
forge.py — The render service.

Responsibilities:
  1. Manage player profiles (API key → persistent identity).
  2. Expose runtime config (workflows, prompt templates, lore) via /config.
  3. Accept render briefs (prompt + profile_id) from the game via HTTP.
  4. Submit sprite renders to Graydient (txt2img workflow).
  5. Auto-queue a walk animation job for every completed sprite
     (img2vid workflow using the original Graydient URL as init_image).
  6. Run sprite results through rembg for clean alpha; save videos directly.
  7. Serve the Three.js game itself from the same origin.

All tunable values (workflows, prompt templates, lore) live in config.py
and are read at job-creation time so changes take effect without restart.
"""

import logging
import os
import queue
import threading
import time
import uuid
from io import BytesIO
from typing import Optional

import dotenv
import requests
from fastapi import FastAPI, HTTPException
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
ANIMS_DIR   = os.path.join(os.path.dirname(__file__), "anims")
GAME_DIR    = os.path.join(os.path.dirname(__file__), "game")
HOST        = os.environ.get("FORGE_HOST", "127.0.0.1")
PORT        = int(os.environ.get("FORGE_PORT", "8000"))

os.makedirs(SPRITES_DIR, exist_ok=True)
os.makedirs(ANIMS_DIR,   exist_ok=True)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("forge")

# ---------- prompt scaffolding ----------
# Templates are read from config at job-creation time so player edits
# in the config panel take effect immediately without a server restart.

def build_sprite_prompt(user_prompt: str) -> str:
    return config.get("sprite_prompt_template").format(user_prompt=user_prompt.strip())

def build_walk_prompt(user_prompt: str) -> str:
    return config.get("walk_prompt_template").format(user_prompt=user_prompt.strip())

# ---------- models ----------

class RegisterRequest(BaseModel):
    username: str
    password: str
    api_key: str

class LoginRequest(BaseModel):
    username: str
    password: str

class ConfigUpdate(BaseModel):
    workflow: str
    anim_workflow: str
    sprite_prompt_template: str
    walk_prompt_template: str
    lore: str

class JobRequest(BaseModel):
    prompt: str
    profile_id: str

class Job(BaseModel):
    id: str
    profile_id: str
    prompt: str
    full_prompt: str
    status: str           # queued | rendering | processing | done | failed
    sprite_name: Optional[str] = None
    source_url: Optional[str] = None   # pre-rembg Graydient URL; init_image for animation
    anim_job_id: Optional[str] = None  # set once the walk anim job is queued
    error: Optional[str] = None
    created_at: float
    finished_at: Optional[float] = None

class AnimJob(BaseModel):
    id: str
    sprite_job_id: str
    prompt: str            # user's original description, used in walk prompt
    status: str            # queued | rendering | processing | done | failed
    anim_name: Optional[str] = None
    error: Optional[str] = None
    created_at: float
    finished_at: Optional[float] = None

JOBS:      dict[str, Job]     = {}
ANIM_JOBS: dict[str, AnimJob] = {}

JOB_QUEUE:      "queue.Queue[str]" = queue.Queue()
ANIM_JOB_QUEUE: "queue.Queue[str]" = queue.Queue()

JOBS_LOCK      = threading.Lock()
ANIM_JOBS_LOCK = threading.Lock()

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

            # Store the original Graydient URL before rembg — animation needs it.
            with JOBS_LOCK:
                job.source_url = url
                job.status = "processing"

            log.info("[%s] downloading sprite %s", job.id, url)
            resp = requests.get(url, timeout=120)
            resp.raise_for_status()

            sprite_name = f"{job.id}.png"
            process_sprite(resp.content, os.path.join(SPRITES_DIR, sprite_name))

            # Auto-queue the walk animation using the original render as init_image.
            anim_id = uuid.uuid4().hex[:8]
            anim_job = AnimJob(
                id=anim_id,
                sprite_job_id=job.id,
                prompt=job.prompt,
                status="queued",
                created_at=time.time(),
            )
            with ANIM_JOBS_LOCK:
                ANIM_JOBS[anim_id] = anim_job
            ANIM_JOB_QUEUE.put(anim_id)

            with JOBS_LOCK:
                job.sprite_name = sprite_name
                job.anim_job_id = anim_id
                job.status = "done"
                job.finished_at = time.time()

            log.info("[%s] sprite saved, walk anim queued as %s", job.id, anim_id)

        except Exception:
            log.exception("[%s] sprite FAILED", job_id)
            with JOBS_LOCK:
                if job_id in JOBS:
                    JOBS[job_id].status = "failed"
                    JOBS[job_id].finished_at = time.time()
        finally:
            JOB_QUEUE.task_done()

# ---------- animation worker ----------

def anim_worker():
    log.info("animation worker started")
    while True:
        anim_id = ANIM_JOB_QUEUE.get()
        try:
            with ANIM_JOBS_LOCK:
                anim_job = ANIM_JOBS[anim_id]
                anim_job.status = "rendering"

            with JOBS_LOCK:
                sprite_job = JOBS[anim_job.sprite_job_id]

            api_key = profiles.get_api_key(sprite_job.profile_id)
            if not api_key:
                raise RuntimeError(f"no api key for profile {sprite_job.profile_id}")

            source_url = sprite_job.source_url
            if not source_url:
                raise RuntimeError("sprite job has no source_url for animation")

            walk_prompt = build_walk_prompt(anim_job.prompt)
            collected = {"url": None}

            def on_event(event):
                if "rendering_done" in event:
                    data = event["rendering_done"]
                    info = graydient_client.render_info(data["render_hash"], api_key)
                    collected["url"] = graydient_client.extract_image_url(info)
                    log.info("[anim %s] done, url=%s", anim_id, collected["url"])

            anim_workflow = config.get("anim_workflow")
            log.info("[anim %s] submitting walk anim (workflow=%s)", anim_id, anim_workflow)
            graydient_client.render_create(
                prompt=walk_prompt,
                workflow=anim_workflow,
                api_key=api_key,
                on_event=on_event,
                init_image=source_url,
            )

            if not collected["url"]:
                raise RuntimeError("animation stream closed with no URL")

            with ANIM_JOBS_LOCK:
                anim_job.status = "processing"

            log.info("[anim %s] downloading %s", anim_id, collected["url"])
            resp = requests.get(collected["url"], timeout=300)
            resp.raise_for_status()

            ext = ".mp4"
            url_lower = collected["url"].lower()
            if ".webm" in url_lower:
                ext = ".webm"
            elif ".gif" in url_lower:
                ext = ".gif"

            anim_name = f"{anim_id}_walk{ext}"
            with open(os.path.join(ANIMS_DIR, anim_name), "wb") as f:
                f.write(resp.content)

            with ANIM_JOBS_LOCK:
                anim_job.anim_name = anim_name
                anim_job.status = "done"
                anim_job.finished_at = time.time()

            log.info("[anim %s] saved %s", anim_id, anim_name)

        except Exception:
            log.exception("[anim %s] FAILED", anim_id)
            with ANIM_JOBS_LOCK:
                if anim_id in ANIM_JOBS:
                    ANIM_JOBS[anim_id].status = "failed"
                    ANIM_JOBS[anim_id].finished_at = time.time()
        finally:
            ANIM_JOB_QUEUE.task_done()

threading.Thread(target=render_worker, daemon=True).start()
threading.Thread(target=anim_worker,   daemon=True).start()

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
    updated = config.update(cfg.model_dump())
    log.info("config updated: workflow=%s anim_workflow=%s",
             updated["workflow"], updated["anim_workflow"])
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
    job = Job(
        id=job_id,
        profile_id=req.profile_id,
        prompt=prompt,
        full_prompt=build_sprite_prompt(prompt),
        status="queued",
        created_at=time.time(),
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

# -- animation jobs --

@app.get("/anim-jobs/{anim_job_id}")
def get_anim_job(anim_job_id: str):
    with ANIM_JOBS_LOCK:
        if anim_job_id not in ANIM_JOBS:
            raise HTTPException(404, "no such animation job")
        return ANIM_JOBS[anim_job_id]

# -- static assets --

@app.get("/sprites/{name}")
def get_sprite(name: str):
    if "/" in name or "\\" in name or ".." in name or not name.endswith(".png"):
        raise HTTPException(400, "bad sprite name")
    path = os.path.join(SPRITES_DIR, name)
    if not os.path.exists(path):
        raise HTTPException(404, "sprite not found")
    return FileResponse(path, media_type="image/png")

@app.get("/anims/{name}")
def get_anim(name: str):
    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(400, "bad anim name")
    path = os.path.join(ANIMS_DIR, name)
    if not os.path.exists(path):
        raise HTTPException(404, "anim not found")
    media_type = "video/webm" if name.endswith(".webm") else "video/mp4"
    return FileResponse(path, media_type=media_type)

app.mount("/", StaticFiles(directory=GAME_DIR, html=True), name="game")

if __name__ == "__main__":
    import uvicorn
    log.info("forge listening on http://%s:%d", HOST, PORT)
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
