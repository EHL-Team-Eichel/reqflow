# Customizing a Research block

Select a **Research** block in Data Flow. Its inspector keeps the existing workplace action,
research question, local-document picker, query-planning switch and generic budget controls.
The new controls edit only the canonical `params.agents` and `params.scopeJson` values. They do
not start collection, enable providers, grant platform permission or approve requirements.

## Social media and Research agents

**Social media** is a native, single-select dropdown with these options:

- **None** removes `reddit`, `youtube`, `instagram`, `tiktok` and `x` from the selected agents.
- **Reddit**, **YouTube**, **Instagram**, **TikTok** or **X** replaces that social subset with one agent.
- **All** selects all five social agents.
- **Custom** reflects a combination of two to four social agents. Choose the combination with
  the existing **Research agents** chips; selecting Custom itself does not alter the agents.

Every dropdown change preserves the non-social agents and their order, including owner forums,
editorial reviews, competitors, studies, regional context, technology and BMW publications.
The chips still support arbitrary social/non-social combinations. Both controls use the same
`agents` array; there is no persisted social-media parameter. Chip changes immediately update
the dropdown's displayed selection.

At least one research agent must remain selected. Choosing None with only social agents selected,
or removing the final chip, shows **Select at least one research agent.** and keeps the last
accepted selection. To disable social collection, first select a non-social agent, then choose None.

The legacy **Look at** / `sources` selector is hidden. Its saved value is not rewritten here and
does not select collectors. Provider credentials, enablement and approvals remain in Settings.
Agent selection never implies available access or complete collection.

## Research scope form

The **Scope form** exposes:

- Brand and model overrides.
- Current and previous vehicle generations, derivative, propulsion and model year.
- Markets and languages, one value per line.
- Publication start and end dates.
- Keywords, one complete phrase per line.
- Source URLs, one complete URL per line.
- Optional competitors, each with a brand, model and optional generation.

Fields are overrides, not prefilled copies of global settings. In particular, a blank **Model
override** means **From Settings**, resolved by the backend when the workflow runs. Clearing an
edited field removes its key from `scopeJson`; it does not write a made-up replacement model,
market or language. The renderer does not write schema defaults into the scope object.

Where present in an older block, **Fallback market (legacy)** is used only when `scopeJson` has no
`markets` override. The existing maximum-age control remains a backend publication-date fallback;
an explicit `publishedFrom` overrides it. Clearing a date override does not promise an unbounded
date range. Backend defaults and the workflow scope still apply.

Markets and languages are collection filters, not source metadata. A selected market or language
must never be presented as evidence that a returned source belongs to it. Missing source metadata
remains unknown. Competitors and URLs are operator inputs, not gathered evidence or verified claims.

Edit the form, then choose **Apply scope**. The full candidate must pass the shared `ResearchScope`
schema before the inspector submits it to the existing workflow store. Invalid URLs, incomplete
competitors, invalid calendar dates and a publication start after its end show an error without
changing the accepted scope. Scope edits are local drafts until applied; apply them before Start.
**Discard draft** explicitly restores the accepted scope.

## Advanced JSON and preservation

**Advanced JSON** edits the same `scopeJson`, not another scope object. It still supports fields
outside the form, including `questions`, `horizonYears`, `allowedDomains`, `blockedDomains`,
`documentIds` and `eurostatDatasets` with their dimension filters. Domain policies and document
access continue to be enforced in the main process.

Form changes patch only fields that were edited. Existing valid advanced fields remain intact;
unchanged strings, arrays and optional values are not normalized or replaced with defaults.
Explicit empty arrays or empty optional strings entered through advanced JSON also remain intact
when untouched; remove those keys in JSON if you want to restore backend defaults instead.
Switching between form and JSON first validates the draft and carries it across. There is no
silent reset to `{}`. Applying valid advanced JSON keeps its text as entered.

Invalid JSON stays visible with an error. Invalid schema values and unknown keys are also retained
in the editor, but cannot be accepted or switched into the form until corrected: the current
`ResearchScope` contract is strict. The UI never silently drops unsupported fields. Extend the
shared contract through its owner if a new scope field is required.

Lists use newlines, not commas, so commas inside keywords and URLs remain intact. Unicode model
names, keywords, languages and URLs survive serialization. Scope JSON is configuration only:
never put API keys, passwords or credentials in it or in a source URL.

## UI selectors

Stable selectors for parent-owned desktop interaction tests:

- `[data-testid="research-configuration"]`
- `select[data-testid="research-social-media"]`
- `[data-testid="research-agents"] button[aria-pressed]`
- `[data-testid="research-scope"]`
- `[data-testid="research-scope-form-toggle"]`
- `[data-testid="research-scope-advanced-toggle"]`
- `[data-testid="research-scope-json"]`
- `[data-testid="research-scope-apply"]`
- `[data-testid="research-scope-discard"]`
- `[data-testid="research-scope-error"]`
- `[data-testid="research-scope-<key>"]`, where `<key>` is `brand`, `model`,
  `currentGeneration`, `previousGeneration`, `derivative`, `propulsion`, `modelYear`,
  `markets`, `languages`, `publishedFrom`, `publishedTo`, `keywords` or `urls`.
- `[data-testid="research-scope-competitors"]` (open the Competitors disclosure first).
- `[data-testid="research-competitor-add"]`
- `[data-testid="research-competitor-<index>-<key>"]`, with a zero-based index and
  `brand`, `model` or `generation`.

The existing inspector, Raw preview, splitter workplace and HIL review-report selectors and
controls remain unchanged.

## Offline regression tests

Run from the repository root:

```sh
npx vitest run apps/desktop/src/renderer/src/components/dataflow/research-configuration.test.ts
```

The colocated tests use synthetic configuration only. They cover social combinations and
non-social preservation, zero-selection errors, clearing overrides, invalid JSON/schema values,
publication dates, URLs, competitors, Unicode and round-tripping prior advanced fields. They make
no network or filesystem requests and do not establish live provider access.
