# Research and multi-provider integration verification

**Final integration record — 2026-10-11**, branch `ws6-ai-providers`.
Host: macOS (`darwin`, arm64), Node v24.21.0, npm 11.19.0.
Integrated upstream `main` at `9228fb3`, preserving its SQLite services, Car, HIL,
splitter workplaces, templates, lineage and Raw ingestion alongside Research.

## Completed gates

| Gate                                               | Actual result                                                                                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                                    | Passed at 00:52 local time: all-workspace typecheck, **71 test files / 1,625 tests passed / 25 skipped**, repository Prettier check.    |
| `npm run smoke`                                    | Passed: native Electron, **36 screenshots / 85 Research checks**, zero application-provider/model requests.                             |
| `npm run package:dir --workspace @reqflow/desktop` | Passed: unsigned macOS arm64 directory app.                                                                                             |
| Packaged application smoke                         | Passed: **36 screenshots / 86 Research checks** in the actual `.app`, including ASAR-unpacked XLSX Worker execution.                    |
| Package inventory                                  | Passed: 22 ASAR entries, compiled main/preload/renderer plus manifest only; no agent logs, smoke user data, credentials or source data. |
| Packaged WebSocket fallback                        | Passed: actual emitted ASAR helpers, guarded optional imports, 64/65-byte masking and JavaScript/Node UTF-8 paths.                      |
| Independent LLM review                             | No actionable blocker found; **205 focused tests across 13 suites** passed. Live vendor compatibility remains unverified.               |
| Independent requirement-integrity re-review        | Concurrent-update and mutation/audit atomicity findings closed; **32 focused synthetic tests** passed.                                  |
| Independent Research access re-review              | Active-revocation finding closed; **22 integration tests** passed, including all five non-cooperative-transport revocation cases.       |

The 25 skipped tests require absent private BMW fixtures. They were not supplied,
read or uploaded. All executed test data and API transports are synthetic.

Generated reports, screenshots, model-routing diagnostics and delegate logs are gitignored:

- `apps/desktop/out/smoke/report.json`
- `apps/desktop/out/smoke-packaged-ai-providers/report.json`
- `apps/desktop/out/agents/`

Parent inspection opened native `settings-ai-openai.png`, `settings-ai-google.png`,
`dataflow-research-configuration.png`, `dataflow-research-result.png`, and packaged
`dataflow-research-result.png`. Provider/model controls, social dropdown, layout,
honest partial results and export controls were inspected.

### What native execution proved

- Upstream synthetic Raw, splitter, HIL, Car, lineage and template workflows still execute.
- Settings selects OpenAI/Gemini, switches quality/fast presets and remembers custom model IDs.
  These GUI checks use no keys and perform no live model request.
- The social-media dropdown replaces only social agent selections, preserving non-social agents.
- A synthetic twelve-column XLSX is imported through native-file/typed IPC boundaries and parsed
  by the real compiled Worker. Packaged execution uses
  `ReqFlow.app/Contents/Resources/app.asar.unpacked/out/main/research-xlsx-worker.js`.
- Both BMW agents share one source and two raw records: one independent feedback opinion with
  two original association rows and all source-supplied VFC values. Original IDs, text, metadata,
  source rows, escaped HTML and unknown attribution remain intact.
- Both BMW agents honestly report `partial` while web access is Off, with zero API requests.
  JSON/XLSX/CSV exports are read back and checked against SQLite datasets, outputs and audit.

Smoke isolates user data, skips dotenv/development URLs, disables environment credentials,
uses synthetic native-dialog inputs, and rejects outbound application transport. The packaged
probe receives only the repository's synthetic `data/samples` path through its smoke-only setting.

## Correctness and security coverage

The previous Research branch's resource, provenance, cancellation and export protections remain
covered: bounded ZIP/Worker/header/normalized JSON sizes, pre-stringification persistence limits,
bounded escaped previews, latest-retrieved deduplication, formula safety, CRLF/Unicode and overflow
round trips, paginated official APIs, partial preservation, domain/access gates and shared budgets.

This integration additionally verifies:

- **LLM transports:** OpenAI Responses and Gemini `generateContent`, text/object generation,
  original Zod validation, provider-specific schemas, optional/null handling, refusals/safety/
  unsuccessful termination, cancellation, custom models and sanitized errors. Anthropic/mock remain.
- **Mastra:** selected provider/key/fast model, explicit opt-in, scope-only prompts, one step,
  zero retries, strict local query validation and no silent paid fallback.
- **Unified persistence:** one main composition root and execution kernel; SQLite datasets and
  settings snapshots, queued persistence before execution, restart recovery, HIL restore,
  partial outputs, rollback-safe legacy migration and reversible imported-file copies.
- **Requirement integrity:** immutable versions, expected-current-version compare-and-swap,
  no late challenge overwrites or deletion resurrection, and atomic mutation/evidence/audit
  savepoints. No network or asynchronous yield occurs inside these database transactions.
- **Immediate Research revocation:** disabling access, deleting credentials, setting web Off,
  tightening an allowlist or adding a blocklist aborts active collection. A held search deliberately
  ignores its signal; the run settles before release, no following scrape dispatches, no late
  evidence enters the dataset, and earlier originals remain unchanged.
- **Coding-agent routing:** resolved project configuration enforces Gemini-only delegated roles
  despite installed role-file overrides; low/medium/high reasoning profiles match actual task
  effort. This is independent of the app's three live LLM providers. Restart interactive OpenCode.

The Vite optional-`ws`-addon regression remains covered by `ws-bundle.test.ts` in development and
production. Fresh package helper probes passed. Actual dev UI/IPC was verified on the earlier
`ws6-research` branch; it was not rerun as a separate acceptance gate for this integration.

## Reproduce

From the repository root, with dependencies installed and Node ≥22.13:

```sh
npm run check
npm run smoke
npm run package:dir --workspace @reqflow/desktop
REQFLOW_SMOKE_SAMPLES_DIR="$PWD/data/samples" \
  "apps/desktop/release/mac-arm64/ReqFlow.app/Contents/MacOS/ReqFlow" \
  --smoke=apps/desktop/out/smoke-packaged-ai-providers
```

The last command is macOS arm64-specific. No signed/notarized installer, Windows installer
or Linux package is claimed.

## Dependency audit and remaining limits

Fresh `npm audit --json` reports **12 moderate, 0 high, 0 critical** advisories (exit 1).
This is not a clean audit. ExcelJS resolves the overridden `uuid` 11.1.1; remaining chains
include Mastra's gray-matter/js-yaml/argparse/sprintf-js and Electron-builder's global-agent/roarr.
Suggested breaking downgrades were not applied. The build still warns about gray-matter `eval`;
review found no raw-source execution path through these tool/workspace-free query-planning Agents.

- **Live APIs:** real Anthropic/OpenAI/Gemini generation, account model availability, billing,
  platform approvals, X archive access, Apify rights and complete conversations were not tested.
  Presets and official documentation are not proof of account access.
- **Private data:** no BMW originals or Windows reference workbook were inspected. The supplied
  4,076 association-row / 2,128 opinion figures remain unverified reference counts.
- **Docling/platforms/keyrings:** real local Docling conversion/model provisioning, Windows/Linux
  native execution and real OS encryption were not exercised. Encryption tests use doubles and
  smoke stores no keys. There is no cloud parser fallback.
- **Budgets:** limits are per Research block, not workflow-wide monetary totals. Apify charge caps
  are per actor; up to four independent cleanup attempts supplement ordinary request limits.
  Abort cannot guarantee a remote stop or refund; vendor-side DNS/redirect behavior is unverified.
- **Product depth:** native synthetic integration is verified, not an end-to-end private BMW
  decision-making validation. Existing HIL/reviewer metadata is not a separate authentication system.
