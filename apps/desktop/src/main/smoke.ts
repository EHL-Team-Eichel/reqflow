import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Worker } from "node:worker_threads";
import { PALETTE_BLOCK_KINDS, ResearchDataset, Settings, WorkflowRun } from "@reqflow/core";
import { ipcChannel, type AppInfo, type IpcResult, type ReqflowHandlers } from "@reqflow/core/ipc";
import type { BrowserWindow, NativeImage } from "electron";
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

export async function runSmoke(win: BrowserWindow, outDir: string): Promise<number> {
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
      const seen = frames;
      wc.invalidate();
      const deadline = Date.now() + 3000;
      while (frames === seen && Date.now() < deadline) await delay(20);
      if (frames === seen || !frame) {
        errors.push(`${name}: no frame was painted`);
        return;
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
    `window.reqflowBridge.invoke("reqflow:requirements.list")`,
  );
  check(
    unbuilt?.ok === false && !!unbuilt.error?.code,
    `requirements.list should return a structured error, got ${JSON.stringify(unbuilt)}`,
  );
  const blocked = await js<string>(
    `window.reqflowBridge.invoke("not-a-channel").then(() => "allowed", () => "blocked")`,
  );
  check(blocked === "blocked", "preload allowed an unknown IPC channel");

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
      Object.values(secrets).every((status) => !status.configured && status.source === null),
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
      ensure(await click(`[data-testid="block-${kind}"]`), `select existing ${kind} block`);
      await delay(100);
      ensure(
        await click('[data-testid="inspector-delete"]'),
        `delete existing ${kind} through Inspector`,
      );
      await delay(100);
    }
    ensure((await count(".react-flow__node")) === 0, "all seven earlier blocks deleted through UI");
    ensure(
      await click('[data-testid="palette-item-research"]'),
      "add isolated Research from palette",
    );
    await delay(300);
    const agentsSelector = await fieldSelector("Research agents");
    const options = await js<{ label: string; selected: boolean }[]>(
      `[...document.querySelector(${JSON.stringify(agentsSelector)}).querySelectorAll('button')].map(button => ({ label: button.textContent.trim(), selected: button.getAttribute('aria-pressed') === 'true' }))`,
    );
    // Select local-document agents first, so deselecting the three defaults never produces no agents.
    for (const desired of ["bmw sales", "bmw strategy"]) {
      const option = options.find((entry) => entry.label === desired);
      ensure(option, `agent option ${desired} exists`);
      if (!option.selected)
        ensure(await clickButton(agentsSelector, desired), `select ${desired} agent`);
      await delay(100);
    }
    for (const option of options) {
      if (option.selected && !["bmw sales", "bmw strategy"].includes(option.label)) {
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
    const planningSelector = await fieldSelector("Mastra query planning (paid Anthropic request)");
    ensure(
      await js<boolean>(
        `document.querySelector(${JSON.stringify(planningSelector)})?.getAttribute('aria-checked') === 'false'`,
      ),
      "paid query planning remains off",
    );
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
    ensure(await click('[data-testid="run-start"]'), "start actual workflow through RunControls");
    await waitFor(
      "completed live Research UI and dataset summary",
      async () => {
        const controls = await text('[data-testid="run-controls"]');
        if (controls.includes("Run failed") || controls.includes("Could not start workflow:"))
          throw new Error(
            "Native Research workflow failed; inspect run logs in isolated smoke data.",
          );
        return (
          controls.includes("Run completed") &&
          /Research: 1 sources\s*·\s*2 raw records/.test(controls)
        );
      },
      45000,
    );
    const controls = await text('[data-testid="run-controls"]');
    // Summary owns the ID. Whole-section textContent concatenates the following block label to it.
    const runId = /run_[A-Za-z0-9_-]+/.exec(
      await text('[data-testid="run-controls"] details summary'),
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
      controls.includes("bmw sales:") &&
        controls.includes("bmw strategy:") &&
        controls.includes("Partial collection") &&
        controls.includes("0 requests"),
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
    ensure(await click('[data-testid="run-controls"] details summary'), "open native run details");
    ensure(
      await clickButton('[data-testid="run-controls"]', "Inspect output"),
      "inspect output through renderer button",
    );
    await waitFor("verbatim source output preview", async () =>
      (await text('[data-testid="run-controls"] pre')).includes(SYNTHETIC_FEEDBACK),
    );
    ensure(
      await js<boolean>(`(() => {
        const pre = document.querySelector('[data-testid="run-controls"] pre');
        return pre?.innerHTML.includes('&lt;script&gt;synthetic&lt;/script&gt;') &&
          !pre.querySelector('script') && typeof window.__reqflowSmokeExecuted === 'undefined';
      })()`),
      "source HTML renders as escaped text; no script executes",
    );
    ensure(
      await click('[data-testid="run-controls"] details summary'),
      "collapse output details for result screenshot",
    );
    await js(`document.querySelector('[data-testid="run-controls"]').scrollTop = 0`);
    await shot("dataflow-research-result");

    for (const format of ["json", "xlsx", "csv"] as const) {
      ensure(
        await clickButton('[data-testid="run-controls"]', `Export ${format.toUpperCase()}`),
        `export ${format.toUpperCase()} through renderer`,
      );
      await waitFor(`native ${format.toUpperCase()} export`, async () =>
        (await text('[data-testid="run-controls"]')).includes(
          `Export saved: ${join(outDir, `research-export.${format}`)}`,
        ),
      );
    }
    nativeResearch.exports = await verifySmokeResearchFiles(outDir, dataDir, dataset, ensure);
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
