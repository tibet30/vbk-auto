import {
  trafficLineLabel,
  type TrafficLineChildProgress,
  type TrafficLineChildStage,
  type TrafficLineConfig,
  type TrafficLineEndpointPlan,
  type TrafficLineVariant,
} from "../../../../shared/contracts-traffic-line.js";
import { buildTrafficLineTargets } from "./orchestrator.js";
import { ensureTrafficLineRelationship } from "./relationships.js";
import { ensureTrafficLinePresentation } from "./presentation.js";
import {
  ensureTrafficLineSegments,
  recoverPendingTrafficLineSegmentSubmit,
  trafficLineResourceCheckDates,
} from "./segments.js";
import { ensureVehicleResourceBinding, ensureVehicleResourceGroupDraft } from "../vehicle-resource-api.js";
import { productNeedsVehicleResource } from "../../../../shared/product-form.js";
import { ensureTrafficLineItinerary } from "./itinerary.js";
import { ensureTrafficLineClauses } from "./clauses.js";
import {
  activateTrafficLineChild,
  verifyStableTrafficLineChildren,
  type TrafficLineChildReadback,
} from "./readback.js";
import type { TrafficLinePage } from "./client.js";
import { preflightTrafficLineEndpoints, resolveTrafficLineEndpoints } from "./endpoints.js";
import type { TrafficLineStationDisambiguator } from "./endpoints.js";

export interface TrafficLineApiOptions {
  maxSegmentPolls?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: Date;
  stableReadbackIntervalMs?: number;
  stableReadbackSamples?: number;
  itinerary?: readonly { spots?: Array<{ city?: string | null }> }[];
  endpointPlan?: TrafficLineEndpointPlan;
  rejectedTrainStationCodes?: readonly string[];
  childProgress?: readonly TrafficLineChildProgress[];
  onEndpointPlan?: (plan: TrafficLineEndpointPlan) => void;
  onUnavailableVariants?: (reasons: Partial<Record<TrafficLineVariant, string>>) => void;
  onRejectedTrainStationCodes?: (codes: string[]) => void;
  onChildProgress?: (progress: TrafficLineChildProgress) => void;
  onStatus?: (message: string) => void;
  disambiguator?: TrafficLineStationDisambiguator;
  product?: Record<string, unknown>;
}

export interface TrafficLineApiResult {
  enabled: boolean;
  children: Array<{ variant: TrafficLineVariant; lineDescription: string; childProductId: string; verified: TrafficLineChildReadback }>;
  skipped?: Array<{ variant: TrafficLineVariant; lineDescription: string; reason: string }>;
}

const STALLED_SEGMENT_SUBMIT_RETRY_DELAY_MS = 10 * 60 * 1_000;

/**
 * 可恢复的完整子产品流水线：站点规划 → 关系 → 图文 → 资源 → 行程 → 条款 →
 * 有效化 → 聚合回读。每一检查点均在远端读回之后才通知外层持久化。
 */
export async function ensureTrafficLineApi(
  page: TrafficLinePage,
  parentProductId: string,
  config: TrafficLineConfig,
  options: TrafficLineApiOptions = {},
): Promise<TrafficLineApiResult> {
  let targets = buildTrafficLineTargets(config);
  if (!targets.length) return { enabled: false, children: [] };
  if (!options.itinerary?.length) {
    throw new Error("线路及交通缺少已核实的行程 POI 城市；未创建任何子产品，可安全重试。");
  }
  const resourceCheckDates = trafficLineResourceCheckDates(options.product, options.now);
  const skipped: NonNullable<TrafficLineApiResult["skipped"]> = [];
  targets = targets.filter((target) => {
    const previous = options.childProgress?.find((item) => item.variant === target.variant);
    if (!previous || !trafficLineChildShouldBeSkipped(previous)) return true;
    const reason = previous.failureReason!;
    skipped.push({ variant: target.variant, lineDescription: target.lineDescription, reason });
    options.onChildProgress?.({
      ...previous,
      skipped: true,
      failedStage: undefined,
      failureReason: reason,
    });
    return false;
  });
  if (!targets.length) return { enabled: true, children: [], skipped };
  const persistedEndpoints = endpointPlanCanWrite(options.endpointPlan, targets.map((target) => target.variant))
    ? structuredClone(options.endpointPlan)
    : null;
  let endpoints: TrafficLineEndpointPlan;
  if (persistedEndpoints) {
    endpoints = persistedEndpoints;
  } else {
    const availability = await preflightTrafficLineEndpoints(
      page, options.itinerary, new Date(), options.disambiguator, options.product,
      targets.map((target) => target.variant),
    );
    options.onUnavailableVariants?.(availability.unavailableVariants);
    targets = targets.filter((target) => availability.availableVariants.includes(target.variant));
    if (!targets.length) return { enabled: true, children: [], skipped };
    endpoints = availability.endpointPlan;
  }
  if (persistedEndpoints && trainEndpointNeedsReplacement(options.childProgress)) {
    if (!endpoints.train) throw new Error("火车子产品恢复时缺少已核实的火车站点，未重放资源提交。");
    const rejectedCodes = [...new Set([
      ...(options.rejectedTrainStationCodes ?? []),
      endpoints.train.arrival.code,
      endpoints.train.departure.code,
    ].filter(Boolean))];
    // 先持久化已被正式资源判定无效的站码，避免进程中断后循环选回。
    options.onRejectedTrainStationCodes?.(rejectedCodes);
    const replacement = await resolveTrafficLineEndpoints(
      page,
      options.itinerary,
      new Date(),
      options.disambiguator,
      options.product,
      { excludedTrainCodes: rejectedCodes },
    );
    if (sameTrainEndpoints(endpoints, replacement)) {
      throw new Error("火车子产品未找到不同于已失败站点的接口确认候选，未重放资源提交。");
    }
    endpoints = { ...endpoints, train: replacement.train, resolvedAt: replacement.resolvedAt };
  }
  options.onEndpointPlan?.(endpoints);
  const pending: Array<{
    variant: TrafficLineVariant;
    lineDescription: string;
    childProductId: string;
    checkpoint: (stage: TrafficLineChildStage, childProductId?: string, verified?: boolean) => void;
    snapshot: () => TrafficLineChildProgress;
  }> = [];
  for (const target of targets) {
    const previous = options.childProgress?.find((item) => item.variant === target.variant);
    let progress: TrafficLineChildProgress = previous
      ? invalidateTrafficLineFinalReadback(previous)
      : {
        variant: target.variant,
        lineDescription: trafficLineLabel(target.variant),
        completedStages: [],
        verified: false,
      };
    const checkpoint = (stage: TrafficLineChildStage, childProductId = progress.childProductId, verified = false) => {
      progress = {
        ...progress,
        childProductId,
        completedStages: [...new Set([...progress.completedStages, stage])],
        verified,
        failedStage: undefined,
        failureReason: undefined,
      };
      options.onChildProgress?.(progress);
    };
    try {
      checkpoint("planned");
      checkpoint("stationsResolved");
      const relationship = await ensureTrafficLineRelationship(page, parentProductId, target);
      checkpoint("childCreated", relationship.productId);
      // 恢复时平台可能已完成全部远端步骤，但上次本地 checkpoint
      // 未来得及持久化。已有效子产品也必须等所有兄弟均激活后进入整组稳定门；
      // 不能用此刻的一次成功提前补 finalReadback。
      if (relationship.active === true) {
        pending.push({
          variant: target.variant,
          lineDescription: trafficLineLabel(target.variant),
          childProductId: relationship.productId,
          checkpoint,
          snapshot: () => progress,
        });
        continue;
      }
      await ensureTrafficLinePresentation(page, parentProductId, relationship.productId);
      checkpoint("presentationCopied", relationship.productId);
      const recoveringTimedOutSubmit = previous?.failedStage === "resourcesSaved"
        && /(?:轮询后仍未完成|仍在 VBK 异步核验)/.test(previous.failureReason ?? "");
      const submitRecovery = recoveringTimedOutSubmit
        ? await recoverPendingTrafficLineSegmentSubmit(
            page,
            relationship.productId,
            target.variant,
            endpoints,
            {
              maxPolls: options.maxSegmentPolls,
              sleep: options.sleep,
              onProgress: (attempt, maxPolls) => options.onStatus?.(
                `交通子产品 ${relationship.productId} 正在继续等待上次 VBK 班期核验（${attempt}/${maxPolls}）`,
              ),
            },
          )
        : "restartable";
      const recoveredSubmit = submitRecovery === "recovered";
      if (recoveredSubmit) {
        options.onStatus?.(`交通子产品 ${relationship.productId} 上次班期校验已完成，已通过正式资源回读。`);
      }
      const replacingStalledPendingSubmit = submitRecovery === "pending"
        && trafficLinePendingSubmitNeedsOneRecoveryRetry(previous, options.now);
      if (submitRecovery === "pending" && !replacingStalledPendingSubmit) {
        throw new Error("子产品上一次资源提交仍在 VBK 异步核验；本次仅做了只读查询，未重复提交，请稍后从 trafficLine 继续。");
      }
      if (replacingStalledPendingSubmit) {
        options.onStatus?.(`交通子产品 ${relationship.productId} 的班期校验已超过 10 分钟仍未收口，正在用 ${resourceCheckDates.length} 个代表性真实班期受控重提一次。`);
      }
      if (!recoveredSubmit) {
        if (!resourceCheckDates.length) {
          throw new Error("产品没有可用于交通资源核验的销售班期，已保留交通子产品基础信息，跳过班期资源设置。");
        }
        await ensureTrafficLineSegments(page, relationship.productId, target.variant, endpoints, {
          maxPolls: options.maxSegmentPolls,
          sleep: options.sleep,
          now: options.now,
          schedule: resourceCheckDates,
          onValidationProgress: (attempt, maxPolls) => options.onStatus?.(
            `交通子产品 ${relationship.productId} 正在等待 VBK 班期核验（${attempt}/${maxPolls}）`,
          ),
          beforeSubmit: async () => {
            await ensureTrafficLineItinerary(page, relationship.productId, target.variant, endpoints);
            await ensureTrafficLineVehicleDraft(page, relationship.productId, options.product);
          },
          onSubmit: (departureCityCount) => {
            const submittedAt = new Date().toISOString();
            progress = {
              ...progress,
              validationScheduleCount: resourceCheckDates.length,
              validationDepartureCityCount: departureCityCount,
              validationSubmittedAt: submittedAt,
              validationRecoveryResubmittedAt: replacingStalledPendingSubmit ? submittedAt : progress.validationRecoveryResubmittedAt,
            };
            options.onChildProgress?.(progress);
          },
        });
      }
      // submitSegments 会再次结算资源草稿；即使提交前已有交通卡片，也必须在
      // 提交成功后重新落一次，并以正式资源段回读为准。
      await ensureTrafficLineItinerary(page, relationship.productId, target.variant, endpoints);
      await ensureTrafficLineVehicleBinding(page, relationship.productId, options.product);
      checkpoint("resourcesSaved", relationship.productId);
      checkpoint("itinerarySaved", relationship.productId);
      await ensureTrafficLineClauses(page, relationship.productId, target.variant);
      checkpoint("clausesSaved", relationship.productId);
      await activateTrafficLineChild(page, parentProductId, relationship, target.variant);
      checkpoint("activated", relationship.productId);
      pending.push({
        variant: target.variant,
        lineDescription: trafficLineLabel(target.variant),
        childProductId: relationship.productId,
        checkpoint,
        snapshot: () => progress,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      options.onChildProgress?.({
        ...progress,
        skipped: true,
        failedStage: undefined,
        failureReason: reason,
      });
      skipped.push({ variant: target.variant, lineDescription: target.lineDescription, reason });
      options.onStatus?.(`${target.lineDescription}子产品未完成，已跳过继续处理其它子产品：${reason}`);
      continue;
    }
  }
  if (!pending.length) {
    return { enabled: true, children: [], skipped };
  }
  let verifiedChildren: TrafficLineChildReadback[];
  try {
    verifiedChildren = await verifyStableTrafficLineChildren(
      page,
      parentProductId,
      pending.map(({ variant, childProductId }) => ({ variant, childProductId })),
      endpoints,
      {
        intervalMs: options.stableReadbackIntervalMs,
        requiredConsecutive: options.stableReadbackSamples,
        sleep: options.sleep,
      },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    for (const child of pending) {
      const progress = child.snapshot();
      options.onChildProgress?.({
        ...progress,
        verified: false,
        skipped: true,
        failedStage: undefined,
        failureReason: reason,
      });
      skipped.push({ variant: child.variant, lineDescription: child.lineDescription, reason });
    }
    return { enabled: true, children: [], skipped };
  }
  const children: TrafficLineApiResult["children"] = [];
  for (const [index, child] of pending.entries()) {
    const verified = verifiedChildren[index]!;
    for (const stage of ["presentationCopied", "resourcesSaved", "itinerarySaved", "clausesSaved", "activated"] as const) {
      child.checkpoint(stage, child.childProductId);
    }
    child.checkpoint("finalReadback", child.childProductId, true);
    children.push({
      variant: child.variant,
      lineDescription: child.lineDescription,
      childProductId: child.childProductId,
      verified,
    });
  }
  return { enabled: true, children, skipped };
}

/** 配置了用车的交通子产品独立维护资源段，必须在自己的草稿首段挂上用车组。 */
async function ensureTrafficLineVehicleDraft(page: TrafficLinePage, productId: string, product: Record<string, unknown> | undefined) {
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
async function ensureTrafficLineVehicleBinding(page: TrafficLinePage, productId: string, product: Record<string, unknown> | undefined) {
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
    && child.failedStage === "resourcesSaved"
    && /(?:缺少多出发城市|没有任何可用的多出发城市)/.test(child.failureReason ?? "")));
}

/** 只有平台明确的“无可售资源”结论才会降级跳过；会话和保存失败仍严格中断。 */
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

function sameTrainEndpoints(current: TrafficLineEndpointPlan, replacement: TrafficLineEndpointPlan): boolean {
  if (!current.train || !replacement.train) return false;
  return current.train.arrival.code === replacement.train.arrival.code
    && current.train.departure.code === replacement.train.departure.code;
}

function nextStage(completed: readonly TrafficLineChildStage[]): TrafficLineChildStage {
  return (["planned", "stationsResolved", "childCreated", "presentationCopied", "resourcesSaved", "itinerarySaved", "clausesSaved", "activated", "finalReadback"] as const)
    .find((stage) => !completed.includes(stage)) ?? "activated";
}
