/**
 * 首轮 AI 规划完成后自动触发 VBK 用车资源组匹配的 helper（首轮 post-processing）。
 *
 * 设计动机：runAiReply 旧实现只在「researchTasks 含用车类标签」时调
 * resolveVehicleResource，导致 research task 没生成 / 已被人工 accept 时，
 * 资源组阶段永远不会被自动触发。本模块把「该不该跑」与「有没有 research task」
 * 解耦——只要产品数据自己指向「私家团 + 行程天数 + 上车城市」，就触发。
 *
 * 设计要点（参考 CLAUDE.md / AGENTS.md）：
 *   - 复用既有 resolveVehicleResource，不重写搜索逻辑；
 *   - 只在 requestedTotalCost 缺失时按产品数据估算（天数 / 上车城市 / 是否包车 /
 *     行程密度），写回前仅持久化 requestedTotalCost 一个字段，不碰
 *     resourceGroupId / resourceGroupName（真实 ID/Name 必须由 VBK 匹配回填）；
 *   - 黑名单约束（BLACKLISTED_VALUE_KEYS）由上层 stage-runner 守住：本模块只
 *     写 requestedTotalCost，其它业务字段绝不染指；AI 写入路径仍被禁止写
 *     resourceGroupId/Name；
 *   - 失败一律 console.info，不抛错：search 接口不稳 / VBK 未登录属常态，
 *     第一轮草稿本身已经可用；
 *   - 不打印 cookie / cookieorigin / ctok / 任何凭证字段；
 *   - 与现有自动化阶段共用同一个 BrowserView，不需要再开新会话。
 *
 * 导出：
 *   - shouldRunVehicleResourceResolution：纯函数，决定是否该触发（基于产品数据）；
 *   - estimateVehicleRequestedTotalCost：纯函数，按产品数据估全程用车总成本；
 *   - resolveRequestedTotalCostEstimate：把估算结果写回 product operations.vehicleResource
 *     的 requestedTotalCost（不触发搜索，调用方拿到结果后再决定是否调用 resolveVehicleResource）；
 *   - applyAutoVehicleResourceTrigger：串联「判断 → 估算 → 写 requestedTotalCost →
 *     调 resolveVehicleResource → 持久化」的异步入口，捕获所有抛错并以
 *     { written, reason } 返回，不阻塞 ai:send 主流程。
 */
import { logInfo } from "../../shared/log-timestamp.js";
import type { Page } from "playwright";
import type { ProductDetail } from "../../shared/contracts.js";
import {
  buildVehicleResourceQuery,
  resolveVehicleResource,
} from "./vehicle-resource.js";

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function positiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return null;
}

/**
 * 业务闸门：当前产品是不是「该跑用车资源组」？
 * 判定规则：
 *   - productForm 必须是 privateTour；
 *   - basicInfo.days >= 1；
 *   - operations.pickupCity 或 basicInfo.meetingCity / destinationCity 至少有一项非空；
 *   - operations.vehicleResource.resourceGroupId 还没被回填（已匹配过的不要重复跑）；
 *
 * 不依赖 researchTasks —— 用户没有生成用车研究任务 / 已人工 accept 时，本函数仍然返回 true。
 */
export function shouldRunVehicleResourceResolution(product: Record<string, unknown>): boolean {
  const sales = safeObject(product.sales);
  if (textValue(sales?.productForm) !== "privateTour") return false;
  const basic = safeObject(product.basicInfo);
  const days = positiveInteger(basic?.days);
  if (!days) return false;
  const operations = safeObject(product.operations);
  const vehicle = safeObject(operations?.vehicleResource);
  if (positiveInteger(vehicle?.resourceGroupId)) return false;
  const pickupCity = textValue(operations?.pickupCity)
    || textValue(basic?.meetingCity)
    || textValue(basic?.destinationCity);
  if (!pickupCity) return false;
  return true;
}

/**
 * 按产品数据估算整段行程的预计用车总成本（人民币）。
 *
 * 启发式（与现有 operations 内 AI 草稿口径一致）：
 *   - 基础价 700 元 / 天；
 *   - 行程天数 ≥ 3 天 + 包车（transport === "charter" 或默认） + 多景点：+100 元；
 *   - 长途（pickupCity 与 destinationCity 不同）：+150 元；
 *   - 高强度行程：itinerary 中 spots 总数 / days >= 3 → +100 元；
 *   - 先得到单日基础成本，再乘完整行程天数，最后取整到 50 元档位。
 *
 * 输入字段缺任何一项都视作中性输入；不会抛错。返回 undefined 表示数据不足以估算。
 */
export function estimateVehicleRequestedTotalCost(product: Record<string, unknown>): number | null {
  if (!shouldRunVehicleResourceResolution(product)) return null;
  const basic = safeObject(product.basicInfo) ?? {};
  const operations = safeObject(product.operations) ?? {};
  const days = positiveInteger(basic.days);
  if (!days) return null;

  let dailyCost = 700;

  const pickupCity = textValue(operations.pickupCity) || textValue(basic.meetingCity) || "";
  const destinationCity = textValue(basic.destinationCity) || "";
  if (pickupCity && destinationCity && pickupCity !== destinationCity) {
    dailyCost += 150;
  }

  // transport 含 charter/private 视为「真包车」，更高单价。
  const transport = textValue(operations.transport);
  if (/包车|charter|private/i.test(transport)) {
    dailyCost += 100;
  }

  // 行程强度：spots 总数 / 天数 ≥ 3 → 每天 +100 元。
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary as Array<Record<string, unknown>> : [];
  let spotCount = 0;
  for (const day of itinerary) {
    const dayRecord = safeObject(day);
    const spots = Array.isArray(dayRecord?.spots) ? dayRecord.spots : [];
    spotCount += spots.length;
  }
  if (days > 0 && spotCount / days >= 3) {
    dailyCost += 100;
  }

  // 长行程：3 天及以上默认 +50 元。
  if (days >= 3) {
    dailyCost += 50;
  }

  // 向上取整到 50 元档（与 vehicle-resource.ts 同步）。
  const rounded = Math.ceil((dailyCost * days) / 50) * 50;
  return rounded;
}

/**
 * 把估算结果写回 product.operations.vehicleResource.requestedTotalCost；
 * 只在以下条件同时成立时写：
 *   - businessOk(shouldRunVehicleResourceResolution) === true；
 *   - 估算有结果（estimateVehicleRequestedTotalCost 返回 number）；
 *   - 现有 vehicleResource 缺 requestedTotalCost 或为非法值；
 *   - 用户没主动 cleared（requestedTotalCostCleared !== true）；
 *
 * 副作用：不动 vehicleResource 其它字段，不动 product 其它子树。
 */
export function resolveRequestedTotalCostEstimate(product: Record<string, unknown>): Record<string, unknown> {
  if (!shouldRunVehicleResourceResolution(product)) return product;
  const operations = safeObject(product.operations) ?? {};
  const vehicle = safeObject(operations.vehicleResource) ?? {};
  const days = positiveInteger(safeObject(product.basicInfo)?.days) || 1;
  const legacyDailyCost = positiveNumber(vehicle.requestedDailyCost);
  const legacyFieldsPresent = "requestedDailyCost" in vehicle || "requestedDailyCostCleared" in vehicle;
  const canonicalTotalCost = positiveNumber(vehicle.requestedTotalCost);

  // 历史产品可能同时带有 requestedDailyCost / requestedDailyCostCleared。
  // 这里是唯一的兼容迁移点：读取时乘 basicInfo.days，随后立即删除旧字段，
  // 不让新 payload 同时承载日价和全程总价两套语义。
  if (legacyFieldsPresent) {
    const nextVehicle = { ...vehicle };
    delete nextVehicle.requestedDailyCost;
    delete nextVehicle.requestedDailyCostCleared;

    if (vehicle.requestedDailyCostCleared === true) {
      delete nextVehicle.requestedTotalCost;
      nextVehicle.requestedTotalCostCleared = true;
    } else if (!canonicalTotalCost && legacyDailyCost) {
      nextVehicle.requestedTotalCost = Math.ceil((legacyDailyCost * days) / 50) * 50;
    } else if (canonicalTotalCost) {
      nextVehicle.requestedTotalCost = canonicalTotalCost;
    }

    return {
      ...product,
      operations: {
        ...operations,
        vehicleResource: nextVehicle,
      },
    };
  }

  if (vehicle.requestedTotalCostCleared === true || canonicalTotalCost) return product;
  const estimate = estimateVehicleRequestedTotalCost(product);
  if (!estimate) return product;
  return {
    ...product,
    operations: {
      ...operations,
      vehicleResource: {
        ...vehicle,
        requestedTotalCost: estimate,
      },
    },
  };
}

export interface AutoVehicleTriggerOutcome {
  /** 是否真的把 product 写回（estimatedTotalCost 写入或 VBK 资源组回填）。 */
  written: boolean;
  /** 没写时的简短原因（不会含任何敏感字段）。 */
  reason: string;
  /** 是否仅写入了 requestedTotalCost（未调 VBK / 未命中）。 */
  estimatedTotalCost?: number;
  /** 真实命中的 resourceGroupId（仅在 VBK 命中时存在）。 */
  resourceGroupId?: number;
}

/**
 * 主入口：runAiReply 在写入第一版产品之后调用一次。
 *
 * 输入：
 *   - page：main 进程侧 VbkBrowser.page() 的引用；浏览器已经登录；
 *   - product：当前持久化的产品（resolvedVehicleResource 需要 ProductDetail 形状）。
 *
 * 输出：
 *   - nextProduct：可能被改写的产品（written=false 时与传入基本相等）；
 *   - outcome：诊断信息，便于上层 console.info 跟踪；
 *
 * 行为约束：
 *   - shouldRunVehicleResourceResolution === false → 直接返回，不搜；
 *   - requestedTotalCost 缺失时先用 resolveRequestedTotalCostEstimate 估算并持久化，
 *     然后再调 resolveVehicleResource；任何抛错都被捕获，不影响 ai:send 主流程；
 *   - 不打印 cookie / cookieorigin / 任何凭证字段。
 */
export async function applyAutoVehicleResourceTrigger(args: {
  page: Page;
  product: ProductDetail;
}): Promise<{ nextProduct: ProductDetail; outcome: AutoVehicleTriggerOutcome }> {
  const product = args.product;
  const productData = product.product;
  if (!shouldRunVehicleResourceResolution(productData)) {
    return { nextProduct: product, outcome: { written: false, reason: "产品数据未指向私家团用车，跳过自动触发" } };
  }

  // 估算并持久化 requestedTotalCost（仅这一项）。
  const withEstimate = resolveRequestedTotalCostEstimate(productData);
  const estimateValue = (() => {
    const ops = safeObject(withEstimate.operations);
    const vehicle = safeObject(ops?.vehicleResource);
    return positiveNumber(vehicle?.requestedTotalCost);
  })();

  // 估算写入后立即调真实匹配：resolveVehicleResource 会用 requestedTotalCost
  // 作为搜索关键词的一部分，再由 bestResourceGroup 把最接近的资源组挑出来。
  let resolveResult: Awaited<ReturnType<typeof resolveVehicleResource>> | null = null;
  try {
    resolveResult = await resolveVehicleResource(args.page, {
      ...product,
      product: withEstimate,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 估算写回了也算 partial success，把估算值带回去；调用方视情况落库。
    return {
      nextProduct: { ...product, product: withEstimate },
      outcome: {
        written: Boolean(estimateValue),
        reason: `resolveVehicleResource 失败：${message.slice(0, 200)}`,
        estimatedTotalCost: estimateValue ?? undefined,
      },
    };
  }

  const nextProduct: ProductDetail = {
    ...product,
    product: resolveResult.product,
  };

  if (!resolveResult.resolved) {
    return {
      nextProduct,
      outcome: {
        written: true,
        reason: resolveResult.note,
        estimatedTotalCost: estimateValue ?? undefined,
      },
    };
  }

  return {
    nextProduct,
    outcome: {
      written: true,
      reason: resolveResult.note,
      estimatedTotalCost: estimateValue ?? undefined,
      resourceGroupId: resolveResult.resolved.resourceGroupId,
    },
  };
}

/**
 * 复用 buildVehicleResourceQuery 给其它模块（自动化阶段）做 query 计算；
 * 这里只 re-export 便于单测聚焦在 trigger 层。
 */
export { buildVehicleResourceQuery };
