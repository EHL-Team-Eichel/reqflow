import {
  defaultBlockParams,
  DEFAULT_SETTINGS,
  PipelineData,
  type AuditEventInput,
  type LlmClient,
  type LlmObjectRequest,
  type LlmTextRequest,
  type StoredFile,
} from "@reqflow/core";
import type { BlockContext } from "@reqflow/engine";
import { describe, expect, it, vi } from "vitest";
import {
  textPdf as makeTextPdf,
  scannedPdf as makeRasterImagePdf,
} from "../../../../data/samples/raw-pdf-fixture";
import {
  MAX_FILE_SIZE_BYTES,
  MAX_PAGE_CHARS,
  MAX_PDF_PAGES,
  isPdfCandidate,
  isPdfMagic,
  readPdf,
} from "./pdf";
import { rawBlock } from "./raw";
import { readSpreadsheet } from "./read";
import { structurePdf, type PageStructure } from "./structure";

const rawParams = (patch: Record<string, unknown>) => ({ ...defaultBlockParams("raw"), ...patch });

const makeBlankPdf = () => makeTextPdf([{ lines: [] }]);

interface TestContextOptions {
  files?: StoredFile[];
  llm?: LlmClient;
  provider?: "anthropic" | "openai" | "google" | "mock";
}

function createTestContext(opts: TestContextOptions = {}) {
  const logs: string[] = [];
  const audit: AuditEventInput[] = [];
  const files = opts.files ?? [];
  const ctx = {
    runId: "run_test_pdf_01",
    blockId: "raw-pdf-1",
    scope: DEFAULT_SETTINGS.defaultScope,
    settings: {
      ...DEFAULT_SETTINGS,
      llm: {
        ...DEFAULT_SETTINGS.llm,
        provider: opts.provider ?? "anthropic",
      },
    },
    llm: opts.llm,
    files: {
      get: async (id: string) => {
        const f = files.find((x) => x.id === id);
        if (!f) throw new Error(`no file ${id}`);
        return f;
      },
    },
    audit: {
      record: async (e: AuditEventInput) => {
        audit.push(e);
        return { ...e, id: "aud_test", at: new Date().toISOString(), changes: [] };
      },
    },
    log: (m: string) => logs.push(m),
    signal: new AbortController().signal,
  } as unknown as BlockContext;

  return { ctx, logs, audit };
}

describe("PDF Detection and Spreadsheet routing", () => {
  it("detects PDF magic bytes and candidate filenames", () => {
    const valid = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // %PDF-1
    expect(isPdfMagic(valid)).toBe(true);
    expect(isPdfCandidate("specs.pdf", undefined, valid)).toBe(true);
    expect(isPdfCandidate("specs.PDF")).toBe(true);
    expect(isPdfCandidate("doc.bin", "application/pdf")).toBe(true);
    expect(isPdfCandidate("table.xlsx")).toBe(false);
  });

  it("fails invalid renamed PDF with sanitized error without leaking content", async () => {
    const invalidPdf: StoredFile = {
      id: "file_corrupt",
      name: "secret_document.pdf",
      mimeType: "application/pdf",
      bytes: new TextEncoder().encode("CONFIDENTIAL_PASSWORD_12345"),
    };
    const c = createTestContext({ files: [invalidPdf] });

    await expect(
      rawBlock.run(
        {},
        rawParams({ file: { fileId: invalidPdf.id, name: invalidPdf.name } }),
        c.ctx,
      ),
    ).rejects.toThrow(`"${invalidPdf.name}" is not a valid PDF file.`);

    // Verify error doesn't leak content
    try {
      await rawBlock.run(
        {},
        rawParams({ file: { fileId: invalidPdf.id, name: invalidPdf.name } }),
        c.ctx,
      );
    } catch (err: any) {
      expect(err.message).not.toContain("CONFIDENTIAL");
      expect(err.message).not.toContain("PASSWORD");
    }
  });

  it("throws internal use error when readSpreadsheet is directly called on PDF", async () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.7 header");
    await expect(readSpreadsheet("options.pdf", pdfBytes, "")).rejects.toThrow(
      /readSpreadsheet called on PDF "options.pdf". This is an internal error; PDFs must be routed through readPdf/,
    );
  });
});

describe("PDF Reader (pdf.ts)", () => {
  it("extracts text from real embedded PDF and preserves layout row ordering", async () => {
    const bytes = makeTextPdf([
      {
        lines: [
          "BMW 1 Series (F70) Equipment Specification",
          "Line 1: Heated Steering Wheel Standard",
          "Line 2: Panoramic Glass Sunroof Optional",
        ],
      },
    ]);

    const result = await readPdf("embedded.pdf", bytes);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.page).toBe(1);
    expect(result.pages[0]!.method).toBe("text");
    expect(result.pages[0]!.text).toContain("BMW 1 Series (F70) Equipment Specification");
    expect(result.pages[0]!.text).toContain("Line 1: Heated Steering Wheel Standard");
    expect(result.pages[0]!.text).toContain("Line 2: Panoramic Glass Sunroof Optional");

    // Layout row ordering check: Line 1 appears before Line 2
    const idx1 = result.pages[0]!.text.indexOf("Line 1");
    const idx2 = result.pages[0]!.text.indexOf("Line 2");
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
  });

  it("reports blank pages rather than skipping silently", async () => {
    const bytes = makeBlankPdf();
    const result = await readPdf("blank.pdf", bytes);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.page).toBe(1);
    expect(result.pages[0]!.text).toBe("");
    expect(result.notes).toContain(
      "Page 1 has no readable text after OCR; it may be blank or image-only.",
    );
  });

  it("enforces 30MB file size limit", async () => {
    const oversizedBytes = new Uint8Array(MAX_FILE_SIZE_BYTES + 1);
    oversizedBytes[0] = 0x25;
    oversizedBytes[1] = 0x50;
    oversizedBytes[2] = 0x44;
    oversizedBytes[3] = 0x46; // %PDF

    await expect(readPdf("huge.pdf", oversizedBytes)).rejects.toThrow(
      /exceeds the maximum PDF size limit of 30MB/,
    );
  });

  it("enforces 100 pages limit", async () => {
    const pages = Array.from({ length: MAX_PDF_PAGES + 1 }, (_, i) => ({
      lines: [`Page line ${i + 1}`],
    }));
    const bytes = makeTextPdf(pages);

    await expect(readPdf("overpages.pdf", bytes)).rejects.toThrow(
      /exceeding the maximum limit of 100 pages/,
    );
  });

  it("performs real OCR on image-only PDF fixture using local bundled tesseract assets", async () => {
    // Generate real image-only PDF with text rasterized into canvas (no embedded font text)
    const bytes = await makeRasterImagePdf("BMW TEST OCR");
    const result = await readPdf("raster.pdf", bytes);

    expect(result.pages).toHaveLength(1);
    const p = result.pages[0]!;
    expect(p.page).toBe(1);
    expect(p.method).toBe("ocr");
    expect(typeof p.confidence).toBe("number");
    expect(p.confidence).toBeGreaterThan(0);
    // OCR recognized the text
    expect(p.text.toUpperCase()).toContain("BMW TEST OCR");
  }, 60_000);
});

describe("PDF safety regressions", () => {
  const options = {
    key: "file_synthetic",
    title: "synthetic.pdf",
    dataset: "equipment_data" as const,
    scope: DEFAULT_SETTINGS.defaultScope,
    retrievedAt: "2026-10-11T00:00:00.000Z",
  };
  const page = {
    page: 1,
    text: "Heated seats standard\nFootnote: package only",
    method: "text" as const,
  };
  const llm = (object: unknown): LlmClient => ({
    generateObject: async <T>() => ({ object: object as T, model: "synthetic-model" }),
    generateText: async () => {
      throw new Error("unused");
    },
  });
  const item = {
    title: "Seats",
    itemType: "feature",
    verbatimExcerpt: "Heated seats standard",
    cells: [],
  };

  it("validates even injected clients and never exposes invalid model content", async () => {
    await expect(
      structurePdf([page], llm({ items: "PRIVATE_MODEL_OUTPUT" }), options),
    ).rejects.toThrow(/schema on page 1/);
  });

  it("requires exact whitespace and field values, not merely a genuine unrelated quote", async () => {
    await expect(
      structurePdf(
        [page],
        llm({ items: [{ ...item, verbatimExcerpt: "standard Footnote" }] }),
        options,
      ),
    ).rejects.toThrow(/invalid verbatim/);
    await expect(
      structurePdf(
        [page],
        llm({
          items: [{ ...item, cells: [{ key: "price", value: "900", evidence: "Heated seats" }] }],
        }),
        options,
      ),
    ).rejects.toThrow(/invalid cell evidence/);
  });

  it("rejects duplicate field names instead of overwriting a cell", async () => {
    const cell = { key: "status", value: "standard", evidence: "standard" };
    await expect(
      structurePdf([page], llm({ items: [{ ...item, cells: [cell, cell] }] }), options),
    ).rejects.toThrow(/duplicate cell key/);
  });

  it("sanitizes provider failure and keeps no partial model output", async () => {
    const provider = llm({});
    provider.generateObject = async () => {
      throw new Error("PRIVATE_DOCUMENT_RESPONSE");
    };
    await expect(structurePdf([page], provider, options)).rejects.toThrow(
      "PDF AI extraction failed on page 1. Check the configured default AI and credentials; no partial data was published.",
    );
  });

  it("rejects invented titles and unsupported availability metadata", async () => {
    const genuine = { ...item, title: "Heated seats" };
    await expect(
      structurePdf(
        [page],
        llm({ items: [{ ...genuine, title: "Invented premium seats" }] }),
        options,
      ),
    ).rejects.toThrow(/unsupported title\/section/);
    await expect(
      structurePdf(
        [page],
        llm({
          items: [{ ...genuine, availability: "optional", availabilityEvidence: "standard" }],
        }),
        options,
      ),
    ).rejects.toThrow(/unsupported availability/);
    await expect(
      structurePdf([page], llm({ items: [{ ...genuine, availability: "standard" }] }), options),
    ).rejects.toThrow(/unsupported availability/);
  });

  it("stops before parsing or requesting AI when cancelled", async () => {
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(readPdf("synthetic.pdf", makeBlankPdf(), { signal })).rejects.toThrow("cancelled");
    const provider = llm({});
    const generate = vi.spyOn(provider, "generateObject");
    await expect(structurePdf([page], provider, { ...options, signal })).rejects.toThrow(
      "cancelled",
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it("cancels an in-flight local OCR operation promptly", async () => {
    const bytes = await makeRasterImagePdf("SYNTHETIC OCR CANCELLATION");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("cancelled OCR")), 50);
    try {
      await expect(readPdf("cancel.pdf", bytes, { signal: controller.signal })).rejects.toThrow(
        "cancelled OCR",
      );
    } finally {
      clearTimeout(timer);
    }
  }, 10_000);
});

describe("PDF Structuring, LLM Verification, and Pipeline Provenance", () => {
  it("refuses offline mock structuring with instruction to configure real AI", async () => {
    const bytes = makeTextPdf([{ lines: ["BMW Feature 1"] }]);
    const file: StoredFile = {
      id: "file_pdf_offline",
      name: "equipment.pdf",
      mimeType: "application/pdf",
      bytes,
    };
    const c = createTestContext({ files: [file], provider: "mock" });

    await expect(
      rawBlock.run({}, rawParams({ file: { fileId: file.id, name: file.name } }), c.ctx),
    ).rejects.toThrow(/PDF structuring is not supported with offline mock/);
  });

  it("calls ctx.llm.generateObject with tier default and structures items", async () => {
    const line1 = "BMW F70 Heated Seats: Standard equipment";
    const line2 = "BMW F70 Parking Assistant: Optional package 05DM";
    const bytes = makeTextPdf([{ lines: [line1, line2] }]);
    const file: StoredFile = {
      id: "file_pdf_valid",
      name: "f70_equipment.pdf",
      mimeType: "application/pdf",
      bytes,
    };

    let capturedTier: string | undefined;
    const fakeLlm: LlmClient = {
      async generateObject<T>(req: LlmObjectRequest<T>) {
        capturedTier = req.tier;
        const mockStructure: PageStructure = {
          items: [
            {
              title: "Heated Seats",
              itemType: "equipment_option",
              verbatimExcerpt: line1,
              availability: "standard",
              availabilityEvidence: "Standard equipment",
              cells: [
                { key: "Option", value: "Heated Seats", evidence: "Heated Seats" },
                { key: "Status", value: "Standard", evidence: "Standard equipment" },
              ],
            },
            {
              title: "Parking Assistant",
              itemType: "equipment_option",
              verbatimExcerpt: line2,
              availability: "optional",
              availabilityEvidence: "Optional package 05DM",
              cells: [{ key: "Package", value: "05DM", evidence: "05DM" }],
            },
          ],
        };
        return { object: mockStructure as T, model: "gpt-4.1-mini-test" };
      },
      async generateText(_req: LlmTextRequest) {
        throw new Error("not used");
      },
    };

    const c = createTestContext({ files: [file], llm: fakeLlm });
    const result = await rawBlock.run(
      {},
      rawParams({ file: { fileId: file.id, name: file.name }, dataset: "equipment_data" }),
      c.ctx,
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(capturedTier).toBe("default");

    const out = PipelineData.parse(result.outputs.out);
    // Source verification
    expect(out.sources).toHaveLength(1);
    expect(out.sources[0]!.kind).toBe("equipment_data");
    expect(out.sources[0]!.origin).toBe("bmw_internal");

    // Records verification: 1 original page record + 2 structured item records = 3 records
    expect(out.records).toHaveLength(3);

    // 1. Original page record retained
    const origRecord = out.records.find((r) => r.id.endsWith("_orig"));
    expect(origRecord).toBeDefined();
    expect(origRecord!.fields?.page).toBe(1);
    expect(origRecord!.fields?.extractionMethod).toBe("text");

    // 2. Structured item records
    const itemRecords = out.records.filter((r) => !r.id.endsWith("_orig"));
    expect(itemRecords).toHaveLength(2);
    expect(itemRecords[0]!.text).toBe(line1);
    expect(itemRecords[0]!.fields?.title).toBe("Heated Seats");
    expect(itemRecords[0]!.fields?.interpretationStatus).toBe("ai_derived_needs_review");
    expect(itemRecords[0]!.fields?.verified).toBe(false);
    expect(itemRecords[0]!.fields?.extractionModel).toBe("gpt-4.1-mini-test");

    // 3. No decisions or findings derived
    expect(out.findings).toHaveLength(0);

    // 4. Audit trail records exact model ID
    const auditEvent = c.audit.find((a) => a.action === "source.ingested");
    expect(auditEvent).toBeDefined();
    expect((auditEvent?.actor as any)?.model).toBe("gpt-4.1-mini-test");

    // 5. Logs model, page, and count only
    const logSummary = c.logs.find((l) => l.includes("Ingested PDF using model"));
    expect(logSummary).toBeDefined();
    expect(logSummary).toContain("model gpt-4.1-mini-test: 1 page(s), 3 record(s)");
  });

  it("rejects hallucinated verbatim excerpt with page/item identifier only without leaking data", async () => {
    const pageText = "Valid text on page 1";
    const fakeLlm: LlmClient = {
      async generateObject<T>(_req: LlmObjectRequest<T>) {
        const forgedStructure: PageStructure = {
          items: [
            {
              title: "Invented Feature",
              itemType: "feature",
              verbatimExcerpt: "NONEXISTENT FORGED TEXT SECRET_123",
              cells: [],
            },
          ],
        };
        return { object: forgedStructure as T, model: "test-model" };
      },
      async generateText() {
        throw new Error("not used");
      },
    };

    const pages = [{ page: 1, text: pageText, method: "text" as const }];
    await expect(
      structurePdf(pages, fakeLlm, {
        key: "test_key",
        title: "test.pdf",
        dataset: "equipment_data",
        scope: DEFAULT_SETTINGS.defaultScope,
        retrievedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("Malformed AI extraction: invalid verbatim excerpt on page 1, item 0");

    // Verify error does NOT leak forged text or secret content
    try {
      await structurePdf(pages, fakeLlm, {
        key: "test_key",
        title: "test.pdf",
        dataset: "equipment_data",
        scope: DEFAULT_SETTINGS.defaultScope,
        retrievedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      expect(err.message).not.toContain("SECRET_123");
      expect(err.message).not.toContain("NONEXISTENT");
    }
  });

  it("rejects invalid cell evidence with page/item/cell identifier only", async () => {
    const pageText = "Genuine text on page 1";
    const fakeLlm: LlmClient = {
      async generateObject<T>(_req: LlmObjectRequest<T>) {
        const forgedStructure: PageStructure = {
          items: [
            {
              title: "Feature",
              itemType: "feature",
              verbatimExcerpt: "Genuine text on page 1",
              cells: [{ key: "Price", value: "500 EUR", evidence: "FORGED_PRICE_EVIDENCE" }],
            },
          ],
        };
        return { object: forgedStructure as T, model: "test-model" };
      },
      async generateText() {
        throw new Error("not used");
      },
    };

    const pages = [{ page: 1, text: pageText, method: "text" as const }];
    await expect(
      structurePdf(pages, fakeLlm, {
        key: "test_key",
        title: "test.pdf",
        dataset: "equipment_data",
        scope: DEFAULT_SETTINGS.defaultScope,
        retrievedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("Malformed AI extraction: invalid cell evidence on page 1, item 0, cell 0");
  });

  it("produces deterministic IDs across runs", async () => {
    const text = "BMW F70 Standard Item";
    const pages = [{ page: 1, text, method: "text" as const }];
    const fakeLlm: LlmClient = {
      async generateObject<T>(_req: LlmObjectRequest<T>) {
        const structure: PageStructure = {
          items: [
            {
              title: "Standard Item",
              itemType: "equipment_option",
              verbatimExcerpt: text,
              cells: [{ key: "Item", value: "Standard Item", evidence: "Standard Item" }],
            },
          ],
        };
        return { object: structure as T, model: "test-model" };
      },
      async generateText() {
        throw new Error("not used");
      },
    };

    const run1 = await structurePdf(pages, fakeLlm, {
      key: "fixed_key",
      title: "test.pdf",
      dataset: "equipment_data",
      scope: DEFAULT_SETTINGS.defaultScope,
      retrievedAt: "2026-10-11T00:00:00.000Z",
    });

    const run2 = await structurePdf(pages, fakeLlm, {
      key: "fixed_key",
      title: "test.pdf",
      dataset: "equipment_data",
      scope: DEFAULT_SETTINGS.defaultScope,
      retrievedAt: "2026-10-11T00:00:00.000Z",
    });

    expect(run1.records.map((r) => r.id)).toEqual(run2.records.map((r) => r.id));
    expect(run1.source.id).toEqual(run2.source.id);
  });
});
