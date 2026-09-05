import { postTrafficLineSoa, record, type JsonRecord, type TrafficLinePage } from "./client.js";

export function manualRequiredClauseIdsByTab(payload: JsonRecord): Map<number, number[]> {
  if (!Array.isArray(payload.manualSaveClauseTipDtos)) {
    throw new Error("子产品必选条款响应缺少 manualSaveClauseTipDtos 数组。");
  }
  const result = new Map<number, number[]>();
  for (const rawTip of payload.manualSaveClauseTipDtos) {
    const tip = record(rawTip);
    if (!tip || !Array.isArray(tip.clauseItemIds)) {
      throw new Error("子产品必选条款响应包含无法解析的提示项。");
    }
    const tab = Number(tip.tabNum);
    const ids = tip.clauseItemIds.map(Number);
    if (!Number.isInteger(tab) || tab < 1 || tab > 4
      || !ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error("子产品必选条款响应包含非法页签或条款 ID。");
    }
    result.set(tab, [...new Set([...(result.get(tab) ?? []), ...ids])]);
  }
  return result;
}

/**
 * autoSaveRequiredTextClause 偶尔先只返回 Ack=Success，提示数组稍后才物化。
 * 该接口只带 productId，是平台的幂等必选项同步探针；仅对此缺字段结果
 * 有界重读。实测条款已收敛后服务会只返回 ResponseStatus，因此连续省略
 * 按“未给出新增提示”处理；最终仍须通过正式条款、绑定包和激活业务门。
 * 字段存在但结构畸形时仍立即失败。
 */
export async function readManualRequiredClauses(
  page: TrafficLinePage,
  productId: string,
  options: { maxMissingResponses?: number; sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<Map<number, number[]>> {
  const max = Math.max(1, Math.min(3, Math.floor(options.maxMissingResponses ?? 3)));
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= max; attempt += 1) {
    await postTrafficLineSoa(page, "20698", "getProductClause", {
      productId,
      onlyNeedId: true,
      needDraft: false,
      needMatched: false,
    }, "读取子产品正式条款");
    const payload = await postTrafficLineSoa(page, "20698", "autoSaveRequiredTextClause", {
      productId: Number(productId) || productId,
    }, "同步子产品平台必选文本条款");
    if (Object.hasOwn(payload, "manualSaveClauseTipDtos")) {
      return manualRequiredClauseIdsByTab(payload);
    }
    if (attempt < max) await sleep(attempt * 500);
  }
  return new Map();
}
