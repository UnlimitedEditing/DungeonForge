# LatentCrawl v0.1 — First Spark

*A procedurally generated dungeon crawler with an AI rendering pipeline.*  
*Or: what happens when you stop asking whether something is a good idea and just build it.*

---

It started as a stupid question. What if the creatures in a dungeon crawler weren't drawn by an artist, or even pre-generated at studio time, but summoned fresh from a text prompt — unique to each player, each run, each world? What if the game's bestiary was, in a meaningful sense, infinite?

The sensible answer is: that's a terrible idea, rendering takes forever, the quality is inconsistent, and you'd need to solve about fourteen hard problems before it resembles a game.

We did it anyway. And it works. Kind of. Mostly. Sometimes you ask for a skeleton warrior and get something that haunts you. But when you ask for a giant spider and a giant spider materialises out of latent space and starts wandering your dungeon like it owns the place — that's one of those moments where you sit back, look at what you've built, and think *oh no, this is real.*

---

## What's actually in v0.1

This is a vertical slice. One room. One player. A terminal in the middle of the screen where you type creature descriptions, and a forge behind the scenes that turns them into walking sprites. That's the whole game. It is not a game. It is a proof of concept that, against reasonable odds, is also a little bit magic.

**The rendering pipeline**

Your prompt goes to Graydient's txt2img workflow. The result comes back as a raw image, gets background-stripped with `rembg`, trimmed to its bounding box, and dropped into a Three.js scene as a billboarded sprite with pixel-crisp upscaling. A pulsing amber placeholder holds the spot while the render is in flight — renders take a few minutes, and pretending otherwise would be a lie.

The same render then gets fed back into Graydient's img2vid workflow as an `init_image`. A walk animation comes back. When it's ready, the static sprite swaps for a `THREE.VideoTexture` and the creature starts moving. There's a blinking `walk…` tag in the job list so you know it's coming.

**Persistent encrypted profiles**

Your Graydient API key is encrypted with your password using PBKDF2-HMAC-SHA256 and Fernet symmetric encryption. The plaintext key never touches disk. `profiles.json` contains a bcrypt hash and a ciphertext — neither is useful without your password. You log in again after a server restart to restore your session. You cannot recover your key without your password. We told you that when you registered.

**In-game config panel**

Accessible from the spawn terminal via the CONFIG tab. You can swap the Graydient workflow slugs (the primary iteration variable — we don't yet know which workflows will produce the most consistent sprite material), rewrite the prompt scaffolding templates entirely, and write a lore source. The lore field is wired in and persisted now. The thing that consumes it — an LLM composer that derives prompt modifiers from world description and player behaviour — is the next serious piece of work.

**Monster roaming**

Each rendered creature picks a random position in the room, walks toward it at a slightly randomised speed, pauses, picks another. That's the entire AI. It is embarrassingly simple and somehow exactly right for a floating test room where you're mostly just watching things materialise.

---

## The honest state of it

Render latency is real and you will feel it. The prompt template is a rough first pass — the scaffolding that surrounds your creature description was written in an afternoon and has had almost no iteration. There's no combat, no inventory, no dungeon layout, no quests, no progression, no sound. The "room" is a box with a stone dais in the middle.

And yet. It runs. The pipeline works end to end. The spider walks around. Your profile survives a restart. You can change the workflow slug from the in-game config panel and the next spawn uses it immediately. The bones are real.

---

## Roadmap

### v0.2 — The Forge
The homestead. Right now there's no place to be between experiences — you're either in the room or you're not. The Forge fixes that: a dedicated environment where players configure, generate, and seed content before dropping into an experience, so render latency is absorbed in the lobby rather than mid-session.

- Forge environment: stone hearth, floating ember particles, molten-light aesthetic with a touch of otherworldly whimsy — a place that feels like the thing generating your world
- Content seeding UI: queue creatures, items, and locations before you enter
- Lore book editor: write your world once, lock it in, let everything generated inherit its tone
- Experience launcher: choose a preset world configuration or build your own

### v0.3 — Full Asset Pipeline
The same render pipeline extended to every asset class a world needs:

- **Skyboxes** — equirectangular txt2img mapped onto a Three.js sky sphere
- **Items & weapons** — sprite pipeline with category-aware prompt scaffolding
- **Spells & VFX** — short animated sprites via img2vid, composited in-scene
- **Environment props** — billboarded furniture, flora, ruins, architecture fragments
- **Materials** — seamless texture generation for walls, floors, and surfaces

### v0.4 — Procedural Inheritance & Presets
Content that evolves without losing coherence. The core problem of infinite generation is that it drifts — a goblin's grandchild becomes something unrecognisable. This milestone adds guardrails:

- Parent → child concept tree: every generated asset can spawn variants that inherit from it
- Coherence guards: configurable drift limits so nth-generation content stays recognisably related to the root
- Procedural naming conventions seeded from lore (no more `creature_a8f3`)
- Archetype presets shipping out of the box: **Classic Fantasy**, **Cosmic Horror**, **Dark Industrial**, **Mythpunk** — each with tuned workflow slugs, prompt scaffolding, and naming conventions
- SQLite bestiary replacing the in-memory job table — your creatures persist

### v0.5 — Game Logic Engine
LatentCrawl becomes a platform rather than a single game. Players define the rules:

- NPC behaviour states: idle, patrol, react, trade, quest-give — each triggerable by world conditions
- Quest generation tied to lore and bestiary content
- Basic combat: hitbox, HP, damage, death state
- Inventory and item pickup
- Condition editor in The Forge: define win states, encounter triggers, economy rules, consequence chains

### v0.6 — Experience Templates
Three playable modes, all built on the same asset pipeline and logic engine:

- **The Room** *(exists now)* — freeform sandbox, spawn anything, no rules
- **Delve** — procedural dungeon crawler roguelike, room-by-room generation with inheritance-based difficulty scaling
- **Wandering** — open world exploration and survival, biome-aware generation informed by lore
- **The Long Game** — full RPG loop: factions, reputation, evolving world state, questlines that modify the generation

### v1.0 — The Exchange
The layer that makes everything above permanent and communal:

- Multiplayer lobby system with shared bestiary and synchronised generation queue
- Content marketplace: share creatures, items, lore books, and full world configurations
- Community instancing: load another player's exported world and run it as your own experience
- Player-to-player inheritance: fork someone else's creature lineage, take it somewhere new

---

## Built on

[Graydient](https://graydient.ai) (AI rendering), [Three.js](https://threejs.org) (3D engine), [FastAPI](https://fastapi.tiangolo.com) (server), [rembg](https://github.com/danielgatis/rembg) (background removal), bcrypt + cryptography (profile security).

This project is built around the Graydient platform specifically. The rendering pipeline is not designed to be backend-agnostic — at least not yet. If that changes it will change deliberately, not by accident.

---

## Source & licence

Source is available to read and to contribute to. All other rights reserved for now. This will open up properly when the exchange layer exists and there's something worth protecting properly. Until then: don't redistribute it, don't strip out Graydient and sell it as something else, and if you build something cool with it come talk to us.

---

*It's a spider in a box. We're unreasonably proud of it.*
