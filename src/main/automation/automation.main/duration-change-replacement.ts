import type { ProductDetail } from "../../../shared/contracts.js";
import type { VbkDatabase } from "../../infrastructure/database/database.js";
import { PlatformOperationError } from "../../application/platform-operation-service.js";
import { approvalForRun } from "../../agent/integration-gates.js";
import { DurationChangeRejectedError } from "../ctrip/itinerary-api/readback.js";
import { DURATION_REPLACEMENT_SCOPE, durationChangedFromRemote, enteredRemoteItineraryDays } from "../../../shared/duration-replacement.js";
import { assertRemoteDraftUnpublished } from "./automation.main.replace-locked-draft.js";

/**
 * 改天数失败转新建产品：
 *   - 已有远端草稿改天数时，基本信息以 resizeTourDailyInfo=F 只改 travelDays，行程按新天数整版重写；
 *   - 只有本轮天数确实不同于当前远端草稿最后一次录入的天数时，平台明确拒绝写入
 *     （原因含「行程天数 / 出游天数 / travelDays」，「提前预订天数」等其它天数字段不算）
 *     或回读天数不一致才视为该产品天数已被锁定；天数未变时按普通失败处理；
 *   - 超时后的只读恢复回读到旧天数只说明上次写入未生效，不算被拒（见 association-save.ts）；
 *   - 运营批准须显式包含 vbk.duration_replacement（确认卡已说明可能新建产品），
 *     且只读回读确认旧草稿仍未提审、未发布，否则不转新建、阶段失败并说明原因；
 *   - 满足后只在本地解绑旧草稿（VBK 无删除接口，旧草稿保留），在同一轮已批准录入内
 *     从第一个阶段新建产品重录；每轮最多一次，第二次直接失败。
 */

export type DurationReplacement = NonNullable<NonNullable<ProductDetail["automation"]>["durationReplacement"]>;
export type DurationReplacementDb = Pick<VbkDatabase, "getProduct" | "setProductLifecycle" | "addMessage" | "getAgentSnapshot">;

const DURATION_PHASES = new Set(["basic", "itinerary"]);

function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = error; current && chain.length < 8; current = (current as { cause?: unknown }).cause) chain.push(current);
  return chain;
}

/** 只认基本信息/行程阶段：回读天数不一致，或平台明确拒绝且原因指向行程天数；不确定写入一律不算。 */
export function isDurationChangeRejection(phase: string | undefined, error: unknown): boolean {
  if (!phase || !DURATION_PHASES.has(phase)) return false;
  if ((error as { uncertainWrite?: boolean } | undefined)?.uncertainWrite) return false;
  if (causes(error).some((item) => item instanceof DurationChangeRejectedError)) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/回读行程天数不一致/.test(message)) return true;
  const platformRejected = (error instanceof PlatformOperationError && error.kind === "business_rejection")
    || /Ack=Failure/.test(message);
  return platformRejected && /行程天数|出游天数|travelDays/.test(message);
}

/** Agent 录入的阶段失败通常以 needs_user 结束而不抛错，此时从已落库的失败记录判定。 */
function recordedRejection(product: ProductDetail | undefined, thrown: unknown): boolean {
  const run = product?.automation;
  if (!product?.productId || !run || run.durationReplacement) return false;
  // 只有本轮确实在改天数（与远端草稿最后一次录入的天数不同）才可能转新建。
  if (!durationChangedFromRemote(product)) return false;
  if (thrown !== undefined) return isDurationChangeRejection(run.currentPhase, thrown);
  const phase = run.currentPhase;
  return run.status === "failed" && Boolean(phase)
    && isDurationChangeRejection(phase, run.recovery?.phases[phase!]?.finalError ?? "");
}

/** 只做本地判定，不碰远端；解绑由 runWithDurationReplacement 写库。 */
export function prepareDurationChangeReplacement(product: ProductDetail): { previousProductId: string } {
  const previousProductId = String(product.productId ?? "").trim();
  if (!previousProductId) throw new Error("当前产品没有可替代的远端草稿。");
  return { previousProductId };
}

export interface DurationReplacementDeps {
  db: DurationReplacementDb;
  localProductId: string;
  emit: (localProductId: string) => void;
  /** 只读回读旧草稿基本信息（getProductBaseInfo），用于转新建前确认仍未提审、未发布。 */
  readRemoteBaseInfo: (productId: string) => Promise<unknown>;
}

/**
 * 不能转新建：保持本地绑定并告知运营原因。原录入是抛错结束的，包装原因后重新抛出；
 * 原录入以 needs_user 落库结束（未抛错）时，失败记录已在库中，正常返回。
 */
function refuseReplacement(deps: DurationReplacementDeps, thrown: unknown, reason: string): void {
  deps.db.addMessage(deps.localProductId, "assistant", reason);
  deps.emit(deps.localProductId);
  if (thrown !== undefined) throw new Error(reason, { cause: thrown });
}

/**
 * 包住一次已批准录入：首轮天数被拒时解绑并以新建产品重跑一次。
 * attempt(undefined) 是原录入；attempt(replacement) 是转新建后的整轮重录。
 */
export async function runWithDurationReplacement(
  deps: DurationReplacementDeps,
  attempt: (replacement?: DurationReplacement) => Promise<void>,
): Promise<void> {
  const { db, localProductId } = deps;
  let thrown: unknown;
  try {
    await attempt();
  } catch (error) {
    thrown = error;
  }
  const product = db.getProduct(localProductId);
  if (!recordedRejection(product, thrown)) {
    if (thrown !== undefined) throw thrown;
    return;
  }
  const { previousProductId } = prepareDurationChangeReplacement(product!);
  const days = Number((product!.product.basicInfo as Record<string, unknown> | undefined)?.days);
  const prefix = `VBK 产品 ${previousProductId} 未接受行程天数从 ${enteredRemoteItineraryDays(product!)} 天改为 ${days} 天`;
  const approval = approvalForRun(db.getAgentSnapshot(localProductId));
  if (!approval?.scope.includes(DURATION_REPLACEMENT_SCOPE)) {
    return refuseReplacement(deps, thrown, `${prefix}。本次确认未授权「保留旧草稿并新建产品」，已保留原绑定，不会新建产品；请重新确认后录入。`);
  }
  try {
    assertRemoteDraftUnpublished(await deps.readRemoteBaseInfo(previousProductId), previousProductId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return refuseReplacement(deps, thrown, `${prefix}，转新建前的远端只读核对未通过：${detail}。已保留原绑定，不会新建产品。`);
  }
  const replacement: DurationReplacement = { previousProductId, at: new Date().toISOString(), approvalId: approval.id };
  db.setProductLifecycle(localProductId, { productId: null, status: "review", basicInfoSaved: false });
  db.addMessage(localProductId, "assistant",
    `${prefix}，按已锁定处理：已在本地解绑，正在按新天数新建产品重新录入。`
    + `旧草稿 ${previousProductId} 已保留，请在 VBK 后台手动下线或删除。旧草稿下的交通子产品随旧草稿保留。`);
  deps.emit(localProductId);
  await attempt(replacement);
}
