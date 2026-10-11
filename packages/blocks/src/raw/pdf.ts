import { createRequire } from "node:module";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Worker as OcrWorker } from "tesseract.js";

const require = createRequire(import.meta.url);

export const MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024; // 30 MB
export const MAX_PDF_PAGES = 100;
export const MAX_RENDER_PIXELS = 8 * 1024 * 1024; // 8M pixels
export const MAX_PAGE_CHARS = 50_000; // 50k chars per page
export const OCR_SPARSE_THRESHOLD_CHARS = 50;
export const OCR_PAGE_TIMEOUT_MS = 45_000;

export interface PdfPageResult {
  page: number;
  text: string;
  method: "text" | "ocr";
  confidence?: number;
}

export interface ReadPdfOptions {
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface ReadPdfOutput {
  pages: PdfPageResult[];
  notes: string[];
}

export const isPdfMagic = (b: Uint8Array): boolean =>
  b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF

export function isPdfCandidate(name: string, mimeType?: string, bytes?: Uint8Array): boolean {
  if (bytes && isPdfMagic(bytes)) return true;
  if (mimeType === "application/pdf") return true;
  if (/\.pdf$/i.test(name)) return true;
  return false;
}

const unpacked = (path: string) => path.replace(/app\.asar(?=[\\/])/, "app.asar.unpacked");

interface TextFragment {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function assemblePageText(fragments: TextFragment[]): string {
  if (fragments.length === 0) return "";

  // Sort fragments by y descending (top to bottom in PDF coordinate space)
  const sorted = [...fragments].sort((a, b) => {
    const dy = b.y - a.y;
    if (Math.abs(dy) > 3) return dy;
    return a.x - b.x;
  });

  const lines: TextFragment[][] = [];
  for (const frag of sorted) {
    const line = lines.find((l) => {
      const lineY = l[0]!.y;
      const tol = Math.max(frag.height * 0.5, 3);
      return Math.abs(frag.y - lineY) <= tol;
    });

    if (line) {
      line.push(frag);
    } else {
      lines.push([frag]);
    }
  }

  // Sort lines top-to-bottom
  lines.sort((a, b) => b[0]!.y - a[0]!.y);

  const lineStrings: string[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
    let lineStr = "";
    let previous: TextFragment | undefined;
    for (const f of line) {
      const cleanStr = f.str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
      if (!cleanStr) continue;
      if (!lineStr) {
        lineStr = cleanStr;
      } else {
        const gap = previous ? f.x - previous.x - previous.width : 0;
        const charWidth = previous ? previous.width / Math.max(previous.str.length, 1) : 4;
        const spaces =
          gap > 0 ? Math.min(80, Math.max(1, Math.round(gap / Math.max(charWidth, 2)))) : 1;
        lineStr += " ".repeat(spaces) + cleanStr;
      }
      previous = f;
    }
    const trimmed = lineStr.trimEnd();
    if (trimmed) {
      lineStrings.push(trimmed);
    }
  }

  return lineStrings.join("\n");
}

export async function readPdf(
  name: string,
  bytes: Uint8Array,
  options: ReadPdfOptions = {},
): Promise<ReadPdfOutput> {
  options.signal?.throwIfAborted();
  if (bytes.byteLength > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `"${name}" exceeds the maximum PDF size limit of 30MB (${(bytes.byteLength / (1024 * 1024)).toFixed(1)}MB).`,
    );
  }

  if (!isPdfMagic(bytes)) {
    throw new Error(`"${name}" is not a valid PDF file.`);
  }

  // Ensure Node globals exist before importing pdfjs
  const canvasModule = await import("@napi-rs/canvas");
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.DOMMatrix === "undefined" && canvasModule.DOMMatrix) {
    g.DOMMatrix = canvasModule.DOMMatrix;
  }
  if (typeof g.ImageData === "undefined" && canvasModule.ImageData) {
    g.ImageData = canvasModule.ImageData;
  }
  if (typeof g.Path2D === "undefined" && canvasModule.Path2D) {
    g.Path2D = canvasModule.Path2D;
  }
  if (typeof g.Image === "undefined" && canvasModule.Image) {
    g.Image = canvasModule.Image;
  }

  // Dynamically import pdfjs
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const workerSrc = unpacked(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"));
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerSrc).href;

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    disableFontFace: true,
    enableXfa: false,
    useSystemFonts: false,
    cMapUrl: pathToFileURL(
      unpacked(require.resolve("pdfjs-dist/package.json")).replace(/package\.json$/, "cmaps/"),
    ).href,
    cMapPacked: true,
    standardFontDataUrl: unpacked(require.resolve("pdfjs-dist/package.json")).replace(
      /package\.json$/,
      "standard_fonts/",
    ),
    wasmUrl: unpacked(require.resolve("pdfjs-dist/package.json")).replace(
      /package\.json$/,
      "wasm/",
    ),
  });

  const abortLoading = () => {
    void loadingTask.destroy();
  };
  options.signal?.addEventListener("abort", abortLoading, { once: true });

  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    if (options.signal?.aborted) throw options.signal.reason;
    options.signal?.removeEventListener("abort", abortLoading);
    await loadingTask.destroy();
    throw new Error(
      `"${name}" could not be parsed as a PDF. It may be corrupt or password-protected.`,
    );
  }

  if (doc.numPages > MAX_PDF_PAGES) {
    await doc.cleanup();
    await loadingTask.destroy();
    options.signal?.removeEventListener("abort", abortLoading);
    throw new Error(
      `"${name}" has ${doc.numPages} pages, exceeding the maximum limit of ${MAX_PDF_PAGES} pages.`,
    );
  }

  const pages: PdfPageResult[] = [];
  const notes: string[] = [];
  let ocrWorker: OcrWorker | null = null;
  let langDir: string | undefined;

  async function bounded<T>(task: Promise<T>, pageNum: number): Promise<T> {
    options.signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        task,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(options.signal?.reason ?? new Error("PDF extraction cancelled"));
          options.signal?.addEventListener("abort", abort, { once: true });
          timer = setTimeout(
            () =>
              reject(new Error(`OCR timeout on page ${pageNum} after ${OCR_PAGE_TIMEOUT_MS}ms`)),
            OCR_PAGE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) options.signal?.removeEventListener("abort", abort);
    }
  }

  const getOcrWorker = async (pageNum: number) => {
    if (ocrWorker) return ocrWorker;
    const { createWorker } = await import("tesseract.js");
    const workerPath = unpacked(require.resolve("tesseract.js/src/worker-script/node/index.js"));
    const corePath = unpacked(require.resolve("tesseract.js-core"));
    langDir = mkdtempSync(join(tmpdir(), "reqflow-tessdata-"));
    for (const lang of ["eng", "deu"]) {
      const meta = require(`@tesseract.js-data/${lang}`) as { langPath: string };
      copyFileSync(
        unpacked(join(meta.langPath, `${lang}.traineddata.gz`)),
        join(langDir, `${lang}.traineddata.gz`),
      );
    }
    const creating = createWorker(["eng", "deu"], 1, {
      workerPath,
      corePath,
      langPath: langDir,
      gzip: true,
      cacheMethod: "none",
      logger: () => {},
      errorHandler: () => {},
    });
    try {
      ocrWorker = await bounded(creating, pageNum);
    } catch (error) {
      const lateDir = langDir;
      langDir = undefined;
      void creating
        .then(async (worker) => {
          await worker.terminate();
        })
        .catch(() => {})
        .finally(() => {
          if (lateDir) rmSync(lateDir, { recursive: true, force: true });
        });
      throw error;
    }
    return ocrWorker;
  };

  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      options.signal?.throwIfAborted();

      const page = await doc.getPage(pageNum);
      const textContent = await page.getTextContent({ includeMarkedContent: false });

      const fragments: TextFragment[] = [];
      for (const item of textContent.items) {
        if ("str" in item && typeof item.str === "string" && item.str.length > 0) {
          fragments.push({
            str: item.str,
            x: item.transform[4] ?? 0,
            y: item.transform[5] ?? 0,
            width: item.width ?? 0,
            height: item.height ?? 0,
          });
        }
      }

      let extractedText = assemblePageText(fragments);
      if (extractedText.length > MAX_PAGE_CHARS) {
        throw new Error(
          `Page ${pageNum} of "${name}" exceeds the maximum characters limit of ${MAX_PAGE_CHARS} (${extractedText.length} chars).`,
        );
      }

      const trimmedText = extractedText.trim();
      const isSparseOrEmpty = trimmedText.length < OCR_SPARSE_THRESHOLD_CHARS;

      if (!isSparseOrEmpty) {
        pages.push({
          page: pageNum,
          text: extractedText,
          method: "text",
        });
        continue;
      }

      // Page is sparse or empty: attempt local OCR
      const baseViewport = page.getViewport({ scale: 1.0 });
      if (baseViewport.width * baseViewport.height > MAX_RENDER_PIXELS) {
        throw new Error(
          `Page ${pageNum} render resolution (${Math.round(baseViewport.width * baseViewport.height)} pixels) exceeds limit of 8M pixels.`,
        );
      }

      const maxScale = Math.sqrt(MAX_RENDER_PIXELS / (baseViewport.width * baseViewport.height));
      const scale = Math.min(2.0, maxScale);
      const viewport = page.getViewport({ scale });

      if (viewport.width * viewport.height > MAX_RENDER_PIXELS) {
        throw new Error(`Page ${pageNum} render resolution exceeds limit of 8M pixels.`);
      }

      const canvas = canvasModule.createCanvas(
        Math.floor(viewport.width),
        Math.floor(viewport.height),
      );
      const context = canvas.getContext("2d");

      const renderTask = page.render({
        canvas: null,
        canvasContext: context as any,
        viewport,
      });
      const abortRender = () => renderTask.cancel();
      options.signal?.addEventListener("abort", abortRender, { once: true });
      try {
        await renderTask.promise;
      } finally {
        options.signal?.removeEventListener("abort", abortRender);
      }
      const imageBuffer = canvas.toBuffer("image/png");

      const worker = await getOcrWorker(pageNum);
      options.signal?.throwIfAborted();

      const ocrResult = await bounded(worker.recognize(imageBuffer), pageNum);
      options.signal?.throwIfAborted();

      const ocrText = (ocrResult?.data?.text ?? "").trim();
      const ocrConfidence =
        typeof ocrResult?.data?.confidence === "number" ? ocrResult.data.confidence : undefined;

      if (ocrText.length > MAX_PAGE_CHARS) {
        throw new Error(
          `Page ${pageNum} OCR text of "${name}" exceeds limit of ${MAX_PAGE_CHARS} chars.`,
        );
      }

      if (ocrText.length > 0) {
        pages.push({
          page: pageNum,
          text: ocrText,
          method: "ocr",
          confidence: ocrConfidence,
        });
        if (options.log) {
          options.log(`Page ${pageNum}: OCR extracted ${ocrText.length} characters.`);
        }
      } else if (trimmedText.length > 0) {
        // Preserve nonempty sparse text if OCR yields none
        pages.push({
          page: pageNum,
          text: extractedText,
          method: "text",
        });
      } else {
        // Blank page: report rather than skipping silently
        pages.push({
          page: pageNum,
          text: "",
          method: "ocr",
          confidence: ocrConfidence,
        });
        notes.push(
          `Page ${pageNum} has no readable text after OCR; it may be blank or image-only.`,
        );
        if (options.log) {
          options.log(`Page ${pageNum} has no readable text after OCR.`);
        }
      }
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && /^(Page \d+|OCR timeout)/.test(error.message)) throw error;
    throw new Error(
      `PDF text/OCR extraction failed. Check the document and local OCR runtime; no partial data was published.`,
    );
  } finally {
    if (ocrWorker) {
      await ocrWorker.terminate();
      ocrWorker = null;
    }
    if (langDir) rmSync(langDir, { recursive: true, force: true });
    options.signal?.removeEventListener("abort", abortLoading);
    await loadingTask.destroy();
  }

  return { pages, notes };
}
