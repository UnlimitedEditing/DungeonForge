# DungeonForge — CLAUDE.md

Procedurally generated dungeon crawler with an AI rendering pipeline built on Graydient.

## Running locally

```powershell
pip install -r requirements.txt
# Add GRAYDIENT_KEY=your-key to a .env file
python forge.py
# Open http://127.0.0.1:8000
```

First run: `rembg` downloads its segmentation model (~170 MB, one-time).

## Repo layout

```
forge.py              FastAPI server — profiles, job queue, sprite + anim workers, static serving
graydient_client.py   Our own HTTP client for the Graydient v3 API (no SDK dependency)
profiles.py           Player profile store — bcrypt passwords, Fernet-encrypted API keys
config.py             Runtime config store — workflows, prompt templates, lore source
requirements.txt      Python deps
game/
  index.html          Shell — Three.js import map, setup screen, Forge hub, terminal
  main.js             Three.js scenes (Forge + Room), controls, sprite/anim lifecycle
  style.css           Amber CRT / forge aesthetic
sprites/              Generated PNGs (gitignored, created at runtime)
anims/                Generated walk animation videos (gitignored, created at runtime)
profiles.json         Encrypted player profiles (gitignored, created at runtime)
config.json           Persisted runtime config (gitignored, created at runtime)
```

## Architecture

**Rendering pipeline**
1. Player submits a creature description
2. `forge.py` wraps it with `SPRITE_PROMPT_TEMPLATE` and POSTs to Graydient (txt2img workflow)
3. SSE stream — on `rendering_done` event, downloads the image URL
4. Runs through `rembg` for background removal + alpha trim → saves to `sprites/`
5. Automatically queues a walk animation job (img2vid workflow, original Graydient URL as `init_image`)
6. Browser polls `/jobs/{id}` → swaps placeholder for finished sprite
7. Browser polls `/anim-jobs/{id}` → swaps static texture for `THREE.VideoTexture`

**Profile security**
- Passwords hashed with bcrypt
- API keys encrypted with Fernet (PBKDF2-HMAC-SHA256 derived key, random salt per profile)
- Plaintext key never written to disk; decrypted into in-memory session on login
- Session lost on restart → user logs in again to restore

**Config**
- All tunable values live in `config.py` / `config.json`
- Read at job-creation time (not startup) so changes apply without restart
- Exposed via `GET /config` and `PUT /config`
- In-game CONFIG tab in the terminal and Forge hub both hit the same endpoint

**Two iteration knobs** (most impactful things to change):
1. `workflow` / `anim_workflow` slugs — try different Graydient offerings
2. `sprite_prompt_template` / `walk_prompt_template` — tune scaffolding for cleaner rembg output

## Key constraints

- One worker thread per queue (sprite + animation run in parallel)
- In-memory job tables — lost on restart, no persistence yet (SQLite bestiary is v0.4)
- `PointerLockControls` requires desktop browser — mobile support needs dual-joystick rewrite (see below)
- Graydient renders take minutes — render latency is a design constraint, not a bug

## Planned: web deployment (needs funding)

The frontend (`game/`) is pure static files and deploys to Vercel trivially with zero config. The backend cannot run on Vercel — serverless functions timeout in 10–60s and the render workers are long-running threads with persistent file I/O.

**Target split:**
| Layer | Host | Notes |
|---|---|---|
| `game/` | Vercel | Static CDN, instant global distribution |
| `forge.py` | Railway or Render | Long-running Python, persistent volume |

**What needs changing when budget allows:**
- `vercel.json` pointing at `game/` as output directory
- `railway.toml` for the Python service with a persistent volume mount
- `FORGE_BASE` in `main.js` needs to read from a configurable env var (currently `window.location.origin`) for cross-origin split deployment
- CORS is already wide open for local dev — tighten to the Vercel domain for production

## Planned: mobile support (blocked on web deployment)

Desktop only for now. `PointerLockControls` doesn't exist on mobile browsers.

**What needs changing:**
- Replace `PointerLockControls` with dual-joystick touch controller (`nipplejs` or raw touch events)
- Left stick: move, right stick: look — standard mobile FPS layout
- Responsive HUD and terminal CSS
- Large spawn button as tap target (virtual keyboard flow)
- Config panel stays desktop-only — editing long prompt templates on a phone is painful

Mobile is a natural fit otherwise: the rendering pipeline is server-side, Three.js WebGL runs well on modern phones, and the amber aesthetic looks great on OLED.

## Roadmap summary

| Version | Name | Status |
|---|---|---|
| v0.1 | First Spark | ✓ shipped |
| v0.2 | The Forge | in progress |
| v0.3 | Full Asset Pipeline | planned |
| v0.4 | Procedural Inheritance & Presets | planned |
| v0.5 | Game Logic Engine | planned |
| v0.6 | Experience Templates | planned |
| v1.0 | The Exchange | planned |

See `RELEASE.md` for full milestone descriptions.
