# OpenWorld

<div align="center">

**AI-powered 3D scene creator — describe it, Claude builds it.**

[![Stars](https://img.shields.io/github/stars/ntzamos/openworld?style=flat-square&color=yellow)](https://github.com/ntzamos/openworld/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun&logoColor=white)](https://bun.sh)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED?style=flat-square&logo=docker&logoColor=white)](https://hub.docker.com)

</div>

---

<!-- Add a GIF/screenshot here showing the app in action -->

OpenWorld lets you describe any 3D scene, model, or game in plain English — and Claude builds it for you in real-time using Three.js. Type "a low-poly island with palm trees and a sunset", watch it render. Say "add dolphins jumping out of the water" — done. Two Docker containers. One prompt away from your next 3D creation.

---

## Use Cases

**Creative**

- **Rapid 3D prototyping** — Describe a scene and get a working Three.js prototype in seconds. Iterate with follow-up prompts.
- **Game jam starter** — "Make a 3D maze game with first-person controls and a timer" — playable in your browser, no setup required.
- **Visual storytelling** — Build animated scenes with characters, environments, and lighting — all through conversation.

**Education**

- **Learn Three.js by example** — See how Claude structures scenes, lighting, materials, and animations. Every creation is viewable source code.
- **Interactive demos** — Create 3D visualizations for presentations, lectures, or documentation on the fly.
- **Geometry & physics** — "Show me a solar system with accurate orbital mechanics" — learn by building.

**Professional**

- **Client mockups** — Quickly visualize spatial concepts, product layouts, or architectural ideas before committing to full 3D tooling.
- **Portfolio pieces** — Generate impressive 3D scenes and games to showcase creative coding skills.
- **Internal tools** — Embed generated scenes into dashboards, reports, or web apps.

---

## What You Get

| | |
|---|---|
| **Chat-to-3D** | Describe anything — Claude generates a full Three.js scene |
| **Live preview** | Scene renders instantly in the viewport as soon as it's ready |
| **Follow-ups** | "Add fog", "make it night time", "add a score counter" — iterative refinement |
| **Session history** | Every conversation is saved with its 3D scene — come back anytime |
| **File attachments** | Upload reference images, textures, or 3D models to guide creation |
| **Responsive** | Works on desktop and mobile — scene on top, chat on bottom |
| **OAuth login** | Connects to your Claude account via OAuth PKCE — no API key needed |
| **PostgreSQL** | Chat sessions and messages persisted in a real database |

---

## Get Started in 5 Minutes

**Run locally with Docker:**

```bash
git clone https://github.com/ntzamos/openworld
cd openworld
cp .env.example .env
docker compose up -d
open http://localhost:3000
```

Connect your Claude account through the auth modal on first load. Start building.

**Development mode (without Docker):**

```bash
bun install
# Start PostgreSQL separately, then:
bun run dev
open http://localhost:3000
```

---

## Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- A [Claude](https://claude.ai) account (OAuth login — no API key required)

---

## Architecture

```
openworld/
├── server.js              # Bun server — API, static files, Claude CLI orchestration
├── db/
│   ├── migrate.js         # Migration runner (tracks applied migrations)
│   └── migrations/        # SQL migration files
├── public/
│   ├── index.html         # SPA shell
│   ├── style.css          # UI styles
│   ├── app.js             # Frontend logic
│   └── fonts/             # Self-hosted Inter font
├── sessions/              # UUID folders with generated Three.js scenes
├── Dockerfile             # Bun + Claude CLI
└── docker-compose.yml     # App + PostgreSQL 18
```

Each chat session creates a UUID folder under `sessions/`. Claude CLI runs inside that folder and generates a self-contained `index.html` with Three.js. The scene loads in an iframe in the main viewport.

---

## How It Works

1. **You describe** a 3D scene, model, or game in the chat
2. **Claude CLI** is spawned with `--dangerously-skip-permissions` in the session's folder
3. **Claude writes** a complete Three.js scene as `index.html`
4. **The scene loads** automatically in the viewport
5. **Follow-up messages** pass the full conversation history — Claude updates the existing scene

---

## Audit

This project spawns `claude` CLI with `--dangerously-skip-permissions`. This means Claude can read/write files within the session directory without confirmation prompts. Each session is isolated to its own UUID folder under `sessions/`.

**Security considerations:**
- Generated scenes run in a sandboxed iframe (`allow-scripts allow-same-origin`)
- Claude only has filesystem access within the session directory
- No network requests are made by the server on behalf of generated scenes
- OAuth tokens are stored in `~/.claude/.credentials.json` (standard Claude CLI location)

---

## License

MIT
