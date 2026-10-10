# Research API Settings

Open **Settings → Research APIs & Zugänge** to manage research access. This section is separate
from the existing AI model and web-search settings. It does not start research or select a model.

## Select web research explicitly

Use **Settings → AI & research → Web research → Provider** to select **Firecrawl (recommended)**
or **Tavily (alternative)**. Save that provider's credential and enable it separately in
**Research APIs & Zugänge** before an explicit workflow run. Saving a key, enabling a provider,
or changing the selector does not start collection.

- **Off (no web search)** blocks web search requests even when a web provider has a saved key and
  its Enabled switch is on.
- The selector controls web search only. YouTube, Apify, X, Reddit, OpenAlex, Eurostat, and local
  documents are controlled independently by their own access settings and the workflow request.
- There is no automatic fallback to another vendor when the selected provider is unavailable,
  disabled, or missing credentials.
- Existing `anthropic_web_search` settings remain valid for compatibility and display as
  **Claude web search (legacy · unsupported)**. That option is not offered for new selections.
  Choose Firecrawl, Tavily, or Off; the legacy value must never silently route to Firecrawl.

### Optional Mastra query planning

The Anthropic key in **AI & research → API keys** can support optional Mastra query planning.
Planning also requires the Research block's explicit query-planning toggle, **off by default**.
Saving an Anthropic key or selecting an AI model does not opt a block into planning. When enabled,
an explicit run may make paid Anthropic model calls using the configured planning model.

Planning generates retrieval queries only. It cannot enable providers, bypass missing credentials
or required platform approvals, override the web selector, or invent source evidence. Deterministic
query building remains available without model calls when planning is off. The block toggle and
backend enforcement are maintained by the core/main/block owners, not this Settings slice.

## Providers

The nine providers are grouped into web search, social/community access, and studies/documents:

| Provider                 | Credential fields                                                  | Additional controls                                                                     |
| ------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Firecrawl                | `firecrawl_api_key`                                                | Enabled switch; explicit connection test                                                |
| Tavily (alternative)     | `tavily_api_key`                                                   | Enabled switch; explicit connection test; does not replace the selected search provider |
| YouTube                  | `youtube_api_key`                                                  | Enabled switch; explicit connection test                                                |
| Apify (Instagram/TikTok) | `apify_api_token`                                                  | Separate platform approval and fixed actor allowlist                                    |
| X                        | `x_bearer_token`                                                   | Recent/full-archive selector; the account plan must permit the selected mode            |
| Reddit                   | `reddit_client_id`, `reddit_client_secret`, `reddit_refresh_token` | Separate research approval and identifiable user-agent                                  |
| OpenAlex                 | `openalex_api_key` (optional)                                      | Actual access and quota limitations come from the connection report                     |
| Eurostat                 | None                                                               | Public statistics; choose datasets in the workflow                                      |
| Local documents          | None                                                               | Uses documents imported and selected in Data Flow; no external connection               |

Official provider documentation links open in the system browser using the existing Electron
external-link handler. Local documents do not have an external service or API-key setup page.

Apify actor selection is limited to `APIFY_ACTORS` from the final shared contract:

- `apify/instagram-scraper`
- `apify/instagram-comment-scraper`
- `clockworks/tiktok-scraper`
- `clockworks/tiktok-comments-scraper`

Reddit's user-agent input requires an identifiable client in the form
`desktop:ReqFlow:0.1 (by /u/your_reddit_username)`, with 10–200 characters. Replace the example
username with the contact for your approved client. The shared schema is also validated before
configuration is submitted. These controls do not obtain platform permission on your behalf.

## Credentials and connection reports

- Inputs are masked, start empty, and never receive a configured credential from main.
- **Save** submits only a nonempty, trimmed draft. Empty or whitespace-only input cannot delete
  a credential. Submitting clears the draft immediately, before the IPC call completes. Failed
  saves require re-entering the credential; errors never retain a draft for retry.
- **Remove** is a separate button for each configured credential. It alone submits `null` to
  delete the saved credential. An environment credential may remain configured after removal;
  the refreshed main status is authoritative. Removal also clears any draft for that credential.
- Credential drafts are cleared on errors and when leaving the section. Returned credentials are
  never used as input values; only configured status is displayed.
- Saving or removing a key reloads provider statuses. Neither operation enables a provider,
  grants approval, tests a connection, nor launches collection.
- **Enabled**, **platform approval**, **credential configured**, and **connection tested** are
  distinct. A successful test never implies provider activation or platform approval.
- **Test connection** is an explicit, small check. It may consume API quota or credits. It does
  not launch a research workflow. The local-document check has no external request.

The UI shows the exact `ConnectionReport.state` code, its human-readable label, the main-process
message, `testedAt` when present, capabilities, and limitations. The supported codes are:
`not_configured`, `untested`, `success`, `invalid_credentials`, `permission_required`,
`rate_limited`, `unreachable`, and `unsupported`. A configured credential is not shown as a
successful connection. Missing statuses are displayed as unavailable, never replaced with demo
or fabricated results. Loading and error states provide an explicit status reload action.

The existing **AI & research → API keys** area now accepts a masked Anthropic key in the same
`anthropic_api_key` namespace. Saving/removing it reloads secret status without changing `llm`
settings. The existing Tavily status points to the new Research API section for editing.

## IPC boundary and persistence

Renderer operations use the existing typed `api` bridge only:

```ts
api.research.providers(): Promise<ResearchProviderStatus[]>
api.research.configure(id, config): Promise<ResearchProviderStatus>
api.research.test(id): Promise<ResearchProviderStatus>
api.settings.get(): Promise<Settings>
api.settings.setSecret(name, valueOrNull): Promise<SecretStatus>
```

Anthropic status is read with `api.settings.secrets()`. Secrets are never included in provider
configuration or the settings autosave store. The renderer performs no network, filesystem, or
Node operations. Only sanitized `ReqflowError.message` strings from main are displayed for
rejected calls; arbitrary errors, raw objects, and error details are not rendered.

Configuration uses the complete validated current `ResearchProviderConfig`, preserving fields
not edited by the control. After `configure` succeeds, the UI awaits
`settingsStore.getState().reloadResearchApis(): Promise<void>`. This reads and validates
`api.settings.get()`, then reconciles **only** `settings.research.apis`. Dirty theme, AI provider/model,
web selector, domains, and all other local settings survive unchanged. The pending 400 ms autosave
is neither cancelled nor restarted, and the provider refresh does not change persistence state.
The method throws on the current reload's failure so the controller can report an action failure.

Reconciliation runs even if the section was unmounted while configuring. Store generation guards
ignore older reload responses and errors after a newer reload begins. Autosave generation/revision
guards prevent older save responses or failures from replacing newer local edits. A full-settings
save response started before or during provider reconciliation cannot restore stale API flags.
These UI guards do not replace the main-process ownership rule below.

Research operations are serialized within the section. Inputs and action buttons are disabled
while an operation is pending. Generation guards discard stale responses after unmount or effect
replay, and credential drafts are discarded on unmount. Anthropic has an independent pending guard
and request generation. These guards do not cancel an IPC write that main has already received.

### Main-process assumptions

- `configure` persists `settings.research.apis[id]` in the same Settings object returned by
  `settings.get`, and returns one status rather than a list.
- `settings.save` validates general settings but preserves main's current `research.apis`, ignoring
  incoming API flags. This is required even for an autosave already in flight during configuration.
  Dedicated `configure` alone changes provider access flags; a stale general-settings save must not
  undo enablement, approval, actor allowlists, or revocation.
- `test` returns one status, does not activate a provider or grant approval, and returns sanitized
  report messages/capabilities/limitations.
- Provider statuses identify configured credentials by the exact `SecretName` keys listed above.
- Credential changes invalidate or otherwise accurately update any previous connection report;
  `providers()` must not return an old success as a test of the new credential.
- `setSecret(name, null)` removes the saved credential; environment fallback may remain.
- Secrets and connection reports returned by main contain no credential values and use sanitized
  messages. For credentials, only configured booleans and source (`keychain`/`env`) cross the read boundary.
- Main/block execution enforces Off and unsupported legacy web values without network requests or
  vendor fallback. Other providers remain independently controlled.
- The Research block's query-planning toggle defaults to false. Main supplies an Anthropic planner
  only for an explicitly opted-in block with configured access; planning never bypasses provider gates.

## Focused verification

No live provider checks or real credentials are used by the tests.

```sh
npm exec -- vitest run apps/desktop/src/renderer/src/lib/settings-store.test.ts apps/desktop/src/renderer/src/components/settings/sections/ResearchApisSection.test.ts
npm exec -- tsc --noEmit -p apps/desktop/tsconfig.web.json
```

Controller tests cover all provider/credential mappings, report codes, blank-save safety,
explicit removal, draft clearing, failed status refresh, sanitized errors, preservation of
configuration, fixed actor validation, separate testing/approval/enablement, pending guards,
and stale/unmounted responses. Store/controller integration tests verify that pending theme,
AI model/provider, web selection, and provider configuration all persist together. Store tests
also cover unchanged debounce timing, rapid edits, out-of-order save/reload success and failure,
and reconciliation overlapping an in-flight save. AI presentation tests verify the Firecrawl
selector, explicit Off, independently controlled providers, legacy compatibility, and planning help.
Static rendering tests use existing React DOM support; no new test package is required.

The main-process smoke script includes `settings-section-research-apis`. The parent integration
session owns full-root typecheck/tests and smoke verification. Do not run live connection tests
as part of smoke.
