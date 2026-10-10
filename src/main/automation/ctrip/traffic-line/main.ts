/**
 * 可恢复的完整交通子产品流水线：站点规划 → 关系 → 图文 → 资源 → 行程 → 条款 →
 * 有效化 → 聚合回读。每一检查点均在远端读回之后才通知外层持久化。
 *
 * 拆分子文件：
 *   - main-types.ts   : TrafficLineApiOptions / TrafficLineApiResult 等公共类型；
 *   - main/process-target.ts : 单子产品流水线（站点规划到激活）。
 *
 * 主函数现在只剩「过滤 / 调度 / 整组聚合回读」三段，逻辑更易读。
 */

import {
  trafficLineLabel,
  type TrafficLineVariant,
} from "../../../../shared/contracts-traffic-line.js";
import { buildTrafficLineTargets, trafficLineSkippedChildCanBeRevalidated } from "./orchestrator.js";
import {
  endpointPlanCanWrite,
  trainEndpointNeedsReplacement,
  sameTrainEndpoints,
  trainRecoveryExcludedCodes,
  trafficLineChildShouldBeSkipped,
  trafficLineSkippedChildCanBeRetried,
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
import {
  verifyStableTrafficLineChildren,
  type TrafficLineChildReadback,
} from "./readback.js";
import type { TrafficLinePage } from "./client.js";
import { preflightTrafficLineEndpoints, resolveTrainReplacementEndpoints } from "./endpoints.js";
import { trafficLinePlanMatchesExplicitCities } from "../../../../shared/traffic-line-user-endpoints.js";
import { ensureHotelResourceApi } from "../hotel-resource-api.js";
import { trafficLineFailureProgress } from "./child-failure.js";
import {
  processTrafficLineTarget,
  type PendingTrafficLineChild,
} from "./main/process-target.js";
import type {
  TrafficLineApiOptions,
  TrafficLineApiResult,
} from "./main-types.js";

export type {
  TrafficLineApiOptions,
  TrafficLineApiResult,
};

export async function ensureTrafficLineApi(
  page: TrafficLinePage,
  parentProductId: string,
  config: import("../../../../shared/contracts-traffic-line.js").TrafficLineConfig,
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
  let endpoints: import("../../../../shared/contracts-traffic-line.js").TrafficLineEndpointPlan;
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

  const childResults = await Promise.all(targets.map((target) => processTrafficLineTarget(page, parentProductId, target, endpoints, options)));
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

export type { PendingTrafficLineChild };