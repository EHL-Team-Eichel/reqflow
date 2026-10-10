import { emptyPipelineData, parseBlockParams, PipelineData, type FileRef } from "@reqflow/core";
import { defineBlock } from "@reqflow/engine";
import { readDatabase } from "./database";
import { usageFindings } from "./findings";
import { readSpreadsheet } from "./read";
import { tableToRecords, type RawDataset } from "./records";
import { toTable } from "./table";

/** Mirrors BLOCK_SPECS.raw.params (validated by parseBlockParams before use). */
interface RawParams {
  source: "excel" | "database";
  dataset: RawDataset;
  file: FileRef | null;
  sheet: string;
  dbType: string;
  connection: string;
  query: string;
}

/**
 * The Raw block: an uploaded Excel/CSV file or a SQLite query → one Source, one SourceRecord per row,
 * and deterministic usage findings for equipment and sales data. Everything it skips or assumes is
 * written to the block log; malformed input fails with the row or column named.
 */
export const rawBlock = defineBlock({
  kind: "raw",
  async run(_inputs, rawParams, ctx) {
    const p = parseBlockParams("raw", rawParams) as unknown as RawParams;
    const notes: string[] = [];
    let rows;
    let key: string;
    let title: string;
    let uri: string | undefined;
    let sheet: string | undefined;

    if (p.source === "excel") {
      if (!p.file) throw new Error("Choose an Excel or CSV file in the block's parameters");
      const file = await ctx.files.get(p.file.fileId);
      const read = await readSpreadsheet(file.name, file.bytes, p.sheet);
      notes.push(...read.notes);
      rows = read.rows;
      sheet = read.sheet;
      key = `${file.id}#${sheet ?? ""}`;
      title = sheet ? `${file.name} · ${sheet}` : file.name;
      uri = file.id;
    } else {
      const read = readDatabase(p.dbType, p.connection, p.query);
      rows = read.rows;
      key = read.key;
      title = read.title;
    }
    ctx.signal.throwIfAborted();

    const table = toTable(rows);
    notes.push(...table.notes);
    const ingested = tableToRecords(table, {
      key,
      title,
      ...(uri ? { uri } : {}),
      ...(sheet ? { sheet } : {}),
      dataset: p.dataset,
      scope: ctx.scope,
      retrievedAt: new Date().toISOString(),
    });
    notes.push(...ingested.notes);
    const { findings, notes: findingNotes } = usageFindings(p.dataset, table, ingested, ctx.scope);
    notes.push(...findingNotes);

    // Fail here, with the schema's message, rather than hand malformed data downstream.
    const out = PipelineData.parse({
      ...emptyPipelineData(),
      sources: [ingested.source],
      records: ingested.records,
      findings,
    });

    for (const note of notes) ctx.log(note);
    ctx.log(
      `Read ${out.records.length} record(s) from "${title}"` +
        (findings.length ? ` and derived ${findings.length} usage finding(s).` : "."),
    );
    const actor = { type: "ai", component: "raw", model: "deterministic" } as const;
    const run = ctx.runId.startsWith("run_") ? { runId: ctx.runId, blockId: ctx.blockId } : {};
    await ctx.audit.record({
      actor,
      action: "source.ingested",
      entityType: "source",
      entityId: ingested.source.id,
      ...run,
    });
    for (const f of findings) {
      await ctx.audit.record({
        actor,
        action: "finding.extracted",
        entityType: "finding",
        entityId: f.id,
        ...run,
      });
    }
    return { status: "ok", outputs: { out } };
  },
});
