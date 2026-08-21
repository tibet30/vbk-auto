import path from "node:path";
import { BrowserWindow } from "electron";
import { logWarn } from "../shared/log-timestamp.js";
import { APP_NAME } from "../shared/brand.js";
import type { ProductDetail, Settings } from "../shared/contracts.js";
import { DraftAutomation } from "./automation/automation.js";
import type { VbkDatabase } from "./infrastructure/database/database.js";
import type { LocalVbkCookieStore } from "./infrastructure/vbk-cookie-store.js";
import { VbkBrowser } from "./infrastructure/vbk-browser.js";
import { installContentSecurityPolicy } from "./infrastructure/csp.js";
import type { MiniMaxService } from "./minimax/minimax.js";

interface CreateMainWindowArgs {
  db: VbkDatabase;
  cookieStore: LocalVbkCookieStore;
  root: string;
  isDev: boolean;
  debuggingPort: string;
  getSettings: () => Settings;
  aiService: (snapshot?: Settings) => Promise<MiniMaxService>;
  emitProduct: (product: ProductDetail) => void;
  onWindowCreated?: (window: BrowserWindow) => void;
  onServicesCreated?: (services: MainWindowServices) => void;
}

const devRendererUrl = process.env.VBK_RENDERER_URL?.trim() || "http://127.0.0.1:5173";

export interface MainWindowServices {
  window: BrowserWindow;
  browser: VbkBrowser;
  automation: DraftAutomation;
}

/** Create the renderer window and the services whose lifecycle belongs to it. */
export async function createMainWindow(args: CreateMainWindowArgs): Promise<MainWindowServices> {
  const window = new BrowserWindow({
    width: 1512,
    height: 982,
    minWidth: 1180,
    minHeight: 760,
    title: APP_NAME,
    backgroundColor: "#fafafa",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(args.root, "dist-electron", "main", "preload.cjs"),
    },
  });
  args.onWindowCreated?.(window);
  installContentSecurityPolicy(window.webContents.session);

  const sessions = args.cookieStore;
  const browser = new VbkBrowser(window, args.debuggingPort, {
    saveSession: (key, name, cookiesJson) => { sessions.saveSession(key, name, cookiesJson); },
    loadSession: (key) => sessions.loadSession(key),
    listSessions: () => sessions.listSessions(),
    deleteSession: (key) => { sessions.deleteSession(key); },
    getActiveAccountKey: () => args.db.getSetting("vbkActiveAccountKey")?.value,
    setActiveAccountKey: (key) => args.db.setSetting("vbkActiveAccountKey", key),
    clearActiveAccountKey: () => args.db.deleteSetting("vbkActiveAccountKey"),
  });
  const automation = new DraftAutomation(
    args.db,
    browser,
    args.emitProduct,
    async (request) => {
      args.getSettings();
      try {
        return await (await args.aiService()).diagnoseAutomationFailure(request);
      } catch (error) {
        logWarn("[recovery] advisor failed", {
          phase: request.phase,
          attempt: request.attempt,
          errorCode: (error as { code?: string }).code,
        });
        throw error;
      }
    },
    async (request) => {
      args.getSettings();
      try {
        return await (await args.aiService()).disambiguateOption(request);
      } catch (error) {
        logWarn("[disambiguator] failed", {
          kind: request.kind,
          desired: request.desired,
          errorCode: (error as { code?: string }).code,
        });
        throw error;
      }
    },
    async (request) => {
      args.getSettings();
      return (await args.aiService()).reply({ ...request, history: [] });
    },
  );
  const services = { window, browser, automation };
  // IPC handlers are registered before createMainWindow. Publish all service
  // references before loading the renderer, because its first React effect
  // immediately invokes browser:status / browser:setVisible.
  args.onServicesCreated?.(services);
  await browser.initialise();
  if (args.isDev) await window.loadURL(devRendererUrl);
  else await window.loadFile(path.join(args.root, "dist", "index.html"));
  void browser.waitUntilReady().then((ready) => {
    if (ready && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send("vbk:page-ready");
    }
  });
  return services;
}
