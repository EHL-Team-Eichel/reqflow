# Publication, statistics and local document collection

These adapters return provider-owned original records through the final `ProviderAdapter` contract.
They do not classify opinions with AI, infer preferences from statistics, create forecasts, approve
requirements, or execute instructions contained in collected documents. All filesystem and subprocess
operations belong in the Electron main process.

## Exported factories and integration

```ts
// packages/blocks/src/research/providers/openalex.ts
createOpenAlexAdapter(): ProviderAdapter
// packages/blocks/src/research/providers/eurostat.ts
createEurostatAdapter(): ProviderAdapter
// packages/blocks/src/research/providers/documents.ts
createLocalDocumentsAdapter(): ProviderAdapter

// packages/blocks/src/research/documents/local.ts
interface LocalDocumentReaderOptions {
  resolveFile: (id: string) => Promise<{ path: string; name: string }>;
  doclingCommand?: string;
  xlsxWorkerPath?: string;
}
createLocalDocumentReader(
  options: LocalDocumentReaderOptions,
): NonNullable<ProviderContext["documents"]>
```

The parent supplies `resolveFile` from its trusted imported-file store. Renderer inputs are imported
`file_…` IDs only; the renderer never supplies a path or executable. The resolver must return an
absolute path to a regular, non-symlink file. An executable setting is main-process configuration,
not a document or renderer instruction. Use an absolute executable path when it is outside `PATH`.

```ts
const reader = createLocalDocumentReader({
  resolveFile: (id) => importedFiles.resolve(id),
  xlsxWorkerPath: join(__dirname, "research-xlsx-worker.js"),
});
// Supply this same reader through ProviderContext.documents for both BMW agents.
const documents = reader;
```

Cache document reads **in the parent run**, keyed by imported file ID and page limit. Share an
in-flight promise between `bmw_sales` and `bmw_strategy` when both select the same imported ID.
Scope that cache to a run with a shared run abort signal, remove failed promises, and do not reuse
cancelled promises across runs. The reader deliberately does not maintain a persistent content cache.
This preserves original source/record IDs and lets the parent deduplicate records while retaining
both collecting-agent associations. Adapters neither infer an import's BMW dataset kind from its
filename nor independently count repeated sheet associations as opinions.

Source identity uses `reqflow-file:///<fileId>`, not `file://` URLs containing private user paths.
`sourceTitle` is the imported ID. `metadata.originalArtifact = { fileId }` points back to the parent
file store; temporary conversion artifacts are not source identities. Table sheet names, row numbers,
Docling JSON pointers, page numbers and bounding boxes remain available for evidence lookup.

## OpenAlex

Verified against official documentation on 2026-10-10:

- [Search works](https://docs.openalex.org/api-entities/works/search-works).
- [Cursor pagination](https://docs.openalex.org/how-to-use-the-api/get-lists-of-entities/paging).
- [Work attributes](https://docs.openalex.org/api-entities/works/work-object).
- [Authentication](https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication).

Collection uses `GET https://api.openalex.org/works`, `search`, publication-date/language `filter`,
`cursor=*`, and response `meta.next_cursor`. Page size is at most the currently supported 100.
Queries come from the supplied query plan, scope questions, scope keywords, or vehicle/market scope;
no unrelated default research topic is substituted. Publication-date and supported two-letter
language filters come from scope. Geographic applicability is **not** inferred from author affiliation,
query wording, or a requested EU market. Allowed-domain rules cannot constrain OpenAlex's scholarly
corpus through these filters; this adapter collects OpenAlex metadata, not arbitrary linked sites.

Optional `openalex_api_key` travels only in the officially supported `Authorization: Bearer …`
header, never in a URL, output record, or adapter log. The injected HTTP transport must also redact
authorization headers. HTTP failures are converted to fixed, credential-safe messages. Pagination
deduplicates work IDs and reports result/request limits, repeated cursors, cancellation and partial
page failures explicitly. The connection probe performs one search with `per_page=1&select=id,title`.

`abstract_inverted_index` is reconstructed by position with original tokens and no paraphrasing.
Returned text is labeled `ABSTRACT\n…`; `metadata.contentLevel` is `abstract`. Missing or ambiguous
indexes yield explicitly labeled metadata-only records. Publication metadata includes title, DOI,
authors, bibliographic fields, date/year, language, work type, OA and retraction metadata.

An explicitly OA primary-location PDF URL is preserved only as an **unretrieved original reference**
with `accessibility: "provider_metadata"`. Credential-bearing links are not retained. This contract
has no remote binary downloader/parser, so this adapter does not download PDFs, scrape landing pages,
retrieve OpenAlex metered content, or call local Docling on remote documents. OpenAlex abstracts and
OA flags are **not full-text evidence** and do not provide complete commercial market studies.

## Eurostat

Verified against official documentation on 2026-10-10:

- [Statistics API overview and time filters](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-getting-started/api).
- [Statistics API detailed guidelines](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-detailed-guidelines/api-statistics).

Collection requires explicit `scope.eurostatDatasets`, including dataset codes and dimension filters.
Without them, the outcome is `blocked` with a selection limitation, not unrelated statistics. Requests
use the official Statistics 1.0 JSON-stat 2.0 endpoint with `format=JSON` and an API-supported label
language (`EN`, `DE`, `FR`). Geographic filters are passed exactly; `EU` is never expanded to an EU
aggregate or country list. `time`/`time_period`, `sinceTimePeriod`, `untilTimePeriod` and
`lastTimePeriod` remain explicit dataset selections. Conflicting time modes and simultaneous
`geo`/`geoLevel` are rejected. Publication dates are not silently reinterpreted as observation periods.

Each dataset selection produces a raw metrics **table record**, not prose conclusions. Row-major
coordinate decoding follows `id` and `size`; both dimension codes and category labels appear in
columns. Values remain numeric, zero remains zero, and missing/suppressed observations remain `null`.
Observation status strings, including combined flags such as `ep`, are preserved without interpretation.
Dimensions, labels, explicit units, notes, annotations, raw sparse/dense values/status and full
extensions are retained. `updated` is dataset metadata, not an observation's publication date.

A selection is capped at 20,000 observation cells. Larger or asynchronous extractions produce an
explicit limitation requesting narrower filters; no partial table is mislabeled complete. Dataset
failures preserve successful preceding selections. The connection probe retrieves a single latest
`demo_pjan` observation for `geo=DE&sex=T&age=TOTAL`, not a research run or default dataset suggestion.

## Local TXT and XLSX

Plain UTF-8 TXT is retained verbatim as one passage. Invalid encoding is rejected rather than
silently replacing bytes. Text is never interpreted as executable instructions.

Regular XLSX uses the existing `exceljs` dependency, with deterministic workbook/sheet order.
Every sheet is preserved; the first nonempty row is the header, subsequent row positions and values
remain exact, including interior blank rows and `null` cells. Empty header cells remain empty strings.
This deterministic header rule is stated as a limitation; it is not a semantic header detector.
Numbers, booleans, strings, saved formula results, rich text, hyperlink display text and ISO date
representations are supported. Formula objects, rich-text/hyperlink artifacts, date formats and cell
notes remain in metadata. Formulas, hyperlinks and macros are never executed or followed. Explicit
unit columns/header markers and source cell notes populate table units/footnotes. Units are not
inferred from a value's magnitude. `maxPages` does not truncate spreadsheet sheets.

The `Feedback_Explorer` layout requires explicit feedback ID, text and VFC columns. Repeated
**same ID + same text** rows become one `feedback` record with multiple original VFC associations,
row locators and source classifications. Different IDs remain distinct even with identical text;
different texts under one ID remain separate and carry a conflict limitation. Classification cells
are marked `origin: "source_explicit"`; no AI classification or additional independent opinion is
created. Conflicting market/vehicle cells remove single-value attribution but retain original rows.

Files are capped at 64 MiB, each sheet at 100,000 rows and 512 columns. These are fail-explicit safety
bounds, not silent truncation. Plain TXT and XLSX need no Python or Docling installation.

### XLSX memory and execution isolation

The desktop parent must build `packages/blocks/src/research/documents/xlsx-worker.ts` as a separate
Node worker entry named **`research-xlsx-worker.js`** and supply its trusted absolute output path as
`xlsxWorkerPath`. The worker imports ExcelJS directly; bundle its runtime dependencies or ensure
they are resolvable from that output location. Place the entry outside ASAR and keep it independent
of renderer code. This slice does not modify Electron/Vite configuration; the parent owns that entry.

With `xlsxWorkerPath`, parsing runs in a real `worker_threads.Worker`, not on the main event loop.
The worker receives transferred workbook bytes only, an empty environment (no provider secrets),
no inherited `execArgv`, and `workerData: { reqflowXlsxWorker: true }` as its entry marker. The worker
has a 128 MiB old-generation heap limit, 16 MiB young-generation limit and 4 MiB stack limit. These
V8 limits are **not a total RSS limit**; ZIP buffers/native allocations are separately bounded below.
The parent enforces a 30-second parse deadline, promptly terminates CPU-bound workers on cancellation,
discards worker stdout/stderr, and converts parser/runtime failures to fixed messages without paths
or document text. A configured worker failure never triggers in-process or cloud fallback.

Before starting the worker or ExcelJS, the parent checks ZIP central/local headers. XLSX archives
are limited to **16 MiB compressed**, **32 MiB total declared expansion**, and **2,048 entries**.
Malformed, encrypted, multi-disk and unsupported compression archives are rejected; Zip64 is explicitly
unsupported. Local/central sizes and names must agree, file ranges cannot overlap, and duplicate
entry names are rejected. Decompression additionally verifies actual entry length using a bounded
zlib output limit before ExcelJS sees the workbook, so under-declared expansion cannot bypass bounds.

Worksheet XML row/cell/dimension addresses are checked before ExcelJS load, and decoded sheet
dimensions are checked again after loading. The aggregate budget across **all** sheets is
**1,000,000 `rowCount × columnCount` cells**, including sparse gaps; no dense representation is created
before that check. Parsed existing-cell metadata is capped at **16 MiB** before worker transfer and
revalidated by the parent. The worker returns preserved row/cell data, not an unchecked workbook model.
The reader uses existing cells only, never `getCell`/`getRow` to materialize absent cells, and yields
periodically while producing bounded null-filled table rows. Feedback records retain only their own
association rows/artifacts; they do not clone the entire sheet's row index per opinion.

Header provenance has an additional fail-explicit bound before table creation, unit extraction,
column normalization or per-feedback header copies: **16,384 UTF-16 code units per header** and
**128 KiB per worksheet's serialized UTF-8 header array**, including JSON escaping, brackets and
commas (at most 512 headers). Raw string lengths and rich-text run lengths are checked before joining
or converting header text. Exceeding either bound throws `ProviderError` with `code: "limit_reached"`
and a static message that contains no header excerpt. Headers within the bounds are preserved
verbatim, not shortened or relabeled. These limits apply only to headers, not Customer Feedback
bodies, which remain subject to the existing aggregate/output safeguards. Regression tests run the
actual bundled parser in a configured Worker against a synthetic 3 MiB header and 50 feedback rows,
and verify rejection before normalization or collected-record copies. Valid 3 KiB headers and long
feedback bodies remain unchanged.

The optional path preserves in-process compatibility for callers/tests that do not provide a worker.
That mode still applies ZIP expansion, pre-load address, output and aggregate cell checks, but does
**not** provide the worker's heap isolation or hard termination deadline. Desktop integration must
supply `xlsxWorkerPath`; do not use compatibility mode for production untrusted imports. Synthetic
CJS worker tests cover real Worker invocation, empty environment, cancellation, deadline and fixed
error handling. Native Electron worker bundling/smoke verification remains the parent's integration gate.

## Optional local Docling subprocess

Verified against official documentation on 2026-10-10:

- [Installation](https://docling-project.github.io/docling/getting_started/installation/).
- [CLI reference](https://docling-project.github.io/docling/reference/cli/).
- [Model prefetch and offline usage](https://docling-project.github.io/docling/usage/advanced_options/).

PDF/DOCX/PPTX conversion is optional and requires a separately installed **local** Python Docling
CLI and prefetched layout/table models. Electron installers do not gain this Python runtime or
model assets merely by bundling JavaScript. Packaging must include architecture-compatible Python,
Docling/PyTorch dependencies and model artifacts outside the ASAR, or document a local installation.
No manifests or installer definitions are changed by this slice.

Example development preparation (an explicit operator action, never an automatic document fallback):

```sh
python -m venv .venv-docling
# Activate this environment using your platform's normal command.
python -m pip install docling
docling-tools models download layout tableformer
# Set DOCLING_ARTIFACTS_PATH to an absolute path containing these prefetched artifacts.
# On Windows, pass the trusted .venv-docling/Scripts/docling.exe path as doclingCommand.
# On macOS/Linux, pass the trusted .venv-docling/bin/docling path as doclingCommand.
docling --help
```

Pin and test the chosen Python/Docling/PyTorch versions when packaging. Intel macOS has distinct
PyTorch compatibility constraints described in the official installation page. Prefetch happens
before sensitive document parsing and may contact model repositories; parsing itself never installs
dependencies or downloads assets.

The reader probes help locally (at most two five-second subprocesses), detects the newer `convert`
subcommand versus a compatible legacy CLI, and checks required safety/page/export flags. A missing
executable, unsupported CLI, or absent absolute `DOCLING_ARTIFACTS_PATH` leaves TXT/XLSX available and
reports complex formats unsupported. A help probe does not prove that every required model is
installed; missing/incompatible model assets produce an explicit conversion error.

Conversion uses `spawn` with an argument array and `shell: false`, a private temporary directory,
a fixed temporary input filename, JSON output, `--page-range 1-N`, a 120-second CLI/process timeout,
abort-signal cancellation, and bounded subprocess/output bytes. The subprocess receives only an
allowlisted local environment, not provider credentials. Remote services and external plugins are
disabled, model-cache offline flags are set, and OCR is disabled in this deliberately narrow slice.
Scanned PDFs need a separately approved local OCR integration; no cloud OCR fallback exists. The
runtime must be provisioned offline and can additionally be network-sandboxed by packaging policy.

PDF/PPTX page limits are passed to the backend. DOCX does not have stable PDF-style pagination;
records state that bounds apply where supported and do not claim complete page coverage. Exported
text prefers Docling `orig` over normalized `text`, tables retain cell spans/flags, footnote refs and
original text, and records retain JSON pointers/page provenance plus the original imported artifact
ID. Temporary files are removed in `finally`, including on cancellation; cleanup failure is explicit.

The current development host has no detected `docling` command. Tests exercise deterministic
TXT/XLSX ingestion and a **synthetic local executable** for real subprocess invocation, safety flags,
JSON export ingestion and cancellation. They do not claim a real Python/model-backed PDF conversion
was run or that Docling is already packaged.
