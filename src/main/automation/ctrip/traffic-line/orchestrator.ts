/**
 * 线路及交通子产品的确定性编排辅助。
 *
 * 本文件只负责 opt-in 判定、历史子产品幂等匹配，以及把“创建壳”委托给注入的 gateway。
 * 图文/资源/行程/条款/有效化写入由 trafficLine 主阶段的其它模块完成。
 */

import {
  normaliseTrafficLineVariant,
  trafficLineLabel,
  type TrafficLineConfig,
  type TrafficLineVariant,
} from "../../../../shared/contracts-traffic-line.js";
import type {
  TrafficLineChildAction,
  TrafficLineExistingChild,
  TrafficLineGateway,
  TrafficLineProvisionPlan,
  TrafficLineProvisionResult,
  TrafficLineTarget,
} from "./types.js";

export function buildTrafficLineTargets(config: TrafficLineConfig | undefined): TrafficLineTarget[] {
  if (!config?.enabled) return [];
  const seen = new Set<TrafficLineVariant>();
  return config.variants.flatMap((variant) => {
    if (seen.has(variant)) return [];
    seen.add(variant);
    return [{
      variant,
      lineDescription: trafficLineLabel(variant),
    }];
  });
}

/**
 * 将目标与平台已存在的子产品做一次纯匹配。多个现有产品落到同一个 variant
 * 时不猜测哪个可用，而是返回 blocked，杜绝新建重复产品或误激活历史产品。
 */
export function buildTrafficLineProvisionPlan(
  config: TrafficLineConfig | undefined,
  existingChildren: readonly TrafficLineExistingChild[],
): TrafficLineProvisionPlan {
  const targets = buildTrafficLineTargets(config);
  const actions = targets.map((target): TrafficLineChildAction => {
    const matches = existingChildren.filter((child) => normaliseTrafficLineVariant(child.lineDescription) === target.variant);
    if (matches.length > 1) {
      return { kind: "blocked", target, reason: `VBK 中存在 ${matches.length} 个「${target.lineDescription}」子产品，需先人工确认。` };
    }
    if (matches.length === 1) return { kind: "reuse", target, child: matches[0] };
    return { kind: "create", target };
  });
  return { enabled: Boolean(config?.enabled), actions };
}

/** 创建请求从刚回读的模板复制，并按子产品规则禁用当日可订。 */
export function buildTrafficLineSaveRequest(
  parentProductId: string,
  target: TrafficLineTarget,
  template: { generalInfoDto: Record<string, unknown>; subLineInfoDto: Record<string, unknown> },
) {
  return {
    parentProductId,
    lineDescription: target.lineDescription,
    generalInfoDto: structuredClone(template.generalInfoDto),
    subLineInfoDto: {
      ...structuredClone(template.subLineInfoDto),
      advanceBookingDays: 1,
      advanceBookingTime: "18:00",
      lineDescription: target.lineDescription,
    },
  };
}

/**
 * 创建壳的唯一副作用入口。调用方必须在母产品远端 readback 后才传入 gateway；
 * 本函数不会隐式激活套餐，也不会调用后续资源、行程或条款写入。
 */
export async function provisionTrafficLineChildren({
  parentProductId,
  config,
  gateway,
}: {
  parentProductId: string;
  config: TrafficLineConfig | undefined;
  gateway: TrafficLineGateway;
}): Promise<TrafficLineProvisionResult> {
  const existing = config?.enabled ? await gateway.listExistingChildren(parentProductId) : [];
  const plan = buildTrafficLineProvisionPlan(config, existing);
  const created: TrafficLineExistingChild[] = [];
  const reused: TrafficLineExistingChild[] = [];
  const blocked: TrafficLineProvisionResult["blocked"] = [];
  const creates = plan.actions.filter((action): action is Extract<TrafficLineChildAction, { kind: "create" }> => action.kind === "create");
  const template = creates.length ? await gateway.getCreateTemplate(parentProductId) : null;

  for (const action of plan.actions) {
    if (action.kind === "reuse") {
      reused.push(action.child);
      continue;
    }
    if (action.kind === "blocked") {
      blocked.push({ target: action.target, reason: action.reason });
      continue;
    }
    const saved = await gateway.createChild(buildTrafficLineSaveRequest(parentProductId, action.target, template!));
    created.push({ productId: saved.productId, lineDescription: action.target.lineDescription });
  }
  return { plan, created, reused, blocked };
}
