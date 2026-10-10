import { chromium, type Browser, type Page } from "playwright";
import { logWarn } from "../../shared/log-timestamp.js";
import { selectUsableVbkPage, selectVbkPage } from "./vbk-page-selection.js";
import { attachVbkSessionFetch, observeVbkSessionFetch } from "./vbk-session-fetch-adapter.js";
import { ItineraryDraftCapture } from "./itinerary-draft-capture.js";
import { createVbkRequestPage, type VbkRequestPage } from "./vbk-request-page.js";
import type { VbkSessionNativeRequest } from "./vbk-session-request.js";
import type { VbkBrowserViewManager } from "./vbk-browser-view-manager.js";

const nativeDialogHandledPages = new WeakSet<Page>();

function isNoDialogShowingError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  return /Page\.handleJavaScriptDialog[\s\S]*No dialog is showing/.test(text);
}

function ensureNativeDialogHandler(page: Page): void {
  if (nativeDialogHandledPages.has(page)) return;
  nativeDialogHandledPages.add(page);
  page.on("dialog", (dialog) => {
    void dialog.accept().catch((error) => {
      if (isNoDialogShowingError(error)) return;
      return dialog.dismiss().catch((dismissError) => {
        if (isNoDialogShowingError(dismissError)) return;
        logWarn("[vbk-browser] native JS dialog auto-dismiss failed", {
          acceptError: error instanceof Error ? error.message : String(error),
          dismissError: dismissError instanceof Error ? dismissError.message : String(dismissError),
        });
      });
    });
  });
}

export class VbkBrowserPageDriver {
  readonly nativeOnly = true;
  private cdp?: Browser;
  private readonly itineraryDraftCapture = new ItineraryDraftCapture();
  private stopNativeItineraryDraftCapture?: () => void;

  constructor(
    private readonly views: VbkBrowserViewManager,
    private readonly debuggingPort: string,
    private readonly ensureReady: () => Promise<void>,
    private readonly ensureInitialPage: () => Promise<void>,
  ) {}

  async requestPage(): Promise<Page> {
    await this.ensureReady();
    const view = this.views.view;
    const key = this.views.activeKey;
    if (!view || view.webContents.isDestroyed()) throw new Error("VBK 账号会话尚未初始化");
    return createVbkRequestPage({
      session: view.webContents.session,
      assertActive: () => {
        if (this.views.view !== view || this.views.activeKey !== key || view.webContents.isDestroyed()) {
          throw new Error("VBK 账号已切换或会话已关闭，已阻止使用旧账号客户端");
        }
      },
      currentUrl: () => view.webContents.getURL(),
      interactivePage: () => this.page({ requireInteractive: true }),
    });
  }

  async vbkSessionFetch(request: VbkSessionNativeRequest) {
    return ((await this.requestPage()) as VbkRequestPage).vbkSessionFetch!(request);
  }

  async page(options: { requireInteractive?: boolean } = {}): Promise<Page> {
    await this.ensureReady();
    if (options.requireInteractive && (this.views.bounds.width <= 0 || this.views.bounds.height <= 0)) {
      const [width, height] = this.views.window.getSize();
      const editorWidth = Math.max(640, Math.round(width * 0.66));
      this.views.setBounds({ x: width - editorWidth, y: 0, width: editorWidth, height });
    }
    await this.ensureInitialPage();
    if (!this.cdp?.isConnected()) {
      this.cdp = await chromium.connectOverCDP(`http://127.0.0.1:${this.debuggingPort}`);
    }
    const pages = this.cdp.contexts().flatMap((context) => context.pages());
    const currentViewUrl = this.views.currentUrl();
    const page = options.requireInteractive
      ? await selectUsableVbkPage(
          pages,
          currentViewUrl,
          async (candidate) => candidate.evaluate(() => window.innerWidth > 0 && window.innerHeight > 0).catch(() => false),
        )
      : selectVbkPage(pages, currentViewUrl);
    if (!page) {
      throw new Error(options.requireInteractive
        ? "未找到可交互的嵌入式 VBK 页面，请打开 VBK 录入区域后重试。"
        : "未找到嵌入式 VBK 页面，请先登录 VBK 后重试。");
    }
    ensureNativeDialogHandler(page);
    const activeSession = this.views.view?.webContents.session;
    if (activeSession) attachVbkSessionFetch(page, activeSession);
    return page;
  }

  async armItineraryDraftCapture(productId: string) {
    const contents = this.views.view?.webContents;
    if (!contents) throw new Error("未找到当前 VBK 页面，无法开始行程草稿诊断。");
    const page = await this.page();
    const snapshot = await this.itineraryDraftCapture.arm(contents, productId, () => {
      this.stopNativeItineraryDraftCapture?.();
      this.stopNativeItineraryDraftCapture = undefined;
    });
    this.stopNativeItineraryDraftCapture = observeVbkSessionFetch(page, (exchange) => {
      this.itineraryDraftCapture.observeNative(
        exchange.endpoint,
        exchange.observedAt,
        exchange.requestBody,
        exchange.responsePayload,
      );
    });
    return snapshot;
  }

  readItineraryDraftCapture() { return this.itineraryDraftCapture.read(); }

  stopItineraryDraftCapture(): void {
    this.itineraryDraftCapture.dispose();
    this.stopNativeItineraryDraftCapture?.();
    this.stopNativeItineraryDraftCapture = undefined;
  }

  async dispose(): Promise<void> {
    this.stopItineraryDraftCapture();
    if (this.cdp?.isConnected()) await this.cdp.close().catch(() => {});
    this.cdp = undefined;
  }
}
