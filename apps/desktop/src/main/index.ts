import { join } from "node:path";
import { app, BrowserWindow, dialog, safeStorage, shell, type IpcMainInvokeEvent } from "electron";
import { IPC_EVENTS } from "@reqflow/core/ipc";
import { createResearchRuntime } from "./research/runtime";
import { createHandlers } from "./handlers";
import { registerIpc } from "./ipc";
import { dataDir, loadDevEnv } from "./paths";
import { parseSmokeArg, runSmoke } from "./smoke";

const smokeDir = parseSmokeArg(process.argv);
// Native smoke always runs with isolated local state and a rejecting transport.
if (smokeDir) app.setPath("userData", join(smokeDir, "electron-user-data"));

// One instance per user avoids competing writers to local state, credentials and the audit trail.
if (!smokeDir && !app.requestSingleInstanceLock()) app.quit();

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
      // The smoke test renders off screen: it paints even when the display sleeps or the window
      // is covered, and never steals focus.
      offscreen: smokeDir !== null,
    },
  });
  win.once("ready-to-show", () => {
    if (!smokeDir) win.show();
  });

  // The window never navigates away from the app; http(s) links open in the user's browser.
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
  .then(async () => {
    if (!smokeDir) loadDevEnv();
    const dir = dataDir(smokeDir ? join(smokeDir, "data") : null);
    const runtime = await createResearchRuntime({
      dir,
      secureStorage: safeStorage,
      fetchImpl: smokeDir
        ? async () => {
            throw new Error("Outbound provider requests are disabled during native smoke.");
          }
        : undefined,
      xlsxWorkerPath: join(
        __dirname.replace(/app\.asar(?=[\\/])/, "app.asar.unpacked"),
        "research-xlsx-worker.js",
      ),
      chooseImport: async () => {
        if (smokeDir) return join(smokeDir, "original.synthetic.xlsx");
        const choice = await dialog.showOpenDialog({
          title: "Import original research document",
          properties: ["openFile"],
          filters: [
            { name: "Original documents", extensions: ["xlsx", "txt", "pdf", "docx", "pptx"] },
          ],
        });
        return choice.canceled ? null : (choice.filePaths[0] ?? null);
      },
      chooseExport: async (format, runId) => {
        if (smokeDir) return join(smokeDir, `research-export.${format}`);
        const choice = await dialog.showSaveDialog({
          title: "Export raw research",
          defaultPath: `${runId}.${format}`,
          filters: [{ name: format.toUpperCase(), extensions: [format] }],
        });
        return choice.canceled ? null : (choice.filePath ?? null);
      },
      publish: (run) => {
        for (const win of BrowserWindow.getAllWindows())
          if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.runUpdate, run);
      },
    });
    let shuttingDown = false;
    app.on("before-quit", (event) => {
      if (!shuttingDown) {
        event.preventDefault();
        shuttingDown = true;
        void runtime.shutdown().finally(() => app.quit());
      }
    });
    registerIpc(
      createHandlers({
        research: runtime.handlers,
        appInfo: () => ({
          version: app.getVersion(),
          platform: process.platform,
          dataDir: dir,
          isPackaged: app.isPackaged,
        }),
      }),
      isTrustedSender,
    );

    const win = createWindow();
    if (smokeDir) {
      void runSmoke(win, smokeDir).then(
        (code) => app.exit(code),
        (err) => {
          console.error("[smoke] crashed:", err);
          app.exit(1);
        },
      );
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch(() => {
    console.error(
      "ReqFlow startup failed; local state or secure storage could not be initialized.",
    );
    app.exit(1);
  });
