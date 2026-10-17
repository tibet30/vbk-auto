import type { AgentApproval, AgentSnapshot, ProductDetail } from "../../../shared/contracts.js";
import { approvedPlanVersion } from "../../application/product-approval-projection.js";

/** A fresh approval after an older plan fingerprint is the legacy replay signal. */
export function approvalFollowsChangedPlan(
  product: ProductDetail,
  snapshot: AgentSnapshot,
  approval: AgentApproval,
): boolean {
  if (snapshot.events.some((event) => event.runId === snapshot.run?.id
    && event.data?.changedApprovalRecovery === true)) return true;
  const currentVersion = approvedPlanVersion(product);
  const approvalIndex = snapshot.events.findIndex((event) => event.type === "approval"
    && (event.data?.approval as AgentApproval | undefined)?.id === approval.id);
  const history = approvalIndex < 0 ? snapshot.events : snapshot.events.slice(0, approvalIndex);
  const earlier = [...history].reverse()
    .filter((event) => event.type === "approval")
    .map((event) => event.data?.approval as AgentApproval | undefined)
    .find((value) => Boolean(value?.productVersion));
  return Boolean(earlier?.productVersion && earlier.productVersion !== currentVersion);
}
