import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  connect,
  createBlock,
  DEFAULT_SETTINGS,
  defaultBlockParams,
  PALETTE_BLOCK_KINDS,
  setBlockParams,
  type WorkflowGraph,
} from "@reqflow/core";
import type { LocalFileStore } from "@reqflow/db";
import type { BrowserWindow, NativeImage } from "electron";

/**
 * `npm run smoke` (= `electron . --smoke=out/smoke`): opens every screen, clicks through the main
 * interactions, screenshots each step, calls the IPC bridge end to end, and exits non-zero on any
 * failed check or renderer error. Used by agents to verify UI work without clicking through the app.
 */
export const SMOKE_ROUTES = ["/dataflow", "/car", "/settings"] as const;
const SETTINGS_SECTIONS = ["app", "parameters", "ai", "collaboration", "about"] as const;

export function parseSmokeArg(argv: readonly string[]): string | null {
  const arg = argv.find((a) => a.startsWith("--smoke="));
  return arg ? resolve(arg.slice("--smoke=".length)) : null;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const slug = (route: string) => route.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-") || "root";

export async function runSmoke(
  win: BrowserWindow,
  outDir: string,
  deps: { files: LocalFileStore; samplesDir: string; bmwDir: string },
): Promise<number> {
  mkdirSync(outDir, { recursive: true });
  const errors: string[] = [];
  const screens: { name: string; file: string }[] = [];
  const wc = win.webContents;
  wc.on("console-message", (event) => {
    if (event.level === "error") errors.push(`console: ${event.message}`);
  });
  wc.on("render-process-gone", (_e, details) => errors.push(`renderer gone: ${details.reason}`));

  if (wc.isLoading()) await new Promise<void>((r) => wc.once("did-finish-load", () => r()));

  const js = <T>(code: string): Promise<T> => wc.executeJavaScript(code);
  const check = (ok: boolean, message: string) => {
    if (!ok) errors.push(message);
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
  const info = await js<{ ok?: boolean }>(`window.reqflowBridge.invoke("reqflow:app.info")`);
  check(info?.ok === true, `app.info failed: ${JSON.stringify(info)}`);
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

  // BMW's real files, only when they are in data/raw/ (local, gitignored). Counts and pass/fail only:
  // nothing from them is logged or screenshotted, and the imported copies are deleted afterwards.
  const bmw = [
    ["F70_feedback_hackathon.xlsx", "customer_feedback"],
    ["F70_G60_G68_G70_customer_studies.xlsx", "customer_study"],
    ["sales_volumes.xlsx", "sales_volume"],
    ["F70_OptionList.PDF", "other"],
  ] as const;
  let bmwChecked = 0;
  for (const [file, dataset] of bmw) {
    const path = join(deps.bmwDir, file);
    if (!existsSync(path)) continue;
    let fileId: string | null = null;
    try {
      const info = await deps.files.importFile(path);
      fileId = info.id;
      const params = {
        ...defaultBlockParams("raw"),
        dataset,
        file: { fileId: info.id, name: info.name },
      };
      const request = { kind: "raw", params, scope: DEFAULT_SETTINGS.defaultScope };
      const res = await js<{
        ok: boolean;
        value?: { outputs: { out: { records: unknown[] } } };
        error?: { message?: string };
      }>(`window.reqflowBridge.invoke("reqflow:blocks.preview", ${JSON.stringify(request)})
        .then((r) => r.ok ? { ok: true, value: { outputs: { out: { records: r.value.outputs.out.records.map(() => 0) } } } } : r)`);
      if (file.endsWith(".PDF")) {
        check(!res.ok && /is a PDF/.test(res.error?.message ?? ""), `BMW ${file}: PDF not refused`);
      } else {
        const records = res.value?.outputs.out.records.length ?? 0;
        check(res.ok && records > 0, `BMW ${file}: ${res.ok ? "no records" : res.error?.message}`);
      }
      bmwChecked++;
    } catch (err) {
      check(false, `BMW ${file} crashed: ${String(err)}`);
    } finally {
      if (fileId) await deps.files.remove(fileId);
    }
  }
  console.log(`smoke: BMW files in data/raw previewed: ${bmwChecked}`);

  // Start from a known theme (the default "system" follows the OS), dark mode comes last.
  await go("/settings");
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
    `dataflow: expected 7 blocks, got ${blockCount}`,
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
  await shot("hil-report-real");
  check(await click('[aria-label="Close report"]'), "report: no close button");
  await delay(300);
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
    (await count('[data-testid^="car-part-"]')) >= 30,
    "car: part index should list every part",
  );
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
    (await text('[data-testid="car-classifier-reason"]')).length > 0,
    "car: classifier should explain itself",
  );
  await shot("car-part-selected");
  for (const view of ["side", "rear", "top"]) {
    check(await click(`[data-testid="car-camera-${view}"]`), `car: no ${view} camera`);
    await delay(900);
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

  // New Reasoning view checks
  check(await click('[data-testid^="car-part-"]'), "car: select a part for reasoning");
  await delay(300);
  check(
    (await count('[data-testid="car-requirement-confidence"]')) >= 1,
    "car: requirement should have confidence chip",
  );
  await shot("car-confidence");

  check(await click('[data-testid="car-requirement-why"]'), "car: no why button");
  for (let i = 0; i < 20 && (await count('[data-testid="reasoning-view"]')) === 0; i++)
    await delay(100);
  check((await count('[data-testid="reasoning-view"]')) >= 1, "car: reasoning view didn't open");
  await delay(100);
  await shot("reasoning-requirement");

  check(await click('[aria-label="Close thought process"]'), "car: no reasoning close button");
  await delay(300);

  // Data Flow block reasoning
  await go("/dataflow");
  for (let i = 0; i < 40 && (await count('[data-testid^="block-"]')) === 0; i++) await delay(100);
  check(await click('[data-testid="block-reasoning"]'), "dataflow: no block-reasoning button");
  for (let i = 0; i < 20 && (await count('[data-testid="reasoning-view"]')) === 0; i++)
    await delay(100);
  check(
    (await count('[data-testid="reasoning-view"]')) >= 1,
    "dataflow: block reasoning view didn't open",
  );
  await delay(100);
  await shot("reasoning-block");
  check(await click('[aria-label="Close thought process"]'), "dataflow: no reasoning close button");
  await delay(300);

  // Settings -> AI API setups
  await go("/settings");
  check(await click('[data-testid="settings-section-ai"]'), "settings: no AI section");
  await delay(300);
  check(await click('[data-testid="settings-add-setup"]'), "settings: no add setup button");
  await delay(200);
  await shot("settings-api-setups");
  check(await click('[data-testid^="settings-delete-setup-"]'), "settings: no delete setup button");
  await delay(200);

  // Go back to car for reset
  await go("/car");
  await delay(600);

  // Reset: asks in place, removes every requirement, and the car is empty afterwards.
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
  check((await count('[data-testid^="car-badge-"]')) === 0, "car: badges left after reset");
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
    await shot(`settings-${id}`);
  }
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
    await shot(`${slug(route)}-dark`);
  }

  const report = { ok: errors.length === 0, platform: process.platform, errors, screens };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    `[smoke] ${report.ok ? "PASS" : "FAIL"} on ${process.platform}: ${screens.length} screenshots → ${outDir}`,
  );
  for (const e of errors) console.error(`[smoke] ${e}`);
  return report.ok ? 0 : 1;
}
