import type { ProductDetail } from "../../../shared/contracts.js";
import type { VbkDatabase } from "../../infrastructure/database/database.js";
import { PlatformOperationError } from "../../application/platform-operation-service.js";
import { approvalForRun } from "../../agent/integration-gates.js";
import { DurationChangeRejectedError } from "../ctrip/itinerary-api/readback.js";

/**
 * 改天数失败转新建产品：
 *   - 已有远端草稿改天数时，基本信息以 resizeTourDailyInfo=F 只改 travelDays，行程按新天数整版重写；
 *   - 写入报错（含「天数」）或回读天数不一致，即视为该产品天数已被锁定；
 *   - 此时只在本地解绑旧草稿（VBK 无删除接口，旧草稿保留），在同一轮已批准录入内
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

/** 只认基本信息/行程阶段：回读天数不一致，或平台明确拒绝且原因含「天数」；不确定写入一律不算。 */
export function isDurationChangeRejection(phase: string | undefined, error: unknown): boolean {
  if (!phase || !DURATION_PHASES.has(phase)) return false;
  if ((error as { uncertainWrite?: boolean } | undefined)?.uncertainWrite) return false;
  if (causes(error).some((item) => item instanceof DurationChangeRejectedError)) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/回读行程天数不一致/.test(message)) return true;
  const platformRejected = (error instanceof PlatformOperationError && error.kind === "business_rejection")
    || /Ack=Failure/.test(message);
  return platformRejected && /天数/.test(message);
}

/** Agent 录入的阶段失败通常以 needs_user 结束而不抛错，此时从已落库的失败记录判定。 */
function recordedRejection(product: ProductDetail | undefined, thrown: unknown): boolean {
  const run = product?.automation;
  if (!product?.productId || !run || run.durationReplacement) return false;
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

/**
 * 包住一次已批准录入：首轮天数被拒时解绑并以新建产品重跑一次。
 * attempt(undefined) 是原录入；attempt(replacement) 是转新建后的整轮重录。
 */
export async function runWithDurationReplacement(
  deps: { db: DurationReplacementDb; localProductId: string; emit: (localProductId: string) => void },
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
  const replacement: DurationReplacement = { previousProductId, at: new Date().toISOString(),
    approvalId: approvalForRun(db.getAgentSnapshot(localProductId))?.id };
  db.setProductLifecycle(localProductId, { productId: null, status: "review", basicInfoSaved: false });
  db.addMessage(localProductId, "assistant",
    `VBK 产品 ${previousProductId} 未接受新的行程天数，按已锁定处理：已在本地解绑，正在按新天数新建产品重新录入。`
    + `旧草稿 ${previousProductId} 已保留，请在 VBK 后台手动下线或删除。`);
  deps.emit(localProductId);
  await attempt(replacement);
}
