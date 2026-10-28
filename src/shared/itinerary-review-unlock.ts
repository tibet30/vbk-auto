/** Separate human authorization for itinerary review; never authorizes publication or traffic children. */
export interface ItineraryReviewMenu {
  key: string;
  title: string;
  url: string;
  enabled: "T" | "F";
}

export interface ItineraryReviewStepReceipt {
  step: string;
  endpoint: string;
  saveType?: number;
  ack: "Success";
  at: string;
}

/** A safe, bounded explanation of a review-check digest mismatch. */
export interface ItineraryReviewDigestMismatch {
  step: string;
  beforeDigest: string;
  afterDigest: string;
  paths: string[];
}

export const ITINERARY_REVIEW_DIGEST_MISMATCH_PATH_LIMIT = 12;
export const ITINERARY_REVIEW_DIGEST_MISMATCH_PATH_MAX_LENGTH = 240;
/** Historical marker written by the removed, unsafe audit=N auto-retry recovery. */
export const ITINERARY_REVIEW_LEGACY_VALIDATION_ONLY_RECOVERY_MESSAGE = "已确认先前仅执行校验且远端草稿未变化，可自动重新校验";
/** Written only after a fresh plan-level readback proves a validation-only mismatch did not persist. */
export const ITINERARY_REVIEW_VALIDATION_ONLY_RECOVERY_MESSAGE = "已只读确认审核校验未改变远端草稿，可继续当前批准流程";
/** Written when the platform rejected a read-only check (e.g. 行程文案非法关键词) before any remote write was dispatched. */
export const ITINERARY_REVIEW_REJECTED_WITHOUT_WRITE_MESSAGE = "平台在只读校验阶段驳回了行程文案，未形成远端写入，可修正文案后重新提交";

const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const step = (value: unknown): value is string => typeof value === "string" && /^[\u4e00-\u9fffA-Za-z0-9_-]{1,40}$/u.test(value);
const path = (value: unknown): value is string => typeof value === "string" && value.length <= ITINERARY_REVIEW_DIGEST_MISMATCH_PATH_MAX_LENGTH
  && /^\$(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[\d+\]|\[\*\])*$/u.test(value);

/** Reject malformed diagnostics so persisted/UI state cannot contain response bodies. */
export function readItineraryReviewDigestMismatch(value: unknown): ItineraryReviewDigestMismatch | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (!step(source.step) || !digest(source.beforeDigest) || !digest(source.afterDigest)
    || !Array.isArray(source.paths) || source.paths.length > ITINERARY_REVIEW_DIGEST_MISMATCH_PATH_LIMIT
    || !source.paths.every(path)) return undefined;
  return {
    step: source.step,
    beforeDigest: source.beforeDigest,
    afterDigest: source.afterDigest,
    paths: [...source.paths],
  };
}

export function itineraryReviewDigestMismatchFromError(error: unknown): ItineraryReviewDigestMismatch | undefined {
  if (!error || typeof error !== "object") return undefined;
  return readItineraryReviewDigestMismatch((error as { digestMismatch?: unknown }).digestMismatch);
}

export interface ItineraryReviewUnlockReceipt {
  verified: true;
  productId: string;
  tourInfoId: string;
  contentDigest: string;
  beforeDigest: string;
  afterDigest: string;
  routeId: number;
  maxStep: number;
  menus: ItineraryReviewMenu[];
  /** active=D 是首次保存基本信息后的「无效·下线」，仍属未发布。 */
  publication: { active: "F" | "D"; isonline: "F"; releaseActive: "F" };
  trafficChildren: 0;
  checkedAt: string;
  tabs: Array<{ key: string; title: string; url: string; verified: true }>;
  requestSteps: ItineraryReviewStepReceipt[];
  preflight?: Record<string, unknown>;
}

export interface ItineraryReviewUnlockPlan {
  token?: string;
  readonlyVerified?: boolean;
  localProductId: string;
  productId: string;
  productName: string;
  accountKey: string;
  productJsonVersion: number;
  tourInfoId: string;
  contentDigest: string;
  maxStep: number;
  lockedMenus: string[];
  expiresAt: string;
  receipt?: ItineraryReviewUnlockReceipt;
}

export interface ItineraryReviewUnlockState {
  localProductId: string;
  status: "requires_review" | "dispatched" | "uncertain" | "verified" | "failed";
  attemptId: string;
  approvalId?: string;
  agentRunId?: string;
  productId: string;
  accountKey: string;
  tourInfoId: string;
  beforeDigest: string;
  afterDigest?: string;
  digestMismatch?: ItineraryReviewDigestMismatch;
  routeId?: number;
  receipt?: ItineraryReviewUnlockReceipt;
  requestSteps?: ItineraryReviewStepReceipt[];
  message?: string;
  updatedAt: string;
}

/**
 * 平台只在只读校验步骤（checkTourDaily saveType=8/3）以「非法关键词」驳回。
 * 这类响应只做校验、不接受任何写入，因此可以安全地修正文案后重试，
 * 不需要进入「写入结果不明」的人工核对门禁。
 */
export function isItineraryReviewCopyRejectionMessage(message: unknown): boolean {
  if (typeof message !== "string" || !/非法(?:词|关键词)/.test(message)) return false;
  return /(?:^|：)行程审核(?:校验|提交校验)失败（Ack=Failure）/.test(message);
}

/**
 * 判定「平台驳回了只读校验，且本次提交没有产生任何远端写入」的审核状态。
 *  - requires_review + 空 attemptId + 专用标记：新链路在未派发写入时写入的状态，
 *    标记本身就是结构证据，允许保留校验步骤回执；
 *  - uncertain + 平台校验驳回文案：旧版本留下的历史状态，回执为空说明失败发生在第一个校验步骤。
 */
export function isItineraryReviewRejectedWithoutWrite(state: ItineraryReviewUnlockState | undefined): boolean {
  if (!state || state.digestMismatch || state.receipt || state.afterDigest !== undefined || state.routeId !== undefined) return false;
  const message = typeof state.message === "string" ? state.message : "";
  if (state.status === "requires_review") {
    return state.attemptId === "" && message.startsWith(ITINERARY_REVIEW_REJECTED_WITHOUT_WRITE_MESSAGE);
  }
  return state.status === "uncertain" && Array.isArray(state.requestSteps) && state.requestSteps.length === 0
    && isItineraryReviewCopyRejectionMessage(message);
}
