# DungeonForge

A procedurally generated dungeon crawler with an AI rendering pipeline. Describe a creature, watch it materialise. Every dungeon is different. Every creature is yours.

Built on [Graydient](https://graydient.ai) for AI rendering, [Three.js](https://threejs.org) for 3D, and [FastAPI](https://fastapi.tiangolo.com) for the server.

---

## Getting started

You need a [Graydient API key](https://graydient.ai) and Python 3.8+.

### Launcher (recommended)

The launcher handles dependencies, API key setup, and opens the game automatically.

**Windows** — double-click `launch.bat`

**macOS**
```bash
chmod +x launch.sh   # first time only
./launch.sh
```

**Linux**
```bash
# tkinter may need installing first
sudo apt install python3-tk   # Debian / Ubuntu
sudo dnf install python3-tkinter   # Fedora

chmod +x launch.sh
./launch.sh
```

The launcher window will prompt for your API key on first run, install dependencies, start the server, and open your browser.

---

### Manual setup (fallback)

If the launcher doesn't work, run these steps in a terminal.

**1. Install Python**

Download from [python.org](https://www.python.org/downloads/). During install on Windows, check **Add Python to PATH**.

If Python is installed but not on PATH (Windows), find it and add it manually:
```powershell
# Find your Python install
ls "$env:LOCALAPPDATA\Programs\Python"

# Then add to user PATH via:
# Settings → System → Advanced system settings → Environment Variables
# Edit the "Path" user variable and add:
#   C:\Users\<you>\AppData\Local\Programs\Python\Python3xx
#   C:\Users\<you>\AppData\Local\Programs\Python\Python3xx\Scripts
```

**2. Install dependencies**
```bash
pip install -r requirements.txt
```

**3. Set your API key**

Create a file named `.env` in the project folder:
```
GRAYDIENT_KEY=your-key-here
```

**4. Run**
```bash
python forge.py
```

Then open <http://127.0.0.1:8000> in your browser. The first render will also download the `rembg` background-removal model (~170 MB, one-time).

---

## How to play

1. Log in or create a profile from the setup screen. Your profile stores your API key encrypted — you only enter it once.
2. Enter The Forge. This is your hub between expeditions.
3. From the Forge terminal, describe a creature and hit **SPAWN**. A pulsing placeholder drops into the dungeon while the render is in flight.
4. Enter the dungeon. Click the viewport to lock the cursor. **WASD** to move, mouse to look.
5. **TAB** / **ESC** returns you to the terminal — queue more spawns while existing ones are still rendering.
6. Reach the glowing violet exit pillar to advance to the next level.

Renders take a few minutes — that's the pipeline, not a bug. Queue a few creatures and explore while they arrive.

---

## What's in here

```
forge.py              FastAPI server — profiles, job queue, sprite + variant workers
graydient_client.py   HTTP client for the Graydient v3 API
profiles.py           Player profile store — bcrypt passwords, Fernet-encrypted API keys
config.py             Runtime config — workflows, prompt templates, lore
launcher.py           GUI launcher (tkinter) — setup, server lifecycle, browser open
launch.bat            Windows launcher entry point
launch.sh             macOS / Linux launcher entry point
game/
  index.html          Shell — Three.js import map, setup screen, Forge hub, terminal
  main.js             Scene orchestration, movement, collision, boot
  scene.js            THREE.js renderer, cameras, PointerLockControls
  entity.js           Sprite spawning, roaming AI, walk animation
  combat.js           Combat resolution, XP, item drops, inventory
  hub-panels.js       All Forge workshop panels
  events.js           Pub/sub event bus
  world-state.js      Flag/counter persistence within a play session
  triggers.js         Tile-based trigger system
  lore-engine.js      World scaffold and inference hooks
  experiences.js      Experience CRUD, fork, share codes
  level.js            Procedural dungeon generator
sprites/              Generated PNGs (gitignored, created at runtime)
anims/                Generated walk animations (gitignored, created at runtime)
```

---

## Architecture notes

**Render pipeline.** Player submits a description → server wraps it with `SPRITE_PROMPT_TEMPLATE` → POSTs to Graydient (txt2img) → SSE stream → `rembg` background removal → saved to `sprites/`. A walk animation job queues automatically using the original Graydient URL as `init_image`.

**Profile security.** Passwords hashed with bcrypt. API keys encrypted with Fernet (PBKDF2-HMAC-SHA256, random salt per profile). Plaintext key never written to disk; decrypted into in-memory session on login. Session clears on restart — log in again to restore.

**Config.** All tunable values (workflows, prompt templates, lore) live in `config.py` / `config.json` and are read at job-creation time, so changes apply without restart. Exposed via `GET /config` and `PUT /config`.
