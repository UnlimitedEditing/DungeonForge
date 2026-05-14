# LatentCrawl v0.2 — The Forge

*A game engine wearing a dungeon crawler like a mask.*  
*Or: what happens when the proof of concept starts asking what it actually is.*

---

v0.1 was a spider in a box. You typed a creature description, waited a few minutes, and something crawled out of latent space and started wandering around a stone room. That was the whole thing. It was magic in a very small container.

v0.2 is what happens when you take that container seriously and ask: what if the player made the world?

The answer is: a lot more infrastructure than you expected, some surprising moments of it all clicking together, and a creeping awareness that you are no longer building a dungeon crawler. You are building something that generates dungeon crawlers. That ship has sailed. We are not sorry.

---

## What's actually in v0.2

### The Forge

There is now a place to be. Between sessions, before expeditions, when you want to configure something without dying — you return to The Forge. A stone hearth, floating ember particles, molten amber light. It functions as a workshop hub: a ring of rooms around a central fire, each handling a different axis of world-building.

You no longer drop straight into a room. You come home first.

### Procedural dungeon generation

The room is gone. In its place: a procedurally generated dungeon that is different every time you enter. The generator runs a drunk-walk algorithm seeded from a 32-bit value, connects rooms with doorways, runs BFS to find the furthest point from your spawn and marks it as the exit. It then builds Three.js geometry for the whole thing — floors, ceilings, walls, doorway cuts — and hands you a minimap in the bottom right corner showing where you are and where you need to go.

Collision is per-tile with per-axis wall-slide so you never get snagged on corners. The exit pillar glows violet. Reaching it advances the seed and builds the next level. The dungeon is, in principle, infinite.

The seed is fully configurable. The layout is deterministic. Two players with the same seed see the same dungeon.

### Experience system

A world is now a JSON document. It has a name, a seed, generation parameters, fog settings, entity rules, world state defaults, and a trigger list. The system ships with one experience — *LatentCrawl*, locked as the canonical baseline — and players can fork it, modify it, save it, and share it with an `EXP:` base64 share code that encodes the entire configuration into a single pasteable string.

Forked experiences persist. Your world is yours.

### The workshop panels

The Forge's side rooms are functional, or at least present and wired:

**Terra Fabricator** — the level editor. Preview your dungeon before you enter it. Adjust the seed, room count, and grid size with live canvas feedback. Save changes back to your active experience (forks only — the canonical experience is locked).

**The Library** — lore inscription and the Entities Codex. Your world description lives here and flows forward into every generation.

**Machinarium** — combat rules, game modes, entity behaviour. The sliders are real and they persist.

**Arcanum** — skills, abilities, and progression curves. Wired but awaiting the combat model that will fully consume it.

**Substance Lab** — equipment and item crafting configuration. Present, connected to the drop pool, ready for the economy layer it will eventually feed.

Some of these panels are more complete than others. They are all real, they all persist to config, and they are all in the same room waiting to be connected to each other — which brings us to the piece of work we are most quietly proud of.

### Game systems

Combat exists. Entities have HP. The player has HP. Things can now die, including you. When an entity dies it has a chance to drop an item from a configurable loot pool. You can pick it up. There is an inventory with six equipment slots. There is an XP system. There is a level-up notification. There is a stats HUD in the bottom left.

None of this is balanced. The numbers are starting points. The point is that the scaffolding is real.

### PBR sprite lighting

Sprites are now lit by the scene. Point lights from braziers and torches cast coloured light across your creatures in a way that makes them feel like they inhabit the space rather than float above it. Combined with the walk animation pipeline, a rendered creature in a procedurally lit corridor looks, against all reasonable expectation, like something that belongs there.

### The pose editor and sprite sheet pipeline

Creatures now have a second pass. After the initial render, you can drop into the pose editor and define skeleton keypoints for ControlNet-guided generation — front-facing, side-facing, back-facing sprites generated from a consistent body plan. The walk animation pipeline handles spritesheet composition. The result is a creature with directional sprites that respond correctly as it roams.

This is still a manual step. Automation is coming.

### The Undercroft

This is the room we didn't know we needed until we tried to connect two workshop panels and realised there was nowhere for the signal to go.

The Undercroft is the wiring room. Three new modules — `events.js`, `world-state.js`, `triggers.js` — form the communication backbone of the entire engine. Systems now talk to each other through a pub/sub event bus rather than through shared global state. Flags, counters, and entity states persist across a play session and reset cleanly when you return to The Forge. Triggers loaded from tile data subscribe to events, evaluate conditions, and fire actions — set a flag, increment a counter, emit another event, show a lore fragment.

The Undercroft panel has three tabs:

- **REGISTRY** — the live state of every flag, counter, and entity state in the current session
- **MONITOR** — a scrolling event log showing every emission in real time, labelled and timestamped
- **MANIFEST** — the trigger list loaded from the current level, showing each trigger's event hook, condition type, and action chain

Right now the manifest is empty for the default experience because the default experience has no triggers yet. That will change. The infrastructure is there. Any tile can have triggers. Any trigger can respond to any event. The system is open and the Undercroft is where you see all of it at once.

The longer-term shape of the Undercroft is visible from here: each workshop gets a small embedded monitor showing only its own channel, and the Undercroft shows all channels together with the wiring context between them. When you try to connect two systems that don't compose, the Undercroft is where the warning appears. When a build works, it's where you see why.

---

## The honest state of it

The dungeon generates correctly and consistently. The exit is always reachable. Collision feels good. The minimap is accurate. The experience system is real and the fork/share model works.

The workshops are more connected than they were and less connected than they will be. Machinarium writes to config and config flows into combat. Arcanum has a schema. Substance Lab has a drop pool. But the Undercroft event bus — the thing that lets these panels talk to *each other* rather than just to the global config — is brand new. The wiring is there. The per-workshop rules that flow through it are not fully written yet. That is the next serious piece of work.

Combat is functional and unbalanced. You can die. Enemies will kill you if you stand in front of them long enough. The numbers were not tuned; they were chosen to not be embarrassing.

The pose editor works. It is not fast. ControlNet generation adds latency on top of the base render latency. The result is worth it but the workflow is still too manual for what it will eventually become.

The Undercroft MONITOR tab will make you feel like you understand what the engine is doing. This feeling is mostly accurate.

---

## Roadmap

### v0.3 — Full Asset Pipeline
The render pipeline extended to every asset class a world needs. The Forge can already generate creatures — now it generates everything:

- **Skyboxes** — equirectangular txt2img mapped onto a Three.js sky sphere
- **Items & weapons** — sprite pipeline with category-aware prompt scaffolding, dropping into the inventory system that now exists to receive them
- **Spells & VFX** — short animated sprites via img2vid, composited in-scene
- **Environment props** — billboarded furniture, flora, ruins, architecture fragments
- **Materials** — seamless texture generation for walls, floors, and surfaces

### v0.4 — Procedural Inheritance & Presets
Content that evolves without losing coherence. The generation problem is drift — a goblin's grandchild becomes something unrecognisable. This milestone adds guardrails:

- Parent → child concept tree: every generated asset can spawn variants that inherit from it
- Coherence guards: configurable drift limits so nth-generation content stays recognisably related to the root
- Procedural naming conventions seeded from lore
- Archetype presets: **Classic Fantasy**, **Cosmic Horror**, **Dark Industrial**, **Mythpunk**
- SQLite bestiary replacing the in-memory job table — your creatures persist across restarts

### v0.5 — Workshop Integration
The Undercroft's event bus is built. Now the workshops consume it properly:

- Machinarium combat rules respond to `entity:died`, `player:damaged` events
- Arcanum skill definitions flow into combat calculations
- Terra Fabricator tile triggers become editable from within the workshop panel
- Substance Lab drop tables read from experience rules rather than global config
- Per-workshop event channels visible in the Undercroft MONITOR

### v0.6 — Experience Templates
Three playable modes, all on the same engine:

- **LatentCrawl** *(exists now)* — procedural dungeon roguelike
- **The Room** *(exists as legacy)* — freeform sandbox, no rules, just spawn things
- **Wandering** — open world exploration, biome-aware generation informed by lore
- **The Long Game** — full RPG loop: factions, reputation, evolving world state, questlines that modify the generation

### v1.0 — The Exchange
The layer that makes it communal:

- Multiplayer with shared bestiary and synchronised generation queue
- Content marketplace: share creatures, items, lore books, world configurations
- Community instancing: load another player's world and run it as your own
- Player-to-player inheritance: fork someone else's creature lineage

---

## Coming soon — web deployment & mobile

The frontend is still pure static files and still deploys to Vercel without configuration. The backend still can't run on serverless. The split is Vercel for `game/`, Railway for `forge.py`, one env var swap in `main.js`, and CORS tightening. The architecture has not changed because the architecture was already right. The Railway bill has not appeared because the Railway bill has not been paid.

Mobile support follows from web deployment. `PointerLockControls` on a phone is a non-starter — it needs replacing with dual-joystick touch input, responsive HUD layout, and a tap-friendly terminal. Everything else — the render pipeline, Three.js WebGL, the amber aesthetic on an OLED — is already correct.

Both are still blocked on the same thing. You know what it is.

---

## Built on

[Graydient](https://graydient.ai) (AI rendering), [Three.js](https://threejs.org) (3D engine), [FastAPI](https://fastapi.tiangolo.com) (server), [rembg](https://github.com/danielgatis/rembg) (background removal), bcrypt + cryptography (profile security).

This project is built around the Graydient platform specifically. The rendering pipeline is not designed to be backend-agnostic — at least not yet. If that changes it will change deliberately, not by accident.

---

## Source & licence

Source is available to read and to contribute to. All other rights reserved for now. This will open up properly when the exchange layer exists and there's something worth protecting properly. Until then: don't redistribute it, don't strip out Graydient and sell it as something else, and if you build something cool with it come talk to us.

---

*It's a dungeon with a forge at the entrance and a wiring room in the basement. We are still unreasonably proud of it.*
