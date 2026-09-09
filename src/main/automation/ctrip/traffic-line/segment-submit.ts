import { list, postTrafficLineSoa, record, text, type TrafficLinePage } from "./client.js";

export type SegmentSubmitState =
  | { status: "missing" }
  | { status: "pending" }
  | { status: "succeeded" }
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
  if (result === "T") return { status: "succeeded" };
  if (result === "U") return { status: "pending" };
  if (result !== "F") throw new Error(`子产品资源提交返回未知状态「${result || "空"}」。`);
  const rejectedCityIds = list(payload.checkSegmentResultCities)
    .map((item) => text(record(item.city)?.cityId))
    .filter(Boolean);
  return {
    status: "failed",
    rejectedCityIds: [...new Set(rejectedCityIds)],
    message: messageText(payload.messages) || "VBK 未返回可用交通资源。",
  };
}

export async function waitForSegmentSubmit(
  page: TrafficLinePage,
  productId: string,
  options: {
    maxPolls?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    onProgress?: (attempt: number, maxPolls: number) => void;
  } = {},
): Promise<string[]> {
  // 一轮最长约 60 秒。超时后持久化为可恢复状态，下一次只读既有校验，
  // 不让界面无反馈地挂七分钟，也不重复提交仍在处理的写请求。
  const maxPolls = options.maxPolls ?? 40;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let missingResultPolls = 0;
  for (let attempt = 1; attempt <= maxPolls; attempt += 1) {
    const state = await readSegmentSubmitState(page, productId);
    if (state.status === "succeeded") return [];
    if (state.status === "failed") {
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
