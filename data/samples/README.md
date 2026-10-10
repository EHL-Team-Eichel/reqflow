# Sample datasets (synthetic)

**Invented for development and tests. Not BMW data, not real customer quotes.** Real BMW files go in
`data/raw/`, which is gitignored.

Regenerate them with `node data/samples/generate.ts` (Node ≥ 23.6). They imitate what BMW exports
might look like, including the awkward parts the Raw block has to handle:

| File                       | Raw block "Dataset" | Format                                                                                                  | What the Raw block makes of it                                                                                                  |
| -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `customer_feedback.csv`    | Customer feedback   | UTF-8 with BOM, `,`, quoted comments with commas, quotes and a line break; de/en/fr/it/es               | 35 records (one per comment, language and market per row); the row without a comment is skipped and reported                   |
| `equipment_take_rates.csv` | Equipment data      | German Excel export: `;`, decimal commas, Windows-1252, German headers (`Ausstattung`, `Einbaurate %`) | 17 records; 8 usage findings (take rate ≥ 70 % → expected as standard, ≤ 15 % → rarely chosen); the row without a rate is reported |
| `sales_volumes.csv`        | Sales volumes       | `,`, one row per derivative and year                                                                    | 12 records; 2 findings (volume change ≥ 10 % between first and last year); the i5 Touring launch (0 units in 2023) is noted        |
| `customer_study.xlsx`      | Customer study      | Excel workbook with two sheets: `Results` (scores) and `Verbatims` (free text)                          | Sheet empty → first sheet (7 records); sheet `Verbatims` → 6 records with languages                                             |

How columns are recognised (English and German names): `packages/blocks/src/raw/columns.ts`.

BMW's real files stay in `data/raw/` (gitignored). When they're there, `npm test` also runs the
"BMW …" suites in `packages/blocks/src/raw/raw.test.ts` (structure checks only) and `npm run smoke`
previews them in the app. To try them by hand: `npm run dev`, add a Raw block, choose the file.
