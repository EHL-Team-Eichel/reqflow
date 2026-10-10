import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BrowserWindow } from "electron";

/**
 * `npm run smoke` (= `electron . --smoke=out/smoke`): opens every screen, screenshots it,
 * calls the IPC bridge end to end, and exits non-zero on any renderer error. Used by CI on all OSes
 * and by agents to verify UI work without clicking through the app.
 */
export const SMOKE_ROUTES = [
  "/workflow",
  "/requirements",
  "/requirements/REQ-5S-EU-001",
  "/audit",
  "/settings",
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
  const wc = win.webContents;
  wc.on("console-message", (event) => {
    if (event.level === "error") errors.push(`console: ${event.message}`);
  });
  wc.on("render-process-gone", (_e, details) => errors.push(`renderer gone: ${details.reason}`));

  if (wc.isLoading()) await new Promise<void>((r) => wc.once("did-finish-load", () => r()));

  // IPC bridge, end to end: one built method must succeed, an unbuilt one must fail loudly.
  const info = await wc.executeJavaScript(`window.reqflowBridge.invoke("reqflow:app.info")`);
  if (!info?.ok) errors.push(`app.info failed: ${JSON.stringify(info)}`);
  const unbuilt = await wc.executeJavaScript(`window.reqflowBridge.invoke("reqflow:audit.list")`);
  if (unbuilt?.ok !== false || !unbuilt.error?.code) {
    errors.push(`audit.list should return a structured error, got ${JSON.stringify(unbuilt)}`);
  }
  const blocked = await wc.executeJavaScript(
    `window.reqflowBridge.invoke("not-a-channel").then(() => "allowed", () => "blocked")`,
  );
  if (blocked !== "blocked") errors.push("preload allowed an unknown IPC channel");

  const screens: { route: string; heading: string; file: string }[] = [];
  for (const route of SMOKE_ROUTES) {
    await wc.executeJavaScript(`location.hash = ${JSON.stringify(`#${route}`)}`);
    await delay(500);
    const heading: string = await wc.executeJavaScript(
      `document.querySelector("h1")?.textContent ?? ""`,
    );
    if (!heading) errors.push(`${route}: no <h1> rendered`);
    const file = join(outDir, `${slug(route)}.png`);
    writeFileSync(file, (await wc.capturePage()).toPNG());
    screens.push({ route, heading, file });
  }

  const report = { ok: errors.length === 0, platform: process.platform, errors, screens };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    `[smoke] ${report.ok ? "PASS" : "FAIL"} on ${process.platform}: ${screens.length} screens → ${outDir}`,
  );
  for (const e of errors) console.error(`[smoke] ${e}`);
  return report.ok ? 0 : 1;
}
