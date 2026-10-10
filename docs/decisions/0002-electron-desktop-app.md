# 0002 — Native desktop app (Electron) instead of a web app

**Status:** accepted (2026-10-10) — supersedes the Next.js part of 0001

**Context:** The app must not be a web app and must run on Windows, macOS and Linux. The team builds
everything in TypeScript, and the engine, SQLite and the AI pipeline were designed for Node.

**Decision:** Electron 44 (pinned) with electron-vite and electron-builder.

- **Main process (Node 24):** engine, SQLite (`node:sqlite`), LLM and web-search calls, file
  import/export dialogs and API keys (OS keychain via `safeStorage`).
- **Renderer:** React 19, React Flow, Tailwind 4 and React Router (hash routing). It is sandboxed: no
  Node, no network.
- **Bridge:** a typed IPC contract in `packages/core/src/ipc.ts` replaces the HTTP API. The preload
  exposes a single allow-listed `invoke` plus run-update events.
- **Packaging:** NSIS `.exe`, `.dmg` and AppImage, built on each OS. Everything is bundled, so there
  are no native modules to rebuild.

**Alternatives:** Tauri 2 offers smaller installers and mobile support, but the engine would have to
run without Node, it needs a Rust toolchain, and rendering varies with each OS's webview. Native
per-OS apps would mean three codebases.

**Consequences:**

- Installers are ~100 MB.
- Builds are unsigned (macOS Gatekeeper and Windows SmartScreen show warnings). Signing is out of
  scope for the hackathon.
- Mobile is out of scope.
- `npm run smoke` gives agents and CI a headless-ish check of every screen.
