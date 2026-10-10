import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PALETTE_BLOCK_KINDS } from "@reqflow/core";
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
