# Raw research verification

**Final integration record — 2026-10-10**, working tree on `ws6-research`.
Host: macOS (`darwin`, arm64), Node v24.21.0, npm 11.19.0.
This record supersedes intermediate slice verification and integration TODOs in the provider docs.

## Completed acceptance gates

| Gate                                               | Actual result                                                                                                                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                | Passed for every workspace.                                                                                                                                                                    |
| `npm test`                                         | **37 test files, 992 tests passed**, no failures or skips.                                                                                                                                     |
| `npm run check`                                    | Passed at 21:26 local time after the dev-start fix: root typecheck, all 992 tests, repository Prettier check.                                                                                  |
| `npm run dev`                                      | Passed: actual development renderer displayed Data Flow and successfully invoked the typed IPC bridge, with addon opt-out flags unset.                                                         |
| `npm run smoke`                                    | Passed: native Electron, **17 screenshots, 69 research checks**, zero provider/model requests.                                                                                                 |
| `npm run package:dir --workspace @reqflow/desktop` | Passed: unsigned macOS arm64 `.app` directory build.                                                                                                                                           |
| Packaged application smoke                         | Passed: **17 screenshots, 69 research checks** using the actual packaged app and ASAR-unpacked Worker.                                                                                         |
| Bundled WebSocket fallback                         | Passed in actual dev, rebuilt production, and rebuilt packaged ASAR: guarded optional imports, 64/65-byte mask/unmask and JavaScript/Node UTF-8 paths.                                         |
| Independent code review                            | Seven reported correctness/architecture findings fixed and re-reviewed; 502 focused tests passed. No remaining blocker found in the reviewed scope.                                            |
| Independent security review                        | Six initial findings and a subsequently discovered XLSX provenance-amplification finding fixed and independently reproduced as closed. No remaining blocker established in the reviewed scope. |
| `git diff --check`                                 | Passed.                                                                                                                                                                                        |

The native and packaged reports are generated, gitignored artifacts:

- `apps/desktop/out/smoke/report.json`
- `apps/desktop/out/smoke-packaged/report.json`
- `apps/desktop/out/dev-launch/report.json`

Screenshots actually opened during parent verification: `dataflow.png`, `dataflow-inner.png`,
`dataflow-research-result.png`, `settings-ai.png`, `settings-research-apis.png`, and the packaged
`dataflow-research-result.png`. Light/dark layouts, navigation, provider controls, honest partial
statuses, and export actions were visually inspected; no blocking layout issue was observed.

### What native execution proved

The GUI imported a synthetic twelve-column XLSX through the typed IPC/native-file boundary,
saved and started the actual Research workflow, and parsed it in a **real compiled Worker thread**.
The packaged Worker entry was:

```text
ReqFlow.app/Contents/Resources/app.asar.unpacked/out/main/research-xlsx-worker.js
```

Both BMW agents produced one shared source and two raw records, including **one independent
feedback opinion with two source-supplied VFC associations**. Verbatim feedback, original IDs,
metadata, source rows, escaped HTML, and unknown reliability/market/vehicle values survived.
Both agents honestly reported `partial` because web research was Off, with **zero API requests**.
JSON/XLSX/CSV exports were written and read back; JSON/Excel IDs, association rows, persisted
datasets/outputs, and audit events were checked.

Smoke mode isolates Electron user data, skips dotenv and development renderer URLs, uses only
synthetic dialog inputs, and rejects outbound transport. No real keys or BMW originals were read.

### Development startup regression

Vite resolved `ws`'s optional `bufferutil` and `utf-8-validate` imports to eager throwing modules
in development and empty stubs in production. That defeated the upstream guarded imports:
development failed at app load, while production could fail later when masking longer frames.
The main-process Rollup configuration now leaves only these optional native probes external,
preserving `ws`'s working JavaScript fallback without shipping native addons.

`apps/desktop/src/main/ws-bundle.test.ts` bundles the real helpers using the application configuration
in both modes, deliberately hides the optional addons, and exercises their guarded fallbacks.
Independent network-free probes also executed unchanged helper sections from the actual emitted
development/production bundles and the rebuilt packaged ASAR. All passed with opt-out flags unset.
Actual `npm run dev` startup and development UI/IPC were verified against isolated research state;
native and packaged smoke were rerun after the fix.

## Reproduce

From the repository root with dependencies installed and Node ≥22.13:

```sh
npm run typecheck && npm test
npm test -- apps/desktop/src/main/ws-bundle.test.ts
npm run check
npm run smoke
npm run package:dir --workspace @reqflow/desktop
"apps/desktop/release/mac-arm64/ReqFlow.app/Contents/MacOS/ReqFlow" --smoke=apps/desktop/out/smoke-packaged
```

The final command is macOS arm64-specific. The built directory app is unsigned; no signed/notarized
installer, Windows installer, or Linux package is claimed.

## Automated coverage and review corrections

All test originals, credentials, transports, encryption doubles, and parser executables are synthetic.
Mastra tests instantiate real Agents and mock generation; they do not buy model calls.

- **Contracts/agents:** exact thirteen IDs, strict input validation, neutral query builders,
  selected-agent routing, explicit provider Off/legacy behavior, no fallback, credentials/approval/
  actor/domain gates, and opt-in scope-only Mastra planning.
- **Providers/HTTP:** original payloads, unknown/coarse dates, paginated comments/replies/cursors,
  401/403/429/schema failures, bounded rate-limit retries, shared planner/HTTP budgets, FIFO
  concurrency, request/body cancellation, endpoint/redirect restrictions, redacted credentials,
  and known-run Apify abort cleanup after ordinary cancellation or budget exhaustion.
- **Documents/resources:** ZIP declared and actual expansion, sparse-workbook cell budgets,
  Worker termination/isolation, header limits, post-normalization JSON byte budgets, safe
  persistence before stringification, and bounded renderer preview without executing getters.
  A 10,437-byte malicious synthetic workbook with a 3 MiB header is rejected; a separate 65 MiB
  persistence probe performed zero stringifications/writes and preserved earlier stored content.
- **Raw/export fidelity:** latest-retrieved revision selection, provenance unions, source-supplied
  feedback associations, twelve-column compatibility, formula-injection guards, CRLF/Unicode,
  reconstructable XLSX overflow, tables/units/flags/nulls, and written-byte round trips.
- **Main/renderer/executor:** partial/cancel/restart preservation, serialized concurrent audit
  appends, synchronous start/resume reservations, partial credential-store reload/removal,
  fail-closed Linux encryption doubles, sanitized IPC errors, stale report invalidation,
  settings reconciliation preserving unrelated pending edits, branch/subflow/HIL-resume contracts.

## Dependency audit

Fresh `npm audit --json` on 2026-10-10 reports **12 moderate, 0 high, 0 critical** advisories
(command exit 1). This is **not a clean audit**. The ExcelJS `uuid` override resolves to 11.1.1,
removing its previous advisory. Remaining chains involve Mastra's `gray-matter`/`js-yaml`/
`argparse`/`sprintf-js` and the existing Electron-builder `global-agent`/`roarr` chain.
Suggested audit remedies are breaking-version downgrades, not compatible patches; they were
not blindly applied. The bundle still emits a gray-matter `eval` warning. Review established no
raw-source execution path into that code: these Mastra Agents configure no skills, workspace,
tools, or source-content prompts. This does not remove the advisories or prove general immunity.

## Material limits and unverified access

- **Live providers:** real credentials, billing, Reddit approval, Apify usage rights, X archive
  entitlement, complete conversations, captions/transcripts, and full-text studies were not tested.
  Official documentation was checked; that is not live access or permission evidence.
- **Private data:** no BMW files or Windows reference workbook were inspected. The supplied
  4,076 association rows / 2,128 unique IDs remain unverified reference figures; synthetic
  twelve-column/association behavior was verified instead.
- **Docling:** unavailable on this host. Real local Python/model-backed PDF/DOCX/PPTX conversion
  and model provisioning remain unverified; OCR is disabled and no cloud fallback exists.
- **Other platforms/OS encryption:** Windows/Linux native execution and real platform keyrings
  were not tested. Encryption rejection/reload tests use doubles; the smoke writes no keys.
- **Budgets/revocation:** limits apply per Research block, not workflow-wide monetary totals.
  Apify caps are per actor; up to four cleanup attempts are supplemental to ordinary request
  limits. Cancellation cannot guarantee a remote stop/refund. Revocation affects subsequent run
  snapshots; cancel active runs for immediate stopping. Vendor-side DNS/redirect behavior is not
  independently verified.
- **Product scope:** this is raw collection/export. Other workstreams' analytical blocks and
  requirement persistence remain unimplemented; no end-to-end BMW decision-making claim is made.
