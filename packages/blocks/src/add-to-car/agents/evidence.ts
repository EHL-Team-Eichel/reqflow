import { createHash } from "node:crypto";
import type {
  ContextMode,
  Finding,
  PipelineData,
  Source,
  SourceKind,
  SourceRecord,
} from "@reqflow/core";

/** What arrived on one "n. Priority" input. */
export interface PriorityInputData {
  port: string;
  rank: number; // 1 = most important
  label: string;
  data: PipelineData;
}

/** What arrived on one context input. */
export interface ContextInputData {
  port: string;
  index: number;
  mode: ContextMode;
  label: string;
  data: PipelineData;
}

/** A record the analysts read: not yet covered by an upstream finding. */
export interface RecordItem {
  record: SourceRecord;
  sourceKind: SourceKind | "unknown";
  rank: number;
  hints: [string, string][]; // short categorical columns, e.g. ["Feedback Type", "Seats"]
  group: string; // sort key that keeps related records in the same batch
}

/** An upstream finding, used as a signal as it is. */
export interface UpstreamSignal {
  finding: Finding;
  rank: number;
}

export interface Prepared {
  records: RecordItem[];
  upstream: UpstreamSignal[];
  sources: Map<string, Source>;
  /** Every record of the priority inputs by id, with the best rank it arrived on. */
  recordIndex: Map<string, { record: SourceRecord; rank: number }>;
  notes: string[]; // what was skipped, merged or sampled, for the logs and the trace
  totalRecords: number; // before sampling
}

/** Reading more records than this per run would cost too much time: the rest are sampled evenly. */
export const MAX_RECORDS_PER_RUN = 4000;
const MAX_HINTS = 4;
const MAX_HINT_CHARS = 80;

export const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

/** Columns worth showing next to a record: neither constant nor unique per row, and short. */
function hintKeys(records: SourceRecord[]): { keys: string[]; group: string | null } {
  const stats = new Map<string, { values: Set<string>; chars: number; filled: number }>();
  for (const r of records) {
    for (const [key, raw] of Object.entries(r.fields ?? {})) {
      const value = fieldText(raw);
      // Skip empty cells and the text column itself (its value is the record's text).
      if (!value || value === r.text.trim() || (value.length > 40 && r.text.includes(value)))
        continue;
      const s = stats.get(key) ?? { values: new Set(), chars: 0, filled: 0 };
      s.values.add(value);
      s.chars += value.length;
      s.filled++;
      stats.set(key, s);
    }
  }
  const n = records.length;
  const usable = [...stats.entries()].filter(
    ([key, s]) =>
      s.values.size > 1 &&
      s.values.size <= Math.max(2, 0.5 * n) &&
      s.chars / s.filled <= 120 &&
      !/(^|[^a-z])id$/i.test(key.trim()),
  );
  usable.sort((a, b) => b[1].filled - a[1].filled || a[1].values.size - b[1].values.size);
  const keys = usable.slice(0, MAX_HINTS).map(([k]) => k);
  // Group by the column whose number of values is closest to √n: coherent batches, not tiny ones.
  const target = Math.sqrt(Math.max(1, n));
  const group =
    usable
      .map(([k, s]) => [k, Math.abs(Math.log(s.values.size / target))] as const)
      .sort((a, b) => a[1] - b[1])[0]?.[0] ?? null;
  return { keys, group };
}

function fieldText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join(" | ");
  return String(value).trim();
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Collects what the priority inputs carry: records to read and upstream findings to reuse.
 * An item arriving on several inputs counts once, on its most important input. Records already
 * cited by an upstream finding are represented by that finding and not read again.
 */
export function prepareEvidence(inputs: PriorityInputData[]): Prepared {
  const notes: string[] = [];
  const sources = new Map<string, Source>();
  const recordIndex = new Map<string, { record: SourceRecord; rank: number }>();
  const findings = new Map<string, UpstreamSignal>();
  let duplicates = 0;

  for (const input of [...inputs].sort((a, b) => a.rank - b.rank)) {
    for (const s of input.data.sources) if (!sources.has(s.id)) sources.set(s.id, s);
    for (const r of input.data.records) {
      if (recordIndex.has(r.id)) duplicates++;
      else recordIndex.set(r.id, { record: r, rank: input.rank });
    }
    for (const f of input.data.findings) {
      if (findings.has(f.id)) duplicates++;
      else findings.set(f.id, { finding: f, rank: input.rank });
    }
    // Requirements arriving here are re-examined as signals: their findings carry the evidence.
    if (input.data.requirements.length) {
      notes.push(
        `${input.data.requirements.length} requirement(s) arrived on ${input.label}; the agents use their findings, not their text.`,
      );
    }
  }
  if (duplicates) {
    notes.push(
      `${duplicates} item(s) arrived on more than one input and count once, on the most important one.`,
    );
  }

  const upstream = [...findings.values()];
  const covered = new Set(
    upstream.flatMap((u) => u.finding.evidence.map((e) => e.recordId).filter(Boolean)),
  );
  const outOfScope = upstream.filter((u) => !u.finding.inScope).length;
  if (outOfScope)
    notes.push(`${outOfScope} upstream finding(s) are marked out of scope and are not used.`);

  const toRead = [...recordIndex.values()].filter(({ record }) => !covered.has(record.id));
  if (recordIndex.size - toRead.length) {
    notes.push(
      `${recordIndex.size - toRead.length} record(s) are already covered by upstream findings and are not read again.`,
    );
  }
  const empty = toRead.filter(({ record }) => record.text.trim().length < 3);
  if (empty.length) notes.push(`${empty.length} record(s) have no readable text and are skipped.`);

  // Hints and groups per source, so columns are judged within their own table.
  const bySource = new Map<string, SourceRecord[]>();
  for (const { record } of toRead) {
    const list = bySource.get(record.sourceId) ?? [];
    list.push(record);
    bySource.set(record.sourceId, list);
  }
  const hintsBySource = new Map([...bySource].map(([id, rs]) => [id, hintKeys(rs)]));

  let records: RecordItem[] = toRead
    .filter(({ record }) => record.text.trim().length >= 3)
    .map(({ record, rank }) => {
      const h = hintsBySource.get(record.sourceId)!;
      const fields = record.fields ?? {};
      const hints = h.keys
        .map((k) => [k, clip(fieldText(fields[k]), MAX_HINT_CHARS)] as [string, string])
        .filter(([, v]) => v.length > 0);
      return {
        record,
        rank,
        sourceKind: sources.get(record.sourceId)?.kind ?? "unknown",
        hints,
        group: h.group ? clip(fieldText(fields[h.group]), 40) : "",
      };
    });
  records.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.record.sourceId.localeCompare(b.record.sourceId) ||
      a.group.localeCompare(b.group) ||
      a.record.id.localeCompare(b.record.id),
  );

  const totalRecords = records.length;
  if (records.length > MAX_RECORDS_PER_RUN) {
    records = sampleEvenly(records, MAX_RECORDS_PER_RUN);
    notes.push(
      `Read ${records.length} of ${totalRecords} records: the rest were sampled out evenly across inputs and topics (limit ${MAX_RECORDS_PER_RUN} per run).`,
    );
  }
  return {
    records,
    upstream: upstream.filter((u) => u.finding.inScope),
    sources,
    recordIndex,
    notes,
    totalRecords,
  };
}

/** Keeps `limit` items, spread evenly over the sorted list, so every input and topic stays in. */
export function sampleEvenly<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  const step = items.length / limit;
  return Array.from({ length: limit }, (_, i) => items[Math.floor(i * step)]!);
}

const NORMALIZE: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "«": '"',
  "»": '"',
  "–": "-",
  "—": "-",
  " ": " ",
};

/** Lowercases, unifies quotes and dashes, collapses whitespace; keeps a map back to `text`. */
function normalized(text: string): { s: string; at: number[] } {
  let s = "";
  const at: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const ch = NORMALIZE[text[i]!] ?? text[i]!;
    if (/\s/.test(ch)) {
      if (!space && s.length) {
        s += " ";
        at.push(i);
      }
      space = true;
      continue;
    }
    space = false;
    s += ch.toLowerCase();
    at.push(i);
  }
  if (s.endsWith(" ")) {
    s = s.slice(0, -1);
    at.pop();
  }
  return { s, at };
}

/**
 * The verbatim passage of `text` that `quote` points to, or null. Tolerates what models change
 * when quoting (case, whitespace, curly quotes, surrounding quote marks or ellipses) but always
 * returns the original characters, so the excerpt stays verbatim.
 */
export function findVerbatim(text: string, quote: string): string | null {
  const q = quote
    .trim()
    .replace(/^["'“„«‘]+|["'”»’]+$/g, "")
    .replace(/^(\.\.\.|…)\s*|\s*(\.\.\.|…)$/g, "")
    .trim();
  if (q.length < 3) return null;
  if (text.includes(q)) return q;
  const t = normalized(text);
  const n = normalized(q);
  const idx = t.s.indexOf(n.s);
  if (idx < 0 || !n.s) return null;
  return text.slice(t.at[idx], t.at[idx + n.s.length - 1]! + 1);
}

/** A verbatim excerpt when the model's quote can't be found: the record's opening words. */
export function openingExcerpt(text: string, max = 300): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.lastIndexOf(" ", max);
  return t.slice(0, cut > max / 2 ? cut : max);
}

/** Every finding cites at most this many excerpts; `mentions` still counts every record. */
export const MAX_EXCERPTS_PER_FINDING = 12;
export const MAX_EXCERPT_CHARS = 1000;
