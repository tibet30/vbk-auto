import type { TrafficLineVariant } from "../../../../shared/contracts-traffic-line.js";
import {
  desiredFirstTabClauses,
  readClausePackage,
  selectedClauseItems,
} from "./clauses.js";
import { readManualRequiredClauses } from "./clause-required.js";
import { list, positiveId, postTrafficLineSoa, record, type JsonRecord, type TrafficLinePage } from "./client.js";

export class TrafficLineClauseReadbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrafficLineClauseReadbackError";
  }
}

/**
 * 最终条款门：用两次 get -> autoSave 幂等同步探针让平台完成必选项重算，再核对四个
 * 已绑定条款包中的选中项均已进入正式条款。这里只在业务回读不完整时
 * 抛可修复错误；会话或协议错误保持原错误，禁止据此盲目重写。
 */
export async function verifyTrafficLineClauses(
  page: TrafficLinePage,
  productId: string,
  variant: TrafficLineVariant,
  options: { syncRequired?: boolean } = {},
): Promise<{ formalClauseCount: number; expectedClauseCount: number }> {
  if (options.syncRequired !== false) {
    for (let probe = 1; probe <= 2; probe += 1) {
      const pending = await readManualRequiredClauses(page, productId);
      if (pending.size) {
        throw new TrafficLineClauseReadbackError(`子产品最终条款回读仍有平台必选项待保存：${formatPending(pending)}。`);
      }
    }
  }
  // syncRequired=false 用于激活后的稳定采样，必须保持纯读。
  const formal = await readFormalClauses(
    page,
    productId,
    options.syncRequired === false ? "稳定回读子产品正式条款" : "同步后回读子产品正式条款",
  );

  const expectedIds = new Set<number>();
  for (const tabEnum of [1, 2, 3, 4]) {
    const payload = await postTrafficLineSoa(
      page, "15638", "listProductClauses", { productId, tabEnum }, `最终回读子产品条款页签 ${tabEnum}`,
    );
    const central = record(payload.centralDataDto);
    if (!central || !positiveId(central.clausePackageId)) {
      throw new Error(`子产品最终条款页签 ${tabEnum} 缺少已绑定 clausePackageId。`);
    }
    const clausePackage = await readClausePackage(page, central);
    const selected = selectedClauseItems(clausePackage);
    const desired = tabEnum === 1
      ? desiredFirstTabClauses(clausePackage, selected, variant)
      : selected;
    desired.forEach((item) => expectedIds.add(Number(item.clauseItemId)));
  }

  const formalIds = new Set(list(formal.formalDtos).map((item) => Number(item.clauseItemId)));
  const missing = [...expectedIds].filter((id) => !formalIds.has(id));
  if (missing.length) {
    throw new TrafficLineClauseReadbackError(`子产品最终正式条款回读缺少：${missing.join("、")}。`);
  }
  return { formalClauseCount: formalIds.size, expectedClauseCount: expectedIds.size };
}

function readFormalClauses(page: TrafficLinePage, productId: string, label: string): Promise<JsonRecord> {
  return postTrafficLineSoa(page, "20698", "getProductClause", {
    productId,
    onlyNeedId: true,
    needDraft: false,
    needMatched: false,
  }, label);
}

function formatPending(value: ReadonlyMap<number, readonly number[]>): string {
  return [...value].map(([tab, ids]) => `页签 ${tab}=${ids.join("、")}`).join("；");
}
