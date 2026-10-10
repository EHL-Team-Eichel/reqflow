import { join } from "node:path";
import type { WorkflowRun } from "@reqflow/core";
import { IPC_EVENTS } from "@reqflow/core/ipc";
import { createFileStore } from "@reqflow/db";
import { app, BrowserWindow, dialog, shell, type IpcMainInvokeEvent } from "electron";
import { createHandlers } from "./handlers";
import { registerIpc } from "./ipc";
import { dataDir, loadDevEnv, uploadsDir } from "./paths";
import { parseSmokeArg, runSmoke } from "./smoke";

const smokeDir = parseSmokeArg(process.argv);

// One instance per user: two processes writing the same SQLite file would corrupt the audit trail.
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
      // The off-screen window is never shown, so Chromium would treat the page as hidden and
      // throttle painting; screenshots would then lag behind the page.
      backgroundThrottling: smokeDir === null,
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

  const devUrl = process.env.ELECTRON_RENDERER_URL;
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

void app.whenReady().then(() => {
  loadDevEnv();
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

  registerIpc(
    createHandlers({
      files,
      dataDir: dir,
      pushRunUpdate,
      pickFile: async () => {
        if (smokeDir) return smokePicks.shift() ?? null;
        const options: Electron.OpenDialogOptions = {
          title: "Choose an Excel or CSV file",
          properties: ["openFile"],
          filters: [{ name: "Spreadsheets", extensions: ["xlsx", "csv"] }],
        };
        const parent = BrowserWindow.getFocusedWindow();
        const result = parent
          ? await dialog.showOpenDialog(parent, options)
          : await dialog.showOpenDialog(options);
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
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
    void runSmoke(win, smokeDir, {
      files,
      samplesDir: join(app.getAppPath(), "../../data/samples"),
      bmwDir: join(app.getAppPath(), "../../data/raw"),
      queuePick: (path) => void smokePicks.push(path),
    }).then(
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
});
