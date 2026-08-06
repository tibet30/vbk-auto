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
  fillItineraryDraft,
  ensureHotelResource,
  ensureVehicleResource,
  runProductPreflight,
  selectStationAddress,
} from "../ctrip/ctrip.js";
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
    desired: string;
    candidates: Array<{ id?: string; text: string }>;
    product: Record<string, unknown>;
  }) => Promise<{ pickedText: string | null; reasoning: string }>;
};

export function debugRunStep(context: DebugContext, stepName: string, argsJson: string): Promise<unknown> {
  return (async () => {
    const { db, browser, resolveButlerSelection, resolveServicePhone, ensureBrowserHasBounds } = context;
    resetBreakpoints();
    // debug 入口也走同样上 view 没上报 bounds 的兑底：保证 window.innerWidth
    // / innerHeight 是主窗口实际大小，否则 click 会超出 viewport。
    ensureBrowserHasBounds();
    const page = await browser.page();
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
      const projectId = typeof args.projectId === "string" ? args.projectId : null;
      if (!projectId) throw new Error("fillItineraryDraft 需要 projectId 参数");
      const project = db.getProject(projectId);
      if (!project) throw new Error(`项目不存在：${projectId}`);
      const product = parseProduct(project.product);
      await breakpoint("beforeFillItineraryDraft");
      const result = await fillItineraryDraft(page, product, { productId: project.productId });
      await breakpoint("afterFillItineraryDraft", { savedWith: result.savedWith });
      return result;
    }

    if (stepName === "fillRecommendationReasons") {
      const projectId = typeof args.projectId === "string" ? args.projectId : null;
      if (!projectId) throw new Error("fillRecommendationReasons 需要 projectId 参数");
      const project = db.getProject(projectId);
      if (!project) throw new Error(`项目不存在：${projectId}`);
      const product = parseProduct(project.product);
      if (!product.presentation?.recommendations?.length) throw new Error("项目 presentation.recommendations 为空");
      await breakpoint("beforeFillRecommendationReasons");
      await fillRecommendationReasons(page, product.presentation.recommendations);
      await breakpoint("afterFillRecommendationReasons");
      return { rows: product.presentation.recommendations.length };
    }

    if (stepName === "fillBasicInfo" || stepName === "fillPresentation") {
      const projectId = typeof args.projectId === "string" ? args.projectId : null;
      if (!projectId) throw new Error(`${stepName} 需要 projectId 参数`);
      const project = db.getProject(projectId);
      if (!project) throw new Error(`项目不存在：${projectId}`);
      const product = parseProduct(project.product);

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
        product,
        disambiguator: context.disambiguator,
      };

      if (stepName === "fillBasicInfo") {
        return await fillBasicInfo(page, product, butlerSelection, extra);
      }

      return await fillAndSavePresentation(page, product);
    }

    if (
      stepName === "fillAndSavePackage"
      || stepName === "fillAndSubmitPricingInventory"
      || stepName === "ensureHotelResource"
      || stepName === "ensureVehicleResource"
      || stepName === "runProductPreflight"
    ) {
      const projectId = typeof args.projectId === "string" ? args.projectId : null;
      if (!projectId) throw new Error(`${stepName} 需要 projectId 参数`);
      const project = db.getProject(projectId);
      if (!project) throw new Error(`项目不存在：${projectId}`);
      const product = parseProduct(project.product);

      if (stepName === "fillAndSavePackage") {
        return await fillAndSavePackage(page, product);
      }
      if (stepName === "fillAndSubmitPricingInventory") {
        return await fillAndSubmitPricingInventory(page, product, project.productId || "");
      }
      if (stepName === "ensureHotelResource") {
        return await ensureHotelResource(page, product, project.productId || "");
      }
      if (stepName === "ensureVehicleResource") {
        return await ensureVehicleResource(page, product, project.productId || "");
      }
      if (stepName === "runProductPreflight") {
        return await runProductPreflight(page, product, project.productId || "");
      }
    }

    throw new Error(
      `未知步骤：${stepName}；支持：snapshot / selectStationAddress / fillItineraryDraft / fillRecommendationReasons / fillAndSavePackage / fillAndSubmitPricingInventory / ensureHotelResource / ensureVehicleResource / runProductPreflight`,
    );
  })();
}

export async function debugSnapshot(context: DebugContext, label?: string): Promise<unknown> {
  // 调试快照也走 fallback： renderer 不上 stage=vbk 时 view 还是 0×0，
  // 取主窗口 size 重设一下，否则后续 click 也会超出 viewport。
  context.ensureBrowserHasBounds();
  const page = await context.browser.page();
  return snapshotDebug(page, label);
}

export function debugHitBreakpoints(): Promise<string[]> {
  return Promise.resolve([...getHitBreakpoints()]);
}

export function debugResume(command: "continue" | "step" | "stop"): Promise<{ stopped: boolean }> {
  return Promise.resolve(resumeDebug(command));
}

export function debugListBreakpoints(): Promise<string[]> {
  return Promise.resolve(listBreakpoints());
}
