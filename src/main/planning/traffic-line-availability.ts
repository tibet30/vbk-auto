/**
 * 初始结构化规划里的大交通判定。
 *
 * 行程 POI 已核验后，才具备首日 / 末日的真实城市。这里用同一 VBK 会话分别
 * 查询机场和火车站；只有相应接口确认成功的变体才会进入 operations.trafficLine。
 */

import {
  TRAFFIC_LINE_VARIANTS,
  normaliseTrafficLineConfig,
  type TrafficLineConfig,
  type TrafficLineVariant,
} from "../../shared/contracts-traffic-line.js";
import type { OrchestratorRuntime } from "./types.js";

export type InitialTrafficLineSyncResult =
  | { status: "updated"; config: TrafficLineConfig }
  | { status: "skipped"; reason: "unsupported" | "alreadyConfigured" | "unconfirmed" };

/**
 * 每个产品默认探测大交通端点：只要 VBK 当前会话能确认机场或火车站，就把
 * 对应往返子产品配置写入草稿。用户已明确配置的交通方式不会被覆盖；但先前
 * 只因会话或消歧服务短暂失败而缺失的方式必须在后续规划中重新核验，不能永久
 * 降级为单一方式。
 */
export async function syncInitialTrafficLineAvailability(
  localProductId: string,
  runtime: OrchestratorRuntime,
): Promise<InitialTrafficLineSyncResult> {
  if (!runtime.resolveTrafficLineAvailability || !runtime.writeResolvedTrafficLineConfig) {
    return { status: "skipped", reason: "unsupported" };
  }
  const current = await runtime.loadCurrentProduct(localProductId);
  const operations = current.operations;
  const existing = normaliseTrafficLineConfig(
    operations && typeof operations === "object" && !Array.isArray(operations)
      ? (operations as Record<string, unknown>).trafficLine
      : undefined,
  );
  if ((existing?.enabled || existing?.variants.length) && !hasRetryableTrafficAvailability(existing)) {
    return { status: "skipped", reason: "alreadyConfigured" };
  }

  let availability;
  try {
    availability = await runtime.resolveTrafficLineAvailability(localProductId);
  } catch {
    // 失败不等于目的地没有大交通；下次 POI 已更完整或会话恢复后可以重试。
    return { status: "skipped", reason: "unconfirmed" };
  }
  if (!availability) return { status: "skipped", reason: "unconfirmed" };

  const variants = trafficLineVariantsForResolvedAvailability(availability);
  const config: TrafficLineConfig = {
    enabled: variants.length > 0,
    variants,
    ...(existing?.arrivalCity ? { arrivalCity: existing.arrivalCity } : {}),
    ...(existing?.departureCity ? { departureCity: existing.departureCity } : {}),
    availability,
  };
  const written = await runtime.writeResolvedTrafficLineConfig(localProductId, config);
  if (!written.ok) throw new Error(`大交通判定结果未保存：${written.reason ?? "本地写入失败"}`);
  return { status: "updated", config };
}

/**
 * 端点查询明确返回“没有唯一候选”才是业务不可用。超时、会话、网络或候选
 * 消歧失败并未证实机场不存在，下一次规划应重新查这一种方式。
 */
function hasRetryableTrafficAvailability(config: TrafficLineConfig | undefined): boolean {
  return Object.values(config?.availability?.unavailableVariants ?? {}).some((reason) =>
    !isBusinessUnavailableTrafficStation(reason),
  );
}

function trafficLineVariantsForResolvedAvailability(
  availability: { availableVariants: TrafficLineVariant[]; unavailableVariants: Partial<Record<TrafficLineVariant, string>> },
): TrafficLineVariant[] {
  return TRAFFIC_LINE_VARIANTS.filter((variant) => {
    if (availability.availableVariants.includes(variant)) return true;
    const reason = availability.unavailableVariants[variant];
    return Boolean(reason && !isBusinessUnavailableTrafficStation(reason));
  });
}

function isBusinessUnavailableTrafficStation(reason: string): boolean {
  return /未找到唯一可确认的(?:机场|火车站)候选/.test(reason);
}
