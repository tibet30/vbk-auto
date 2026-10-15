import { randomUUID } from "node:crypto";
import type { AgentSnapshot } from "../../../../shared/contracts-agent.js";
import type {
  ItineraryReviewStepReceipt,
  ItineraryReviewUnlockReceipt,
  ItineraryReviewUnlockState,
} from "../../../../shared/itinerary-review-unlock.js";
import {
  ITINERARY_REVIEW_LEGACY_VALIDATION_ONLY_RECOVERY_MESSAGE,
  ITINERARY_REVIEW_REJECTED_WITHOUT_WRITE_MESSAGE,
  ITINERARY_REVIEW_VALIDATION_ONLY_RECOVERY_MESSAGE,
  itineraryReviewDigestMismatchFromError,
} from "../../../../shared/itinerary-review-unlock.js";
import { itineraryReviewUnlockApproval } from "../../../../shared/itinerary-review-approval.js";
import type { VbkSessionRequestBrowser } from "../../../infrastructure/vbk-session-request.js";
import { itineraryReviewRequestSource } from "../../../operations/itinerary-review-request-source.js";
import { isReviewDraftMenuBoundary } from "../../../operations/itinerary-review-unlock-support.js";
import { isItineraryReviewCompletedMenus } from "../../ctrip/product-menu-readback.js";
import {
  readItineraryReviewEvidence,
  submitItineraryReviewUnlock,
  verifyItineraryReviewUnlockEventually,
  verifyPlannedItinerary,
  type ItineraryReviewEvidence,
} from "../../ctrip/itinerary-review/index.js";

interface Protocol {
  read(page: VbkSessionRequestBrowser, productId: string): Promise<ItineraryReviewEvidence>;
  submit(page: VbkSessionRequestBrowser, evidence: ItineraryReviewEvidence, options: {
    assertCurrent?: () => void | Promise<void>;
    onStep?: (step: ItineraryReviewStepReceipt) => void;
    onWrite?: () => void;
  }): Promise<void>;
  verify(page: VbkSessionRequestBrowser, productId: string, digest?: string,
    product?: unknown): Promise<ItineraryReviewUnlockReceipt>;
}

export interface WorkflowItineraryReviewArgs {
  localProductId: string;
  productId: string;
  product: Record<string, unknown>;
  page: VbkSessionRequestBrowser;
  snapshot(): AgentSnapshot | undefined;
  productIdentity(): string | undefined;
  accountIdentity(): string | undefined;
  cancelled?(): boolean;
  assertAuthorized?(): Promise<void>;
  stateStore: {
    get(id: string): ItineraryReviewUnlockState | undefined;
    save(state: ItineraryReviewUnlockState): void;
  };
  now?: () => number;
  /** Test seams may replace only final verification; reads and submission stay production by default. */
  protocol?: Partial<Protocol>;
  verifyPlan?: typeof verifyPlannedItinerary;
}

function sameEvidence(current: ItineraryReviewEvidence, expected: ItineraryReviewEvidence) {
  const relation = (value: ItineraryReviewEvidence) => JSON.stringify(value.relation);
  const menus = (value: ItineraryReviewEvidence) => JSON.stringify(
    value.menus.map(menu => [menu.key, menu.title, menu.enabled]),
  );
  if (current.productId !== expected.productId || current.tourInfoId !== expected.tourInfoId
    || current.contentDigest !== expected.contentDigest || current.maxStep !== expected.maxStep
    || relation(current) !== relation(expected) || menus(current) !== menus(expected)) {
    throw new Error("行程审核前远端版本或菜单状态已变化，已停止提交");
  }
}

function unlocked(evidence: ItineraryReviewEvidence) {
  return isItineraryReviewCompletedMenus(evidence);
}

/** Empty receipts include check8 response-validation failures, so they are not zero-write proof. */
function hasUnresolvedReviewWrite(previous: ItineraryReviewUnlockState | undefined): boolean {
  return previous?.status === "dispatched" || previous?.status === "uncertain"
    || previous?.digestMismatch !== undefined
    || (previous?.status === "requires_review"
      && previous.attemptId === ""
      && previous.message === ITINERARY_REVIEW_LEGACY_VALIDATION_ONLY_RECOVERY_MESSAGE);
}

/** A full plan readback may skip duplicate itinerary saving, but never the review protocol itself. */
export function canResumeVerifiedItineraryReviewOnly(args: {
  snapshot: AgentSnapshot | undefined;
  state: ItineraryReviewUnlockState | undefined;
  productId: string;
}): boolean {
  const approval = itineraryReviewUnlockApproval(args.snapshot);
  const state = args.state;
  return Boolean(approval && args.snapshot?.run
    && state?.status === "requires_review" && state.attemptId === ""
    && state.message === ITINERARY_REVIEW_VALIDATION_ONLY_RECOVERY_MESSAGE
    && Array.isArray(state.requestSteps) && state.requestSteps.length === 0
    && state.digestMismatch === undefined && state.afterDigest === undefined
    && state.receipt === undefined && state.routeId === undefined
    && state.productId === args.productId && state.approvalId === approval.id
    && state.agentRunId === args.snapshot.run.id && state.accountKey === approval.accountKey);
}

/** A same-run verified receipt completes itinerary without rewriting the now-formal plan. */
export function canReuseVerifiedItineraryReview(args: {
  snapshot: AgentSnapshot | undefined;
  state: ItineraryReviewUnlockState | undefined;
  productId: string;
}): boolean {
  const approval = itineraryReviewUnlockApproval(args.snapshot);
  const state = args.state;
  return Boolean(approval && args.snapshot?.run && state?.status === "verified"
    && state.receipt?.verified === true && state.productId === args.productId
    && state.receipt.productId === args.productId && state.approvalId === approval.id
    && state.agentRunId === args.snapshot.run.id && state.accountKey === approval.accountKey
    && approval.itineraryReviewUnlockAuthorized === true);
}

/** Executes the review protocol only inside the current explicitly approved workflow run. */
export async function runWorkflowItineraryReviewUnlock(args: WorkflowItineraryReviewArgs) {
  const initialApproval = itineraryReviewUnlockApproval(args.snapshot());
  if (!initialApproval) return { skipped: "not-authorized" as const };
  const agentRunId = args.snapshot()!.run!.id;
  const page = itineraryReviewRequestSource(args.page, args.productId);
  const protocol: Protocol = {
    read: readItineraryReviewEvidence,
    submit: submitItineraryReviewUnlock,
    verify: (page, productId, digest, product) => verifyItineraryReviewUnlockEventually(
      page, productId, digest, product, { assertCurrent },
    ),
    ...args.protocol,
  };
  const verifyPlan = args.verifyPlan ?? verifyPlannedItinerary;
  const now = () => new Date(args.now?.() ?? Date.now()).toISOString();
  const assertCurrent = async () => {
    await args.assertAuthorized?.();
    const current = itineraryReviewUnlockApproval(args.snapshot());
    if (!current || current.id !== initialApproval.id) throw new Error("当前行程审核授权已失效");
    if (args.productIdentity() !== args.productId) throw new Error("当前远端产品身份已变化");
    if (args.accountIdentity() !== initialApproval.accountKey) throw new Error("当前 VBK 账号与审核授权不一致");
    if (args.cancelled?.()) throw new Error("自动录入已取消");
  };
  await assertCurrent();
  const previous = args.stateStore.get(args.localProductId);
  let evidence = await protocol.read(page, args.productId);
  await assertCurrent();
  if (unlocked(evidence)) {
    const receipt = await protocol.verify(page, args.productId, previous?.beforeDigest, args.product);
    await assertCurrent();
    args.stateStore.save(verifiedState(args, initialApproval, agentRunId, previous?.attemptId, receipt, now()));
    return { verified: true as const, receipt };
  }
  if (!isReviewDraftMenuBoundary(evidence)) {
    throw new Error("当前远端状态不是可确认的行程审核边界");
  }
  if (hasUnresolvedReviewWrite(previous)) {
    throw new Error("上次行程审核写入结果尚未确认；禁止自动重复提交");
  }
  const planned = await verifyPlan(page, args.product, args.productId, evidence.tourInfoId);
  if (planned.tourInfoId !== evidence.tourInfoId || planned.contentDigest !== evidence.contentDigest) {
    throw new Error("本地确认方案与当前远端行程不一致，已停止审核");
  }
  const fresh = await protocol.read(page, args.productId);
  await assertCurrent();
  sameEvidence(fresh, evidence);
  evidence = fresh;
  const attemptId = randomUUID();
  let state: ItineraryReviewUnlockState = {
    localProductId: args.localProductId, status: "dispatched", attemptId,
    approvalId: initialApproval.id, agentRunId,
    productId: args.productId, accountKey: initialApproval.accountKey,
    tourInfoId: evidence.tourInfoId, beforeDigest: evidence.contentDigest, requestSteps: [],
    message: "已批准的自动录入正在提交行程审核；完成前禁止重复提交", updatedAt: now(),
  };
  args.stateStore.save(state);
  let remoteWriteDispatched = false;
  try {
    await protocol.submit(page, evidence, {
      assertCurrent,
      onWrite: () => { remoteWriteDispatched = true; },
      onStep: step => {
        state = { ...state, requestSteps: [...(state.requestSteps ?? []), step], updatedAt: now() };
        args.stateStore.save(state);
      },
    });
    await assertCurrent();
    const verified = await protocol.verify(page, args.productId, evidence.contentDigest, args.product);
    await assertCurrent();
    const receipt = { ...verified, requestSteps: state.requestSteps ?? [] };
    args.stateStore.save(verifiedState(args, initialApproval, agentRunId, attemptId, receipt, now()));
    return { verified: true as const, receipt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const digestMismatch = itineraryReviewDigestMismatchFromError(error);
    // 平台只在只读校验阶段驳回（如行程文案非法关键词）时，本次提交没有派发任何远端写入：
    // 保留可重试的审核边界，让同一批准流程修正文案后重新提交，而不是留下“写入结果不明”。
    if (!remoteWriteDispatched && !digestMismatch) {
      const rejected = {
        ...state,
        status: "requires_review" as const,
        attemptId: "",
        message: `${ITINERARY_REVIEW_REJECTED_WITHOUT_WRITE_MESSAGE}：${message}`,
        updatedAt: now(),
      };
      args.stateStore.save(rejected);
      throw Object.assign(new Error(message), { itineraryReviewValidationOnly: true });
    }
    state = { ...state, status: "uncertain",
      ...(digestMismatch ? { digestMismatch } : {}),
      message, updatedAt: now() };
    try { args.stateStore.save(state); } catch { /* durable dispatched barrier remains */ }
    throw Object.assign(new Error(state.message), {
      uncertainWrite: true,
      ...(digestMismatch ? { digestMismatch } : {}),
    });
  }
}

function verifiedState(args: WorkflowItineraryReviewArgs,
  approval: { id: string; accountKey: string }, agentRunId: string, attemptId: string | undefined,
  receipt: ItineraryReviewUnlockReceipt, updatedAt: string): ItineraryReviewUnlockState {
  return {
    localProductId: args.localProductId, status: "verified", attemptId: attemptId ?? randomUUID(),
    approvalId: approval.id, agentRunId,
    productId: receipt.productId, accountKey: approval.accountKey, tourInfoId: receipt.tourInfoId,
    beforeDigest: receipt.beforeDigest, afterDigest: receipt.afterDigest, routeId: receipt.routeId,
    receipt, requestSteps: receipt.requestSteps, updatedAt,
  };
}
