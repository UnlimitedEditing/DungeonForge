# Dungeon-Forge :: Vertical Slice

A minimal first-person controller and test room that spawns AI-rendered sprites
via the Graydient SDK. Click SPAWN, describe a creature, watch it materialise
in the dungeon.

This is the bottom of the stack we discussed — Forge + game, no scheduler,
no profile, no bestiary persistence. The point is to confirm the render →
clean → stage loop works end to end and to expose the real-world latency
characteristics so we can design the layers above.

## Setup

```bash
# 1. Install deps
pip install -r requirements.txt

# 2. Set your API key (put it in a .env file beside forge.py)
echo "GRAYDIENT_KEY=your-key-here" > .env
```

The Graydient SDK is loaded directly from `D:\Graydient Exchange\Source API` at runtime —
no install step needed. Override the path with the `GRAYDIENT_SDK_PATH` env var if your
copy lives elsewhere.

First time you run, `rembg` will download its segmentation model
(~170 MB, one-time). Subsequent runs are fast.

## Run

```bash
python forge.py
```

Then open <http://127.0.0.1:8000/> in a browser. That's it — the Forge
serves the game from the same origin, so no CORS dance, no second server.

## How to play

1. Page loads with the spawn terminal open and pointer free.
2. Type a creature description and hit SPAWN (or Enter).
3. A pulsing amber placeholder drops into the room while the render is in
   flight. The job list shows live status: `queued → rendering → processing → done`.
4. Click the viewport to lock the cursor and enter the room. WASD to move,
   mouse to look.
5. <kbd>TAB</kbd> or <kbd>ESC</kbd> reopens the terminal — you can queue more
   spawns while existing ones are still rendering. The pool builds up.

Each new spawn lands on the next position around a small ring at the
centre, so sprites don't pile on top of each other.

## What's in here

```
forge.py              FastAPI service. POST /jobs queues a render brief.
                      Worker thread calls graydient.render.create(),
                      runs the result through rembg, trims the bounding
                      box, saves to sprites/.
requirements.txt      Python deps (excluding the local graydient SDK).
game/index.html       Page shell + import-map for Three.js (jsdelivr).
game/style.css        CRT-terminal aesthetic. Amber phosphor + scanlines.
game/main.js          Three.js scene, FPS controls, spawn polling loop.
sprites/              Generated PNGs accumulate here.
```

## Architecture notes

**Render flow.** The Forge holds a single worker thread pulling from an
in-memory `queue.Queue`. The worker submits to Graydient with the SDK's
streaming callback, blocks until `rendering_done` arrives, then downloads
and rembg-cleans the result. The job table is plain dict (lost on restart) —
fine for the slice, replace with SQLite when we add the bestiary.

**Sprite staging.** The game POSTs to `/jobs`, immediately drops a placeholder
mesh at the next spawn position, then polls `/jobs/{id}` every 3 seconds.
When the job is `done`, the placeholder is swapped for a `THREE.Sprite` that
auto-billboards to the camera. Aspect ratio is preserved from the loaded
texture so renders that come back tall/thin still look right.

**Prompt scaffolding.** The user types only the *subject*. The Forge wraps it
with sprite-friendly constraints (full body, centered, plain white background,
no shadows, etc) — see `SPRITE_PROMPT_TEMPLATE` in `forge.py`. **This is the
first thing to iterate on** once you see your first renders. Better
scaffolding means cleaner rembg output and more consistent sprite scale
across creatures.

**Pixel art look.** Sprites use `NearestFilter` magnification and `alphaTest`
discard for sharp edges. The renderer is at low pixel ratio and the canvas
gets `image-rendering: pixelated`. Tune to taste.

## Known limitations / sharp edges

- **Worker thread starts at import time.** This is the simplest workable
  thing for FastAPI but isn't graceful on shutdown. Migrate to a lifespan
  manager when you add proper queue persistence.
- **No retry on render failure.** A failed job stays failed; you'll see its
  placeholder turn red. Next iteration: scheduler with retry + reason codes.
- **No collision with sprites.** You can walk through enemies. Add a 2D AABB
  check vs sprite positions when you add real combat.
- **One worker.** Graydient effectively serialises us anyway, so this is fine
  until we have parallel-rendering budget.
- **Placeholder is a translucent slab.** Could embed the prompt text as a
  CanvasTexture so you can read what's coming from across the room — left
  as a polish task.
- **No sound.** Graydient has a `txt2wav` workflow; generating ambient room
  drones and creature noises is a natural extension of the same pipeline.

## What this proves and what comes next

This slice proves three things in one runnable package:
1. The Graydient pipeline produces usable sprite material with simple prompt
   scaffolding + rembg cleanup.
2. The game can defer the latency cleanly with placeholder-and-poll.
3. The architecture cleanly separates the Forge service from the game so
   the next layers (scheduler, profile, bestiary) bolt on without changing
   either side.

Once you've kicked the tyres and watched a few renders complete:

- **Iterate on the prompt template** until your renders need minimal rembg
  cleanup and have consistent scale.
- **Replace the in-memory job dict with SQLite** so sprites survive restart
  and become a real bestiary.
- **Add the scheduler** that keeps a baseline pool topped up in the
  background between explicit spawns.
- **Add the profile + LLM-composer step** (OpenRouter free tier) that turns
  player behaviour into prompt modifiers.

Then we're looking at dungeon generation and the actual combat loop, and the
slice has become a game.
