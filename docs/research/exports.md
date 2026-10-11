# Raw research exports

Exports validate the shared `ResearchDataset` contract. They do not infer sentiment, human
classifications, or requirement decisions. Where mandatory AI source content assessment was executed,
tabular outputs filter non-relevant material and XLSX includes dedicated assessment details, while all
originals remain intact in the raw dataset and archive sheets.

## Identity and collected revisions

- Source IDs use the normalized source URL. Normalization removes fragments and `utm_*`,
  `fbclid`, and `gclid` tracking parameters and sorts query keys. Meaningful query parameters,
  repeated values, editions, and languages remain part of identity.
- Firecrawl and Tavily publications at the same normalized URL share a document record ID,
  even when the vendors supply different IDs. Comments from other providers use the provider,
  host, and original record ID, so identical text does not collapse independent comments.
- Merging selects each record's greatest `retrievedAt`, regardless of dataset argument order.
  Sources use their own `retrievedAt`, not their records' timestamps. The dataset's run ID and
  timestamp come from the latest dataset. Timestamp comparisons retain fractional-second precision.
- Equal timestamps use the later merge argument. Collection agents, run IDs, and limitations
  are always unioned with all previously accumulated values, including values from older revisions.
  Collection outcomes remain available, including partial or failed agents.
- Assessments under `record.fields.researchAssessments` are preserved per record, deduplicated by
  `${assessment.agentId}:${assessment.runId}:${JSON.stringify(assessment.scope)}`. If a record's
  content changes, only assessments whose `contentHash` matches the latest revision are retained;
  prior assessments for older content are discarded.
- A changed content hash adds an explicit revision limitation, including the timestamp tie rule.
  Merging does not overwrite earlier run datasets. Export or retain those datasets to inspect
  earlier content; the merged dataset contains only the selected revision for each record ID.

## JSON

`exportResearchJson` writes the complete validated raw dataset, with original text, metadata,
tables, source associations, context, attribution, IDs, limitations, collection outcomes, and
`fields.researchAssessments`. Spreadsheet formula guards, output row filtering, and overflow storage
do not alter JSON values. All collected originals are preserved regardless of assessment verdict.

## Raw-compatible output and Research_Explorer

The Research node emits flat column-oriented records, like Raw's imported table rows. For newly
assessed runs, deterministic `summarizeResearchRows` emits **ONE AI-summary passage row per accepted
original record**. The `Customer Feedback` column holds the synthesized AI summary, and `metadata.textOrigin`
is set to `"ai_summary"`. Exact verbatim citations and locators are preserved in the flat `Original Evidence`
column and the structured `metadata.summaryEvidence` object, referencing exact character offsets and native
table row indexes. Source-only attributed BMW columns (Brand, Sales Description, Country, Derivate,
Engine Type, Feedback Type, VFC levels) retain original source values or remain `null` if unknown/missing;
no vehicle attributes, classifications, or requirements are fabricated.

When records carry source assessments (`reviewed: true`), records evaluated as irrelevant, uncertain,
or unreviewed are excluded from derived rows and `Research_Explorer`. The block's final output `sources`
list contains ONLY `sourceIds` referenced by accepted usable rows; unreferenced sources are removed from
the usable source list. All originals remain complete in the raw archive. Older archives or low-level tests
without assessments (`reviewed: false`) retain legacy unreviewed behavior (`researchTableRows`), emitting
all original records without filtering or retrospective LLM calls.

Source feedback keeps one independent opinion with differing source classifications in list-valued
fields. Other prose in legacy unassessed runs is split mechanically into paragraphs with character locators.
Explicit tables retain native headers and numeric/boolean values, emitting only assessed relevant rows.

Each row retains source provenance and `collectedRecordId` links it to the unchanged collected record.
Row metadata has an 8 KiB budget: properties that do not fit remain only in the original archive,
with their names explicitly listed in `archivedMetadataKeys` on the derived row. This prevents
whole-page HTML, PDF pages or other bulky provider payloads from being repeated per paragraph or
table row. Resolve those keys on the collected record's metadata using the row's collected ID and
run IDs. Native cells and verbatim text are not shortened; original metadata remains complete in
JSON and the archive sheets. The 64 MiB derived-output limit is unchanged.
Missing classifications are not inferred from the research question or workflow scope.

`Research_Explorer`, the first XLSX sheet, and CSV contain every record type. They begin with the
twelve feedback columns below, followed by provenance, record type, original collected-record ID,
and native columns. Tabular exports include `AI Text Origin` (from `metadata.textOrigin`) and
`Original Evidence`. If any record in the dataset has assessments, a compact `AI Source Assessment`
column is added, listing `[{ agentId, verdict, model }]` for each row. Non-feedback prose uses
Customer Feedback as its text column but retains its original record type. Feedback source associations
are expanded into their exact supplied rows. Native columns colliding with provenance names get a
`Source Column: ` prefix, repeated if needed to avoid another supplied header; provenance and source
values are both retained.

CSV uses a UTF-8 BOM, quoted fields, escaped quotes, CRLF row separators, and original embedded
newlines. CSV has no Excel cell-length truncation. JSON and the archive sheets preserve the
complete original dataset rather than replacing it with these derived table rows.

## Feedback_Explorer

The first twelve columns are:

1. ID
2. Source
3. Brand
4. Sales Description
5. Country
6. Derivate (e-code)
7. Engine Type
8. Feedback Type
9. Customer Feedback
10. Vfc level2 3 Name
11. Vfc level2 Name
12. Vfc level3 Name

Only `recordType: "feedback"` records deemed usable by source assessment (`usableFeedback`) appear
here. Feedback_Explorer still contains actual original customer opinions (full verbatim text, never
replaced with AI summaries). Customer feedback judged irrelevant, uncertain, or unreviewed remains
archived in `Research Records` but is excluded from `Feedback_Explorer`. Studies, tables, forecasts,
product descriptions, transcripts, and other research records are not counted as customer opinions.

The local reader supplies `metadata.sourceAssociations` as
`[{ headers, values, row, sheet }]`. Each association produces one export row, using its own
exact source header names and values. All rows for one opinion have the **same normalized ID**.
Multiple VFC associations are not independent opinions. `Original Feedback ID`, `Source Sheet`,
and `Source Row` preserve the source identity and location. Malformed associations fail clearly
instead of disappearing from the export.

For providers without source associations, explicitly named `metadata.originalFields` or metadata
keys supply original columns. Missing Brand, Country, vehicle, and Feedback Type remain blank;
market or vehicle attribution is not substituted for a source column. Source defaults to the
supplied publisher, then provider, only when there is no association. Customer Feedback uses the
original feedback column when present, otherwise the raw record text. `Sentiment`, lowercase
aliases, and other classification keys never become Feedback Type. Source-supplied classifications
remain separate in the record metadata; an exact `Feedback Type` source key can populate that column.

Additional columns carry publication precision, retrieval time, language, source URLs and IDs,
collection agents, run IDs, locators, and limitations. Unknown publication dates are never replaced
by retrieval time.

## XLSX sheets

- `Research_Explorer`: the all-record-type tabular view emitted by `summarizeResearchRows`, filtered to
  relevant evidence when reviewed, including `AI Text Origin`, `Original Evidence`, and the compact
  `AI Source Assessment` column.
- `Feedback_Explorer`: the feedback view of usable original customer opinions (full verbatim text).
- `Table_1`, `Table_2`, etc.: explicit table records as actual native-column sheets, directly
  readable by Raw, preserving numeric and boolean cells rather than serializing rows into JSON.
  Emits only assessed relevant rows; if a table has zero relevant rows, its sheet is omitted.
- `Source Assessments`: present whenever any record in the dataset has `fields.researchAssessments`.
  Contains `Record ID`, `Source ID`, `Agent`, `AI Verdict`, `Reasons`, `Uncertainties`, `Model`,
  `Content Hash`, `Verbatim Excerpt Ranges`, `Native Row Indexes`, `Summaries`, `Scope`, and `Run ID`.
  Preserves full rationale, uncertainties, exact character ranges, row indexes, and per-chunk summaries for every assessed original.
- `Sources`: list of sources referenced by accepted usable rows (archive retains all).
- `Research Records`: all record types, original text, context, metadata, fields (including
  `fields.researchAssessments`), attribution, provider, IDs, content hash, limitations, and complete
  table data, including empty tables. All originals are retained regardless of assessment verdict.
- `Metrics Tables`: original table headers and row values, including zeros, nulls and flags,
  with units, footnotes, dimensions, and record/source IDs. Retains all original rows regardless of
  assessment verdict.
- `Research Runs`: collection outcomes, requested record IDs, request counts (including review requests),
  limitations, and the dataset's synthetic flag.
- `Cell Overflow`: present only when a string cannot fit or cannot be represented directly in XML.
  Applies to `Source Assessments` columns (Reasons, Uncertainties, Summaries, Scope) as well as record/source fields.

All workbook string cells stay within Excel's **32,767 UTF-16 code-unit limit**, including formula
guards and serialized metadata. A value that does not fit is replaced by an explicit storage pointer,
not a summary or an unmarked truncation. The complete original serialized value is stored in ordered,
bounded overflow segments. Source titles, publishers, table metadata, context, fields, run metadata,
and other columns use the same rule as feedback text.

Overflow rows contain:

- `Record ID` and `Source ID` when applicable. Source-owned cells use Source ID; run-owned cells
  are located through their owning sheet and row. Exceptionally long IDs reference their ID cell.
- `Sheet`, `Row`, `Column` (one-based, including the header row), and `Column Name` identifying
  the original cell. This separates repeated views of the same value.
- `Segment Order` (one-based) and `Segment Count`.
- `Original Segment`, a spreadsheet-safe display. XML-unrepresentable segments display JSON instead.
- `Original Segment JSON`, the authoritative JSON string for that segment.
- `Serialization`: `string`, `json`, `number`, or `boolean`, describing the original cell value.

To reconstruct a value, select the exact owning sheet/row/column, sort by numeric Segment Order,
parse each Original Segment JSON, and concatenate the resulting strings. For `Serialization: json`,
parse the concatenated string again to restore the structured value. Do not remove apostrophes from
the display column: that cannot distinguish a formula guard from an original apostrophe.
Segments never split a Unicode surrogate pair and are bounded after JSON escaping as well as
after spreadsheet guarding. XML-incompatible controls and lone surrogates remain recoverable
through the authoritative serialized segments.

Strings whose first non-whitespace/control character is `=`, `+`, `-`, or `@` receive an apostrophe
guard in spreadsheet views. Cells are always text, never executable formulas. JSON remains unchanged.

The XLSX writer uses ASCII transport tokens and restores shared-string XML after packaging. This
avoids splitting surrogate pairs in ExcelJS's ZIP writer. Carriage returns are restored as `&#13;`
so XML readers preserve standalone CR and CRLF instead of normalizing them to LF. Non-ASCII
characters use numeric references to avoid UTF-8 chunk-boundary corruption in ExcelJS readers.
Literal source entities such as `&#13;` remain literal text, not interpreted source markup.

## Source approvals are never human requirement statuses

AI source assessment verdicts (`relevant`, `irrelevant`, `uncertain`, `unreviewed`) are automated
data-hygiene filters. They are **never** human requirement decisions (`approved`, `rejected`,
`deferred`). AI never decides product requirements. Only a human product manager approves, rejects,
or defers requirements in the Car and Data Flow tabs.

## Integration dependency

The export module imports `jszip` for shared-string XML postprocessing. **`jszip ^3.10.2`** is
declared directly in `@reqflow/blocks` and locked by the parent integration.

## Focused verification

```sh
npx vitest run packages/blocks/src/research/raw.test.ts packages/blocks/src/research/export.test.ts packages/blocks/src/research/tabular.test.ts packages/blocks/src/research/assessment.test.ts
npm run typecheck -w @reqflow/blocks
npx prettier --check docs/research/exports.md docs/research/README.md
```

Tests use synthetic data and load the actual written XLSX bytes. No live provider calls or BMW files
are needed. No real LLM accuracy was tested; no numeric trust scores or inferred attribution are used.
