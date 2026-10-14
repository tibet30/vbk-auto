/**
 * DraftAutomation lifecycle 守卫：
 *   - canRestartPreWriteAuthorizationFailure：write guard 前配置失败时允许
 *     从 saleControl 重跑；其它失败状态仍走权威核查。
 *
 * 把这条独立工具从主类文件里抽出来，避免类文件被夹塞零碎决策逻辑。
 */

import type { AutomationRun } from "../../../../shared/contracts.js";

const PRE_WRITE_AUTHORIZATION_FAILURES = new Set([
  "当前任务未处于可录入状态。",
  "方案、意图或账号已变化，请重新确认后录入。",
]);

export function canRestartPreWriteAuthorizationFailure(
  run: AutomationRun | undefined,
  productId: string | null | undefined,
): boolean {
  return Boolean(
    run?.status === "failed"
      && !productId
      && run.currentPhase === "saleControl"
      && run.phases.every((phase: { status: string }) => phase.status === "pending")
      && run.logs.some((entry: { message: string }) => PRE_WRITE_AUTHORIZATION_FAILURES.has(entry.message)),
  );
}
