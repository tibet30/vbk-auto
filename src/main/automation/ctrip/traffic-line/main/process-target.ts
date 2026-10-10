/**
 * processTarget：单交通子产品的完整流水线（站点规划 / 关系 / 图文 / 资源
 * / 行程 / 条款 / 激活）。把 ensureTrafficLineApi 内的 target 单步逻辑
 * 拆出，主函数只剩「过滤 / 调度 / 整组聚合回读」。
 *
 * 文件抽出来的目的：
 *   - 主函数不再是 200+ 行巨型流程，便于阅读；
 *   - 子流程能被 readback.test.ts / 单元测试单测；
 *   - 失败时返回 `{ skipped: ... }` 而不是抛错，方便外层以子产品维度跳过
 *     继续推进其它子产品。
 */

import {
  ensureTrafficLineRelationship,
} from "../relationships.js";
import { ensureTrafficLinePresentation } from "../presentation.js";
import {
  ensureTrafficLineSegments,
  readTrafficLineSegmentReadback,
  recoverPendingTrafficLineSegmentSubmit,
  trafficLineResourceCheckDates,
} from "../segments.js";
import {
  ensureTrafficLineVehicleBinding,
  ensureTrafficLineVehicleDraft,
  invalidateTrafficLineFinalReadback,
  trafficLinePendingSubmitNeedsOneRecoveryRetry,
} from "../helpers.js";
import { ensureTrafficLineItinerary } from "../itinerary.js";
import {
  activateTrafficLineChild,
  repairTrafficLineItineraryIfMissing,
  ensureTrafficLineClausesWithItineraryRecovery,
} from "../readback.js";
import { submitWithOnePendingRecovery } from "../pending-submit-recovery.js";
import { submitWithFormalCardRecovery } from "../card-submit-recovery.js";
import { readSegmentSubmitState } from "../segment-submit.js";
import {
  trafficLineFailureProgress,
  trafficRouteActivationCanResume,
  trafficSegmentSubmitNeedsRecovery,
  trafficClauseMaterializationCanResume,
  trafficResourceCardRejected,
} from "../child-failure.js";
import {
  trafficLineLabel,
  type TrafficLineChildProgress,
  type TrafficLineChildStage,
  type TrafficLineEndpointPlan,
  type TrafficLineVariant,
} from "../../../../../shared/contracts-traffic-line.js";
import type { TrafficLinePage } from "../client.js";
import type { TrafficLineApiOptions, TrafficLineApiResult } from "../main-types.js";
import { ensureHotelResourceApi } from "../../hotel-resource-api.js";

export interface PendingTrafficLineChild {
  variant: TrafficLineVariant;
  lineDescription: string;
  childProductId: string;
  checkpoint: (stage: TrafficLineChildStage, childProductId?: string, verified?: boolean) => void;
  snapshot: () => TrafficLineChildProgress;
}

export type TrafficLineChildPipelineResult =
  | { pending: PendingTrafficLineChild }
  | { skipped: { variant: TrafficLineVariant; lineDescription: string; reason: string } };

export async function processTrafficLineTarget(
  page: TrafficLinePage,
  parentProductId: string,
  target: { variant: TrafficLineVariant; lineDescription: string },
  endpoints: TrafficLineEndpointPlan,
  options: TrafficLineApiOptions,
): Promise<TrafficLineChildPipelineResult> {
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
    // hotelGrades=[] 拒绝"至少包含一晚酒店"，即使母产品本身已有酒店。
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
    const resourceCheckDates = trafficLineResourceCheckDates(options.product, options.now);
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
}

export type { TrafficLineApiOptions, TrafficLineApiResult };