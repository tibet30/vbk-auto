/**
 * 「Debug」IPC 入口：debugRunStep / debugSnapshot / debugHitBreakpoints / debugResume /
 * debugListBreakpoints。
 *   - debugRunStep：根据 stepName 字符串分派到具体 ctrip / schema helper，按需挂断点；
 *   - debugSnapshot：触发一次调试快照；
 *   - debugHitBreakpoints / debugResume / debugListBreakpoints：调试状态读写。
 *
 * 全部强制调 ensureBrowserHasBounds 免于 renderer 上 view 没上报 bounds 导致 click 越界。
 */

import { parseProduct } from "../schema/schema.js";
import {
  resetBreakpoints,
  getHitBreakpoints,
  listBreakpoints,
  resume as resumeDebug,
  snapshot as snapshotDebug,
} from "../debug.js";
import {
  fillAndSavePackage,
  fillAndSubmitPricingInventory,
  fillAndSavePresentation,
  fillBasicInfo,
  fillRecommendationReasons,
  ensureHotelResource,
  ensureVehicleResource,
  runProductPreflight,
  selectStationAddress,
} from "../ctrip/ctrip.js";
import { fillItineraryDraftApi } from "../ctrip/itinerary/api-entry.js";
import { breakpoint } from "../debug.js";
import type { VbkDatabase } from "../../infrastructure/database/database.js";
import type { VbkBrowser } from "../../infrastructure/vbk-browser.js";
import type { ContactCardSelection } from "../../../shared/contracts.js";

type DebugContext = {
  db: VbkDatabase;
  browser: VbkBrowser;
  resolveButlerSelection: (accountName: string | undefined) => ContactCardSelection | null;
  resolveServicePhone: (accountName: string | undefined) => string | null;
  ensureBrowserHasBounds: () => void;
  disambiguator?: (req: {
    kind: "province" | "city" | "spot" | "station";
    stationSubtype?: "airport" | "train";
    desired: string;
    candidates: Array<{ id?: string; text: string }>;
    product: Record<string, unknown>;
  }) => Promise<{ pickedText: string | null; reasoning: string }>;
};

/**
 * 按 stepName 字符串分派到具体 helper：
 *   - snapshot / selectStationAddress / fillItineraryDraft / fillRecommendationReasons
 *     / fillBasicInfo / fillPresentation 走带断点的版本；
 *   - fillItineraryDraft 走全量接口保存路径（fillItineraryDraftApi），不再
 *     使用 DOM 写入，避免重复出现「DOM 看起来成功但接口没保存」的误报；
 *   - fillAndSavePackage / fillAndSubmitPricingInventory / ensureHotelResource /
 *     ensureVehicleResource / runProductPreflight 走日常 helper；
 * 未知名直接抛「未知步骤」并列出支持列表。
 */
export function debugRunStep(context: DebugContext, stepName: string, argsJson: string): Promise<unknown> {
  return (async () => {
    const { db, browser, resolveButlerSelection, resolveServicePhone, ensureBrowserHasBounds } = context;
    resetBreakpoints();
    // debug 入口也走同样上 view 没上报 bounds 的兑底：保证 window.innerWidth
    // / innerHeight 是主窗口实际大小，否则 click 会超出 viewport。
    ensureBrowserHasBounds();
    const page = await browser.page({ requireInteractive: true });
    const args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
    const cardSelector = typeof args.cardSelector === "string" ? args.cardSelector : null;

    if (stepName === "snapshot") {
      return snapshotDebug(page, typeof args.label === "string" ? args.label : "manual");
    }

    if (stepName === "selectStationAddress") {
      if (!cardSelector) throw new Error("selectStationAddress 需要 cardSelector 参数");
      const card = page.locator(cardSelector).first();
      const city = typeof args.city === "string" ? args.city : "大同";
      await breakpoint("beforeSelectStationAddress", { cardSelector, city });
      const result = await selectStationAddress(page, card, city) as unknown as { matched?: boolean; source?: string; reason?: string };
      await breakpoint("afterSelectStationAddress", { city });
      return { ok: result?.matched === true, city, source: result?.source || "unknown", reason: result?.reason || null };
    }

    if (stepName === "fillItineraryDraft") {
      const localProductId = typeof args.localProductId === "string" ? args.localProductId : null;
      if (!localProductId) throw new Error("fillItineraryDraft 需要 localProductId 参数");
      const product = db.getProduct(localProductId);
      if (!product) throw new Error(`产品不存在：${localProductId}`);
      const productData = parseProduct(product.product);
      await breakpoint("beforeFillItineraryDraft");
      // 全量接口保存：DOM 写入路径已废弃，避免误报成功。
      const result = await fillItineraryDraftApi(page, productData, { productId: product.productId });
      await breakpoint("afterFillItineraryDraft", { savedWith: result.savedWith });
      return result;
    }

    if (stepName === "fillRecommendationReasons") {
      const localProductId = typeof args.localProductId === "string" ? args.localProductId : null;
      if (!localProductId) throw new Error("fillRecommendationReasons 需要 localProductId 参数");
      const product = db.getProduct(localProductId);
      if (!product) throw new Error(`产品不存在：${localProductId}`);
      const productData = parseProduct(product.product);
      if (!productData.presentation?.recommendations?.length) throw new Error("产品 presentation.recommendations 为空");
      await breakpoint("beforeFillRecommendationReasons");
      await fillRecommendationReasons(page, productData.presentation.recommendations);
      await breakpoint("afterFillRecommendationReasons");
      return { rows: productData.presentation.recommendations.length };
    }

    if (stepName === "fillBasicInfo" || stepName === "fillPresentation") {
      const localProductId = typeof args.localProductId === "string" ? args.localProductId : null;
      if (!localProductId) throw new Error(`${stepName} 需要 localProductId 参数`);
      const product = db.getProduct(localProductId);
      if (!product) throw new Error(`产品不存在：${localProductId}`);
      const productData = parseProduct(product.product);

      // 账号固定信息（管家联系人 / 400 电话）始终从本机账号设置读取，
      // 不再从 product.accountInfo 取。
      const accountName = db.getSetting("vbkAccountName")?.value;
      const butlerSelection = resolveButlerSelection(accountName);
      const servicePhone = resolveServicePhone(accountName) ?? "";
      if (stepName === "fillBasicInfo") {
        if (!butlerSelection) throw new Error("管家联系人未在账号设置里维护，无法 fillBasicInfo。");
        if (!servicePhone) throw new Error("线上 400 电话未在账号设置里维护，无法 fillBasicInfo。");
      }

      const extra = {
        servicePhone,
        product: productData,
        disambiguator: context.disambiguator,
      };

      if (stepName === "fillBasicInfo") {
        return await fillBasicInfo(page, productData, butlerSelection, extra);
      }

      return await fillAndSavePresentation(page, productData);
    }

    if (
      stepName === "fillAndSavePackage"
      || stepName === "fillAndSubmitPricingInventory"
      || stepName === "ensureHotelResource"
      || stepName === "ensureVehicleResource"
      || stepName === "runProductPreflight"
    ) {
      const localProductId = typeof args.localProductId === "string" ? args.localProductId : null;
      if (!localProductId) throw new Error(`${stepName} 需要 localProductId 参数`);
      const product = db.getProduct(localProductId);
      if (!product) throw new Error(`产品不存在：${localProductId}`);
      const productData = parseProduct(product.product);

      if (stepName === "fillAndSavePackage") {
        return await fillAndSavePackage(page, productData);
      }
      if (stepName === "fillAndSubmitPricingInventory") {
        return await fillAndSubmitPricingInventory(page, productData, product.productId || "");
      }
      if (stepName === "ensureHotelResource") {
        return await ensureHotelResource(page, productData, product.productId || "");
      }
      if (stepName === "ensureVehicleResource") {
        return await ensureVehicleResource(page, productData, product.productId || "");
      }
      if (stepName === "runProductPreflight") {
        return await runProductPreflight(page, productData, product.productId || "");
      }
    }

    throw new Error(
      `未知步骤：${stepName}；支持：snapshot / selectStationAddress / fillItineraryDraft / fillRecommendationReasons / fillAndSavePackage / fillAndSubmitPricingInventory / ensureHotelResource / ensureVehicleResource / runProductPreflight`,
    );
  })();
}

/**
 * 触发调试快照；先 ensureBrowserHasBounds 再取主窗口 size，否则 click 越界。
 */
export async function debugSnapshot(context: DebugContext, label?: string): Promise<unknown> {
  // 调试快照也走 fallback： renderer 不上 stage=vbk 时 view 还是 0×0，
  // 取主窗口 size 重设一下，否则后续 click 也会超出 viewport。
  context.ensureBrowserHasBounds();
  const page = await context.browser.page({ requireInteractive: true });
  return snapshotDebug(page, label);
}

/**
 * 返回当前已命中的断点数组（Promise.resolve 是因为实现是同步）。
 */
export function debugHitBreakpoints(): Promise<string[]> {
  return Promise.resolve([...getHitBreakpoints()]);
}

/**
 * 转发调试 resume 命令（continue / step / stop）；stopped 表示是否真的停下手。
 */
export function debugResume(command: "continue" | "step" | "stop"): Promise<{ stopped: boolean }> {
  return Promise.resolve(resumeDebug(command));
}

/**
 * 返回当前已设置的断点名称列表（Promise.resolve 是因为实现是同步）。
 */
export function debugListBreakpoints(): Promise<string[]> {
  return Promise.resolve(listBreakpoints());
}
