/**
 * 历史 bug 恢复：旧版 run.ts 把收尾 `saveScreenshot` 内联在主流程里，当
 * page width=0 / page 已 detach / CDP 抛 Page.captureScreenshot 错误时
 * 整条 run 被 catch 标为 failed，并把项目状态置为 blocked。这种"截图失败
 * = 业务失败"在 finalizeRunWithScreenshot 之后已不再发生，但已经落库
 * 的"业务全部成功、最后一步截图失败"记录仍在；当前 automation:retry 看到
 * 没有 failed phase 会退化为 start 全量重跑（错误），retryPhase(preflight)
 * 又因 preflight 已 completed 被 preparePhaseRetry 拒绝。
 *
 * 本文件提供最窄安全恢复：
 *   - isLegacyScreenshotFalseFailure(run)：纯函数，判定是否命中"业务
 *     全部成功、最后一步是截图失败"这一类历史脏数据；
 *   - recoverLegacyScreenshotFalseFailure：把命中的 run 切到 succeeded、
 *     重试收尾截图、调 updateProduct 把项目切到 draft_saved，绝不重跑
 *     任何业务阶段。
 *
 * 调用方（automation:retry IPC 入口）先调本文件做一次窄恢复，未命中时
 * 走 retryPhase / start 的原路径。
 */

import { finalizeRunWithScreenshot } from "./automation.main.run.finalize.js";
import { saveScreenshot } from "../ctrip/ctrip.js";
import type { AutomationRun, ProjectDetail } from "../../../shared/contracts.js";
import type { AutomationRunContext } from "./automation.main.context.js";

/**
 * 历史 bug 留下的"截图失败 = 业务失败"判定。所有条件必须同时满足：
 *   1) run.status === "failed"；
 *   2) 所有 phases[i].status === "completed"（按长度校验，不必枚举具体阶段名）；
 *   3) run.recovery 里没有任何 phase.state === "needs_user"（不能吞业务失败）；
 *   4) 最后一条 level="error" 日志 message 命中最终截图错误特征。
 *
 * 满足时调用方应把这条 run 切到 succeeded + 项目状态 draft_saved，不再重跑任何阶段。
 */
export function isLegacyScreenshotFalseFailure(run: AutomationRun | undefined | null): boolean {
  if (!run) return false;
  if (run.status !== "failed") return false;
  if (run.currentPhase != null) return false;
  if (run.phases.length === 0) return false;
  if (!run.phases.every((phase) => phase.status === "completed")) return false;
  const recovery = run.recovery?.phases ?? {};
  if (Object.values(recovery).some((rec) => rec.state === "needs_user")) return false;
  return lastErrorLogIsScreenshotFailure(run);
}

/**
 * 在 logs 里倒序找最近一条 level="error" 的日志，校验 message 命中已知
 * 截图错误特征（page.screenshot / Page.captureScreenshot / Cannot take
 * screenshot with 0 width 等）。任一特征命中即认为属于"最终截图失败"。
 */
export function lastErrorLogIsScreenshotFailure(run: AutomationRun): boolean {
  const errorLogs = run.logs.filter((entry) => entry.level === "error");
  if (errorLogs.length === 0) return false;
  const last = errorLogs[errorLogs.length - 1];
  return SCREENSHOT_ERROR_PATTERNS.some((pattern) => pattern.test(last.message));
}

const SCREENSHOT_ERROR_PATTERNS: RegExp[] = [
  /page\.screenshot/i,
  /Page\.captureScreenshot/,
  /Cannot take screenshot with 0 width/,
];

/**
 * 互斥包装：把"检查 running → 命中判定 → 写回"做成原子段。持有锁期间其
 * 他 start / retryOnePhase / retryPhase 无法进入；未命中时释放锁返回
 * false，调用方继续走 retryPhase / start 原路径（不会自锁）。
 *
 * 锁释放发生在所有 IO 路径（含 page 抛错、screenshot 抛错）之后。
 */
export async function withRecoveryMutex<T>(
  lock: { acquire: () => boolean; release: () => void },
  work: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  if (!lock.acquire()) return { acquired: false };
  try {
    const value = await work();
    return { acquired: true, value };
  } finally {
    lock.release();
  }
}

/**
 * 互斥检查 + 命中时执行窄恢复。
 *   - 已在跑的项目绝不进入（避免与 in-flight runner 争抢 view / emit）；
 *   - 未命中返回 false，让 automation:retry 走 retryPhase / start 原逻辑。
 *   - 命中返回 true（已落库 + emit），调用方不应再走 retryPhase / start。
 *
 * 内部不会修改 AutomationRunContext 的 cancellationRequested、不重跑
 * 任何业务阶段 handler；唯一会调 saveScreenshot 的是 finalizeRunWithScreenshot，
 * 截图再次失败仅写 warning，不影响 succeeded 状态。
 */
export async function recoverLegacyScreenshotFalseFailure(
  ctx: AutomationRunContext,
  projectId: string,
  lock: { acquire: () => boolean; release: () => void },
): Promise<boolean> {
  if (!lock.acquire()) return false;
  try {
    const project: ProjectDetail | undefined = ctx.db.getProject(projectId);
    if (!project) return false;
    const run = project.automation;
    if (!run || !isLegacyScreenshotFalseFailure(run)) return false;
    const productId = project.productId;
    if (!productId) return false;

    const next: AutomationRun = {
      id: run.id,
      status: "succeeded",
      phases: run.phases,
      logs: run.logs,
      currentPhase: undefined,
      screenshot: run.screenshot,
      recovery: run.recovery,
    };
    const log = (message: string, level: "info" | "warning" | "error" = "info") => {
      next.logs = [
        ...next.logs,
        { at: new Date().toISOString(), message, level },
      ];
      ctx.db.saveAutomation(projectId, next);
      ctx.emit(projectId);
    };

    log("检测到历史截图失败遗留的失败记录，按业务完成状态恢复（不重跑任何阶段）", "warning");
    ctx.browser.setVisible(true);
    ctx.ensureBrowserHasBounds();
    let page: unknown;
    try {
      page = await ctx.browser.page();
    } catch (error) {
      // 拿不到 page 也要保留 succeeded：业务已完成，最终截图失败属于
      // best-effort 步骤（与 finalizeRunWithScreenshot 同语义）。
      const message = error instanceof Error ? error.message : String(error);
      log(`恢复路径无法获取页面：${message}（业务已完成，run 状态不受影响）`, "warning");
      next.screenshot = undefined;
      ctx.db.saveAutomation(projectId, next);
      ctx.db.updateProduct(projectId, project.product, "draft_saved");
      ctx.emit(projectId);
      return true;
    }

    await finalizeRunWithScreenshot(next, saveScreenshot, productId, page, log);
    log("产品草稿已保存，未提交审核、未发布。", "warning");
    ctx.db.saveAutomation(projectId, next);
    ctx.db.updateProduct(projectId, project.product, "draft_saved");
    ctx.emit(projectId);
    return true;
  } finally {
    lock.release();
  }
}
