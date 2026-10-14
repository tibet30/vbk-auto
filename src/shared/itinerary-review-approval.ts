import type { AgentApproval, AgentSnapshot } from "./contracts-agent.js";

export const ITINERARY_REVIEW_UNLOCK_SCOPE = "vbk.review_unlock:itinerary";

/** Only the current run's explicit approval may authorize the review protocol. */
export function itineraryReviewUnlockApproval(snapshot: AgentSnapshot | undefined): AgentApproval | undefined {
  if (!snapshot?.run) return undefined;
  const latest = [...snapshot.events].reverse()
    .find(event => event.runId === snapshot.run?.id && event.type === "approval");
  const approval = latest?.data?.approval as AgentApproval | undefined;
  if (approval?.status !== "approved"
    || approval.intentVersion !== snapshot.run.intentVersion
    || approval.itineraryReviewUnlockAuthorized !== true
    || !approval.scope.includes(ITINERARY_REVIEW_UNLOCK_SCOPE)) return undefined;
  return approval;
}

export function itineraryReviewUnlockAuthorized(snapshot: AgentSnapshot | undefined): boolean {
  return Boolean(itineraryReviewUnlockApproval(snapshot));
}
