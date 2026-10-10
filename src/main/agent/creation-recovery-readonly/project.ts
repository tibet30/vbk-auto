/**
 * recovery 输出投影：
 *   - projectCreationVariant：剥掉内部 id 字段，仅暴露 variant / unsubmittedDraftVerified /
 *     draftSource / ids / poi85862；
 *   - projectPreflight：仅保留 productId / verifiedWith + basic / presentation / itinerary /
 *     package / pricingInventory / clauses / resources 八个证据段；
 *   - projectTrafficTarget：把 RecoveryTarget 转成 { variant, productId,
 *     lineDescription, packageId, active, finalReadback: { ... } } 形式，
 *     finalReadback 是 verifyTrafficChild 的输出字段。
 */

import type { CreationVariantReadback, RecoveryTarget } from "./types.js";

export function projectCreationVariant(value: CreationVariantReadback) {
  return {
    variant: value.variant,
    unsubmittedDraftVerified: value.unsubmittedDraftVerified,
    ...(value.draftSource ? { draftSource: value.draftSource } : {}),
    ids: value.ids,
    ...(value.poi85862 ? { poi85862: value.poi85862 } : {}),
  };
}

export function projectPreflight(value: unknown): Record<string, unknown> {
  const evidence = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    productId: evidence.productId,
    verifiedWith: evidence.verifiedWith,
    basic: evidence.basic,
    presentation: evidence.presentation,
    itinerary: evidence.itinerary,
    package: evidence.package,
    pricingInventory: evidence.pricingInventory,
    clauses: evidence.clauses,
    resources: evidence.resources,
  };
}

export function projectTrafficTarget(target: RecoveryTarget) {
  return {
    variant: target.variant,
    productId: target.child.productId,
    lineDescription: target.child.lineDescription,
    packageId: target.child.packageId,
    active: target.child.active,
    finalReadback: {
      tourInfoId: target.readback.tourInfoId,
      segmentCount: target.readback.segmentCount,
      departureCityCount: target.readback.departureCityCount,
      transportNodes: target.readback.transportNodes,
      clauseCount: target.readback.clauseCount,
      presentationVerified: target.readback.presentationVerified,
    },
  };
}