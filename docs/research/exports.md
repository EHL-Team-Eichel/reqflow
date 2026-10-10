# Raw research exports

Exports validate the shared `ResearchDataset` contract. They do not change the input dataset,
infer sentiment or classifications, summarize evidence, or create requirements.

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
- A changed content hash adds an explicit revision limitation, including the timestamp tie rule.
  Merging does not overwrite earlier run datasets. Export or retain those datasets to inspect
  earlier content; the merged dataset contains only the selected revision for each record ID.

## JSON

`exportResearchJson` writes the complete validated raw dataset, with original text, metadata,
tables, source associations, context, attribution, IDs, limitations, and collection outcomes.
Spreadsheet formula guards and overflow storage do not alter JSON values.

## Feedback_Explorer and CSV

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

Only `recordType: "feedback"` records appear here. Studies, tables, forecasts, product descriptions,
transcripts, and other research records are not counted as customer opinions.

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
by retrieval time. CSV contains only these feedback rows, with a UTF-8 BOM, quoted fields, escaped
quotes, CRLF row separators, and original embedded newlines. CSV has no Excel cell-length truncation.

## XLSX sheets

- `Feedback_Explorer`: the feedback view described above.
- `Sources`: original source identity, title, URL, publisher, dates, and supplied source attributes.
- `Research Records`: all record types, original text, context, metadata, fields, attribution,
  provider, IDs, content hash, limitations, and complete table data, including empty tables.
- `Metrics Tables`: original table headers and row values, including zeros, nulls and flags,
  with units, footnotes, dimensions, and record/source IDs.
- `Research Runs`: collection outcomes, requested record IDs, request counts, limitations,
  and the dataset's synthetic flag.
- `Cell Overflow`: present only when a string cannot fit or cannot be represented directly in XML.

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

## Integration dependency

The export module imports `jszip` for shared-string XML postprocessing. **`jszip ^3.10.2`** is
declared directly in `@reqflow/blocks` and locked by the parent integration.

## Focused verification

```sh
npx vitest run packages/blocks/src/research/raw.test.ts packages/blocks/src/research/export.test.ts
npm run typecheck -w @reqflow/blocks
npx prettier --check packages/blocks/src/research/raw.ts packages/blocks/src/research/raw.test.ts packages/blocks/src/research/export.ts packages/blocks/src/research/export.test.ts docs/research/exports.md
```

Tests use synthetic data and load the actual written XLSX bytes. No live provider calls or BMW files
are needed.
