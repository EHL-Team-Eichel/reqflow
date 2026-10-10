# Workstream status

### WS1 — Engine, persistence & main process

- **Status:** in progress
- **Agent:** OpenCode (GPT-6.1 Sol)
- **Branch:** `ws1-engine`
- **Works:** repository cloned; `npm install` completed on Node 24.18.0.
- **Verify:** implementation checks not run yet. Run `npm run check` before merging.
- **Next:** fixture-backed read handlers first; then SQLite repositories, executor,
  review/output nodes, and validated IPC wiring, in small tested slices.
- **Decisions:** the initial checkout has no `docs/STATUS.md` and the remote has
  only `main`; WS1 is the first parallel workstream in `docs/WORKSTREAMS.md`.
  Claiming it provisionally without assigning statuses to other workstreams.
  Follow the existing architecture and core contracts; keep all engineering
  changes inside WS1-owned paths.
- **Setup:** only `opencode` is installed among the requested agent CLIs.
  Entire 0.11.4 was installed locally with a verified release checksum and
  `entire enable --agent opencode` installed its project plugin. Existing Claude
  hooks were preserved. `entire status --json` reports enabled with Claude Code
  and OpenCode, but no active captured session yet; checkpoint capture is not
  claimed as verified. CLI path for this machine:
  `C:\Users\jonas\AppData\Local\Temp\opencode\entire\entire.exe`.
- **Open questions / requests:** none for core yet. `npm install` reported eight
  moderate dependency vulnerabilities; no out-of-lane dependency changes made.
