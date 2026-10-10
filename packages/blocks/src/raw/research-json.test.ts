import {
  AuditEvent,
  DEFAULT_SETTINGS,
  defaultBlockParams,
  emptyPipelineData,
  PipelineData,
  type AuditEventInput,
  type StoredFile,
} from "@reqflow/core";
import { fixtureRequirements } from "@reqflow/core/fixtures";
import type { BlockContext } from "@reqflow/engine";
import { describe, expect, it } from "vitest";
import { parseResearchJson as exportedParser } from "./index";
import { rawBlock } from "./raw";
import { isResearchJsonFile, parseResearchJson } from "./research-json";

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const source = () => ({
  id: "src_research",
  kind: "review",
  origin: "web",
  title: "Synthetic owner review",
  uri: "https://example.com/review?campaign=synthetic#climate",
  publisher: "Synthetic publication",
  publishedAt: "2026-10-01T12:00:00.000Z",
  retrievedAt: "2026-10-10T12:00:00.000Z",
  reliability: "medium",
  market: "CN",
  vehicleLine: "7 Series",
  provenance: { query: "synthetic climate review", fetchedBy: "offline-fixture" },
});
const record = () => ({
  id: "rec_research",
  sourceId: "src_research",
  text: "车主反馈: physical climate buttons are easier to use.",
  locator: "paragraph 4, sentence 2",
  market: "CN",
  language: "zh",
  fields: { original: { tags: ["climate", "controls"], rank: 2 }, empty: null },
  provenance: { url: "https://example.com/review#climate", offsets: [7, 56] },
});
const research = () => ({
  sources: [source()],
  records: [record()],
  schemaVersion: "research-fixture@1",
  metadata: { queries: ["synthetic"], warnings: ["single source"], provider: "offline" },
  unknownExtension: { nested: [null, false, { preserved: true }] },
});
const pipeline = () => ({
  ...research(),
  findings: [
    {
      id: "fnd_research",
      kind: "complaint",
      statement: "Customers prefer physical climate controls.",
      category: "usability_controls",
      evidence: [
        {
          sourceId: "src_research",
          recordId: "rec_research",
          excerpt: "physical climate buttons are easier to use",
          locator: "paragraph 4, sentence 2",
          provenance: { extraction: "offline" },
        },
      ],
      mentions: 1,
      markets: ["CN"],
      confidence: 0.8,
      inScope: true,
      themeId: "thm_research",
      provenance: { reviewed: false },
    },
  ],
  themes: [
    {
      id: "thm_research",
      label: "Climate controls",
      summary: "Physical controls",
      category: "usability_controls",
      findingIds: ["fnd_research"],
      provenance: { clusteredBy: "offline" },
    },
  ],
  requirements: [
    {
      ...fixtureRequirements[2]!,
      findingIds: ["fnd_research"],
      sourceIds: ["src_research"],
      conflictingFindingIds: [],
      status: "deferred",
      createdBy: { type: "human", userId: "synthetic-pm", name: "Synthetic PM" },
      provenance: { decision: "imported, not changed" },
    },
  ],
});

describe("parseResearchJson", () => {
  it("is exposed from the Raw entry point", () => {
    expect(exportedParser).toBe(parseResearchJson);
  });

  it("accepts structural Research datasets and only fills missing pipeline layers", () => {
    const input = research();
    const out = parseResearchJson(bytesOf(input));
    expect(out).toEqual({ ...input, findings: [], themes: [], requirements: [] });
    expect(PipelineData.safeParse(out).success).toBe(true);
  });

  it("keeps all pipeline objects, nested extensions, locators and prior human decisions unchanged", () => {
    const input = pipeline();
    expect(parseResearchJson(bytesOf(input))).toEqual(input);
  });

  it("keeps existing internal dataset kinds rather than applying the Raw dataset selector", () => {
    const input = research();
    input.sources[0] = { ...source(), kind: "sales_volume", origin: "bmw_internal" };
    expect(parseResearchJson(bytesOf(input)).sources).toEqual(input.sources);
  });

  it("accepts empty envelopes and optional layers independently", () => {
    expect(parseResearchJson(bytesOf(emptyPipelineData()))).toEqual(emptyPipelineData());
    const input = { ...research(), findings: pipeline().findings.map(({ themeId, ...f }) => f) };
    expect(parseResearchJson(bytesOf(input))).toEqual({ ...input, themes: [], requirements: [] });
  });

  it("accepts UTF-8 JSON with a BOM", () => {
    expect(
      parseResearchJson(new TextEncoder().encode(`\uFEFF${JSON.stringify(research())}`)),
    ).toEqual({ ...research(), findings: [], themes: [], requirements: [] });
  });

  it.each([null, [], "synthetic", 42, {}, { records: [] }, { sources: [] }, { data: research() }])(
    "rejects unsupported top-level input %# rather than guessing",
    (input) => {
      expect(() => parseResearchJson(bytesOf(input))).toThrow(/Research JSON.*sources.*records/);
    },
  );

  it.each([
    { ...research(), sources: null },
    { ...research(), records: {} },
    { ...research(), findings: null },
    { ...research(), themes: {} },
    { ...research(), requirements: "not an array" },
    { ...research(), sources: [{ ...source(), reliability: "secret-invalid-value" }] },
    { ...research(), records: [{ ...record(), text: null }] },
    { ...research(), findings: [{}] },
    { ...research(), themes: [{}] },
    { ...research(), requirements: [{}] },
  ])("rejects malformed core arrays and objects %# without disclosing values", (input) => {
    expect(() => parseResearchJson(bytesOf(input))).toThrow(/Research JSON/);
    try {
      parseResearchJson(bytesOf(input));
    } catch (error) {
      expect(String(error)).not.toContain("secret-invalid-value");
    }
  });

  it("names the invalid schema field, without echoing source values", () => {
    const input = { ...research(), sources: [{ ...source(), kind: "synthetic-secret" }] };
    expect(() => parseResearchJson(bytesOf(input))).toThrow(/sources\[0\]\.kind/);
    expect(() => parseResearchJson(bytesOf(input))).not.toThrow(/synthetic-secret/);
  });

  it("rejects invalid syntax and invalid UTF-8 without exposing content or parser causes", () => {
    for (const bytes of [
      new TextEncoder().encode('{"synthetic-secret": broken}'),
      new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
    ]) {
      try {
        parseResearchJson(bytes);
        expect.unreachable("malformed JSON must fail");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/Research JSON.*UTF-8 JSON/);
        expect((error as Error).message).not.toContain("synthetic-secret");
        expect((error as Error).cause).toBeUndefined();
      }
    }
  });

  it("rejects files over 16 MiB before decoding but accepts exactly 16 MiB", () => {
    const limit = 16 * 1024 * 1024;
    expect(() => parseResearchJson(new Uint8Array(limit + 1))).toThrow(/16 MiB/);
    const padded = new Uint8Array(limit).fill(0x20);
    padded.set(bytesOf(research()));
    expect(parseResearchJson(padded).records).toEqual(research().records);
  });

  it.each(["sources", "records", "findings", "themes", "requirements"] as const)(
    "rejects repeated %s IDs, including identical copies",
    (key) => {
      const input = pipeline();
      const duplicate = { ...input, [key]: [input[key][0], input[key][0]] };
      expect(() => parseResearchJson(bytesOf(duplicate))).toThrow(/duplicate.*ID/i);
    },
  );

  it("rejects conflicting duplicate IDs without printing their values", () => {
    const duplicate = { ...source(), title: "Conflicting synthetic title" };
    const input = { ...research(), sources: [source(), duplicate] };
    expect(() => parseResearchJson(bytesOf(input))).toThrow(/duplicate.*ID/i);
    expect(() => parseResearchJson(bytesOf(input))).not.toThrow(/src_research|Conflicting/);
  });

  it("rejects duplicate web URIs under different IDs", () => {
    const duplicateSource = { ...source(), id: "src_duplicate" };
    expect(() =>
      parseResearchJson(bytesOf({ ...research(), sources: [source(), duplicateSource] })),
    ).toThrow(/duplicate.*identity/i);
  });

  it("keeps independent comments with distinct comment/customer IDs, equal text and no locator", () => {
    const a = {
      ...record(),
      locator: undefined,
      fields: { ...record().fields, commentId: "comment-a", customerId: "customer-a" },
    };
    const b = {
      ...a,
      id: "rec_independent",
      fields: { ...a.fields, commentId: "comment-b", customerId: "customer-b" },
      provenance: { ...a.provenance, offsets: [71, 120] },
    };
    const input = { ...research(), records: [a, b] };
    expect(parseResearchJson(bytesOf(input))).toEqual(
      JSON.parse(
        JSON.stringify({
          ...input,
          findings: [],
          themes: [],
          requirements: [],
        }),
      ),
    );
  });

  it.each([undefined, "paragraph 4, sentence 2"])(
    "does not infer duplicate identity from wording or locator: %s",
    (locator) => {
      const a = { ...record(), locator };
      const b = { ...a, id: "rec_independent" };
      const input = { ...research(), records: [a, b] };
      expect(parseResearchJson(bytesOf(input)).records).toEqual(JSON.parse(JSON.stringify([a, b])));
    },
  );

  it.each([
    "originalId",
    "originalRecordId",
    "originalCommentId",
    "providerRecordId",
    "reviewId",
    "feedbackId",
    "responseId",
    "commentId",
    "Original Comment ID",
    "comment_id",
  ])("rejects verified duplicate %s identities even when text conflicts", (field) => {
    const a = {
      ...record(),
      locator: undefined,
      fields: { [field]: "original-comment", customerId: "customer-a", provider: "offline" },
    };
    for (const text of [a.text, "Conflicting text"]) {
      const b = { ...a, id: "rec_duplicate", text };
      expect(() => parseResearchJson(bytesOf({ ...research(), records: [a, b] }))).toThrow(
        /records\[1\].*duplicate.*identity/i,
      );
      expect(() => parseResearchJson(bytesOf({ ...research(), records: [a, b] }))).not.toThrow(
        /original-comment|customer-a|offline/,
      );
    }
  });

  it.each([
    { commentId: "comment-b", customerId: "customer-a", provider: "offline" },
    { commentId: "comment-a", customerId: "customer-b", provider: "offline" },
    { commentId: "comment-a", customerId: "customer-a", provider: "other-provider" },
    { customerId: "customer-a", provider: "offline" },
  ])("distinguishes comment, customer and provider identities %#", (fields) => {
    const a = {
      ...record(),
      locator: undefined,
      fields: { commentId: "comment-a", customerId: "customer-a", provider: "offline" },
    };
    const b = { ...a, id: "rec_independent", fields };
    const input = { ...research(), records: [a, b] };
    expect(parseResearchJson(bytesOf(input)).records).toEqual(JSON.parse(JSON.stringify([a, b])));
  });

  it("scopes explicit comment identities to their source", () => {
    const a = { ...record(), fields: { commentId: "comment-a", customerId: "customer-a" } };
    const b = { ...a, id: "rec_another_source", sourceId: "src_another" };
    const input = {
      ...research(),
      sources: [source(), { ...source(), id: "src_another", uri: "https://example.com/another" }],
      records: [a, b],
    };
    expect(parseResearchJson(bytesOf(input)).records).toEqual([a, b]);
  });

  it("does not treat the same customer ID as the same comment", () => {
    const a = { ...record(), locator: undefined, fields: { customerId: "customer-a" } };
    const b = { ...a, id: "rec_another_comment" };
    const input = { ...research(), records: [a, b] };
    expect(parseResearchJson(bytesOf(input)).records).toEqual(JSON.parse(JSON.stringify([a, b])));
  });

  it("allows repeated text at different locators and internal sheets sharing an upload URI", () => {
    const a = { ...source(), origin: "bmw_internal", uri: "file_workbook", title: "Sheet A" };
    const b = { ...a, id: "src_sheetb", title: "Sheet B" };
    const input = {
      ...research(),
      sources: [a, b],
      records: [record(), { ...record(), id: "rec_another", locator: "paragraph 5" }],
    };
    expect(parseResearchJson(bytesOf(input)).records).toEqual(input.records);
  });

  it("rejects every dangling record source link, not only the first record", () => {
    const bad = { ...record(), id: "rec_bad", sourceId: "src_secret_missing" };
    const input = { ...research(), records: [record(), bad] };
    expect(() => parseResearchJson(bytesOf(input))).toThrow(/records\[1\]\.sourceId/);
    expect(() => parseResearchJson(bytesOf(input))).not.toThrow(/src_secret_missing/);
  });

  it.each([
    { sourceId: "src_missing" },
    { recordId: "rec_missing" },
    { excerpt: "invented, not verbatim" },
  ])("rejects invalid finding evidence %#", (patch) => {
    const input = pipeline();
    Object.assign(input.findings[0]!.evidence[0]!, patch);
    expect(() => parseResearchJson(bytesOf(input))).toThrow(/findings\[0\]\.evidence\[0\]/);
  });

  it("rejects evidence that names a record from a different source", () => {
    const input = pipeline();
    input.sources.push({ ...source(), id: "src_another", uri: "https://example.com/another" });
    input.findings[0]!.evidence[0]!.sourceId = "src_another";
    expect(() => parseResearchJson(bytesOf(input))).toThrow(/evidence.*sourceId/);
  });

  it("allows source-only evidence when no record ID is supplied", () => {
    const input = pipeline();
    const { recordId, ...evidence } = input.findings[0]!.evidence[0]!;
    const data = { ...input, findings: [{ ...input.findings[0]!, evidence: [evidence] }] };
    expect(parseResearchJson(bytesOf(data))).toEqual(data);
  });

  it.each([
    ["findings", "themeId"],
    ["themes", "findingIds"],
    ["requirements", "findingIds"],
    ["requirements", "conflictingFindingIds"],
    ["requirements", "sourceIds"],
  ] as const)("rejects missing optional-layer references in %s.%s", (layer, field) => {
    const input = pipeline();
    const prefix = field === "themeId" ? "thm" : field === "sourceIds" ? "src" : "fnd";
    const value = `${prefix}_missing`;
    Object.assign(input[layer][0]!, { [field]: field === "themeId" ? value : [value] });
    expect(() => parseResearchJson(bytesOf(input))).toThrow(
      new RegExp(`${layer}\\[0\\]\\.${field}`),
    );
  });
});

describe("Raw Research JSON file handling", () => {
  function context(file: StoredFile, signal = new AbortController().signal) {
    const logs: string[] = [];
    const audit: AuditEventInput[] = [];
    const ctx = {
      runId: "run_json",
      blockId: "raw-json",
      scope: DEFAULT_SETTINGS.defaultScope,
      settings: DEFAULT_SETTINGS,
      files: { get: async () => file },
      audit: {
        record: async (event: AuditEventInput) => {
          audit.push(event);
          return AuditEvent.parse({
            ...event,
            id: `aud_${audit.length}`,
            at: "2026-10-10T12:00:00.000Z",
            changes: [],
          });
        },
      },
      log: (message: string) => logs.push(message),
      signal,
    } as unknown as BlockContext;
    return { ctx, logs, audit };
  }
  const file = (name: string, mimeType: string, input: unknown = pipeline()): StoredFile => ({
    id: "file_research",
    name,
    mimeType,
    bytes: bytesOf(input),
  });
  const params = {
    ...defaultBlockParams("raw"),
    source: "excel",
    dataset: "equipment_data",
    sheet: "Ignored for JSON",
    file: { fileId: "file_research", name: "dialog name.xlsx" },
  };

  it.each([
    ["research.JSON", "application/octet-stream"],
    ["research.data", "application/json"],
    ["research.data", "text/json; charset=utf-8"],
    ["research.data", "APPLICATION/LD+JSON; charset=UTF-8"],
  ])("recognizes JSON by stored name or MIME: %s, %s", async (name, mime) => {
    const f = file(name, mime);
    expect(isResearchJsonFile(f)).toBe(true);
    const c = context(f);
    const result = await rawBlock.run({}, params, c.ctx);
    expect(result).toEqual({ status: "ok", outputs: { out: pipeline() } });
  });

  it.each([
    ["book.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["table.csv", "text/csv"],
    ["research.json.csv", "application/octet-stream"],
  ])("leaves existing file handling unchanged for %s", (name, mime) => {
    expect(isResearchJsonFile(file(name, mime))).toBe(false);
  });

  it("imports independent no-locator comments with equal wording and original provenance", async () => {
    const { locator, ...original } = record();
    const a = {
      ...original,
      fields: { ...original.fields, commentId: "comment-a", customerId: "customer-a" },
    };
    const b = {
      ...a,
      id: "rec_independent",
      fields: { ...a.fields, commentId: "comment-b", customerId: "customer-b" },
      provenance: { ...a.provenance, offsets: [71, 120] },
    };
    const input = { ...research(), records: [a, b] };
    const c = context(file("research.json", "application/json", input));
    expect(await rawBlock.run({}, params, c.ctx)).toEqual({
      status: "ok",
      outputs: { out: { ...input, findings: [], themes: [], requirements: [] } },
    });
    expect(c.logs).toEqual([
      "Imported Research JSON: 1 source(s), 2 record(s), 0 finding(s), 0 theme(s), 0 requirement(s).",
    ]);
  });

  it("imports sources individually, logs counts only, and does not claim to extract imported findings", async () => {
    const input = pipeline();
    input.sources.push({ ...source(), id: "src_second", uri: "https://example.com/second" });
    const c = context(file("secret-filename.json", "application/json", input));
    await rawBlock.run({}, params, c.ctx);
    expect(c.audit.map((event) => [event.action, event.entityId])).toEqual([
      ["source.ingested", "src_research"],
      ["source.ingested", "src_second"],
    ]);
    expect(
      c.audit.every((event) => event.runId === "run_json" && event.blockId === "raw-json"),
    ).toBe(true);
    expect(c.audit.every((event) => /Imported.*JSON/.test(event.rationale ?? ""))).toBe(true);
    expect(c.logs).toEqual([
      "Imported Research JSON: 2 source(s), 1 record(s), 1 finding(s), 1 theme(s), 1 requirement(s).",
    ]);
  });

  it("uses the same safe import audit for previews without an invalid run ID", async () => {
    const c = context(file("research.json", "application/json"));
    c.ctx.runId = "preview";
    await rawBlock.run({}, params, c.ctx);
    expect(c.audit).toHaveLength(1);
    expect(c.audit[0]).not.toHaveProperty("runId");
  });

  it("fails before output, logs or audit writes and never falls back to CSV on malformed JSON", async () => {
    const f = file("private.json", "application/json");
    f.bytes = new TextEncoder().encode('{"synthetic-secret": broken}');
    const c = context(f);
    await expect(rawBlock.run({}, params, c.ctx)).rejects.toThrow(/Research JSON.*UTF-8 JSON/);
    expect(c.logs).toEqual([]);
    expect(c.audit).toEqual([]);
  });

  it("rejects oversized imports and cancellation before audit writes", async () => {
    const f = file("research.json", "application/json");
    f.bytes = new Uint8Array(16 * 1024 * 1024 + 1);
    const c = context(f);
    await expect(rawBlock.run({}, params, c.ctx)).rejects.toThrow(/16 MiB/);
    expect(c.audit).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    const cancelled = context(file("research.json", "application/json"), controller.signal);
    await expect(rawBlock.run({}, params, cancelled.ctx)).rejects.toThrow();
    expect(cancelled.logs).toEqual([]);
    expect(cancelled.audit).toEqual([]);
  });
});
