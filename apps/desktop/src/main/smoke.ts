import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import {
  BLOCK_SPECS,
  PALETTE_BLOCK_KINDS,
  LLM_MODEL_DEFAULTS,
  ResearchDataset,
  Settings,
  SECRET_NAMES,
  WorkflowRun,
  connect,
  CarPowertrain,
  createBlock,
  DEFAULT_SETTINGS,
  defaultBlockParams,
  setBlockParams,
  type WorkflowGraph,
} from "@reqflow/core";
import { ipcChannel, type AppInfo, type IpcResult, type ReqflowHandlers } from "@reqflow/core/ipc";
import { fixturePipelineData, fixtureScope } from "@reqflow/core/fixtures";
import type { LocalFileStore } from "@reqflow/db";
import type { BrowserWindow, NativeImage } from "electron";
import { NO_AGENT_SERVICES } from "@reqflow/engine";
import { rawBlock } from "../../../../packages/blocks/src/raw/raw";
import { readPdf } from "../../../../packages/blocks/src/raw/pdf";
import { scannedPdf, textPdf } from "../../../../data/samples/raw-pdf-fixture";
import {
  SYNTHETIC_FEEDBACK,
  verifySmokeResearchDataset,
  verifySmokeResearchFiles,
  writeSmokeResearchFixture,
  type SmokeAssertion,
} from "./research/smoke-fixture";

type InvokeMethod<N extends keyof ReqflowHandlers, M extends keyof ReqflowHandlers[N]> = Extract<
  ReqflowHandlers[N][M],
  (...args: never[]) => Promise<unknown>
>;

/**
 * `npm run smoke` (= `electron . --smoke=out/smoke`): opens every screen, clicks through the main
 * interactions, screenshots each step, calls the IPC bridge end to end, and exits non-zero on any
 * failed check or renderer error. Used by agents to verify UI work without clicking through the app.
 */
export const SMOKE_ROUTES = ["/dataflow", "/car", "/settings"] as const;
const SETTINGS_SECTIONS = [
  "app",
  "model",
  "model-switcher",
  "parameters",
  "ai",
  "research-apis",
  "collaboration",
  "about",
] as const;

export function parseSmokeArg(argv: readonly string[]): string | null {
  const arg = argv.find((a) => a.startsWith("--smoke="));
  return arg ? resolve(arg.slice("--smoke=".length)) : null;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const slug = (route: string) => route.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-") || "root";

export async function runSmoke(
  win: BrowserWindow,
  outDir: string,
  deps: {
    files: LocalFileStore;
    samplesDir: string;
    bmwDir: string;
    /** The next "Choose file…" in the app returns this path instead of opening a dialog. */
    queuePick: (path: string) => void;
  },
): Promise<number> {
  mkdirSync(outDir, { recursive: true });
  // Never leave an earlier successful report behind if this run aborts before completion.
  writeFileSync(
    join(outDir, "report.json"),
    JSON.stringify({ ok: false, errors: ["Smoke run has not completed."], screens: [] }, null, 2),
  );
  const errors: string[] = [];
  const screens: { name: string; file: string }[] = [];
  const wc = win.webContents;
  wc.on("console-message", (event) => {
    if (event.level === "error") errors.push(`console: ${event.message}`);
  });
  wc.on("render-process-gone", (_e, details) => errors.push(`renderer gone: ${details.reason}`));

  if (wc.isLoading()) await new Promise<void>((r) => wc.once("did-finish-load", () => r()));

  const js = <T>(code: string): Promise<T> => wc.executeJavaScript(code);
  const invoke = async <N extends keyof ReqflowHandlers, M extends keyof ReqflowHandlers[N]>(
    namespace: N,
    method: M,
    ...args: Parameters<InvokeMethod<N, M>>
  ): Promise<Awaited<ReturnType<InvokeMethod<N, M>>>> => {
    const result = await js<IpcResult<Awaited<ReturnType<InvokeMethod<N, M>>>>>(
      `window.reqflowBridge.invoke(${JSON.stringify(ipcChannel(namespace, String(method)))}, ...${JSON.stringify(args)})`,
    );
    if (!result.ok) throw new Error(`${namespace}.${String(method)} failed: ${result.error.code}`);
    return result.value;
  };
  const check = (ok: boolean, message: string) => {
    if (!ok) errors.push(message);
  };
  const llmSettings = async () => Settings.parse(await invoke("settings", "get")).llm;
  const waitForLlm = async (expected: Partial<Settings["llm"]>) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const current = await llmSettings();
      if (
        Object.entries(expected).every(
          ([key, value]) => current[key as keyof typeof current] === value,
        )
      )
        return current;
      await delay(100);
    }
    throw new Error("Timed out waiting for selected AI settings to persist.");
  };
  const go = async (route: string) => {
    await js(`location.hash = ${JSON.stringify(`#${route}`)}`);
    await delay(500);
  };
  const count = (selector: string) =>
    js<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const text = (selector: string) =>
    js<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
  /** Clicks the first match; false when nothing matches. */
  const click = (selector: string) =>
    js<boolean>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
    );
  // Screenshots come from the off-screen renderer's paint events: force a repaint, then wait for it,
  // so every screenshot shows the state the checks just verified (capturePage can return stale frames).
  let frame: NativeImage | null = null;
  let frames = 0;
  wc.on("paint", (_event, _dirty, image) => {
    frame = image;
    frames++;
  });
  if (wc.isOffscreen()) wc.setFrameRate(30);
  const centre = (selector: string) =>
    js<{ x: number; y: number } | null>(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null; })()`,
    );
  /** Presses the mouse on one element, moves in steps, and releases on another. */
  const drag = async (from: string, to: string) => {
    const a = await centre(from);
    const b = await centre(to);
    check(!!a && !!b, `drag: missing ${a ? to : from}`);
    if (!a || !b) return;
    const at = (t: number) => ({
      x: Math.round(a.x + (b.x - a.x) * t),
      y: Math.round(a.y + (b.y - a.y) * t),
    });
    wc.sendInputEvent({ type: "mouseMove", ...a });
    wc.sendInputEvent({ type: "mouseDown", ...a, button: "left", clickCount: 1 });
    for (let i = 1; i <= 12; i++) {
      wc.sendInputEvent({ type: "mouseMove", ...at(i / 12), modifiers: ["leftbuttondown"] });
      await delay(16);
    }
    wc.sendInputEvent({ type: "mouseUp", ...b, button: "left", clickCount: 1 });
    await delay(300);
  };
  /** Sets a <select> the way React notices (native setter + change event). */
  const setSelect = async (selector: string, value: string) => {
    const ok = await js<boolean>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`,
    );
    check(ok, `select: no ${selector}`);
  };
  /** Focus + select the field, then type each chunk as a separate input event. */
  const type = async (selector: string, chunks: string[]) => {
    const found = await js<boolean>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); el.select?.(); return true; })()`,
    );
    check(found, `typing: no field ${selector}`);
    if (!found) return;
    for (const chunk of chunks) {
      if (chunk === "") await js("document.execCommand('delete')");
      else wc.insertText(chunk);
      await delay(120);
    }
  };
  const shot = async (name: string) => {
    const file = join(outDir, `${name}.png`);
    if (!wc.isOffscreen()) {
      writeFileSync(file, (await wc.capturePage()).toPNG());
    } else {
      await delay(100); // let React commit and React Flow settle before forcing the frame
      // Two forced frames: a frame already on its way when we start may still show the old state.
      for (let pass = 0; pass < 2; pass++) {
        const seen = frames;
        wc.invalidate();
        const deadline = Date.now() + 3000;
        while (frames === seen && Date.now() < deadline) await delay(20);
        if (frames === seen || !frame) {
          errors.push(`${name}: no frame was painted`);
          return;
        }
      }
      writeFileSync(file, (frame as NativeImage).toPNG());
    }
    screens.push({ name, file });
  };

  // IPC bridge, end to end: one built method must succeed, an unbuilt one must fail loudly.
  const info = await js<IpcResult<AppInfo>>(`window.reqflowBridge.invoke("reqflow:app.info")`);
  check(info?.ok === true, "app.info failed");
  // Check before any UI writes, not only before the Research slice. Never modify private app state.
  if (!info.ok || resolve(info.value.dataDir) !== resolve(join(outDir, "data"))) {
    throw new Error(
      "Smoke refused: runtime data must be isolated under the smoke output directory.",
    );
  }
  const unbuilt = await js<{ ok?: boolean; error?: { code?: string } }>(
    `window.reqflowBridge.invoke("reqflow:runs.get", "run_unbuilt")`,
  );
  check(
    unbuilt?.ok === false && !!unbuilt.error?.code,
    `runs.get should return a structured error, got ${JSON.stringify(unbuilt)}`,
  );
  const blocked = await js<string>(
    `window.reqflowBridge.invoke("not-a-channel").then(() => "allowed", () => "blocked")`,
  );
  check(blocked === "blocked", "preload allowed an unknown IPC channel");

  // Repeated smoke runs retain their isolated Settings history. Explicitly select
  // Mock before any analytical workflow, including after an interrupted provider check.
  await go("/settings");
  check(await click('[data-testid="settings-section-ai"]'), "settings: open offline AI setup");
  await delay(200);
  await setSelect("#llm-provider", "mock");
  await waitForLlm({ provider: "mock" });

  // Raw block end to end in the packaged code: import the synthetic samples, preview them over IPC
  // (CSV with German formatting, and an Excel workbook through the bundled reader).
  for (const [file, dataset, minRecords] of [
    ["equipment_take_rates.csv", "equipment_data", 17],
    ["customer_study.xlsx", "customer_study", 7],
  ] as const) {
    try {
      const info = await deps.files.importFile(join(deps.samplesDir, file));
      const params = {
        ...defaultBlockParams("raw"),
        dataset,
        file: { fileId: info.id, name: info.name },
      };
      const request = { kind: "raw", params, scope: DEFAULT_SETTINGS.defaultScope };
      const res = await js<{
        ok: boolean;
        value?: { outputs: { out: { records: unknown[] } } };
        error?: unknown;
      }>(`window.reqflowBridge.invoke("reqflow:blocks.preview", ${JSON.stringify(request)})`);
      const records = res.value?.outputs.out.records.length ?? 0;
      check(
        res.ok && records === minRecords,
        `raw preview of ${file}: ${JSON.stringify(res.error ?? records)}`,
      );
    } catch (err) {
      check(false, `raw preview of ${file} crashed: ${String(err)}`);
    }
  }

  // Real bundled PDF/OCR runtime; synthetic AI adapter, never a live provider or private document.
  const syntheticPdfPath = join(outDir, "synthetic-raw-equipment.pdf");
  const syntheticText =
    "Synthetic equipment: Heated seats are standard. Parking camera is optional.";
  writeFileSync(syntheticPdfPath, textPdf([{ lines: [syntheticText] }]));
  const pdfInfo = await deps.files.importFile(syntheticPdfPath);
  const pdfResult = await rawBlock.run(
    {},
    {
      ...defaultBlockParams("raw"),
      dataset: "equipment_data",
      file: { fileId: pdfInfo.id, name: pdfInfo.name },
    },
    {
      runId: "preview",
      blockId: "smoke-pdf",
      scope: DEFAULT_SETTINGS.defaultScope,
      settings: { ...DEFAULT_SETTINGS, llm: { ...DEFAULT_SETTINGS.llm, provider: "openai" } },
      llm: {
        async generateObject(request) {
          return {
            object: request.schema.parse({
              items: [
                {
                  title: "Synthetic equipment",
                  itemType: "note",
                  verbatimExcerpt: syntheticText,
                  cells: [],
                },
              ],
            }),
            model: "synthetic-smoke-adapter",
          };
        },
        async generateText() {
          throw new Error("Unused synthetic text adapter");
        },
      },
      agents: NO_AGENT_SERVICES,
      files: deps.files,
      web: null,
      audit: {
        async record(event) {
          return {
            ...event,
            id: "aud_smokepdf",
            at: new Date().toISOString(),
            changes: event.changes ?? [],
          };
        },
      },
      car: {
        async add() {
          throw new Error("Raw must not publish requirements");
        },
      },
      log: () => {},
      progress: () => {},
      signal: new AbortController().signal,
      resumed: false,
    },
  );
  check(
    pdfResult.status === "ok" && pdfResult.outputs.out?.records.length === 2,
    "raw PDF: structured item and original page retained",
  );
  const scan = await readPdf("synthetic-scan.pdf", await scannedPdf("BMW TEST OCR"));
  check(
    scan.pages[0]?.method === "ocr" && scan.pages[0].text.includes("BMW TEST OCR"),
    "raw PDF: real local bilingual OCR works in bundled runtime",
  );

  // Optional private BMW-file smoke is deliberately disabled: native smoke reads synthetic samples only.
  console.log("smoke: optional private BMW-file preview skipped (synthetic fixtures only)");

  // Start from a known theme (the default "system" follows the OS), dark mode comes last.
  await go("/settings");
  check(await click('[data-testid="settings-section-app"]'), "settings: open app appearance");
  await delay(200);
  check(await click('[data-testid="theme-light"]'), "settings: no light theme option");
  await delay(200);
  check(
    (await js<string | undefined>("document.documentElement.dataset.theme")) === "light",
    "settings: theme did not switch to light",
  );

  // 1. Every page renders.
  for (const route of SMOKE_ROUTES) {
    await go(route);
    check(!!(await text("h1")), `${route}: no <h1> rendered`);
    await shot(slug(route));
  }

  // 2. Data Flow: add one block of each kind, inspect, open an inner workplace and come back.
  await go("/dataflow");
  check(
    (await count('[data-testid="workplace-empty"]')) === 1,
    "dataflow: empty-state hint missing",
  );
  for (const kind of PALETTE_BLOCK_KINDS) {
    check(await click(`[data-testid="palette-item-${kind}"]`), `dataflow: no palette item ${kind}`);
    await delay(150);
  }
  await delay(500);
  const blockCount = await count(".react-flow__node");
  check(
    blockCount === PALETTE_BLOCK_KINDS.length,
    `dataflow: expected ${PALETTE_BLOCK_KINDS.length} blocks, got ${blockCount}`,
  );
  for (const kind of PALETTE_BLOCK_KINDS) {
    check((await count(`[data-testid="block-${kind}"]`)) === 1, `dataflow: block ${kind} missing`);
  }
  check((await count('[data-testid="inspector"]')) === 1, "dataflow: inspector not shown");
  await shot("dataflow-blocks");

  check(
    await click('[data-testid="block-research"] [data-testid="block-expand"]'),
    "dataflow: research block has no expand button",
  );
  await delay(600);
  const crumbs = await text('[data-testid="breadcrumb"]');
  check(/Research/.test(crumbs), `dataflow: breadcrumb should name Research, got "${crumbs}"`);
  check(
    (await count(".react-flow__node")) === 1 &&
      (await count('[data-testid="boundary-output"]')) === 1,
    "dataflow: Research's inner workplace should hold only its output",
  );
  await shot("dataflow-inner");
  check(await click('[data-testid="crumb-0"]'), "dataflow: no breadcrumb back to the top level");
  await delay(600);
  check(
    (await count(".react-flow__node")) === PALETTE_BLOCK_KINDS.length,
    "dataflow: blocks lost after leaving the inner workplace",
  );

  // 3. Typing, as a user does it: text arrives in chunks, and drafts must survive each commit
  //    (spaces between words, new lines in a list, an empty name while retyping).
  check(await click('[data-testid="block-ai_splitter"]'), "typing: can't select the splitter");
  await delay(300);
  const addBranch = () =>
    js<boolean>(`(() => {
    const button = [...document.querySelectorAll('[data-testid="inspector"] button')]
      .find((b) => b.textContent.trim() === '+ Add');
    if (!button) return false;
    button.click(); return true;
  })()`);
  for (let i = 3; i < 10; i++) {
    check(await addBranch(), "splitter: no add branch button");
    await delay(100);
  }
  check(
    (await count('[data-testid="block-ai_splitter"] .react-flow__handle.source')) === 10,
    "splitter: ten output handles expected",
  );
  check(
    await js<boolean>(`[...document.querySelectorAll('[data-testid="inspector"] button')]
    .find((b) => b.textContent.trim() === '+ Add')?.disabled === true`),
    "splitter: maximum ten branches must be enforced",
  );
  await shot("splitter-ten-outputs");
  await js(`document.querySelector('[data-testid="block-ai_splitter"]')
    .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
  await delay(600);
  check(
    (await count('[data-testid="boundary-input"]')) === 1 &&
      (await count('[data-testid="boundary-output"]')) === 10,
    "splitter: double-click should open one input and ten output boundaries",
  );
  await shot("splitter-inner-ten");
  check(await click('[data-testid="crumb-0"]'), "splitter: breadcrumb back missing");
  await delay(400);
  check(await click('[data-testid="block-ai_splitter"]'), "splitter: cannot reselect");
  await delay(200);
  for (let i = 10; i > 2; i--) {
    check(await click(`[aria-label="Remove entry ${i}"]`), "splitter: cannot remove branch");
    await delay(100);
  }
  check(
    (await count('[data-testid="block-ai_splitter"] .react-flow__handle.source')) === 2,
    "splitter: removing branches should update output handles",
  );
  check(
    await js<boolean>(`document.querySelector('[aria-label="Remove entry 1"]')?.disabled === true`),
    "splitter: minimum two branches must be enforced",
  );
  check(await click('[data-testid="inspector-open-inner"]'), "splitter: no inner workplace button");
  await delay(600);
  check(
    (await count('[data-testid="boundary-output"]')) === 2,
    "splitter: removed boundaries should disappear inside",
  );
  await shot("splitter-inner-two");
  check(await click('[data-testid="crumb-0"]'), "splitter: breadcrumb back missing");
  await delay(400);
  check(await click('[data-testid="block-ai_splitter"]'), "typing: can't reselect the splitter");
  await delay(200);
  await type('[aria-label="Branch name 1"]', ["Top ", "priority"]);
  check(
    (await text('[data-testid="block-ai_splitter"]')).includes("Top priority"),
    "typing: splitter branch should read 'Top priority'",
  );
  await type('[aria-label="Block name"]', ["Rank ", "by value"]);
  check(
    (await text('[data-testid="block-ai_splitter"]')).includes("Rank by value"),
    "typing: block should be renamed to 'Rank by value'",
  );
  await type('[aria-label="Block name"]', [""]);
  check(
    (await count('[data-testid="inspector"] [role="alert"]')) === 1,
    "typing: an empty block name should show an error",
  );
  await shot("dataflow-typing");

  // Connect ports by dragging with the mouse, like a user.
  check(await click('[aria-label="Close details"]'), "dataflow: inspector can't be closed");
  await delay(200);
  const handle = (kind: string, side: "source" | "target") =>
    `[data-testid="block-${kind}"] .react-flow__handle.${side}`;
  await drag(handle("raw", "source"), handle("ai_filter", "target"));
  await drag(handle("ai_filter", "source"), handle("custom", "target"));
  check((await count(".react-flow__edge")) === 2, "dataflow: dragging port to port should connect");
  await drag(handle("custom", "source"), handle("ai_filter", "target")); // would close a loop
  check((await count(".react-flow__edge")) === 2, "dataflow: a loop must be refused");
  await shot("dataflow-connected");

  // HIL review report: double-click the HIL block → lineage chart + data at this point.
  await drag(handle("custom", "source"), handle("hil", "target"));
  check((await count(".react-flow__edge")) === 3, "dataflow: custom → HIL should connect");
  await js(
    `document.querySelector('[data-testid="block-hil"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`,
  );
  await delay(600);
  check((await count('[data-testid="hil-report"]')) === 1, "report: double-click didn't open it");
  const steps = await count('[data-testid="hil-report"] [data-testid="lineage-step"]');
  check(steps === 4, `report: lineage should show raw → filter → custom → HIL, got ${steps} steps`);
  check((await count('[data-testid="data-empty"]')) === 1, "report: no-data state missing");
  check(
    (await count('[data-testid="data-sample"]')) === 0,
    "report: demo data must be gone (no synthetic sample button)",
  );
  await shot("hil-report");
  check(
    await click('[data-testid="lineage-step"][data-step-id^="raw-"] [data-testid="step-data"]'),
    "report: raw step has no data icon",
  );
  await delay(300);
  check(
    /Raw/.test(await text('[data-testid="data-panel"]')),
    "report: data panel should switch to the Raw step",
  );
  check(
    /Choose an Excel or CSV file/.test(await text('[data-testid="data-panel"]')),
    "report: a Raw step without a file should show the block's own error (real preview path)",
  );
  await shot("hil-report-raw");
  check(await click('[aria-label="Close report"]'), "report: no close button");
  await delay(300);
  check((await count('[data-testid="hil-report"]')) === 0, "report: didn't close");

  // Raw block with real data through the UI only: a SQLite source (the file dialog can't be scripted).
  const dbPath = join(outDir, "data", "smoke-feedback.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("DROP TABLE IF EXISTS feedback; CREATE TABLE feedback (market TEXT, comment TEXT)");
  db.exec(
    "INSERT INTO feedback VALUES ('DE', 'Im Fond ist es für Erwachsene zu eng'), ('GB', 'Rear legroom is too tight for adults'), ('FR', 'Le coffre est trop petit')",
  );
  db.exec(`DROP TABLE IF EXISTS review_feedback; CREATE TABLE review_feedback (id TEXT, comment TEXT);
    INSERT INTO review_feedback VALUES
    ('S1', 'Rear seats are uncomfortable every journey'),
    ('S2', 'I need better rear seat support daily'),
    ('S3', 'The infotainment screen is broken and needs a restart'),
    ('S4', 'I cannot use the infotainment screen'),
    ('S5', 'I like the rear seats'),
    ('S6', 'I want a bigger trunk');`);
  db.close();
  check(await click('[data-testid="block-raw"]'), "raw: can't select the Raw block");
  await delay(300);
  await setSelect('[data-testid="inspector"] select', "database");
  await delay(200);
  await type('input[placeholder="/path/to/data.sqlite"]', [dbPath]);
  await type('textarea[placeholder="SELECT * FROM customer_feedback"]', ["SELECT * FROM feedback"]);
  check(await click('[data-testid="preview-load"]'), "raw: no preview button");
  await delay(800);
  const counts = await text('[data-testid="preview-counts"]');
  check(/3 records/.test(counts), `raw: preview should read 3 records, got "${counts}"`);
  await shot("raw-preview");

  await setSelect('[data-testid="inspector"] select', "excel");
  await delay(200);
  deps.queuePick(syntheticPdfPath);
  const pickedPdf = await js<boolean>(`(() => {
    const button = [...document.querySelectorAll('[data-testid="inspector"] button')].find(el => el.textContent.trim() === "Choose file…");
    if (!button) return false; button.click(); return true;
  })()`);
  check(pickedPdf, "raw PDF: native file upload action exists");
  await delay(400);
  check(
    (await text('[data-testid="inspector"]')).includes("synthetic-raw-equipment.pdf"),
    "raw PDF: uploaded PDF displayed",
  );
  check(await click('[data-testid="preview-load"]'), "raw PDF: explicit preview action exists");
  await delay(400);
  check(
    (await text('[data-testid="inspector"]')).includes("offline mock"),
    "raw PDF: mock refuses to invent structured evidence",
  );
  await shot("raw-pdf-upload");
  await setSelect('[data-testid="inspector"] select', "database");
  await delay(200);
  check(await click('[data-testid="preview-load"]'), "raw: restore SQLite preview after PDF check");
  await delay(500);

  // The built splitter, real Raw reader, workflow executor and LLM settings over packaged IPC.
  let splitGraph: WorkflowGraph = {
    blocks: [
      createBlock("raw", { id: "smoke-raw", position: { x: 0, y: 0 } }),
      createBlock("ai_splitter", { id: "smoke-split", position: { x: 300, y: 0 } }),
    ],
    edges: [],
  };
  splitGraph = setBlockParams(splitGraph, "smoke-raw", {
    ...defaultBlockParams("raw"),
    source: "database",
    connection: dbPath,
    query: "SELECT * FROM feedback",
  }).graph;
  splitGraph = setBlockParams(splitGraph, "smoke-split", {
    ...defaultBlockParams("ai_splitter"),
    splitBy: "custom",
    branches: ["Adults", "Other"],
    instruction:
      "Route feedback explicitly mentioning adults to Adults; all other feedback to Other.",
  }).graph;
  splitGraph = connect(splitGraph, {
    source: "smoke-raw",
    sourcePort: "out",
    target: "smoke-split",
    targetPort: "in",
  });
  const splitWorkflow = await js<{ ok: boolean; value?: { id: string }; error?: unknown }>(
    `window.reqflowBridge.invoke("reqflow:workflows.save", ${JSON.stringify({
      ...splitGraph,
      name: "Synthetic splitter smoke",
      scope: DEFAULT_SETTINGS.defaultScope,
    })})`,
  );
  check(splitWorkflow.ok, `splitter: workflow save failed ${JSON.stringify(splitWorkflow.error)}`);
  if (splitWorkflow.value) {
    const started = await js<{ ok: boolean; value?: { id: string }; error?: unknown }>(
      `window.reqflowBridge.invoke("reqflow:runs.start", ${JSON.stringify(splitWorkflow.value.id)})`,
    );
    check(started.ok, `splitter: run start failed ${JSON.stringify(started.error)}`);
    if (started.value) {
      const runId = JSON.stringify(started.value.id);
      const deadline = Date.now() + 5000;
      let status = "running";
      while (status === "running" && Date.now() < deadline) {
        await delay(100);
        status = await js<string>(`window.reqflowBridge.invoke("reqflow:runs.get", ${runId})
          .then((r) => r.value?.status ?? "error")`);
      }
      check(status === "completed", `splitter: synthetic run ended ${status}`);
      const output = await js<{
        ok: boolean;
        value?: Record<string, { records: { id: string }[] }>;
        error?: unknown;
      }>(`window.reqflowBridge.invoke("reqflow:runs.blockOutput", ${runId}, "smoke-split")`);
      const ids = Object.values(output.value ?? {}).flatMap((data) =>
        data.records.map((record) => record.id),
      );
      check(
        output.ok &&
          Object.keys(output.value ?? {}).length === 2 &&
          ids.length === 3 &&
          new Set(ids).size === 3,
        `splitter: two outputs must route all three records exactly once ${JSON.stringify(output.error ?? ids.length)}`,
      );
    }
  }
  await js(
    `document.querySelector('[data-testid="block-hil"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`,
  );
  await delay(500);
  check(
    await click('[data-testid="lineage-step"][data-step-id^="raw-"] [data-testid="step-data"]'),
    "report: raw step has no data icon",
  );
  await delay(800);
  check(
    (await count('[data-testid="data-real"]')) === 1,
    "report: Raw step should show its real data",
  );
  check((await count('[data-testid="data-table"] tbody tr')) === 3, "report: 3 real rows expected");

  check(
    await click('[data-testid="sample-export-toggle"]'),
    "report: export sample panel not found",
  );
  await delay(300);
  await type('input[aria-label="Review objective"]', ["Synthetic format-check review"]);
  // Omit one of the three records, proving export selection is separate from displayed data.
  await js(
    `document.querySelectorAll('[data-testid="sample-item"][data-dataset="Records"]')[2]?.click()`,
  );
  await delay(100);
  check(
    (await js<number>(
      `document.querySelectorAll('[data-testid="sample-item"][data-dataset="Records"]:checked').length`,
    )) === 2,
    "report: record deselection failed",
  );
  await shot("hil-report-export-panel");
  check(await click('[data-testid="sample-export-pdf"]'), "report: export sample button not found");
  const pdfDeadline = Date.now() + 20_000;
  while (
    !(await text('[data-testid="sample-export-result"]')).startsWith("PDF saved:") &&
    Date.now() < pdfDeadline
  )
    await delay(100);
  check(
    (await text('[data-testid="sample-export-result"]')).startsWith("PDF saved:"),
    "report: PDF export did not complete successfully",
  );
  const pdfPath = join(outDir, "synthetic-report.pdf");
  check(existsSync(pdfPath), "report: PDF file was not created");
  if (existsSync(pdfPath)) {
    const pdfBuf = readFileSync(pdfPath);
    writeFileSync(join(outDir, "synthetic-format-report.pdf"), pdfBuf);
    check(
      pdfBuf.toString("ascii", 0, 5) === "%PDF-",
      "report: PDF file does not have valid header",
    );
  }
  await shot("hil-report-export-saved");
  await js('document.documentElement.dataset.theme = "dark"');
  await shot("hil-report-export-dark");
  await js('document.documentElement.dataset.theme = "light"');
  wc.enableDeviceEmulation({
    screenPosition: "desktop",
    screenSize: { width: 1024, height: 640 },
    viewPosition: { x: 0, y: 0 },
    viewSize: { width: 1024, height: 640 },
    deviceScaleFactor: 1,
    scale: 1,
  });
  await delay(200);
  check(
    (await js<number>("window.innerWidth")) === 1024,
    "report: minimum viewport emulation failed",
  );
  await shot("hil-report-export-minimum");
  wc.disableDeviceEmulation();

  // Exercise the richer brief with synthetic requirement/evidence fixtures, never app demo data.
  const selectedData = {
    sources: fixturePipelineData.sources.slice(0, 3),
    records: fixturePipelineData.records.slice(0, 3),
    findings: fixturePipelineData.findings.slice(0, 3),
    themes: fixturePipelineData.themes.slice(0, 3),
    requirements: fixturePipelineData.requirements.slice(0, 3),
  };
  const managementExport = await js<{ ok: boolean; error?: { message: string } }>(
    `window.reqflowBridge.invoke("reqflow:exports.hilReport", ${JSON.stringify({
      metadata: {
        scope: fixtureScope,
        gate: {
          label: "Synthetic cross-functional concept review",
          reviewer: "pm",
          approvalsNeeded: 1,
        },
        currentStep: { label: "Synthetic requirement sample", id: "synthetic-gate" },
        lineageSteps: [
          { id: "synthetic-gate", label: "Synthetic requirement sample", kind: "hil", path: [] },
        ],
        lineageLinks: [],
      },
      selectedData,
      fullCounts: {
        Sources: fixturePipelineData.sources.length,
        Records: fixturePipelineData.records.length,
        Findings: fixturePipelineData.findings.length,
        Themes: fixturePipelineData.themes.length,
        Requirements: fixturePipelineData.requirements.length,
      },
      notes: {
        objective: "Synthetic format validation, not product approval",
        owner: "PM and UX reviewers",
        nextCheckpoint: "Concept validation",
        openQuestions: "Resolve evidence conflicts before commitment",
      },
    })})`,
  );
  check(
    managementExport.ok,
    `report: synthetic management export failed ${managementExport.error?.message ?? ""}`,
  );
  if (managementExport.ok)
    writeFileSync(join(outDir, "synthetic-management-report.pdf"), readFileSync(pdfPath));

  await shot("hil-report-real");
  check(await click('[aria-label="Close report"]'), "report: no close button");
  await delay(300);

  // Analytical splitter → HIL through the actual editor/run store: graphics, evidence and correction.
  await js("void (window.confirm = () => true)");
  for (let i = 0; i < 30 && (await count('.react-flow__node [data-testid^="block-"]')); i++) {
    await click('.react-flow__node [data-testid^="block-"]');
    await delay(60);
    check(await click('[data-testid="inspector-delete"]'), "splitter report: cannot clear editor");
    await delay(60);
  }
  for (const kind of ["raw", "ai_splitter", "hil"] as const) {
    check(
      await click(`[data-testid="palette-item-${kind}"]`),
      `splitter report: cannot add ${kind}`,
    );
    await delay(150);
  }
  await click('[data-testid="block-raw"]');
  await delay(200);
  await setSelect('[data-testid="inspector"] select', "database");
  await type('input[placeholder="/path/to/data.sqlite"]', [dbPath]);
  await type('textarea[placeholder="SELECT * FROM customer_feedback"]', [
    "SELECT * FROM review_feedback",
  ]);
  await click('[data-testid="block-ai_splitter"]');
  await delay(200);
  await type('[data-testid="inspector"] input[type="number"]', ["5"]);
  await click('[aria-label="Close details"]');
  await delay(200);
  await drag(handle("raw", "source"), handle("ai_splitter", "target"));
  await drag(handle("ai_splitter", "source"), handle("hil", "target"));
  check(await click('[data-testid="flow-run"]'), "splitter report: cannot start editor flow");
  const reviewDeadline = Date.now() + 8000;
  while (
    !/Waiting for human review/i.test(await text('[data-testid="flow-run-status"]')) &&
    Date.now() < reviewDeadline
  )
    await delay(100);
  check(
    /Waiting for human review/i.test(await text('[data-testid="flow-run-status"]')),
    "splitter report: HIL did not pause",
  );
  const paused = await js<WorkflowRun | null>(
    `window.reqflowBridge.invoke("reqflow:runs.list").then(r => r.value?.find(run => run.status === "waiting_for_review") ?? null)`,
  );
  const analysis = paused?.blockRuns.find((br) => br.splitterReport)?.splitterReport;
  check(
    analysis?.assignments.length === 6 && analysis.branches.length === 5,
    "splitter report: six original rows and five priority bands expected",
  );
  check(
    analysis?.input.customerCount === null &&
      analysis.models.some((model) => model.startsWith("mock:")),
    "splitter report: unknown customers and mock provenance must remain explicit",
  );
  await click('[data-testid="block-ai_splitter"]');
  await delay(150);
  check(
    await click('[data-testid="inspector-open-splitter-report"]'),
    "splitter report: inspector entry missing",
  );
  await delay(650);
  check(
    (await count('[data-testid="splitter-report"]')) === 1,
    "splitter report: persisted analysis missing",
  );
  check(
    /Frequency contribution/.test(await text('[data-testid="splitter-report"]')),
    "splitter report: score decomposition missing",
  );
  await shot("splitter-demand-ranking");
  const analysisTab = (label: string) =>
    js<boolean>(
      `(() => { const button = [...document.querySelectorAll('[aria-label="Analysis views"] button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); button?.click(); return !!button; })()`,
    );
  check(await analysisTab("Source × need"), "splitter report: heatmap tab missing");
  await delay(250);
  check(
    (await count('[aria-label="Source by need evidence counts"]')) === 1,
    "splitter report: evidence heatmap missing",
  );
  await shot("splitter-source-heatmap");
  check(await analysisTab("Item routes"), "splitter report: item routes missing");
  await delay(150);
  check(
    await click('[data-testid="splitter-route"] summary'),
    "splitter report: route detail missing",
  );
  await delay(200);
  const displayedItemId = await js<string | null>(
    `document.querySelector('[data-testid="splitter-route"]')?.getAttribute('data-item-id') ?? null`,
  );
  const firstAssignment = analysis?.assignments.find((item) => item.itemId === displayedItemId);
  check(!!firstAssignment, "splitter report: displayed route not in saved assignments");
  const changedPort = firstAssignment?.outputPortId === "out-4" ? "out-0" : "out-4";
  await setSelect('[data-testid="splitter-route"] select', changedPort);
  await type('textarea[placeholder="Why is this evidence better routed to this output?"]', [
    "Synthetic PM review: use the selected branch for follow-up.",
  ]);
  check(
    await click('[data-testid="splitter-save-correction"]'),
    "splitter report: correction action missing",
  );
  await delay(650);
  if (paused && analysis && firstAssignment) {
    const corrected = await js<WorkflowRun>(
      `window.reqflowBridge.invoke("reqflow:runs.get", ${JSON.stringify(paused.id)}).then(r => r.value)`,
    );
    const report = corrected.blockRuns.find(
      (br) => br.blockId === analysis.blockId,
    )?.splitterReport;
    check(
      report?.reviews.length === 1 &&
        report.assignments.find((a) => a.itemId === firstAssignment.itemId)?.outputPortId ===
          changedPort,
      "splitter report: correction was not persisted",
    );
    check(
      report?.assignments.find((item) => item.itemId === firstAssignment.itemId)?.reason ===
        firstAssignment.reason,
      "splitter report: original AI interpretation was lost during human review",
    );
    const audit = await js<{ actor: { type: string }; action: string }[]>(
      `window.reqflowBridge.invoke("reqflow:audit.list", {runId: ${JSON.stringify(paused.id)}, action: "run.routing_reviewed"}).then(r => r.value)`,
    );
    check(
      audit.length === 1 && audit[0]?.actor.type === "human",
      "splitter report: human correction audit missing",
    );
  }
  await shot("splitter-human-routing-correction");
  check(
    await click('[data-testid="splitter-tab-data"]'),
    "splitter report: original-data tab missing",
  );
  await delay(300);
  await shot("splitter-original-evidence");
  await click('[aria-label="Close report"]');
  await js(
    `document.querySelector('[data-testid="block-hil"]').dispatchEvent(new MouseEvent("dblclick", {bubbles: true}))`,
  );
  await delay(450);
  check(
    await click('[data-testid="hil-open-upstream-report"]'),
    "HIL: upstream analysis entry missing",
  );
  await delay(250);
  check(
    (await count('[data-testid="splitter-report"]')) === 1,
    "HIL: cannot inspect saved splitter analysis",
  );
  await shot("hil-splitter-review");
  await click('[data-testid="report-data"]');
  await delay(450);
  check(
    await click('[data-testid="hil-review-confirm"]'),
    "HIL: explicit human continuation missing",
  );
  check(await click('[data-testid="hil-review-continue"]'), "HIL: continuation action missing");
  await delay(450);
  if (paused && analysis && firstAssignment) {
    const continued = await js<WorkflowRun>(
      `window.reqflowBridge.invoke("reqflow:runs.get", ${JSON.stringify(paused.id)}).then(r => r.value)`,
    );
    check(continued.status === "completed", "HIL: corrected run did not complete");
    const hil = continued.graph.blocks.find((block) => block.kind === "hil");
    const output = await js<Record<string, { records: { id: string }[] }>>(
      `window.reqflowBridge.invoke("reqflow:runs.blockOutput", ${JSON.stringify(paused.id)}, ${JSON.stringify(hil?.id)}).then(r => r.value)`,
    );
    const includesChanged = Object.values(output ?? {}).some((data) =>
      data.records.some((record) => record.id === firstAssignment.itemId),
    );
    check(
      includesChanged === (changedPort === "out-0"),
      "HIL: continuation consumed stale splitter routing",
    );
  }
  await click('[aria-label="Close report"]');
  await go("/settings");
  check(await click('[data-testid="settings-section-ai"]'), "settings: no ai section");
  await delay(200);
  await type('textarea[placeholder="One domain per line"]', ["a.example\n", "b.example"]);
  check(
    (await js<string>(
      `document.querySelector('textarea[placeholder="One domain per line"]').value`,
    )) === "a.example\nb.example",
    "typing: allowed domains should keep both lines",
  );

  // Real requirements for the car, made the way the app makes them: Raw → Add to Car on a small
  // synthetic feedback file (two topics, two comments each). No demo data is seeded any more.
  let carRequirements = 0;
  try {
    const csv = join(outDir, "car-feedback.csv");
    writeFileSync(
      csv,
      [
        "id,comment",
        "F1,The rear seats are uncomfortable on long journeys",
        "F2,The rear seats are uncomfortable and need better support",
        "F3,The infotainment screen is too slow and freezes often",
        "F4,The infotainment screen freezes and is too slow to respond",
      ].join("\n"),
    );
    const info = await deps.files.importFile(csv);
    let carGraph: WorkflowGraph = {
      blocks: [
        createBlock("raw", { id: "smoke-car-raw", position: { x: 0, y: 0 } }),
        createBlock("add_to_car", { id: "smoke-car", position: { x: 300, y: 0 } }),
      ],
      edges: [],
    };
    carGraph = setBlockParams(carGraph, "smoke-car-raw", {
      ...defaultBlockParams("raw"),
      dataset: "customer_feedback",
      file: { fileId: info.id, name: info.name },
    }).graph;
    carGraph = connect(carGraph, {
      source: "smoke-car-raw",
      sourcePort: "out",
      target: "smoke-car",
      targetPort: "in-0",
    });
    const saved = await js<{ ok: boolean; value?: { id: string }; error?: unknown }>(
      `window.reqflowBridge.invoke("reqflow:workflows.save", ${JSON.stringify({
        ...carGraph,
        name: "Synthetic feedback to car (smoke)",
        scope: DEFAULT_SETTINGS.defaultScope,
      })})`,
    );
    const started = saved.value
      ? await js<{ ok: boolean; value?: { id: string }; error?: unknown }>(
          `window.reqflowBridge.invoke("reqflow:runs.start", ${JSON.stringify(saved.value.id)})`,
        )
      : null;
    check(!!started?.ok, `car: feedback run didn't start ${JSON.stringify(started?.error)}`);
    if (started?.value) {
      const runId = JSON.stringify(started.value.id);
      let status = "running";
      for (const deadline = Date.now() + 10_000; status === "running" && Date.now() < deadline;) {
        await delay(100);
        status = await js<string>(`window.reqflowBridge.invoke("reqflow:runs.get", ${runId})
          .then((r) => r.value?.status ?? "error")`);
      }
      check(status === "completed", `car: feedback run ended ${status}`);
    }
    carRequirements = await js<number>(
      `window.reqflowBridge.invoke("reqflow:requirements.list").then((r) => r.value?.length ?? -1)`,
    );
    check(carRequirements >= 2, `car: the run should add ≥ 2 requirements, got ${carRequirements}`);
  } catch (err) {
    check(false, `car: making requirements crashed: ${String(err)}`);
  }

  // Car: the 3D car renders, parts are clickable (badge, list and a real click on the canvas),
  // and the classifier explains where each requirement went.
  await go("/car");
  for (let i = 0; i < 40 && (await count('[data-testid="car-canvas"]')) === 0; i++)
    await delay(100);
  check((await count('[data-testid="car-canvas"]')) === 1, "car: no 3D canvas");
  await delay(600);
  await shot("car-3d");
  check(
    (await count('[data-testid^="car-badge-"]')) === 0,
    "car: collapsed menus should have no points",
  );
  check(await click('[data-testid="car-part-group-exterior"] > summary'), "car: no exterior menu");
  await delay(300);
  check(
    (await count('[data-testid^="car-part-"]')) >= 30,
    "car: part index should list every part",
  );
  await delay(400);
  const internalBadges = [
    "front_seats",
    "rear_seats",
    "steering_wheel",
    "curved_display",
    "hud",
    "dashboard",
    "climate",
    "center_console",
    "sound_system",
    "ambient_light",
    "luggage",
    "drivetrain",
    "suspension",
  ]
    .map((id) => `[data-testid="car-badge-${id}"]`)
    .join(", ");
  const badgeVisible = (id: string) =>
    js<boolean>(
      `(() => { const el = document.querySelector('[data-testid="car-badge-${id}"]'); return !!el && getComputedStyle(el).visibility === "visible"; })()`,
    );
  check((await count(internalBadges)) === 0, "car: Exterior must hide all internal points");
  check(await badgeVisible("kidney_grille"), "car: visible front design should have a point");
  check(await click('[data-testid="car-badge-kidney_grille"]'), "car: no front-design point");
  await delay(400);
  check(
    (await text('[data-testid="car-part-title"]')) === "Kidney grille & front design",
    "car: exterior point should select the front design",
  );
  check(
    (await count('[data-testid="car-requirement"]')) >= 1 ||
      (await text('[data-testid="car-part-requirements"]')).includes(
        "No requirements from Add to Car on this part yet.",
      ),
    "car: front-design selection must show requirements or an explicit empty state",
  );
  await shot("car-exterior-points");
  check(await click('[data-testid="car-view-interior"]'), "car: no interior view");
  check(await click('[aria-label="Back to all parts"]'), "car: no back button");
  check(await click('[data-testid="car-part-group-interior"] > summary'), "car: no interior menu");
  await delay(1000);
  check(
    (await count('[data-testid^="car-badge-"]')) >= 4,
    "car: Interior should restore internal points",
  );
  check(await badgeVisible("rear_seats"), "car: Interior must show the rear-seat point");
  check(await click('[data-testid="car-badge-rear_seats"]'), "car: no badge on the rear seats");
  await delay(400);
  check(
    (await count('[data-testid="car-source-sample"]')) === 0,
    "car: demo data must be gone (no synthetic sample source)",
  );
  await delay(400);
  check((await count('[data-testid^="car-badge-"]')) >= 1, "car: requirements should badge parts");
  const badge = await js<string | null>(
    `document.querySelector('[data-testid^="car-badge-"]')?.dataset.testid ?? null`,
  );
  check(!!badge && (await click(`[data-testid="${badge}"]`)), "car: no badge to click");
  await delay(400);
  check(!!(await text('[data-testid="car-part-title"]')), "car: badge click should select a part");
  check(
    (await count('[data-testid="car-requirement"]')) >= 1,
    `car: the part behind ${badge} shows no requirement`,
  );
  check(
    await click('[data-testid="car-requirement"]'),
    "car: open compact requirement evidence detail",
  );
  for (
    let i = 0;
    i < 40 && (await count('[data-testid="car-requirement-full-details"]')) === 0;
    i++
  )
    await delay(100);
  check(
    (await text('[data-testid="car-classifier-reason"]')).length > 0,
    "car: classifier should explain itself",
  );
  await shot("car-part-selected");
  check(await click('[aria-label="Close requirement details"]'), "car: close requirement detail");
  check(await click('[data-testid="car-view-exterior"]'), "car: no exterior view");
  await delay(400);
  check(
    (await count(internalBadges)) === 0,
    "car: selection must not reveal internal points in Exterior",
  );
  await shot("car-exterior-selected-interior");
  for (const view of ["side", "rear", "top"]) {
    check(await click(`[data-testid="car-camera-${view}"]`), `car: no ${view} camera`);
    await delay(900);
    check((await count(internalBadges)) === 0, `car: ${view} Exterior must hide internal points`);
    if (view === "rear")
      check(
        !(await badgeVisible("kidney_grille")),
        "car: rear view must occlude the front-design point",
      );
    await shot(`car-${view}`);
  }
  check(await click('[data-testid="car-camera-side"]'), "car: no side camera");
  await delay(900);
  const canvas = await centre('[data-testid="car-canvas"]');
  if (canvas) {
    // A real click on the middle of the car (the side view puts a door there).
    const at = { x: canvas.x, y: canvas.y + 10 };
    wc.sendInputEvent({ type: "mouseMove", ...at });
    await delay(150);
    wc.sendInputEvent({ type: "mouseDown", ...at, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", ...at, button: "left", clickCount: 1 });
    await delay(400);
    const picked = await text('[data-testid="car-part-title"]');
    check(
      picked !== "" && picked !== "Rear seats",
      `car: clicking the 3D car selected "${picked}"`,
    );
    await shot("car-clicked");
  }
  check(await click('[data-testid="car-view-interior"]'), "car: no interior view");
  check(await click('[data-testid="car-camera-front"]'), "car: no front camera");
  await delay(900);
  await shot("car-interior");
  check(await click('[data-testid="car-view-exterior"]'), "car: no exterior view");
  await delay(300);

  // Car: the part behind a badge shows its requirements with confidence and a "Why?" button.
  check(
    await click('[data-testid="car-view-interior"]'),
    "car: restore interior for reasoning check",
  );
  await delay(1000);
  check(await click('[aria-label="Back to all parts"]'), "car: return to part index for reasoning");
  check(
    await click('[data-testid="car-part-rear_seats"]'),
    "car: select rear-seat requirements for reasoning",
  );
  await delay(400);
  check(
    (await count('[data-testid="car-requirement-confidence"]')) >= 1,
    "car: requirement should have confidence chip",
  );
  await shot("car-confidence");
  check(await click('[data-testid="car-requirement-why"]'), "car: no why button");
  for (let i = 0; i < 30 && (await count('[data-testid="reasoning-view"]')) === 0; i++)
    await delay(100);
  check((await count('[data-testid="reasoning-view"]')) >= 1, "car: reasoning view didn't open");
  check(
    (await count('[data-testid="reasoning-requirement"]')) >= 1,
    "car: the thought process lists no requirement",
  );
  await delay(500);
  await shot("reasoning-requirement");
  check(await click('[aria-label="Close thought process"]'), "car: no reasoning close button");
  await delay(300);

  // Data Flow, as a user would: load a template, choose its file, start, pass the HIL review,
  // then open the Add to Car block's thought process of that run.
  await go("/dataflow");
  await js("window.confirm = () => true; true"); // replacing the current flow asks first
  check(await click('[data-testid="sidebar-mode-templates"]'), "dataflow: no templates tab");
  for (let i = 0; i < 30 && (await count('[data-testid="workflow-template"]')) === 0; i++)
    await delay(100);
  const loaded = await js<boolean>(`(() => {
    const cards = [...document.querySelectorAll('[data-testid="workflow-template"]')];
    const i = cards.findIndex((c) => c.querySelector("h3")?.textContent === "Feedback to requirements");
    const use = i < 0 ? null : document.querySelector('[data-testid="template-use-' + i + '"]');
    use?.click();
    return !!use;
  })()`);
  check(loaded, "dataflow: no 'Feedback to requirements' template");
  await delay(600);
  check(await click('[data-testid="block-raw"]'), "dataflow: the template has no Raw block");
  await delay(300);
  deps.queuePick(join(outDir, "car-feedback.csv"));
  const chose = await js<boolean>(`(() => {
    const b = [...document.querySelectorAll('[data-testid="inspector"] button')]
      .find((e) => e.textContent.trim() === "Choose file…");
    b?.click();
    return !!b;
  })()`);
  check(chose, "dataflow: the Raw block has no file button");
  for (
    let i = 0;
    i < 30 && !(await text('[data-testid="inspector"]')).includes("car-feedback.csv");
    i++
  )
    await delay(100);
  check(await click('[data-testid="flow-run"]'), "dataflow: no Start button");
  for (let i = 0; i < 150 && (await count('[data-testid="flow-review"]')) === 0; i++)
    await delay(100);
  check(await click('[data-testid="flow-review"]'), "dataflow: the run didn't wait for review");
  for (
    let i = 0;
    i < 100 &&
    !(await js<boolean>(
      `!!document.querySelector('[data-testid="hil-review-confirm"]') && !document.querySelector('[data-testid="hil-review-confirm"]').disabled`,
    ));
    i++
  )
    await delay(100);
  check(await click('[data-testid="hil-review-confirm"]'), "dataflow: no review confirmation");
  check(await click('[data-testid="hil-review-continue"]'), "dataflow: no Continue button");
  for (
    let i = 0;
    i < 200 && !(await text('[data-testid="flow-run-status"]')).includes("Completed");
    i++
  )
    await delay(100);
  check(
    (await text('[data-testid="flow-run-status"]')).includes("Completed"),
    `dataflow: the editor run ended "${await text('[data-testid="flow-run-status"]')}"`,
  );
  await click('[aria-label="Close report"]');
  await delay(300);
  check(await click('[data-testid="block-reasoning"]'), "dataflow: no block-reasoning button");
  for (let i = 0; i < 30 && (await count('[data-testid="reasoning-view"]')) === 0; i++)
    await delay(100);
  check(
    (await count('[data-testid="reasoning-view"]')) >= 1,
    "dataflow: block reasoning view didn't open",
  );
  check(
    (await count('[data-testid="reasoning-step"]')) >= 4,
    "dataflow: the thought process should show the agents' steps",
  );
  await delay(500); // let the off-screen view paint the loaded trace
  await shot("reasoning-block");
  check(await click('[data-testid="reasoning-step"]'), "dataflow: steps should be clickable");
  await delay(200);
  await shot("reasoning-block-step");
  check(await click('[aria-label="Close thought process"]'), "dataflow: no reasoning close button");
  await delay(300);

  // Analytics, as a user would: the "Compare feedback sources" template, two synthetic feedback
  // files, then the block opens full screen and every tab renders. Counting is rules only (no AI).
  try {
    const second = join(outDir, "analytics-feedback-b.csv");
    const countries = ["DE", "FR", "GB", "IT", "US", "CN"];
    const comments = [
      "The seat is uncomfortable on long trips and the lumbar support is weak.",
      "Great navigation, but the screen freezes after the update.",
      "Wind noise above 120 km/h is annoying.",
      "Please add wireless Apple CarPlay.",
      "Love the design and the comfortable seats.",
      "The range in winter is disappointing and charging takes too long.",
      "Excellent handling and precise steering.",
      "The trunk is too small for a family.",
    ];
    writeFileSync(
      second,
      [
        "id,date,country,feedback type,comment",
        ...Array.from({ length: 40 }, (_, i) => {
          const month = String((i % 12) + 1).padStart(2, "0");
          const type = i % 3 === 0 ? "Praise" : i % 3 === 1 ? "Complaint" : "Suggestion";
          return `S${i + 1},${2025 + (i % 2)}-${month}-${String((i % 27) + 1).padStart(2, "0")},${countries[i % countries.length]},${type},"${comments[i % comments.length]}"`;
        }),
      ].join("\n"),
    );
    await go("/dataflow");
    await js("window.confirm = () => true; true");
    check(await click('[data-testid="sidebar-mode-templates"]'), "analytics: no templates tab");
    for (let i = 0; i < 30 && (await count('[data-testid="workflow-template"]')) === 0; i++)
      await delay(100);
    const usedTemplate = await js<boolean>(`(() => {
      const cards = [...document.querySelectorAll('[data-testid="workflow-template"]')];
      const i = cards.findIndex((c) => c.querySelector("h3")?.textContent === "Compare feedback sources");
      const use = i < 0 ? null : document.querySelector('[data-testid="template-use-' + i + '"]');
      use?.click();
      return !!use;
    })()`);
    check(usedTemplate, "analytics: no 'Compare feedback sources' template");
    await delay(600);
    check(
      (await count('[data-testid="block-analytics"]')) === 1,
      "analytics: template has no block",
    );
    for (const [index, file] of [
      [0, join(deps.samplesDir, "customer_feedback.csv")],
      [1, second],
    ] as const) {
      await js(`document.querySelectorAll('[data-testid="block-raw"]')[${index}]?.click(); true`);
      await delay(300);
      deps.queuePick(file);
      const chose = await js<boolean>(`(() => {
        const b = [...document.querySelectorAll('[data-testid="inspector"] button')]
          .find((e) => e.textContent.trim() === "Choose file…");
        b?.click();
        return !!b;
      })()`);
      check(chose, `analytics: Raw block ${index + 1} has no file button`);
      const name = file.split(/[\\/]/).pop()!;
      for (let i = 0; i < 30 && !(await text('[data-testid="inspector"]')).includes(name); i++)
        await delay(100);
    }
    await shot("analytics-editor");
    check(await click('[data-testid="analytics-open"]'), "analytics: no analytics button");
    for (
      let i = 0;
      i < 100 &&
      ((await count('[data-testid="analytics-view"]')) === 0 ||
        (await count('[data-testid="analytics-loading"]')) > 0);
      i++
    )
      await delay(100);
    check((await count('[data-testid="analytics-view"]')) === 1, "analytics: view didn't open");
    const inputsText = await text('[data-testid="analytics-inputs"]');
    check(
      /Feedback A\s*35 records/.test(inputsText) && /Feedback B\s*40 records/.test(inputsText),
      `analytics: inputs should read 35 and 40 records, got "${inputsText}"`,
    );
    check(
      (await js<boolean>(
        `(() => { const r = document.querySelector('[data-testid="analytics-view"]').getBoundingClientRect(); return r.left === 0 && r.top === 0 && r.width === window.innerWidth && r.height === window.innerHeight; })()`,
      )) === true,
      "analytics: the view should fill the whole window",
    );
    check(
      (await count('[data-testid="kpi-records"]')) === 1 &&
        (await text('[data-testid="kpi-records"]')).includes("75"),
      "analytics: overview should count 75 records",
    );
    await delay(400);
    await shot("analytics-overview");
    for (const tab of ["countries", "timeline", "voice", "topics", "compare", "flow", "quality"]) {
      check(await click(`[data-testid="analytics-tab-${tab}"]`), `analytics: no ${tab} tab`);
      await delay(400);
      check(
        (await count(`[data-testid="analytics-${tab}"]`)) === 1,
        `analytics: ${tab} tab didn't render`,
      );
      if (tab === "voice") {
        await type('[data-testid="voice-phrase-input"]', ["seat*"]);
        check(await click('[data-testid="voice-phrase-add"]'), "analytics: no Track button");
        await delay(500);
        check(
          (await count('[data-testid="chart-voice-quotes"] li')) > 0,
          "analytics: a tracked phrase should show verbatim quotes",
        );
      }
      if (tab === "flow") {
        check(
          (await count('[data-testid="chart-flow"] svg')) >= 1,
          "analytics: the flow chart should render",
        );
      }
      await shot(`analytics-${tab}`);
    }
    await js(`document.documentElement.dataset.theme = "dark"; true`);
    await click('[data-testid="analytics-tab-overview"]');
    await delay(400);
    await shot("analytics-overview-dark");
    await click('[data-testid="analytics-tab-compare"]');
    await delay(400);
    await shot("analytics-compare-dark");
    await js(`document.documentElement.dataset.theme = "light"; true`);
    check(await click('[data-testid="analytics-close"]'), "analytics: no close button");
    await delay(300);
    check((await count('[data-testid="analytics-view"]')) === 0, "analytics: didn't close");
  } catch (err) {
    check(false, `analytics: crashed: ${String(err)}`);
  }

  // Settings -> AI API setups
  await go("/settings");
  check(await click('[data-testid="settings-section-ai"]'), "settings: no AI section");
  await delay(300);
  check(await click('[data-testid="settings-add-setup"]'), "settings: no add setup button");
  await delay(200);
  await shot("settings-api-setups");
  await js(`document.querySelector('[data-testid="settings-content"]').scrollTop = 900; true`);
  await delay(300);
  await shot("settings-agents");
  check(await click('[data-testid^="settings-delete-setup-"]'), "settings: no delete setup button");
  await delay(200);

  // Go back to car for reset
  await go("/car");
  await delay(600);

  // Reset: asks in place, removes every requirement, and the car is empty afterwards.
  // Reset stays disabled until the page has loaded its requirements: wait for that, not a fixed delay.
  for (
    let i = 0;
    i < 50 &&
    (await js<boolean>(`!!document.querySelector('[data-testid="car-reset"]')?.disabled`));
    i++
  )
    await delay(100);
  check(await click('[data-testid="car-reset"]'), "car: no reset button");
  await delay(200);
  check((await count('[data-testid="car-reset-confirm"]')) === 1, "car: reset didn't ask first");
  await shot("car-reset-confirm");
  check(await click('[data-testid="car-reset-confirm-button"]'), "car: no confirm button");
  await delay(600);
  check(
    (await text('[data-testid="car-reset-message"]')).startsWith("Removed "),
    "car: reset should report what it removed",
  );
  check(
    (await count('[data-testid="car-requirement"]')) === 0,
    "car: requirement cards left after reset",
  );
  const left = await js<number>(
    `window.reqflowBridge.invoke("reqflow:requirements.list").then((r) => r.value?.length ?? -1)`,
  );
  check(left === 0, `car: ${left} requirements left after reset`);
  const deleted = await js<number>(
    `window.reqflowBridge.invoke("reqflow:audit.list", { action: "requirement.deleted" })
      .then((r) => r.value?.length ?? -1)`,
  );
  check(deleted >= carRequirements, "car: reset should audit every removed requirement");
  check(
    await js<boolean>(`document.querySelector('[data-testid="car-reset"]').disabled`),
    "car: reset should be disabled when there is nothing to remove",
  );
  await shot("car-after-reset");

  // 4. Settings: every section, then dark mode across pages.
  await go("/settings");
  for (const id of SETTINGS_SECTIONS) {
    check(await click(`[data-testid="settings-section-${id}"]`), `settings: no section ${id}`);
    await delay(300);
    if (id === "research-apis") {
      check(
        await js<boolean>(
          `[...document.querySelectorAll('input[type="password"]')].every(input => input.value === '')`,
        ),
        "settings: Research API credential inputs must stay empty",
      );
    }
    await shot(`settings-${id}`);
  }
  check(await click('[data-testid="settings-section-ai"]'), "settings: reopen AI section");
  await delay(200);
  const liveModels: Record<"openai" | "google", { quality: string; fast: string }> = {
    openai: {
      quality: "gpt-smoke-private-quality",
      fast: "gpt-smoke-private-fast",
    },
    google: {
      quality: "gemini-smoke-private-quality",
      fast: "gemini-smoke-private-fast",
    },
  };
  const checkModelSelection = async (
    provider: "openai" | "google",
    expected = LLM_MODEL_DEFAULTS[provider],
  ) => {
    const llm = await waitForLlm({ provider, ...expected });
    const selection = await js<{
      qualityPreset: string;
      fastPreset: string;
      qualityCustom: string;
      fastCustom: string;
    }>(`({
      qualityPreset: document.querySelector('#llm-quality-preset')?.value ?? '',
      fastPreset: document.querySelector('#llm-fast-preset')?.value ?? '',
      qualityCustom: document.querySelector('#llm-quality-custom')?.value ?? '',
      fastCustom: document.querySelector('#llm-fast-custom')?.value ?? '',
    })`);
    check(
      llm.provider === provider &&
        llm.model === expected.model &&
        llm.fastModel === expected.fastModel &&
        selection.qualityPreset ===
          (expected.model === LLM_MODEL_DEFAULTS[provider].model ? expected.model : "custom") &&
        selection.fastPreset ===
          (expected.fastModel === LLM_MODEL_DEFAULTS[provider].fastModel
            ? expected.fastModel
            : "custom") &&
        (selection.qualityPreset !== "custom" || selection.qualityCustom === expected.model) &&
        (selection.fastPreset !== "custom" || selection.fastCustom === expected.fastModel),
      `settings: ${provider} quality and fast model controls match persisted IDs`,
    );
    return llm;
  };
  for (const provider of ["openai", "google"] as const) {
    check(
      await (async () => {
        await setSelect("#llm-provider", provider);
        await delay(150);
        // A repeated smoke run may remember its previous custom profile. Select the
        // presets explicitly through the GUI before checking persistence.
        await setSelect("#llm-quality-preset", LLM_MODEL_DEFAULTS[provider].model);
        await setSelect("#llm-fast-preset", LLM_MODEL_DEFAULTS[provider].fastModel);
        const llm = await checkModelSelection(provider);
        const passwordsEmpty = await js<boolean>(
          `[...document.querySelectorAll('input[type="password"]')].every(input => input.value === '')`,
        );
        check(passwordsEmpty, `settings: ${provider} API key remains empty`);
        return llm.provider === provider;
      })(),
      `settings: select ${provider}`,
    );
    await shot(provider === "openai" ? "settings-ai-openai" : "settings-ai-google");
    await setSelect("#llm-quality-preset", "custom");
    await setSelect("#llm-fast-preset", "custom");
    await delay(100);
    await type("#llm-quality-custom", [liveModels[provider].quality]);
    await type("#llm-fast-custom", [liveModels[provider].fast]);
    const llm = await waitForLlm({
      provider,
      model: liveModels[provider].quality,
      fastModel: liveModels[provider].fast,
    });
    check(
      llm.provider === provider &&
        llm.model === liveModels[provider].quality &&
        llm.fastModel === liveModels[provider].fast,
      `settings: ${provider} custom quality and fast model IDs persist without a credential`,
    );
  }
  await setSelect("#llm-provider", "openai");
  await delay(350);
  await checkModelSelection("openai", {
    model: liveModels.openai.quality,
    fastModel: liveModels.openai.fast,
  });
  await setSelect("#llm-provider", "google");
  await delay(350);
  await checkModelSelection("google", {
    model: liveModels.google.quality,
    fastModel: liveModels.google.fast,
  });
  const rememberedGoogle = await llmSettings();
  check(
    rememberedGoogle.modelProfiles?.google?.model === liveModels.google.quality,
    "settings: Google Gemini custom IDs remain in the provider profile",
  );
  await setSelect("#llm-provider", "mock");
  check(
    (await waitForLlm({ provider: "mock" })).provider === "mock",
    "settings: restore offline Mock before workflow run",
  );

  // Model selection is saved through IPC, survives a renderer reload, and changes only the concept.
  const modelSettings = await js<{ ok: boolean; value?: typeof DEFAULT_SETTINGS }>(
    'window.reqflowBridge.invoke("reqflow:settings.get")',
  );
  const modelRequirements = await js<{ ok: boolean; value?: unknown[] }>(
    'window.reqflowBridge.invoke("reqflow:requirements.list")',
  );
  for (const powertrain of CarPowertrain.options) {
    await go("/settings");
    check(await click('[data-testid="settings-section-model"]'), "settings: no model section");
    check(await click(`[data-testid="model-${powertrain}"]`), `settings: no ${powertrain} model`);
    await delay(700);
    check(
      await js<boolean>(
        `document.querySelector('[data-testid="model-${powertrain}"]')?.getAttribute("aria-pressed") === "true"`,
      ),
      `settings: ${powertrain} not selected`,
    );
    const stored = await js<{ ok: boolean; value?: typeof DEFAULT_SETTINGS }>(
      'window.reqflowBridge.invoke("reqflow:settings.get")',
    );
    check(
      stored.ok && stored.value?.model.powertrain === powertrain,
      `settings: ${powertrain} was not saved`,
    );
    check(
      JSON.stringify(stored.value?.defaultScope) ===
        JSON.stringify(modelSettings.value?.defaultScope),
      "model: vehicle scope changed",
    );
    await go("/car");
    const loaded = new Promise<void>((resolve) => wc.once("did-finish-load", () => resolve()));
    wc.reload();
    await loaded;
    await delay(900);
    check(
      await js<boolean>(
        `document.querySelector('[data-testid="car-viewer"]')?.getAttribute("data-powertrain") === ${JSON.stringify(powertrain === "hydrogen" ? "h2" : powertrain === "fuel" ? "gasoline" : powertrain)}`,
      ),
      `car: ${powertrain} did not survive reload`,
    );
    check((await count('[data-testid="car-canvas"]')) === 1, `car: ${powertrain} canvas missing`);
    await shot(`car-model-${powertrain}-exterior`);
    check(
      await click('[data-testid="car-part-group-technology"] > summary'),
      `car: no ${powertrain} technology menu`,
    );
    check(
      await click('[data-testid="car-part-subclass-power_chassis"] > summary'),
      `car: no ${powertrain} powertrain menu`,
    );
    await delay(300);
    const requiredPart =
      powertrain === "hydrogen"
        ? "fuel_cell"
        : powertrain === "electric"
          ? "battery_pack"
          : "fuel_system";
    check(
      (await count(`[data-testid="car-badge-${requiredPart}"]`)) === 1,
      `car: ${powertrain} ${requiredPart} marker missing`,
    );
    check(await click('[data-testid="car-camera-top"]'), "car: no model top camera");
    await delay(900);
    await shot(`car-model-${powertrain}-powertrain`);
    check(
      await click(`[data-testid="car-part-${requiredPart}"]`),
      `car: ${powertrain} part selection missing`,
    );
    await delay(300);
    check(
      (await text('[data-testid="car-part-title"]')).length > 0,
      `car: ${powertrain} selected part missing`,
    );
    await shot(`car-model-${powertrain}-selected`);
    const after = await js<{ ok: boolean; value?: unknown[] }>(
      'window.reqflowBridge.invoke("reqflow:requirements.list")',
    );
    check(
      after.ok && JSON.stringify(after.value) === JSON.stringify(modelRequirements.value),
      "model: requirements changed",
    );
  }
  await go("/settings");
  check(await click('[data-testid="settings-section-model"]'), "settings: no model reset section");
  check(await click('[data-testid="model-electric"]'), "settings: cannot restore default model");
  await delay(700);
  check(
    await click('[data-testid="settings-section-model-switcher"]'),
    "settings: open catalog switcher",
  );
  const catalogIds = await js<string[]>(
    `[...document.querySelectorAll('[data-testid^="model-card-"]')].map(card => card.dataset.testid.slice('model-card-'.length))`,
  );
  check(catalogIds.length === 105, "settings: all 105 catalog models available");
  for (const modelId of [catalogIds[1], catalogIds[0]]) {
    if (!modelId) continue;
    await go("/settings");
    check(
      await click('[data-testid="settings-section-model-switcher"]'),
      "settings: reopen catalog switcher",
    );
    check(await click(`[data-testid="model-card-${modelId}"]`), "settings: select catalog model");
    await go("/car");
    await delay(1000);
    check(
      await js<boolean>(
        `document.querySelector('[data-testid="car-viewer"]')?.dataset.modelId === ${JSON.stringify(modelId)}`,
      ),
      "car: selected catalog model reaches viewer",
    );
    check(
      (await count('[data-testid="car-canvas"]')) === 1,
      "car: catalog switch retains one canvas",
    );
    const stored = await invoke("settings", "get");
    const requirements = await invoke("requirements", "list");
    check(
      JSON.stringify(stored.defaultScope) === JSON.stringify(modelSettings.value?.defaultScope),
      "catalog: requirement scope unchanged",
    );
    check(
      JSON.stringify(requirements) === JSON.stringify(modelRequirements.value),
      "catalog: requirement decisions unchanged",
    );
    await shot(modelId === catalogIds[0] ? "car-catalog-restored" : "car-catalog-selected");
  }
  await go("/settings");
  check(await click('[data-testid="settings-section-app"]'), "settings: no app section");
  await delay(200);
  check(await click('[data-testid="theme-dark"]'), "settings: no dark theme option");
  await delay(300);
  check(
    (await js<string | undefined>("document.documentElement.dataset.theme")) === "dark",
    "settings: theme did not switch to dark",
  );
  await shot("settings-dark");
  for (const route of ["/dataflow", "/car"]) {
    await go(route);
    if (route === "/car") {
      check(
        await click('[data-testid="car-part-group-exterior"] > summary'),
        "car: no dark exterior menu",
      );
      for (let i = 0; i < 40 && !(await badgeVisible("kidney_grille")); i++) await delay(100);
      check((await count(internalBadges)) === 0, "car: dark Exterior must hide internal points");
      check(await badgeVisible("kidney_grille"), "car: dark Exterior must retain visible points");
    }
    await shot(`${slug(route)}-dark`);
  }
  check(await click('[data-testid="car-view-interior"]'), "car: no dark interior view");
  check(
    await click('[data-testid="car-part-group-interior"] > summary'),
    "car: no dark interior menu",
  );
  await delay(400);
  check(await badgeVisible("rear_seats"), "car: dark Interior must restore internal points");
  await shot("car-interior-dark");
  check(await click('[data-testid="car-view-exterior"]'), "car: no dark exterior view");
  await delay(400);
  check((await count(internalBadges)) === 0, "car: dark Exterior must hide internal points again");

  // 5. One final offline slice through the real renderer, preload, main runtime, Worker and disk.
  // Only dialog selections are substituted by main/index.ts. No provider, bridge or parser is faked.
  const nativeResearch = {
    ok: false,
    mode: "offline-local-original-xlsx",
    syntheticInput: true,
    liveProvidersTested: false,
    checks: [] as { name: string; ok: boolean }[],
    runId: null as string | null,
    nativeWorker: {
      entry: join(
        __dirname.replace(/app\.asar(?=[\\/])/, "app.asar.unpacked"),
        "research-xlsx-worker.js",
      ),
      threadId: null as number | null,
      parsedInput: false,
    },
    sources: 0,
    rawRecords: 0,
    independentOpinions: 0,
    associationRows: 0,
    requests: 0,
    collectionStatuses: [] as { agentId: string; status: string }[],
    exports: [] as string[],
  };
  const ensure: SmokeAssertion = (condition, name) => {
    nativeResearch.checks.push({ name, ok: !!condition });
    if (!condition) throw new Error(name);
  };
  const waitFor = async (name: string, predicate: () => Promise<boolean>, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await delay(100);
    }
    throw new Error(`Timed out waiting for ${name}`);
  };
  const clickButton = (scope: string, label: string) =>
    js<boolean>(`(() => {
      const button = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})]
        .find(el => el.textContent.trim() === ${JSON.stringify(label)});
      if (!button || button.disabled) return false;
      button.scrollIntoView({ block: 'nearest' }); button.click(); return true;
    })()`);
  const fieldSelector = async (label: string) => {
    const id = await js<string | null>(`(() => {
      const label = [...document.querySelectorAll('[data-testid="inspector"] label')]
        .find(el => el.textContent.trim() === ${JSON.stringify(label)});
      return label?.htmlFor || null;
    })()`);
    ensure(id, `Research inspector field: ${label}`);
    return `[id=${JSON.stringify(id)}]`;
  };
  // Node emits this event for real Worker construction. Require a successful parse of our workbook,
  // not merely the presence of a bundled worker file or a successful inline parser fallback.
  const onWorker = (worker: Worker) => {
    const threadId = worker.threadId;
    worker.on("message", (reply: unknown) => {
      const message = reply as {
        ok?: boolean;
        workbook?: {
          sheets?: { name: string; columnCount: number; rows: { cells: { value: unknown }[] }[] }[];
        };
      } | null;
      if (
        message?.ok === true &&
        message.workbook?.sheets?.some(
          (sheet) =>
            sheet.name === "Feedback_Explorer" &&
            sheet.columnCount === 12 &&
            sheet.rows.some((row) => row.cells.some((cell) => cell.value === SYNTHETIC_FEEDBACK)),
        )
      ) {
        nativeResearch.nativeWorker.threadId = threadId;
        nativeResearch.nativeWorker.parsedInput = true;
      }
    });
  };
  try {
    ensure(
      info.ok && resolve(info.value.dataDir) === resolve(join(outDir, "data")),
      "runtime data directory is isolated under smoke output",
    );
    const dataDir = info.value.dataDir;
    const secrets = await invoke("settings", "secrets");
    ensure(
      [...SECRET_NAMES.map((name) => secrets[name]), ...Object.values(secrets.setups ?? {})].every(
        (status) => !status.configured && status.source === null,
      ),
      "no saved or environment credentials used",
    );
    ensure(existsSync(nativeResearch.nativeWorker.entry), "bundled native XLSX worker exists");
    await writeSmokeResearchFixture(outDir);

    // Use app settings and ordinary parameter controls; never reach into React/Zustand internals.
    await go("/settings");
    ensure(
      await click('[data-testid="settings-section-app"]'),
      "open App settings for safe deletion",
    );
    await delay(200);
    const confirmation = '[role="switch"][aria-label="Ask before deleting blocks"]';
    if (
      await js<boolean>(
        `document.querySelector(${JSON.stringify(confirmation)})?.getAttribute('aria-checked') === 'true'`,
      )
    ) {
      ensure(await click(confirmation), "disable deletion dialogs through App settings");
    }
    ensure(await click('[data-testid="settings-section-ai"]'), "open offline AI settings");
    await delay(200);
    ensure(
      await js<boolean>(`(() => {
        const select = document.getElementById('web-research-provider');
        if (!select) return false;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'off');
        select.dispatchEvent(new Event('change', { bubbles: true })); return true;
      })()`),
      "turn web research off through Settings",
    );
    // The earlier typing regression deliberately entered example domains. Remove them before running.
    await type('textarea[placeholder="One domain per line"]', [""]);
    await waitFor("offline settings to persist", async () => {
      const settings = Settings.parse(await invoke("settings", "get"));
      return settings.research.provider === "off" && settings.research.allowedDomains.length === 0;
    });
    const providers = await invoke("research", "providers");
    for (const provider of providers) {
      await invoke("research", "configure", provider.id, {
        ...provider.config,
        enabled: provider.id === "local_documents",
        approval: "not_granted",
        allowedActors: [],
      });
    }
    const offline = Settings.parse(await invoke("settings", "get"));
    ensure(
      offline.research.provider === "off" &&
        Object.entries(offline.research.apis).every(
          ([id, config]) => config.enabled === (id === "local_documents"),
        ),
      "all network providers disabled; only local document collection enabled",
    );

    await go("/dataflow");
    for (const kind of PALETTE_BLOCK_KINDS) {
      // Earlier scenarios replace the canvas; remove its actual blocks, including duplicates.
      let remaining = await count(`[data-testid="block-${kind}"]`);
      while (remaining > 0) {
        ensure(await click(`[data-testid="block-${kind}"]`), `select existing ${kind} block`);
        await delay(100);
        ensure(
          await click('[data-testid="inspector-delete"]'),
          `delete existing ${kind} through Inspector`,
        );
        await delay(100);
        const next = await count(`[data-testid="block-${kind}"]`);
        ensure(next < remaining, `deletion removes the selected ${kind} block`);
        remaining = next;
      }
    }
    ensure((await count(".react-flow__node")) === 0, "all earlier blocks deleted through UI");
    ensure(
      await click('[data-testid="palette-item-research"]'),
      "add isolated Research from palette",
    );
    await delay(300);
    const agentsSelector = await fieldSelector("Research agents");
    const initialAgents = await js<{ label: string; selected: boolean }[]>(
      `[...document.querySelector(${JSON.stringify(agentsSelector)}).querySelectorAll('button')].map(button => ({ label: button.textContent.trim(), selected: button.getAttribute('aria-pressed') === 'true' }))`,
    );
    const agentSpec = BLOCK_SPECS.research.params.find((param) => param.key === "agents");
    ensure(
      agentSpec?.type === "multiselect",
      "Research agent options are defined by the shared contract",
    );
    const agentLabel = (id: string) => {
      const option =
        agentSpec.type === "multiselect"
          ? agentSpec.options.find((option) => option.value === id)
          : undefined;
      ensure(option, `Research agent option ${id} is present`);
      return option.label;
    };
    const socialLabels = ["reddit", "youtube", "instagram", "tiktok", "x"].map(agentLabel);
    const nonSocialBefore = initialAgents
      .filter((entry) => entry.selected && !socialLabels.includes(entry.label))
      .map((entry) => entry.label)
      .sort();
    ensure(nonSocialBefore.length > 0, "Research has a non-social agent to preserve");
    const selectedAgentLabels = () =>
      js<string[]>(
        `[...document.querySelector(${JSON.stringify(agentsSelector)}).querySelectorAll('button[aria-pressed="true"]')].map(button => button.textContent.trim()).sort()`,
      );
    await setSelect('[data-testid="research-social-media"]', "all");
    await delay(150);
    ensure(
      JSON.stringify(await selectedAgentLabels()) ===
        JSON.stringify([...nonSocialBefore, ...socialLabels].sort()),
      "social dropdown All replaces the social subset and preserves non-social agents",
    );
    await setSelect('[data-testid="research-social-media"]', "reddit");
    await delay(150);
    ensure(
      JSON.stringify(await selectedAgentLabels()) ===
        JSON.stringify([...nonSocialBefore, agentLabel("reddit")].sort()),
      "social dropdown Reddit replaces all social agents and preserves non-social agents",
    );
    await setSelect('[data-testid="research-social-media"]', "none");
    await delay(150);
    ensure(
      JSON.stringify(await selectedAgentLabels()) === JSON.stringify(nonSocialBefore),
      "social dropdown None removes social agents and preserves non-social agents",
    );
    await shot("dataflow-research-configuration");
    const options = await js<{ label: string; selected: boolean }[]>(
      `[...document.querySelector(${JSON.stringify(agentsSelector)}).querySelectorAll('button')].map(button => ({ label: button.textContent.trim(), selected: button.getAttribute('aria-pressed') === 'true' }))`,
    );
    // Select local-document agents first, so deselecting the three defaults never produces no agents.
    const localDocumentAgents = ["bmw_sales", "bmw_strategy"].map(agentLabel);
    for (const desired of localDocumentAgents) {
      const option = options.find((entry) => entry.label === desired);
      ensure(option, `agent option ${desired} exists`);
      if (!option.selected)
        ensure(await clickButton(agentsSelector, desired), `select ${desired} agent`);
      await delay(100);
    }
    for (const option of options) {
      if (option.selected && !localDocumentAgents.includes(option.label)) {
        ensure(
          await clickButton(agentsSelector, option.label),
          `deselect default ${option.label} agent`,
        );
        await delay(100);
      }
    }
    const selected = await js<string[]>(
      `[...document.querySelector(${JSON.stringify(agentsSelector)}).querySelectorAll('[aria-pressed="true"]')].map(button => button.textContent.trim()).sort()`,
    );
    ensure(
      JSON.stringify(selected) === '["bmw sales","bmw strategy"]',
      "only the two local-document agents selected",
    );
    const planningSelector = await fieldSelector("Mastra query planning (optional model request)");
    ensure(
      await js<boolean>(
        `document.querySelector(${JSON.stringify(planningSelector)})?.getAttribute('aria-checked') === 'false'`,
      ),
      "paid query planning remains off",
    );
    deps.queuePick(join(outDir, "original.synthetic.xlsx"));
    ensure(
      await click(await fieldSelector("Local original document")),
      "choose synthetic XLSX through renderer file import",
    );
    await waitFor("native file import result", async () =>
      (await text('[data-testid="inspector"]')).includes("original.synthetic.xlsx"),
    );
    ensure(
      (await count('[data-testid="inspector"] [role="alert"]')) === 0,
      "import and Research parameters have no validation errors",
    );
    ensure(await click('[aria-label="Close details"]'), "close Research inspector before running");

    process.on("worker", onWorker);
    ensure(await click('[data-testid="flow-run"]'), "start actual workflow through RunControls");
    const immediateStatus = await text('[data-testid="flow-run-status"]');
    if (immediateStatus.includes("Running"))
      ensure(
        (await count('[data-testid="flow-cancel"]')) === 1,
        "active workflow exposes its Cancel run control",
      );
    await waitFor(
      "completed live Research UI and dataset summary",
      async () => {
        const status = await text('[data-testid="flow-run-status"]');
        const controls = await text('[data-testid="run-controls"]');
        if (status.includes("Failed") || controls.includes("Could not start workflow:"))
          throw new Error(
            "Native Research workflow failed; inspect run logs in isolated smoke data.",
          );
        return (
          status.includes("Completed") &&
          /Research: 1 sources\s*·\s*2 raw records/.test(
            await text('[data-testid="research-results"]'),
          )
        );
      },
      45000,
    );
    const controls = await text('[data-testid="run-controls"]');
    const salesStatus = await text('[data-testid="research-agent-bmw_sales"]');
    const strategyStatus = await text('[data-testid="research-agent-bmw_strategy"]');
    // Summary owns the ID. Whole-section textContent concatenates the following block label to it.
    const runId = /run_[A-Za-z0-9_-]+/.exec(
      await text('[data-testid="flow-run-details"] summary'),
    )?.[0];
    ensure(runId, "current run ID visible in RunControls");
    nativeResearch.runId = runId;
    const run = WorkflowRun.parse(await invoke("runs", "get", runId));
    const block = run.graph.blocks[0];
    ensure(
      run.status === "completed" &&
        run.graph.blocks.length === 1 &&
        block?.kind === "research" &&
        block.params.queryPlanning === false &&
        run.blockRuns.some(
          (state) =>
            state.blockId === block.id &&
            state.status === "succeeded" &&
            state.counts.records === 2,
        ),
      "native run completed with one Research block and correct output count",
    );
    ensure(
      nativeResearch.nativeWorker.parsedInput && (nativeResearch.nativeWorker.threadId ?? 0) > 0,
      "real native Worker parsed synthetic 12-column workbook",
    );
    const dataset = ResearchDataset.parse(await invoke("research", "dataset", runId));
    ensure(dataset.runId === run.id, "dataset belongs to visible GUI run");
    const opinion = verifySmokeResearchDataset(dataset, ensure);
    nativeResearch.sources = dataset.sources.length;
    nativeResearch.rawRecords = dataset.records.length;
    nativeResearch.independentOpinions = 1;
    nativeResearch.associationRows = 2;
    nativeResearch.collectionStatuses = dataset.results.map(({ agentId, status }) => ({
      agentId,
      status,
    }));
    nativeResearch.requests = dataset.results.reduce((total, result) => total + result.requests, 0);
    ensure(
      dataset.results.length === 2 &&
        dataset.results.every(
          (result) =>
            result.status === "partial" &&
            result.recordIds.length === 2 &&
            result.requests === 0 &&
            /off|disabled/i.test(result.limitations.join(" ")),
        ),
      "both agents honestly report partial local collection, blocked web and zero API requests",
    );
    ensure(
      salesStatus.includes("Partial collection") &&
        strategyStatus.includes("Partial collection") &&
        salesStatus.includes("0 requests") &&
        strategyStatus.includes("0 requests"),
      "renderer displays honest agent statuses and record/request counts",
    );
    const output = await invoke("runs", "blockOutput", run.id, block.id);
    ensure(
      output.out?.records.length === dataset.records.length &&
        output.out.records.some(
          (record) => record.id === opinion.id && record.text === SYNTHETIC_FEEDBACK,
        ) &&
        output.out.findings.length === 0 &&
        output.out.requirements.length === 0,
      "real block-output IPC contains originals only, with no analysis or requirements",
    );
    ensure(await click('[data-testid="flow-run-details"] summary'), "open native run details");
    ensure(
      await click(`[data-testid="research-inspect-${block.id}"]`),
      "inspect output through renderer button",
    );
    await waitFor("verbatim source output preview", async () =>
      (await text('[data-testid="research-output-preview"]')).includes(SYNTHETIC_FEEDBACK),
    );
    ensure(
      await js<boolean>(`(() => {
        const pre = document.querySelector('[data-testid="research-output-preview"]');
        return pre?.innerHTML.includes('&lt;script&gt;synthetic&lt;/script&gt;') &&
          !pre.querySelector('script') && typeof window.__reqflowSmokeExecuted === 'undefined';
      })()`),
      "source HTML renders as escaped text; no script executes",
    );
    ensure(
      await click('[data-testid="flow-run-details"] summary'),
      "collapse output details for result screenshot",
    );
    await js(`document.querySelector('[data-testid="run-controls"]').scrollTop = 0`);
    await shot("dataflow-research-result");

    for (const format of ["json", "xlsx", "csv"] as const) {
      ensure(
        await click(`[data-testid="research-export-${format}"]`),
        `export ${format.toUpperCase()} through renderer`,
      );
      await waitFor(`native ${format.toUpperCase()} export`, async () =>
        (await text('[aria-label="Research collection results"]')).includes(
          `Export saved: ${join(outDir, `research-export.${format}`)}`,
        ),
      );
    }
    nativeResearch.exports = await verifySmokeResearchFiles(
      outDir,
      dataDir,
      dataset,
      block.id,
      ensure,
    );
    const audit = await invoke("audit", "list", { runId, limit: 100 });
    ensure(
      audit.some((event) => event.action === "run.started") &&
        audit.some((event) => event.action === "run.completed") &&
        audit.filter((event) => event.action === "export.created").length === 3,
      "native persistence records start, completion and all three exports in audit",
    );
    nativeResearch.ok = true;
  } catch (error) {
    errors.push(
      `native Research: ${error instanceof Error ? error.message : "verification failed"}`,
    );
    await shot("dataflow-research-failed");
  } finally {
    process.off("worker", onWorker);
  }

  const report = {
    ok: errors.length === 0,
    platform: process.platform,
    errors,
    screens,
    nativeResearch,
  };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    `[smoke] ${report.ok ? "PASS" : "FAIL"} on ${process.platform}: ${screens.length} screenshots → ${outDir}`,
  );
  for (const e of errors) console.error(`[smoke] ${e}`);
  return report.ok ? 0 : 1;
}
