/**
 * 交通子产品回读：
 *   - verifyTrafficTargets：按 variant 分组 + 唯一性 + 跨组未在 endpointPlan 内的拒绝；
 *     用 verifyTrafficChild 回读每个子产品，收集 RecoveryTarget[]。
 */

import { verifyTrafficLineChild, type TrafficLineChildReadback } from "../../automation/ctrip/traffic-line/readback.js";
import type { TrafficLineEndpointPlan, TrafficLineVariant } from "../../../shared/contracts-traffic-line.js";
import { normaliseTrafficLineVariant, trafficLineLabel } from "../../../shared/contracts-traffic-line.js";
import type { TrafficLineExistingChild } from "../../automation/ctrip/traffic-line/types.js";
import type { RecoveryInput, RecoveryTarget } from "./types.js";

export async function verifyTrafficTargets(args: {
  children: TrafficLineExistingChild[];
  input: RecoveryInput;
  page: unknown;
  verifyTrafficChild?: typeof verifyTrafficLineChild;
}): Promise<RecoveryTarget[]> {
  const verifyTrafficChild = args.verifyTrafficChild ?? verifyTrafficLineChild;
  const children = args.children;
  const byVariant = new Map<TrafficLineVariant, TrafficLineExistingChild[]>();
  for (const child of children) {
    const variant = normaliseTrafficLineVariant(child.lineDescription);
    if (!variant) throw new Error(`母产品交通子产品存在无法识别的方式「${child.lineDescription}」，不能安全恢复。`);
    const list = byVariant.get(variant) ?? [];
    list.push(child);
    byVariant.set(variant, list);
  }
  for (const variant of args.input.variants) {
    const matches = byVariant.get(variant) ?? [];
    if (matches.length !== 1) {
      throw new Error(`${trafficLineLabel(variant)}子产品回读数量为 ${matches.length}，无法唯一确认母子关系。`);
    }
  }
  const extras = [...byVariant.keys()].filter((variant) => !args.input.variants.includes(variant));
  if (extras.length) throw new Error(`母产品出现未在本次已核验交通计划中的子产品：${extras.map(trafficLineLabel).join("、")}。`);

  const targets: RecoveryTarget[] = [];
  if (!args.input.endpointPlan) throw new Error("缺少当前会话已核验的大交通端点计划，不能回读交通子产品。");
  for (const variant of args.input.variants) {
    const child = byVariant.get(variant)![0]!;
    const readback: TrafficLineChildReadback = await verifyTrafficChild(args.page as never, args.input.productId, child.productId, variant, args.input.endpointPlan as TrafficLineEndpointPlan);
    targets.push({ variant, child, readback });
  }
  return targets;
}