/**
 * traffic-line/helpers.ts：
 *   - 状态判定与用车组绑定：被 main.ts / run-phase.ts / integration-gates 复用；
 *   - 不持有 VBK 接口调用（那是 main.ts / segments.ts 的事），只暴露纯函数
 *     与本地资源段操作；
 *   - 不做阶段编排（那是 main.ts 的事）。
 */

import type { TrafficLineEndpointPlan } from "../../../../shared/contracts-traffic-line.js";
import type { TrafficLineChildProgress, TrafficLineChildStage, TrafficLineVariant } from "../../../../shared/contracts-traffic-line.js";
import { productNeedsVehicleResource } from "../../../../shared/product-form.js";
import { ensureVehicleResourceBinding, ensureVehicleResourceGroupDraft } from "../vehicle-resource-api.js";
import type { TrafficLinePage } from "./client.js";

const STALLED_SEGMENT_SUBMIT_RETRY_DELAY_MS = 10 * 60 * 1_000;

/** 配置了用车的交通子产品独立维护资源段，必须在自己的草稿首段挂上用车组。 */
export async function ensureTrafficLineVehicleDraft(
  page: TrafficLinePage,
  productId: string,
  product: Record<string, unknown> | undefined,
): Promise<void> {
  if (!productNeedsVehicleResource(product)) return;
  const operations = product?.operations as Record<string, unknown> | undefined;
  const vehicle = operations?.vehicleResource as Record<string, unknown> | undefined;
  const groupId = Number(vehicle?.resourceGroupId);
  const groupName = String(vehicle?.resourceGroupName ?? "").trim();
  if (!Number.isInteger(groupId) || groupId <= 0 || !groupName) {
    throw new Error("交通子产品缺少可绑定的用车资源组。");
  }
  await ensureVehicleResourceGroupDraft(page, productId, groupId, groupName, { verifyDraft: true });
}

/**
 * submitSegments 会消耗交通子产品的资源草稿。行程写回后必须重新创建草稿、
 * 绑定用车组、提交并通过正式段回读；只保留草稿内的成功不能作为完成证据。
 */
export async function ensureTrafficLineVehicleBinding(
  page: TrafficLinePage,
  productId: string,
  product: Record<string, unknown> | undefined,
): Promise<void> {
  if (!productNeedsVehicleResource(product)) return;
  const operations = product?.operations as Record<string, unknown> | undefined;
  const vehicle = operations?.vehicleResource as Record<string, unknown> | undefined;
  const groupId = Number(vehicle?.resourceGroupId);
  const groupName = String(vehicle?.resourceGroupName ?? "").trim();
  if (!Number.isInteger(groupId) || groupId <= 0 || !groupName) {
    throw new Error("交通子产品缺少可绑定的用车资源组。");
  }
  await ensureVehicleResourceBinding(page, productId, groupId, groupName, { submitDraft: true });
}

/** 每次重新核验都先撤销旧完成证据，保留其它已确认阶段供安全恢复。 */
export function invalidateTrafficLineFinalReadback(progress: TrafficLineChildProgress): TrafficLineChildProgress {
  return {
    ...progress,
    completedStages: progress.completedStages.filter((stage) => stage !== "finalReadback"),
    verified: false,
    failedStage: undefined,
    failureReason: undefined,
  };
}

/**
 * 已确认持续 pending 的提交可在十分钟后受控重提一次。首次重提会留下时间戳，
 * 后续仍未完成时只能继续只读查询，避免叠加多个 submitSegments 写请求。
 */
export function trafficLinePendingSubmitNeedsOneRecoveryRetry(
  progress: TrafficLineChildProgress | undefined,
  now: Date | undefined,
): boolean {
  if (!progress || progress.validationRecoveryResubmittedAt) return false;
  if (progress.validationScheduleCount === undefined) return true;
  const submittedAt = Date.parse(progress.validationSubmittedAt ?? "");
  if (!Number.isFinite(submittedAt)) return false;
  return (now ?? new Date()).getTime() - submittedAt >= STALLED_SEGMENT_SUBMIT_RETRY_DELAY_MS;
}

export function endpointPlanCanWrite(
  plan: TrafficLineEndpointPlan | undefined,
  variants: readonly TrafficLineVariant[] = ["flightRoundTrip", "trainRoundTrip"],
): plan is TrafficLineEndpointPlan {
  return variants.every((variant) => variant === "flightRoundTrip"
    ? Boolean(plan?.flight?.arrival.code && plan.flight.departure.code)
    : Boolean(plan?.train?.arrival.code && plan.train.departure.code
      && plan.train.arrival.resourceKey && plan.train.departure.resourceKey));
}

export function trainEndpointNeedsReplacement(progress: readonly TrafficLineChildProgress[] | undefined): boolean {
  return Boolean(progress?.some((child) => child.variant === "trainRoundTrip"
    && child.verified !== true
    && trafficLineResourceStageFailure(child)
    && /(?:缺少多出发城市|没有任何可用的多出发城市)/.test(child.failureReason ?? "")));
}

/** 只有平台明确的"无可售资源"结论才会降级跳过；会话和保存失败仍严格中断。 */
export function isUnavailableTrafficResourceFailure(reason: string, variant?: TrafficLineVariant): boolean {
  if (/没有可用于交通资源核验的销售班期/.test(reason)) return true;
  if (/(?:没有任何可用的多出发城市|未返回可用于(?:飞机|火车)往返的出发城市)/.test(reason)) return true;
  if (/(?:当前|本)班期.*(?:没有|无).*可用交通资源|(?:没有|无).*可用交通资源.*(?:当前|本)班期/.test(reason)) return true;
  // 同城接送的火车子产品能创建，但 VBK 到套餐有效化才返回该业务结论。
  // 这不是会话或协议失败；保留子产品记录并让其它交通方式继续完成。
  return variant === "trainRoundTrip" && (
    /出发城市为空\s*[,，]?\s*不能打包/.test(reason)
  );
}

export function trafficLineChildShouldBeSkipped(progress: TrafficLineChildProgress | undefined): boolean {
  return Boolean(progress && progress.verified !== true && (progress.skipped === true
    || isUnavailableTrafficResourceFailure(progress.failureReason ?? "", progress.variant)));
}

export function trafficLineSkippedChildCanBeRetried(progress: TrafficLineChildProgress | undefined): boolean {
  return Boolean(progress
    && progress.verified !== true
    && progress.childProductId
    && trafficLineResourceStageFailure(progress)
    && /(?:没有任何可用的多出发城市|未返回可用于(?:飞机|火车)往返的出发城市)/.test(progress.failureReason ?? ""));
}

/**
 * 历史 skipped 只代表当时的计划结果。当前会话再次确认该方式可用时，
 * 不能沿用旧失败；让关系读取先复用已有子产品，再进入纯回读/有界修复。
 */
export function trafficLineResourceStageFailure(progress: TrafficLineChildProgress): boolean {
  if (progress.failedStage === "resourcesSaved") return true;
  if (progress.failedStage) return false;
  if (progress.completedStages.includes("resourcesSaved")) return false;
  return progress.completedStages.includes("presentationCopied")
    && !progress.completedStages.includes("itinerarySaved");
}

export function sameTrainEndpoints(current: TrafficLineEndpointPlan, replacement: TrafficLineEndpointPlan): boolean {
  if (!current.train || !replacement.train) return false;
  return current.train.arrival.code === replacement.train.arrival.code
    && current.train.departure.code === replacement.train.departure.code;
}

export function nextStage(completed: readonly TrafficLineChildStage[]): TrafficLineChildStage {
  return (["planned", "stationsResolved", "childCreated", "presentationCopied", "resourcesSaved", "itinerarySaved", "clausesSaved", "activated", "finalReadback"] as const)
    .find((stage) => !completed.includes(stage)) ?? "activated";
}
