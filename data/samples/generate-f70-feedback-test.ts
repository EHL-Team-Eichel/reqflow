// Regenerate only these invented artifacts: node data/samples/generate-f70-feedback-test.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import writeXlsxFile from "write-excel-file/node";
import { feedbackHeader, feedbackRows, feedbackSheet } from "./f70-feedback-test.fixture.ts";

if (feedbackRows.length !== 100 || feedbackRows.some((row) => row.length !== 12)) {
  throw new Error("Expected exactly 100 synthetic rows of 12 cells.");
}
const rows = [feedbackHeader, ...feedbackRows];
const csv = rows.map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(","));
writeFileSync(join(import.meta.dirname, "f70-feedback-test.csv"), csv.join("\n") + "\n", "utf8");
await writeXlsxFile([{ sheet: feedbackSheet, data: rows }]).toFile(
  join(import.meta.dirname, "f70-feedback-test.xlsx"),
);
console.log("Generated synthetic F70 feedback: 100 data rows, 12 columns, one Feedback_Explorer sheet.");
