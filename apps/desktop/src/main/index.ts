import { join } from "node:path";
import type { WorkflowRun } from "@reqflow/core";
import { IPC_EVENTS } from "@reqflow/core/ipc";
import { createFileStore } from "@reqflow/db";
import { app, BrowserWindow, dialog, safeStorage, shell, type IpcMainInvokeEvent } from "electron";
import { createHandlers } from "./handlers";
import { registerIpc } from "./ipc";
import { dataDir, loadDevEnv, uploadsDir } from "./paths";
import { parseEvalArg, runEvalF70 } from "./eval-f70";
import { SecretsStore } from "./secrets";
import { parseSmokeArg, runSmoke } from "./smoke";

const smokeDir = parseSmokeArg(process.argv);
const evalDir = parseEvalArg(process.argv);

const rejectSmokeFetch: typeof globalThis.fetch = async () => {
  throw new Error("Outbound provider requests are disabled during native smoke.");
};
if (smokeDir) {
  app.setPath("userData", join(smokeDir, "electron-user-data"));
  globalThis.fetch = rejectSmokeFetch;
}

// One instance per user avoids competing state, credential and audit writers.
if (!smokeDir && !evalDir && !app.requestSingleInstanceLock()) app.quit();

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: "ReqFlow",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      offscreen: smokeDir !== null,
      backgroundThrottling: smokeDir === null,
    },
  });
  win.once("ready-to-show", () => {
    if (!smokeDir) win.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const current = new URL(win.webContents.getURL());
    const next = new URL(url);
    if (next.origin !== current.origin || next.pathname !== current.pathname)
      event.preventDefault();
  });

  const devUrl = smokeDir ? undefined : process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
  return win;
}

const isTrustedSender = (event: IpcMainInvokeEvent): boolean =>
  BrowserWindow.fromWebContents(event.sender) !== null &&
  event.senderFrame === event.sender.mainFrame;

app.on("second-instance", () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

void app
  .whenReady()
  .then(() => {
    if (!smokeDir) loadDevEnv();
    if (evalDir) {
      void runEvalF70(evalDir, {
        rawDir: join(app.getAppPath(), "../../data/raw"),
        dataDir: dataDir(null),
        maxRequirements: Number(process.env.EVAL_MAX_REQUIREMENTS) || 20,
      }).then(
        (code) => app.exit(code),
        (err) => {
          console.error("[eval] crashed:", err instanceof Error ? err.message : String(err));
          app.exit(1);
        },
      );
      return;
    }
    // The smoke test can't click a native dialog: it queues the files "Choose file…" returns.
    const smokePicks: string[] = [];
    const dir = dataDir(smokeDir ? join(smokeDir, "data") : null);
    const files = createFileStore(uploadsDir(dir));
    const pushRunUpdate = (run: WorkflowRun) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_EVENTS.runUpdate, run);
        }
      }
    };

    const handlers = createHandlers({
      files,
      dataDir: dir,
      pushRunUpdate,
      secretsStore: new SecretsStore(dir, {
        secureStorage: safeStorage,
        environment: smokeDir ? {} : undefined,
      }),
      researchOptions: {
        fetchImpl: smokeDir ? rejectSmokeFetch : undefined,
        xlsxWorkerPath: join(
          __dirname.replace(/app\.asar(?=[\\/])/, "app.asar.unpacked"),
          "research-xlsx-worker.js",
        ),
      },
      pickFile: async () => {
        if (smokeDir) return smokePicks.shift() ?? null;
        const options: Electron.OpenDialogOptions = {
          title: "Import a dataset or original research document",
          properties: ["openFile"],
          filters: [
            {
              name: "Datasets and documents",
              extensions: [
                "xlsx",
                "csv",
                "json",
                "txt",
                "pdf",
                "docx",
                "pptx",
                "db",
                "sqlite",
                "sqlite3",
              ],
            },
          ],
        };
        const parent = BrowserWindow.getFocusedWindow();
        const result = parent
          ? await dialog.showOpenDialog(parent, options)
          : await dialog.showOpenDialog(options);
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      saveDialog: async (options) => {
        if (smokeDir) {
          const format = options.filters?.[0]?.extensions[0] ?? "json";
          return {
            canceled: false,
            filePath: join(
              smokeDir,
              format === "pdf" ? "synthetic-report.pdf" : `research-export.${format}`,
            ),
          };
        }
        const parent = BrowserWindow.getFocusedWindow();
        return parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options);
      },
      appInfo: () => ({
        version: app.getVersion(),
        platform: process.platform,
        dataDir: dir,
        isPackaged: app.isPackaged,
      }),
    });
    registerIpc(handlers, isTrustedSender);

    let shuttingDown = false;
    app.on("before-quit", (event) => {
      if (shuttingDown) return;
      event.preventDefault();
      shuttingDown = true;
      void handlers.runs
        .list()
        .then((runs) =>
          Promise.all(
            runs
              .filter((run) => run.status === "queued" || run.status === "running")
              .map((run) => handlers.runs.cancel(run.id)),
          ),
        )
        .catch(() => console.error("ReqFlow could not finish every run during shutdown."))
        .finally(() => app.quit());
    });

    const win = createWindow();
    if (smokeDir)
      void runSmoke(win, smokeDir, {
        files,
        samplesDir:
          process.env.REQFLOW_SMOKE_SAMPLES_DIR ?? join(app.getAppPath(), "../../data/samples"),
        bmwDir: join(app.getAppPath(), "../../data/raw"),
        queuePick: (path) => void smokePicks.push(path),
      }).then(
        (code) => app.exit(code),
        () => {
          console.error("[smoke] crashed; inspect the isolated smoke report.");
          app.exit(1);
        },
      );
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch(() => {
    console.error("ReqFlow could not initialize its main-process services.");
    app.exit(1);
  });
