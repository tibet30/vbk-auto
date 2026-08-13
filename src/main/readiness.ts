/**
 * 产品 readiness 的纯函数核心：把产品当前状态、已保存自动化运行、是否阻塞
 * 等映射到对外的 ProductReadiness。供 main.ts readiness IPC 与直接单测共用。
 *
 * 与 main.ts readiness() 包装层的关系：
 *   - main.ts 的 readiness(localProductId) 负责 db.getProduct 与
 *     productNotFound 抛错；
 *   - 本函数接收已 fetch 的 product / researchTasks / automation run，做所有
 *     「合并 / 阻断 / completion」决策，方便单测覆盖 needs_user、cancelled
 *     等场景而不需要构造一个完整 VbkDatabase。
 *
 * needs_user 阻塞的「可见性」红线（真实 run 09306ec1 修复）：
 *   - 当 automation.recovery 里有 phase.state === "needs_user" 时，必须把它
 *     作为一条 actionable 的待处理项（label 含阶段名、detail 给出修复路径
 *     与原始错误信息）暴露给 UI，让用户能立即知道「下一步要补什么」，再
 *     去点 retry；
 *   - 严禁再走「隐藏计数」路径：既不进入 issues 列表、又不让 completion 反映
 *     阻塞——会让 UI 出现「92% 但 0 项待处理」的假就绪态；
 *   - 已被用户主动取消的运行（finalError 前缀为「用户中止」）不再额外生成
 *     待处理项，避免与顶栏「已停止」重复。
 */
import type { AutomationRun, ProductReadiness, ResearchTask } from "../shared/contracts.js";
import { mergeReadinessIssues, openResearchTaskToIssue } from "../shared/readiness-issues.js";
import { isResearchTaskSatisfiedByProduct } from "../shared/research-task-satisfaction.js";
import { isCoverResearchTaskSatisfiedByProduct } from "./minimax/minimax-constants.js";
import { automationBlockers, productSchema } from "./automation/schema/schema.js";

/** completion 计算的最大阻塞数。超过则按 0 完成度处理。 */
const READINESS_MAX_BLOCKERS = 12;

/** needs_user 详情缺失时的兜底文案，避免出现「detail 为空 → 不 push」的 92%/0 pending 假就绪态。 */
const DEFAULT_NEEDS_USER_DETAIL = "自动录入失败，请在 VBK 核查当前阶段失败原因后再次保存草稿。";

export interface ComputeReadinessInput {
  product: Record<string, unknown>;
  researchTasks: ReadonlyArray<ResearchTask>;
  automation?: AutomationRun;
}

/**
 * 计算 readiness：纯函数，无 IO。供 main.ts readiness() 与直接单测共用。
 *
 * @returns ProductReadiness - ready / completion / issues 三元组
 */
export function computeReadiness(input: ComputeReadinessInput): ProductReadiness {
  const { product, researchTasks, automation } = input;
  const issues: ProductReadiness["issues"] = [];
  const parsed = productSchema.safeParse(product);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 6)) {
      issues.push({ label: issue.path.join(".") || "产品方案", detail: issue.message });
    }
  }
  const unresolved = researchTasks.filter((task) =>
    task.state !== "confirmed" &&
    task.state !== "resolved" &&
    !isResearchTaskSatisfiedByProduct(task, product) &&
    !isCoverResearchTaskSatisfiedByProduct(task, product),
  );
  for (const task of unresolved) issues.push(openResearchTaskToIssue(task));
  // 与自动录入使用同一套要求，避免界面显示「可以录入」后才在携程失败。
  // 即便 schema 校验失败也要跑：automationBlockers 会直接检查具体缺失字段
  // 并产出「国家景区（省份）」等人话 label，不依赖 parsed.success。
  for (const blocker of automationBlockers(product)) issues.push(blocker);
  // 把 needs_user 阻塞作为一条 actionable 待处理项推入 issues，确保 UI
  // 能在「待处理事项」列表里看到失败阶段 + 修复路径；不再使用 hidden
  // 计数器，避免与 issues 列表里的同一项重复计入 completion。
  if (automation?.recovery?.phases) {
    const blocked = Object.values(automation.recovery.phases).find((rec) => rec.state === "needs_user");
    if (blocked) {
      const cancelled = typeof blocked.finalError === "string" && blocked.finalError.startsWith("用户中止");
      if (!cancelled) {
        const userInstruction = typeof blocked.userInstruction === "string" ? blocked.userInstruction.trim() : "";
        const finalError = typeof blocked.finalError === "string" ? blocked.finalError.trim() : "";
        const detail = userInstruction || finalError || DEFAULT_NEEDS_USER_DETAIL;
        issues.push({ label: `自动录入失败：${blocked.phase}`, detail });
      }
    }
  }
  const mergedIssues = mergeReadinessIssues(issues);
  const blockerCount = mergedIssues.length;
  const completion = Math.round(
    (Math.max(0, READINESS_MAX_BLOCKERS - Math.min(READINESS_MAX_BLOCKERS, blockerCount))
      / READINESS_MAX_BLOCKERS) * 100,
  );
  return { ready: blockerCount === 0, completion, issues: mergedIssues };
}
