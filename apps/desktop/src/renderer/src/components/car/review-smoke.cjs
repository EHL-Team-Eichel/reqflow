// Standalone Electron test harness, never imported by the renderer.
// Run from apps/desktop after npm run build:
// electron src/renderer/src/components/car/review-smoke.cjs
const { app, BrowserWindow, dialog } = require("electron");
const { mkdirSync, writeFileSync, existsSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const desktop = resolve(__dirname, "../../../../..");
const out = join(desktop, "out/smoke/ws3-review");
const dir = join(out, `data-${Date.now()}`);
mkdirSync(dir, { recursive: true });
app.setPath("userData", join(out, "electron-user-data"));
process.env.REQFLOW_DATA_DIR = dir;
delete process.env.ELECTRON_RENDERER_URL;
// Prevent dev dotenv loading; the harness uses only the compiled application and synthetic state.
Object.defineProperty(app, "isPackaged", { get: () => true });
globalThis.fetch = async () => {
  throw new Error("WS3 smoke forbids outbound requests.");
};
let saveMode = "save";
dialog.showSaveDialog = async (...args) => {
  if (saveMode === "cancel") return { canceled: true };
  if (saveMode === "error") throw new Error("Synthetic save dialog failure");
  const options = args.at(-1);
  return {
    canceled: false,
    filePath: join(out, `requirements.${options.filters[0].extensions[0]}`),
  };
};
const checks = [];
const screens = [];
const errors = [];
writeFileSync(join(out, "report.json"), JSON.stringify({ ok: false, message: "Not completed" }));
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
function check(ok, message) {
  checks.push({ ok: Boolean(ok), message });
  if (!ok) throw new Error(message);
}

app.on("browser-window-created", (_event, win) => {
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  win.webContents.once(
    "did-finish-load",
    () =>
      void run(win).catch((error) => {
        errors.push(error.message);
        finish(1);
      }),
  );
});
function finish(code) {
  writeFileSync(
    join(out, "report.json"),
    JSON.stringify({ ok: code === 0, checks, errors, screens }, null, 2),
  );
  console.log(
    `WS3 native review smoke: ${checks.length} checks, ${screens.length} screenshots, ${errors.length} errors`,
  );
  app.exit(code);
}
const timer = setTimeout(() => {
  errors.push("Native review smoke timed out");
  finish(1);
}, 120000);
timer.unref();

async function run(win) {
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  win.show();
  wc.debugger.attach("1.3");
  const js = (code) => wc.executeJavaScript(code);
  const invoke = async (channel, ...args) => {
    const result = await js(
      `window.reqflowBridge.invoke(${JSON.stringify(`reqflow:${channel}`)}, ...${JSON.stringify(args)})`,
    );
    if (!result.ok) throw new Error(`${channel}: ${result.error.message}`);
    return result.value;
  };
  const wait = async (code) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (await js(code)) return;
      await delay(80);
    }
    throw new Error(`Timed out waiting for ${code}`);
  };
  const click = async (selector) => {
    check(
      await js(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) return false; el.focus(); el.click(); return true; })()`,
      ),
      `Click ${selector}`,
    );
    await delay(100);
  };
  const field = async (label, value) => {
    const found = await js(`(() => {
      const label = [...document.querySelectorAll('[aria-label="Human requirement review"] label')].find(el => el.querySelector('span')?.textContent === ${JSON.stringify(label)});
      const el = label?.querySelector('input,select,textarea');
      if (!el) return false;
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', {bubbles:true}));
      return true;
    })()`);
    check(found, `Set ${label}`);
    await delay(100);
  };
  const select = async (selector, value) => {
    await js(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('change',{bubbles:true})); })()`,
    );
    await delay(100);
  };
  const shot = async (name) => {
    await delay(200);
    const image = await wc.debugger.sendCommand("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(out, `${name}.png`), Buffer.from(image.data, "base64"));
    screens.push(name);
  };
  check(
    (await invoke("app.info")).dataDir === dir,
    "Runtime uses isolated synthetic data directory",
  );
  const settings = await invoke("settings.get");
  await invoke("settings.save", {
    ...settings,
    llm: { ...settings.llm, provider: "mock", model: "mock" },
    app: { ...settings.app, theme: "light" },
  });
  await js("location.reload()");
  await wait("document.documentElement.dataset.theme === 'light'");
  const db = new DatabaseSync(join(dir, "reqflow.db"));
  const ids = ["901", "902", "903", "904"].map((n) => `REQ-F70-EU-${n}`);
  db.prepare("DELETE FROM requirements WHERE id IN (?, ?, ?, ?)").run(...ids);
  const now = new Date().toISOString();
  for (let i = 0; i < ids.length; i++) {
    const r = {
      id: ids[i],
      version: 1,
      title: `Synthetic rear seat review ${i + 1}`,
      description: "Improve customer-facing rear-seat comfort using the linked synthetic feedback.",
      category: "comfort",
      scope: settings.defaultScope,
      targets: [
        {
          metric: "Seat comfort",
          target: "Improved comfort in a synthetic test",
          acceptance: "Synthetic customer panel confirms comfort",
        },
      ],
      findingIds: ["fnd_ws3_synthetic"],
      sourceIds: [],
      conflictingFindingIds: [],
      ...(i < 3 ? { priority: ["must", "should", "could"][i] } : {}),
      evidenceLevel: i === 3 ? "D" : "B",
      assumptions: ["Synthetic assumption"],
      uncertainties: [],
      status: "proposed",
      createdBy: { type: "system", component: "ws3.synthetic-smoke" },
      createdAt: now,
      updatedAt: now,
    };
    db.prepare(
      "INSERT INTO requirements (id,version,title,category,status,priority,evidence_level,run_id,json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      r.id,
      1,
      r.title,
      r.category,
      r.status,
      r.priority ?? null,
      r.evidenceLevel,
      null,
      JSON.stringify(r),
      now,
      now,
    );
  }
  db.close();
  await js("location.hash = '#/car'");
  await wait("!!document.querySelector('[data-testid=car-requirements-tab]')");
  await click("[data-testid=car-requirements-tab]");
  await click("[data-testid=requirement-browser-reload]");
  await wait(
    "document.querySelector('[data-testid=requirement-browser-count]')?.textContent === '4 of 4 shown'",
  );
  check(
    await js(
      "document.querySelector('[data-testid=requirement-browser-group-unprioritized]')?.textContent.includes('1')",
    ),
    "Unprioritized requirement remains visible",
  );
  await shot("ranked-requirements-light");
  await click("[data-testid=requirement-browser-filters] summary");
  await select("[data-testid=requirement-browser-evidence]", "D");
  check(
    await js(
      "document.querySelector('[data-testid=requirement-browser-count]')?.textContent === '1 of 4 shown'",
    ),
    "Evidence filter narrows requirements",
  );
  await click("[data-testid=requirement-browser-clear]");
  await click("[data-testid=requirement-browser-filters] summary");
  await click(`[data-requirement-id="${ids[0]}"]`);
  await wait("!!document.querySelector('[data-testid=car-requirement-full-details]')");
  await click("[data-testid=car-requirement-review-tab]");
  await field("Action", "approve");
  check(
    await js(
      "document.querySelector('[aria-label=\"Human requirement review\"] button[type=submit]').disabled",
    ),
    "Decision requires a rationale",
  );
  await field("Rationale", "Synthetic PM approves the comfort improvement");
  await field("Approval priority override (optional)", "could");
  await shot("human-decision-light");
  await click("[aria-label='Human requirement review'] button[type=submit]");
  await wait(
    "document.querySelector('[data-testid=car-requirement-dialog]')?.textContent.includes('Version 2 saved')",
  );
  let detail = await invoke("requirements.get", ids[0]);
  check(
    detail.requirement.status === "approved" && detail.requirement.priority === "could",
    "Human approval and priority override persisted",
  );
  const originalEvidence = JSON.stringify({
    ids: detail.requirement.findingIds,
    targets: detail.requirement.targets,
  });
  await click("[aria-label='Human requirement review'] button[aria-expanded]");
  await field("Title", "Synthetic rear seat comfort refined by PM");
  await field("Rationale", "Synthetic PM clarifies the customer need");
  await shot("content-edit-light");
  await click("[aria-label='Human requirement review'] button[type=submit]");
  await wait(
    "document.querySelector('[data-testid=car-requirement-dialog]')?.textContent.includes('Version 3 saved')",
  );
  detail = await invoke("requirements.get", ids[0]);
  check(
    detail.requirement.title === "Synthetic rear seat comfort refined by PM" &&
      detail.requirement.status === "approved",
    "Content edit persists without changing human decision",
  );
  check(
    JSON.stringify({ ids: detail.requirement.findingIds, targets: detail.requirement.targets }) ===
      originalEvidence,
    "Untouched evidence and target data preserved",
  );
  await click("[data-testid=car-requirement-history-tab]");
  await wait(
    "document.querySelector('[aria-label=\"Audit events, newest first\"]')?.textContent.includes('requirement.edited')",
  );
  check(
    await js(
      "document.querySelector('[aria-label=\"Audit events, newest first\"]')?.textContent.includes('Synthetic PM approves')",
    ),
    "History shows actual decision rationale",
  );
  await click("[aria-label='Audit events, newest first'] details summary");
  await shot("requirement-history-light");
  await click("[data-testid=car-requirement-review-tab]");
  await field("Action", "challenge");
  await field("Rationale", "Synthetic challenge about conflicting comfort needs");
  check(
    await js(
      "document.querySelector('[aria-label=\"Human requirement review\"] button[type=submit]').disabled",
    ),
    "Challenge requires explicit AI sharing consent",
  );
  await click("[aria-label='Human requirement review'] input[type=checkbox]");
  await click("[aria-label='Human requirement review'] button[type=submit]");
  await wait(
    "document.querySelector('[data-testid=car-requirement-dialog]')?.textContent.includes('Version 4 saved')",
  );
  detail = await invoke("requirements.get", ids[0]);
  check(
    detail.requirement.status === "in_review",
    "Offline challenge returns to review, never approves",
  );
  // A second writer changes the requirement after the review form's snapshot was loaded.
  await invoke("requirements.decide", ids[0], {
    decision: "defer",
    rationale: "Synthetic concurrent PM decision",
  });
  await field("Action", "approve");
  await field("Rationale", "Stale synthetic decision must be refused");
  await click("[aria-label='Human requirement review'] button[type=submit]");
  await wait(
    "document.querySelector('[aria-label=\"Human requirement review\"] [role=alert]')?.textContent.includes('Reload its details')",
  );
  check(
    (await invoke("requirements.get", ids[0])).requirement.status === "deferred",
    "Stale review cannot overwrite the observed newer decision",
  );
  await click("[data-testid=car-requirement-reload]");
  await wait(
    "document.querySelector('[aria-label=\"Human requirement review\"]')?.textContent.includes('Version 5')",
  );
  await field("Action", "reopen");
  await field("Rationale", "Synthetic PM reopens for further review");
  await click("[aria-label='Human requirement review'] button[type=submit]");
  await wait(
    "document.querySelector('[data-testid=car-requirement-dialog]')?.textContent.includes('Version 6 saved')",
  );
  await click("[aria-label='Close requirement details']");
  await wait("!document.querySelector('[data-testid=car-requirement-dialog]')");
  check(
    await js("document.activeElement?.getAttribute('data-requirement-id') === 'REQ-F70-EU-901'"),
    "Closing the dialog restores card focus",
  );
  await click("[data-testid=requirement-browser-export-options] summary");
  for (const format of ["json", "csv", "md"]) {
    await select("[data-testid=requirement-browser-export-format]", format);
    await click("[data-testid=requirement-browser-export]");
    await wait("!!document.querySelector('[data-testid=requirement-browser-export-saved]')");
    check(
      existsSync(join(out, `requirements.${format}`)),
      `Native ${format} export creates a file`,
    );
  }
  saveMode = "cancel";
  await click("[data-testid=requirement-browser-export]");
  await wait("!!document.querySelector('[data-testid=requirement-browser-export-cancelled]')");
  saveMode = "error";
  await click("[data-testid=requirement-browser-export]");
  await wait("!!document.querySelector('[data-testid=requirement-browser-export-error]')");
  await click("[data-testid=car-audit-tab]");
  await wait(
    "document.querySelector('[aria-label=\"Audit events, newest first\"]')?.textContent.includes('requirement.edited')",
  );
  await shot("global-audit-light");
  await invoke("settings.save", {
    ...settings,
    llm: { ...settings.llm, provider: "mock", model: "mock" },
    app: { ...settings.app, theme: "dark" },
  });
  await js("location.reload()");
  await wait("document.documentElement.dataset.theme === 'dark'");
  await wait("!!document.querySelector('[data-testid=car-requirements-tab]')");
  await click("[data-testid=car-requirements-tab]");
  await shot("ranked-requirements-dark");
  win.setSize(1024, 640);
  await shot("ranked-requirements-minimum");
  await click(`[data-requirement-id="${ids[0]}"]`);
  await wait("!!document.querySelector('[data-testid=car-requirement-full-details]')");
  await click("[data-testid=car-requirement-review-tab]");
  await shot("human-review-minimum-dark");
  const audits = await invoke("audit.list", { entityId: ids[0], entityType: "requirement" });
  check(
    audits.some((event) => event.action === "requirement.edited" && event.actor.type === "human"),
    "Content change has a real human audit event",
  );
  check(
    audits.some((event) => event.action === "requirement.challenge_answered"),
    "Offline challenge response remains inspectable in the audit",
  );
  check(
    (await invoke("runs.list")).length === 0,
    "Reviewing and editing never starts or resumes a workflow",
  );
  check(errors.length === 0, "No renderer console errors");
  finish(0);
}

require(join(desktop, "out/main/index.js"));
