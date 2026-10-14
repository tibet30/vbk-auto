import type { AgentSnapshot } from "../../shared/contracts.js";

export const PRE_DISPATCH_VBK_IDENTITY_ERROR = "未验证当前 VBK 登录账号，不能授权或写入。";
export const SAFE_STARTUP_EXTERNAL_ACTION_BLOCK_REASON =
  "本地准备已完成；安全模式不会验证账号或发起 VBK 录入。请用常规模式重新验证账号，并发起新的审批。";

/** Local planning remains available; only account-bound external actions are blocked. */
export function externalAgentActionsBlocked(enabled?: boolean): boolean {
  return enabled === false;
}

/** Persist one stable reason whenever an account-bound action is stopped locally. */
export function pauseSafeStartupExternalAction(
  snapshot: AgentSnapshot,
  pause: (snapshot: AgentSnapshot, reason: string) => void,
): void {
  if (!snapshot.run) return;
  snapshot.run.error = undefined;
  pause(snapshot, SAFE_STARTUP_EXTERNAL_ACTION_BLOCK_REASON);
  const status = snapshot.events.at(-1);
  if (status?.type === "status") status.data = { ...status.data, safeStartupExternalActionBlocked: true };
}

/** A failed account probe can be repaired only when no external dispatch was recorded. */
export function isRecoverableSafeStartupIdentityFailure(snapshot: AgentSnapshot): boolean {
  const run = snapshot.run;
  return run?.status === "failed" && run.error === PRE_DISPATCH_VBK_IDENTITY_ERROR
    && !snapshot.uncertainWrite
    && !snapshot.events.some((event) => event.runId === run.id
      && (event.data?.writeDispatch === true || event.data?.remoteWrite === true));
}
