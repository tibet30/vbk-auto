/** 运行器薄适配：持久化/进度由外层负责，平台协议只委托完整 API 流水线。 */

import type {
  TrafficLineChildProgress,
  TrafficLineConfig,
  TrafficLineEndpointPlan,
  TrafficLineVariant,
  TrafficLineWorkflowProgress,
} from "../../../../shared/contracts-traffic-line.js";
import { ensureTrafficLineApi } from "./main.js";
import type { TrafficLinePage } from "./client.js";
import type { TrafficLineStationDisambiguator } from "./endpoints.js";

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
}: TrafficLinePhaseInput): Promise<TrafficLinePhaseResult> {
  if (!config.enabled || config.variants.length === 0) {
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
  let result: Awaited<ReturnType<typeof ensureTrafficLineApi>>;
  try {
    result = await ensureTrafficLineApi(page, parentProductId, config, {
      itinerary,
      endpointPlan: progress.endpointPlan,
      rejectedTrainStationCodes: progress.rejectedTrainStationCodes,
      childProgress: progress.children,
      onEndpointPlan: (endpointPlan: TrafficLineEndpointPlan) => {
        progress = { ...progress, endpointPlan };
        persist();
      },
      onRejectedTrainStationCodes: (codes: string[]) => {
        progress = { ...progress, rejectedTrainStationCodes: [...codes] };
        persist();
      },
      onChildProgress: upsert,
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
  log(`线路及交通阶段已完成 ${children.length} 个子产品的远端聚合核验。`);
  progress = { ...progress, failureReason: undefined, verifiedAt: new Date().toISOString() };
  persist();
  // 创建/复用计数需由 future checkpoint 记录；不以本轮 API 返回猜测。
  return { planEnabled: result.enabled, created: 0, reused: 0, blocked: 0, children };
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
