/** 运行器薄适配：持久化/进度由外层负责，平台协议只委托完整 API 流水线。 */

import type {
  TrafficLineChildProgress,
  TrafficLineConfig,
  TrafficLineEndpointPlan,
  TrafficLineVariant,
  TrafficLineWorkflowProgress,
} from "../../../../shared/contracts-traffic-line.js";
import { ensureTrafficLineApi, isUnavailableTrafficResourceFailure } from "./main.js";
import type { TrafficLinePage } from "./client.js";
import type { TrafficLineStationDisambiguator } from "./endpoints.js";
import { ensureAuthorizedTrafficRouteReview } from "./authorized-route-review.js";

type TrafficLineLog = (message: string, level?: "info" | "warning" | "error") => void;

interface TrafficLinePhaseInput {
  page: TrafficLinePage;
  parentProductId: string;
  config: TrafficLineConfig;
  itinerary: readonly { spots?: Array<{ city?: string | null }> }[];
  log: TrafficLineLog;
  checkpoint?: TrafficLineWorkflowProgress;
  onCheckpoint?: (checkpoint: TrafficLineWorkflowProgress) => void;
  disambiguator?: TrafficLineStationDisambiguator;
  product?: Record<string, unknown>;
  routeReviewAuthorized?: boolean;
}

interface TrafficLinePhaseResultChild {
  variant: TrafficLineVariant;
  childProductId: string;
  lineDescription: string;
}

export interface TrafficLinePhaseResult {
  planEnabled: boolean;
  created: number;
  reused: number;
  blocked: number;
  children: TrafficLinePhaseResultChild[];
}

/**
 * 运行期不再按同城预先删除火车：初始端点接口确认的配置应完整进入平台
 * 资源校验，由平台的真实可售结果决定是否可创建子产品。
 */
export function trafficLineConfigForProduct(
  config: TrafficLineConfig,
  _product: Record<string, unknown> | undefined,
): TrafficLineConfig {
  return config;
}

export async function ensureTrafficLinePhase({
  page,
  parentProductId,
  config,
  log,
  itinerary,
  checkpoint,
  onCheckpoint,
  disambiguator,
  product,
  routeReviewAuthorized,
}: TrafficLinePhaseInput): Promise<TrafficLinePhaseResult> {
  const executableConfig = trafficLineConfigForProduct(config, product);
  if (!executableConfig.enabled || executableConfig.variants.length === 0) {
    log("线路及交通配置未启用或未选择往返类型，跳过该阶段。", "warning");
    return { planEnabled: false, created: 0, reused: 0, blocked: 0, children: [] };
  }
  let progress = invalidateTrafficLineWorkflowVerification(checkpoint);
  const persist = () => onCheckpoint?.(structuredClone(progress));
  const upsert = (child: TrafficLineChildProgress) => {
    const index = progress.children.findIndex((item) => item.variant === child.variant);
    progress = {
      ...progress,
      children: index < 0
        ? [...progress.children, child]
        : progress.children.map((item, itemIndex) => itemIndex === index ? child : item),
    };
    persist();
  };
  persist();
  const endpointPlan = progress.endpointPlan ?? executableConfig.availability?.endpointPlan;
  let result: Awaited<ReturnType<typeof ensureTrafficLineApi>>;
  try {
    await ensureAuthorizedTrafficRouteReview(page, parentProductId, routeReviewAuthorized === true, log);
    result = await ensureTrafficLineApi(page, parentProductId, executableConfig, {
      // 平台核验不是同步保存；有界只读等待覆盖超过一分钟的正常异步结算。
      maxSegmentPolls: 600,
      itinerary,
      endpointPlan,
      rejectedTrainStationCodes: progress.rejectedTrainStationCodes,
      childProgress: progress.children,
      onEndpointPlan: (endpointPlan: TrafficLineEndpointPlan) => {
        progress = { ...progress, endpointPlan };
        persist();
      },
      onUnavailableVariants: (unavailableVariants) => {
        progress = { ...progress, unavailableVariants };
        persist();
        for (const [variant, reason] of Object.entries(unavailableVariants)) {
          log(`${variant === "flightRoundTrip" ? "飞机" : "火车"}子产品录入前查询不可用，已跳过：${reason}`, "warning");
        }
      },
      onRejectedTrainStationCodes: (codes: string[]) => {
        progress = { ...progress, rejectedTrainStationCodes: [...codes] };
        persist();
      },
      onChildProgress: upsert,
      onStatus: (message) => log(message),
      disambiguator,
      product,
    });
  } catch (error) {
    progress = {
      ...progress,
      failureReason: error instanceof Error ? error.message : String(error),
    };
    persist();
    throw error;
  }
  const children = result.children.map((child) => ({
    variant: child.variant,
    childProductId: child.childProductId,
    lineDescription: child.lineDescription,
  }));
  for (const item of result.skipped ?? []) {
    log(`${item.variant === "flightRoundTrip" ? "飞机" : "火车"}子产品未完成，已记录未完成原因：${item.reason}`, "warning");
  }
  log(`线路及交通阶段已完成 ${children.length} 个子产品的远端聚合核验。`);
  const skipped = result.skipped ?? [];
  // 端点存在不等于当前班期有可售资源；平台明确无资源时保留
  // skipped 证据；会话/保存/回读失败保留子产品失败态，由外层继续母产品预检。
  const unresolvedAvailable = skipped.filter((item) => !isUnavailableTrafficResourceFailure(item.reason, item.variant));
  if (unresolvedAvailable.length) {
    const reason = unresolvedAvailable.map((item) => `${item.variant}=${item.reason}`).join("；");
    progress = { ...progress, failureReason: reason, verifiedAt: undefined };
    persist();
    throw new Error(`当前会话已确认可用的交通子产品未完成最终回读：${reason}`);
  }
  const fullyVerified = children.length > 0 && skipped.length === 0;
  progress = {
    ...progress,
    failureReason: fullyVerified
      ? undefined
      : skipped.map((item) => `${item.variant}=${item.reason}`).join("；") || "交通子产品未完成最终回读。",
    verifiedAt: fullyVerified ? new Date().toISOString() : undefined,
  };
  persist();
  // 创建/复用计数需由 future checkpoint 记录；不以本轮 API 返回猜测。
  return { planEnabled: result.enabled, created: 0, reused: 0, blocked: skipped.length, children };
}

/** 新一轮远端核验开始后，旧 verifiedAt 立即失效，避免 UI 显示历史成功。 */
export function invalidateTrafficLineWorkflowVerification(
  checkpoint: TrafficLineWorkflowProgress | undefined,
): TrafficLineWorkflowProgress {
  return {
    ...(checkpoint ?? { children: [] }),
    verifiedAt: undefined,
    failureReason: undefined,
  };
}
