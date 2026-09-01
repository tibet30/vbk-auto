import { logInfo } from "../../shared/log-timestamp.js";
import { applyAutoVehicleResourceTrigger } from "../operations/vehicle-resource-trigger.js";
import { applyManualReviewField } from "../operations/manual-review-field.js";
import { productNotFound } from "../infrastructure/db-errors.js";
import type { MainIpcContext } from "./context.js";

export function isVehicleResourceOnlyMessage(message: string): boolean {
  const text = message.replace(/\s+/g, "");
  if (!text) return false;
  // 「保留现有用车」常出现在一次完整方案修订的保护条件里，不能因为
  // “匹配 … 用车”恰好落在短窗口内，就吞掉用户要求修改行程的主诉。
  // 仅排除明确的否定句（如“不要修改行程”），保留用车专项场景。
  const textWithoutExplicitItineraryExclusions = text.replace(
    /(?:不要|不用|不必|无需|别|勿).{0,3}(?:修改|更新|变更|调整|重做|重新生成|规划)?(?:行程|景点|POI|itinerary)/gi,
    "",
  );
  const changesItinerary =
    /(?:修改|更新|修复|变更|调整|重做|重新生成|重新规划|编排|安排|替换|添加|删除).{0,14}(?:行程|景点|POI|itinerary)/i.test(textWithoutExplicitItineraryExclusions)
    || /(?:行程|景点|POI|itinerary).{0,14}(?:修改|更新|修复|变更|调整|重做|重新生成|重新规划|编排|安排|替换|添加|删除)/i.test(textWithoutExplicitItineraryExclusions);
  if (changesItinerary) return false;
  const hasVehicleResourceIntent =
    /(用车|车辆|接送|司机|车).{0,12}(资源组|总成本|成本|预算|匹配|搜索|申请|生成|估算)/.test(text)
    || /(资源组|总成本|成本|预算|匹配|搜索|申请|生成|估算).{0,12}(用车|车辆|接送|司机|车)/.test(text);
  if (!hasVehicleResourceIntent) return false;
  const broadPlanningIntent = /(完整|全部|整体|重新规划|重做产品|补全产品|全量|一键).{0,8}(生成|补全|规划|重做|更新)/.test(text);
  return !broadPlanningIntent;
}

export function extractVehicleTotalCost(message: string): number | null {
  const text = message.replace(/[,，]/g, "");
  const candidates = Array.from(text.matchAll(/(\d+(?:\.\d+)?)\s*(万|千|元|块)?/g))
    .map((match) => {
      const amount = Number(match[1]);
      if (!Number.isFinite(amount) || amount <= 0) return null;
      const unit = match[2] ?? "";
      const value = unit === "万" ? amount * 10000 : unit === "千" ? amount * 1000 : amount;
      return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
    })
    .filter((value): value is number => value !== null);
  if (candidates.length === 0) return null;
  return candidates.find((value) => value >= 100) ?? candidates[0];
}

export async function tryHandleVehicleResourceOnlyRequest(args: {
  context: MainIpcContext;
  localProductId: string;
  message: string;
  userMessageId: string;
}): Promise<boolean> {
  const { context, localProductId, message, userMessageId } = args;
  if (!isVehicleResourceOnlyMessage(message)) return false;

  const { db, productMutations, emitProduct } = context;
  let product = db.getProduct(localProductId);
  if (!product) throw productNotFound(localProductId);

  const requestedTotalCost = extractVehicleTotalCost(message);
  if (requestedTotalCost !== null) {
    const nextJson = applyManualReviewField(product.product, {
      field: "vehicleResource",
      requestedTotalCost,
    });
    product = productMutations.replace(localProductId, nextJson, { status: "review", notify: false });
  }

  const login = await context.productWorkflows.runVbkPageExclusive(() => context.browser.status());
  if (!login.loggedIn) {
    db.updateMessageStatus(localProductId, userMessageId, "succeeded");
    db.addMessage(
      localProductId,
      "assistant",
      requestedTotalCost !== null
        ? `已保存全程用车总成本 ${requestedTotalCost} 元；请先登录 VBK，再搜索用车资源组。`
        : "这次只处理用车资源组，不会修改行程。请先登录 VBK，再搜索用车资源组。",
      "succeeded",
    );
    emitProduct(db.getProduct(localProductId)!);
    return true;
  }

  const result = await context.productWorkflows.runVbkPageExclusive(async () =>
    applyAutoVehicleResourceTrigger({
      page: await context.browser.page(),
      product,
    }));
  if (result.outcome.written) {
    productMutations.replace(localProductId, result.nextProduct.product, { status: "review", notify: false });
    if (result.outcome.resourceGroupId) {
      for (const task of result.nextProduct.researchTasks) {
        if (task.state !== "confirmed" && task.state !== "resolved" && /用车|车辆|资源组|接送|司机/.test(task.label || "")) {
          db.markResearchAccepted(localProductId, task.id, result.outcome.reason, "vbk");
        }
      }
    }
  }

  db.updateMessageStatus(localProductId, userMessageId, "succeeded");
  const status = result.outcome.resourceGroupId ? "succeeded" : "failed";
  db.addMessage(
    localProductId,
    "assistant",
    result.outcome.resourceGroupId
      ? `已单独搜索并匹配用车资源组，行程没有重新生成：${result.outcome.reason}`
      : `这次只处理用车资源组，行程没有重新生成；但资源组暂未匹配成功：${result.outcome.reason}`,
    status,
  );
  logInfo("[ai:send] handled vehicle-resource-only request without itinerary patch", {
    localProductId,
    resourceGroupId: result.outcome.resourceGroupId,
    estimatedTotalCost: result.outcome.estimatedTotalCost,
  });
  emitProduct(db.getProduct(localProductId)!);
  return true;
}
