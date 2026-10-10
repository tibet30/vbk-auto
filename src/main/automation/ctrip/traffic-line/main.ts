import { submitWithOnePendingRecovery } from "./pending-submit-recovery.js";
import { submitWithFormalCardRecovery } from "./card-submit-recovery.js";
import { readSegmentSubmitState } from "./segment-submit.js";
import { trafficLineFailureProgress, trafficRouteActivationCanResume, trafficSegmentSubmitNeedsRecovery, trafficClauseMaterializationCanResume, trafficResourceCardRejected } from "./child-failure.js";
import {
  trafficLineLabel,
  type TrafficLineChildProgress,
  type TrafficLineChildStage,
  type TrafficLineConfig,
  type TrafficLineEndpointPlan,
  type TrafficLineVariant,
} from "../../../../shared/contracts-traffic-line.js";
import { buildTrafficLineTargets, trafficLineSkippedChildCanBeRevalidated } from "./orchestrator.js";
import { ensureTrafficLineRelationship } from "./relationships.js";
import { ensureTrafficLinePresentation } from "./presentation.js";
import {
  ensureTrafficLineSegments,
  readTrafficLineSegmentReadback,
  recoverPendingTrafficLineSegmentSubmit,
  trafficLineResourceCheckDates,
} from "./segments.js";
import {
  ensureTrafficLineVehicleBinding,
  ensureTrafficLineVehicleDraft,
  invalidateTrafficLineFinalReadback,
  trafficLinePendingSubmitNeedsOneRecoveryRetry,
  endpointPlanCanWrite,
  trainEndpointNeedsReplacement,
  trafficLineChildShouldBeSkipped,
  trafficLineSkippedChildCanBeRetried,
  sameTrainEndpoints,
  trainRecoveryExcludedCodes,
} from "./helpers.js";
export {
  invalidateTrafficLineFinalReadback,
  trafficLinePendingSubmitNeedsOneRecoveryRetry,
  endpointPlanCanWrite,
  trainEndpointNeedsReplacement,
  isUnavailableTrafficResourceFailure,
  trafficLineChildShouldBeSkipped,
  trafficLineSkippedChildCanBeRetried,
} from "./helpers.js";
import { ensureTrafficLineItinerary } from "./itinerary.js";
import {
  activateTrafficLineChild,
  repairTrafficLineItineraryIfMissing,
  ensureTrafficLineClausesWithItineraryRecovery,
  verifyStableTrafficLineChildren,
  type TrafficLineChildReadback,
} from "./readback.js";
import type { TrafficLinePage } from "./client.js";
import { preflightTrafficLineEndpoints, resolveTrainReplacementEndpoints } from "./endpoints.js";
import { trafficLinePlanMatchesExplicitCities } from "../../../../shared/traffic-line-user-endpoints.js";
import type { TrafficLineStationDisambiguator } from "./endpoints.js";
import { ensureHotelResourceApi } from "../hotel-resource-api.js";

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
  // 交通阶段的只读前置核验会检查母产品正式住宿段；历史产品可能只有
  // 本地候选而远端资源仍为空。先补齐母产品，再把同一份住宿证据同步到子产品。
  if (options.product) {
    await ensureHotelResourceApi(page, options.product, parentProductId);
  }
  const resourceCheckDates = trafficLineResourceCheckDates(options.product, options.now);
  const skipped: NonNullable<TrafficLineApiResult["skipped"]> = [];
  targets = targets.filter((target) => {
    const previous = options.childProgress?.find((item) => item.variant === target.variant);
    if (!previous || !trafficLineChildShouldBeSkipped(previous)
      || trafficLineSkippedChildCanBeRetried(previous)
      || trafficLineSkippedChildCanBeRevalidated(previous, config)) return true;
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
    && trafficLinePlanMatchesExplicitCities(options.product ?? {}, options.endpointPlan)
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
  if (persistedEndpoints && targets.some(target => target.variant === "trainRoundTrip")
    && (trainEndpointNeedsReplacement(options.childProgress)
      || options.rejectedTrainStationCodes?.includes(endpoints.train?.arrival.code ?? ""))) {
    if (!endpoints.train) throw new Error("火车子产品恢复时缺少已核实的火车站点，未重放资源提交。");
    const rejectedCodes = trainRecoveryExcludedCodes(endpoints, options.rejectedTrainStationCodes);
    options.onRejectedTrainStationCodes?.(rejectedCodes);
    try {
      const replacement = await resolveTrainReplacementEndpoints(
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
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const previous = options.childProgress?.find(child => child.variant === "trainRoundTrip");
      skipped.push({ variant: "trainRoundTrip", lineDescription: "火车往返", reason });
      if (previous) options.onChildProgress?.({ ...previous, verified: false, skipped: true, failureReason: reason });
      targets = targets.filter(target => target.variant !== "trainRoundTrip");
    }
  }
  options.onEndpointPlan?.(endpoints);
  type PendingTrafficLineChild = {
    variant: TrafficLineVariant;
    lineDescription: string;
    childProductId: string;
    checkpoint: (stage: TrafficLineChildStage, childProductId?: string, verified?: boolean) => void;
    snapshot: () => TrafficLineChildProgress;
  };
  type TrafficLineChildPipelineResult =
    | { pending: PendingTrafficLineChild }
    | { skipped: { variant: TrafficLineVariant; lineDescription: string; reason: string } };

  const processTarget = async (target: (typeof targets)[number]): Promise<TrafficLineChildPipelineResult> => {
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
        skipped: false,
        failedStage: undefined,
        failureReason: undefined,
      };
      options.onChildProgress?.(progress);
    };
    try {
      checkpoint("planned");
      checkpoint("stationsResolved");
      const relationship = await ensureTrafficLineRelationship(page, parentProductId, target, {
        expectedChildId: progress.childProductId,
        onCreated: childProductId => {
          progress = { ...progress, childProductId };
          options.onChildProgress?.(progress);
        },
      });
      checkpoint("childCreated", relationship.productId);
      // 母图文修复后，已有效套餐也必须继承当前内容，再进入整组回读。
      await ensureTrafficLinePresentation(page, parentProductId, relationship.productId);
      checkpoint("presentationCopied", relationship.productId);
      // 交通子产品独立走 VBK 行程校验；复制母产品图文不会复制住宿资源。
      // 先把母产品已核实的住宿候选写入子产品，否则 checkTourDaily 会以
      // hotelGrades=[] 拒绝“至少包含一晚酒店”，即使母产品本身已有酒店。
      if (options.product) {
        await ensureHotelResourceApi(page, options.product, relationship.productId);
      }
      // 恢复时平台可能已完成全部远端步骤，但上次本地 checkpoint
      // 未来得及持久化。已有效子产品也必须等所有兄弟均激活后进入整组稳定门；
      // 不能用此刻的一次成功提前补 finalReadback。
      if (relationship.active === true) {
        return { pending: {
          variant: target.variant,
          lineDescription: trafficLineLabel(target.variant),
          childProductId: relationship.productId,
          checkpoint,
          snapshot: () => progress,
        } };
      }
      if (trafficRouteActivationCanResume(previous) || trafficClauseMaterializationCanResume(previous) || trafficResourceCardRejected(previous)) {
        // 线路审核或条款物化失败不撤销已保存资源；先独立回读正式资源，
        // 不重建资源草稿，也不重新发起耗时的班期校验。
        await readTrafficLineSegmentReadback(page, relationship.productId, target.variant, endpoints);
        checkpoint("resourcesSaved", relationship.productId);
        if (trafficClauseMaterializationCanResume(previous) || trafficResourceCardRejected(previous)) {
          await repairTrafficLineItineraryIfMissing(page, relationship.productId, target.variant, endpoints);
          checkpoint("itinerarySaved", relationship.productId);
          await ensureTrafficLineClausesWithItineraryRecovery(page, relationship.productId, target.variant, endpoints);
          checkpoint("clausesSaved", relationship.productId);
        }
        await activateTrafficLineChild(page, parentProductId, relationship, target.variant, endpoints);
        checkpoint("activated", relationship.productId);
        return { pending: { variant: target.variant, lineDescription: trafficLineLabel(target.variant),
          childProductId: relationship.productId, checkpoint, snapshot: () => progress } };
      }
      const recoveringTimedOutSubmit = trafficSegmentSubmitNeedsRecovery(previous);
      const submitRecovery = recoveringTimedOutSubmit
        ? await recoverPendingTrafficLineSegmentSubmit(
            page,
            relationship.productId,
            target.variant,
            endpoints,
            {
              maxPolls: options.maxSegmentPolls,
              shouldStopWaiting: () => trafficLinePendingSubmitNeedsOneRecoveryRetry(progress, options.now),
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
        await submitWithFormalCardRecovery({
          readFormalResources: () => readTrafficLineSegmentReadback(page, relationship.productId, target.variant, endpoints),
          onRecovery: () => options.onStatus?.(`交通子产品 ${relationship.productId} 班期校验报告缺交通卡片，正式资源已通过独立回读；继续修复行程及条款，不重复提交资源。`),
          submit: () => submitWithOnePendingRecovery({
          progress: () => progress, now: options.now,
          readState: () => readSegmentSubmitState(page, relationship.productId),
          onRecovery: () => options.onStatus?.(`交通子产品 ${relationship.productId} 持续异步核验超过10分钟，程序正在受控恢复一次。`),
          submit: (recoveryRetry) => ensureTrafficLineSegments(page, relationship.productId, target.variant, endpoints, {
            maxPolls: options.maxSegmentPolls,
            shouldStopWaiting: () => trafficLinePendingSubmitNeedsOneRecoveryRetry(progress, options.now),
            sleep: options.sleep,
            now: options.now,
            schedule: resourceCheckDates,
            onValidationProgress: (attempt, maxPolls) => options.onStatus?.(
              `交通子产品 ${relationship.productId} 正在等待 VBK 班期核验（${attempt}/${maxPolls}）`,
            ),
            beforeSubmit: async () => {
              await ensureTrafficLineVehicleDraft(page, relationship.productId, options.product);
              await ensureTrafficLineItinerary(page, relationship.productId, target.variant, endpoints);
            },
            onSubmit: (departureCityCount) => {
              const submittedAt = new Date().toISOString();
              progress = {
                ...progress,
                validationScheduleCount: resourceCheckDates.length,
                validationDepartureCityCount: departureCityCount,
                validationSubmittedAt: submittedAt,
                validationRecoveryResubmittedAt: (replacingStalledPendingSubmit || recoveryRetry) ? submittedAt : progress.validationRecoveryResubmittedAt,
              };
              options.onChildProgress?.(progress);
            },
          }),
          }),
        });
      }
      // 用车正式提交会重新结算行程关联；先完成所有资源提交，再写回交通卡片。
      // 否则资源段虽有航班，条款读取的正式行程仍可能丢失去返程节点。
      await ensureTrafficLineVehicleBinding(page, relationship.productId, options.product);
      await ensureTrafficLineItinerary(page, relationship.productId, target.variant, endpoints);
      checkpoint("resourcesSaved", relationship.productId);
      checkpoint("itinerarySaved", relationship.productId);
      await ensureTrafficLineClausesWithItineraryRecovery(page, relationship.productId, target.variant, endpoints);
      checkpoint("clausesSaved", relationship.productId);
      await activateTrafficLineChild(page, parentProductId, relationship, target.variant, endpoints);
      checkpoint("activated", relationship.productId);
      return { pending: {
        variant: target.variant,
        lineDescription: trafficLineLabel(target.variant),
        childProductId: relationship.productId,
        checkpoint,
        snapshot: () => progress,
      } };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      options.onChildProgress?.(trafficLineFailureProgress(progress, reason));
      options.onStatus?.(`${target.lineDescription}子产品未完成，已记录失败并继续处理其它子产品：${reason}`);
      return { skipped: { variant: target.variant, lineDescription: target.lineDescription, reason } };
    }
  };

  const childResults = await Promise.all(targets.map((target) => processTarget(target)));
  const pending = childResults.flatMap((result) => "pending" in result ? [result.pending] : []);
  skipped.push(...childResults.flatMap((result) => "skipped" in result ? [result.skipped] : []));
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
        onProgress: (sample, maxSamples, consecutive, required) => options.onStatus?.(
          `交通套餐已启用，正在核查整组最终状态（第 ${sample}/${maxSamples} 次，已连续稳定 ${consecutive}/${required} 次）`,
        ),
      },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    for (const child of pending) {
      const progress = child.snapshot();
      options.onChildProgress?.(trafficLineFailureProgress(progress, reason));
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
