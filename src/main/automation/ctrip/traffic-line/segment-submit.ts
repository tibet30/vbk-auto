import { list, postTrafficLineSoa, record, text, type TrafficLinePage } from "./client.js";

export type SegmentSubmitState =
  | { status: "missing" }
  | { status: "pending" }
  | { status: "succeeded"; removedDepartureCityCount?: number }
  | { status: "failed"; rejectedCityIds: string[]; message: string };

/**
 * `getSubmitSegmentsResult` 仅接受对应子产品资源页发起的会话上下文。
 * 交通阶段本身位于母产品编辑页，不能依赖当前 BrowserView URL。
 */
export function trafficLineResourcePageUrl(productId: string): string {
  return `https://vbooking.ctrip.com/product/input/newResourceRule?productid=${encodeURIComponent(productId)}&from=vbk`;
}

/** 只读查询既有班期校验，不会重提 submitSegments。 */
export async function readSegmentSubmitState(
  page: TrafficLinePage,
  productId: string,
): Promise<SegmentSubmitState> {
  let payload;
  try {
    payload = await postTrafficLineSoa(
      page,
      "15638",
      "getSubmitSegmentsResult",
      { productId },
      "读取子产品资源提交结果",
      {
        referrer: trafficLineResourcePageUrl(productId),
        referrerPolicy: "no-referrer-when-downgrade",
      },
    );
  } catch (error) {
    if (segmentValidationResultMissing(error)) return { status: "missing" };
    throw error;
  }
  const result = text(payload.result);
  const messages = messageText(payload.messages);
  if (result === "T") {
    const removed = messages.match(/出发城市中有(\d+)个城市不符合.*(?:火车票|航班).*自动移除/u)?.[1];
    return { status: "succeeded", ...(removed ? { removedDepartureCityCount: Number(removed) } : {}) };
  }
  if (result === "U") return { status: "pending" };
  if (result !== "F") throw new Error(`子产品资源提交返回未知状态「${result || "空"}」。`);
  const rejectedCityIds = list(payload.checkSegmentResultCities)
    .map((item) => text(record(item.city)?.cityId))
    .filter(Boolean);
  return {
    status: "failed",
    rejectedCityIds: [...new Set(rejectedCityIds)],
    message: [...new Set([messages, ...list(payload.checkSegmentResultCities).flatMap(item =>
      list(item.errors).map(error => `${text(error.schedule)}：${text(error.message).split("Message:")[0]}`))].filter(Boolean))].slice(0, 5).join("；") || "VBK 未返回可用交通资源。",
  };
}

export async function waitForSegmentSubmit(
  page: TrafficLinePage,
  productId: string,
  options: {
    submittedCityIds?: readonly string[];
    maxPolls?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    onProgress?: (attempt: number, maxPolls: number) => void;
    shouldStopWaiting?: () => boolean;
  } = {},
): Promise<string[]> {
  // 默认一轮约 60 秒；真实录入可提供更长预算并持续回报进度。
  // 全程只读既有校验；超时后持久化为可恢复状态，不重复提交处理中的写请求。
  const maxPolls = options.maxPolls ?? 40;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let missingResultPolls = 0;
  for (let attempt = 1; attempt <= maxPolls; attempt += 1) {
    const state = await readSegmentSubmitState(page, productId);
    if (state.status === "succeeded") {
      if (state.removedDepartureCityCount && state.removedDepartureCityCount === options.submittedCityIds?.length) {
        return [...options.submittedCityIds];
      }
      return [];
    }
    if (state.status === "pending" && options.shouldStopWaiting?.()) {
      throw new Error("子产品资源提交仍在 VBK 异步核验（持续超过恢复阈值）；未重复提交。");
    }
    if (state.status === "failed") {
      if (/提前预订|酒店不可订|酒店.*(?:无房|不可用)|用车|套餐|权限|登录|超时|异常/u.test(state.message)) {
        throw new Error(`子产品资源校验未通过（预订规则或地接资源问题，不能判定为无交通资源）：${state.message}`);
      }
      if (state.rejectedCityIds.length) return state.rejectedCityIds;
      throw new Error(`子产品资源提交未通过：${state.message}`);
    }
    if (state.status === "missing") {
      missingResultPolls += 1;
      if (missingResultPolls >= 5 || attempt === maxPolls) {
        throw new Error(`子产品资源提交后未启动班期校验，已只读确认 ${missingResultPolls} 次；未重复提交，可安全重试。`);
      }
    } else if (attempt === 1 || attempt % 10 === 0) {
      options.onProgress?.(attempt, maxPolls);
    }
    if (attempt < maxPolls) await sleep(Math.min(1_500, 500 * attempt));
  }
  throw new Error(`子产品资源提交仍在 VBK 异步核验（已只读查询 ${maxPolls} 次）；未重复提交，请稍后从 trafficLine 继续。`);
}

function segmentValidationResultMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("产品班期校验结果不存在") && message.includes("班期校验已经开始");
}

function messageText(value: unknown): string {
  return Array.isArray(value) ? value.map(text).filter(Boolean).join("；") : text(value);
}
