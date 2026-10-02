import type { ProductDetail } from "../../shared/contracts.js";
import type { VbkBrowser } from "../infrastructure/vbk-browser.js";
import { readItineraryDraftDiagnostic } from "../automation/ctrip/itinerary-api/draft-diagnostics.js";
import type { AgentTool } from "./types.js";

export interface ItineraryDraftToolDependencies {
  browserFor(): VbkBrowser;
  get(localProductId: string): ProductDetail;
  withPage<T>(work: () => Promise<T>): Promise<T>;
}

function safeJson(value: unknown): string { return JSON.stringify(value); }
const MAX_CAPTURE_CONTENT_LENGTH = 10_000;

function compactCapture(value: ReturnType<VbkBrowser["readItineraryDraftCapture"]>) {
  if (!value) return null;
  const compactPayload = (payload: typeof value.payload) => payload && ({
    saveType: payload.saveType, versionValues: payload.versionValues, protocolValues: payload.protocolValues,
  });
  const exchanges = value.exchanges ?? [];
  const candidates = exchanges.slice(-12).map((exchange) => ({
    step: exchange.step, endpointName: exchange.endpointName, serviceId: exchange.serviceId, source: exchange.source,
    observedAt: exchange.observedAt, responseAt: exchange.responseAt, requestFieldNames: exchange.requestFieldNames,
    request: compactPayload(exchange.request), response: compactPayload(exchange.response),
  }));
  const base = {
    armedAt: value.armedAt, productId: value.productId, capturedAt: value.capturedAt,
    complete: value.complete, missingSteps: value.missingSteps, stoppedAt: value.stoppedAt, stopReason: value.stopReason,
  };
  const retained: typeof candidates = [];
  for (const exchange of [...candidates].reverse()) {
    const next = [exchange, ...retained];
    const omittedExchangeCount = exchanges.length - next.length;
    if (safeJson({ ...base, ...(omittedExchangeCount ? { omittedExchangeCount } : {}), exchanges: next }).length > MAX_CAPTURE_CONTENT_LENGTH) break;
    retained.unshift(exchange);
  }
  const omittedExchangeCount = exchanges.length - retained.length;
  return { ...base, ...(omittedExchangeCount ? { omittedExchangeCount } : {}), exchanges: retained };
}

async function assertBoundReadAccount(browser: VbkBrowser, product: ProductDetail): Promise<void> {
  const login = await browser.status(true);
  const account = login.loginAccount?.trim() || login.accountName?.trim();
  if (!login.loggedIn || !account) throw new Error("请先登录产品绑定的 VBK 账号再进行行程草稿诊断。");
  if (product.vbkAccount && product.vbkAccount !== account) {
    throw new Error("当前 VBK 账号与产品绑定账号不一致，不能读取或捕获行程草稿。");
  }
}

/** Operator-facing capture: the only write remains the operator's normal UI save click. */
export function createItineraryDraftTools(deps: ItineraryDraftToolDependencies): AgentTool[] {
  return [{
    name: "capture_itinerary_draft_save",
    description: "开始或读取一次性只读行程草稿保存诊断。开始后由运营人员在 VBK 页面正常点击“存为草稿”，再读取 saveType、版本 ID 与状态；不记录 Cookie、请求头或完整 URL。",
    parameters: { type: "object", properties: { action: { enum: ["arm", "read"] } }, required: ["action"] },
    async execute(args, ctx) {
      const browser = deps.browserFor();
      if (!browser) throw new Error("VBK 浏览器尚未初始化，请稍后重试行程草稿诊断。");
      const product = deps.get(ctx.localProductId);
      if (!product.productId) throw new Error("当前产品尚未创建 VBK 产品，无法绑定行程草稿保存诊断。");
      return deps.withPage(async () => {
        await assertBoundReadAccount(browser, product);
        if (args.action === "read") {
          const capture = browser.readItineraryDraftCapture();
          if (capture && capture.productId !== product.productId) {
            throw new Error("当前产品没有可读取的行程草稿捕获；上一产品的诊断不会跨产品展示。");
          }
          browser.stopItineraryDraftCapture();
          return { content: safeJson(compactCapture(browser.readItineraryDraftCapture())) };
        }
        if (args.action !== "arm") throw new Error("action 必须是 arm 或 read。");
        return { content: safeJson(await browser.armItineraryDraftCapture(product.productId!)) };
      });
    },
  }, {
    name: "read_itinerary_draft_diagnostic",
    description: "只读读取当前产品 formal、draft、audit、preview 行程 ID，并逐版核对广济桥（POI 85862）的 suffixName 与 description；不会推断平台状态枚举或写入平台。",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      const browser = deps.browserFor();
      if (!browser) throw new Error("VBK 浏览器尚未初始化，请稍后重试行程版本诊断。");
      const product = deps.get(ctx.localProductId);
      if (!product.productId) throw new Error("当前产品尚未创建 VBK 产品，无法读取行程版本诊断。");
      return deps.withPage(async () => {
        await assertBoundReadAccount(browser, product);
        const page = await browser.page();
        return { content: safeJson(await readItineraryDraftDiagnostic(page, product.productId!)) };
      });
    },
  }];
}
