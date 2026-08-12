/**
 * DraftAutomation：自动化阶段对外暴露的统一门面类。
 *   - start / stop / retryPhase / retryOnePhase：业务侧 API；
 *   - debugRunStep / debugSnapshot / debugHitBreakpoints / debugResume / debugListBreakpoints：
 *     调试入口；
 *   - running / cancellationRequested：互斥与取消状态字段；
 *   - runLocked / runOnePhaseLocked：私有互斥包装，避免同一项目并发跑两轮。
 *
 * 调用方（IPC handler）只需要 new DraftAutomation(...) 即可获得 dashboard 需要的全部方法。
 */

import { AutomationRunContext } from "./automation.main.context.js";
import { runAutomation as runAutomationFlow } from "./automation.main.run.js";
import { runOnePhase as runOnePhaseFlow } from "./automation.main.run-one.js";
import { projectNotFound } from "../../infrastructure/db-errors.js";
import { VbkDatabase } from "../../infrastructure/database/database.js";
import { VbkBrowser } from "../../infrastructure/vbk-browser.js";
import type { AdvisorOutcome, AdvisorRequest, AutomationRun, ProjectDetail } from "../../../shared/contracts.js";
import { debugHitBreakpoints, debugListBreakpoints, debugResume, debugRunStep, debugSnapshot } from "./automation.main.class.debug.js";
import { ensureBrowserHasBounds, markCancelled, resolveActiveButlerContext, resolveButlerSelection, resolveServicePhone } from "./automation.main.class.helpers.js";
import { recoverLegacyScreenshotFalseFailure as recoverLegacyScreenshotFalseFailureFlow } from "./automation.main.legacy-recovery.js";
import { assertSinglePhaseRetryPrerequisites } from "./automation.main.prerequisites.js";
import { parseProduct } from "../schema/schema.js";
import { runSaleControlPhase } from "./automation.main.run-sale-control.js";

/**
 * 用户点击「停止」后区别于普通失败的语义：
 *   - run.status 走 cancelled（不是 failed）
 *   - project.status 走 blocked（项目可被再次「保存草稿」覆盖）
 *   - 不计入「自动录入失败」诊断，UI 顶部状态显示「已停止」
 *
 * 当前 runner 通过 recovery 的 `cancelled` 状态返回 + markCancelled() 走
 * 取消路径；保留 export 以供 handler 未来需要主动取消（例如在页面
 * 检测到 VBK 上下线后）抛出。
 */
/**
 * DraftAutomation 主页面：
 *   - 持有 db / browser / onUpdate / advisor / disambiguator 等依赖；
 *   - 持有 running + cancellationRequested 两个 Sets 防并发 / 支持取消。
 */
export class DraftAutomation {
  private running = new Set<string>();
  // 用户主动中止的 projectId：runner 在阶段之间和 attempt 之间检查这个集合。
  // 用 Set 而不是 boolean：避免上一次取消信号污染下一轮 run。
  private cancellationRequested = new Set<string>();

  constructor(
    private db: VbkDatabase,
    private browser: VbkBrowser,
    private onUpdate: (project: ProjectDetail) => void,
    private advisor: (req: AdvisorRequest) => Promise<AdvisorOutcome>,
    private disambiguator?: (req: { kind: "province" | "city" | "spot" | "station"; desired: string; candidates: Array<{ id?: string; text: string }>; product: Record<string, unknown> }) => Promise<{ pickedText: string | null; reasoning: string }>,
  ) {}

/**
 * 启动一次完整跑（basic → preflight）；
 * 直接转发到 runLocked。
 */
async start(projectId: string) {
    return this.runLocked(projectId);
  }

  /**
   * 用户点击「停止」时调用。语义：
   *   1. 立即把当前 AutomationRun 标记为 cancelled 并落盘（emit 到 UI），
   *      让顶栏状态切到「已停止」；
   *   2. 在 cancellationRequested 里登记 projectId，runner 在下一次
   *      checkpoint（阶段之间 / attempt 之间）抛 AutomationCancelledError，
   *      跳出循环并把项目状态置为 blocked（不是 failed，避免误导运营以为
   *      出了 VBK 端问题）。
   *   3. 不能立刻 abort 当前 Playwright 调用：playwright page.click 跨进程 await
   *      无安全中断点，强制 cancel 反而可能让浏览器留下半完成的 UI 状态。让当
   *      前阶段的 handler 自然结束更安全。
   */
  async stop(projectId: string) {
    const project = this.db.getProject(projectId);
    if (!project) return;
    const run = project.automation;
    if (!run || run.status !== "running") return;
    this.cancellationRequested.add(projectId);

    // 即时更新 UI：把 run 切成 cancelled。runner 也会再写一次最终状态，
    // 这里先落盘让「停止」点击立刻可见，无需等待下一个 checkpoint。
    const next: AutomationRun = {
      ...run,
      status: "cancelled",
      logs: [
        ...run.logs,
        { at: new Date().toISOString(), message: "用户中止了自动录入", level: "warning" },
      ],
    };
    this.db.saveAutomation(projectId, next);
    this.emit(projectId);
  }

/**
 * 仅供测试使用：查询项目是否被标记为取消。
 */
isCancelRequested(projectId: string): boolean {
    return this.cancellationRequested.has(projectId);
  }

/**
 * 调试入口：按名字调一个具名 ctrip 步骤，返回 JSON 可序列化结果。
 */
async debugRunStep(stepName: string, argsJson: string): Promise<unknown> {
    return debugRunStep({
      db: this.db,
      browser: this.browser,
      resolveButlerSelection: (accountName) => resolveButlerSelection(this.db, accountName),
      resolveServicePhone: (accountName) => resolveServicePhone(this.db, accountName),
      ensureBrowserHasBounds: () => ensureBrowserHasBounds(this.browser),
      disambiguator: this.disambiguator,
    }, stepName, argsJson);
  }

  async debugSnapshot(label?: string): Promise<unknown> {
    return debugSnapshot({
      db: this.db,
      browser: this.browser,
      resolveButlerSelection: (accountName) => resolveButlerSelection(this.db, accountName),
      resolveServicePhone: (accountName) => resolveServicePhone(this.db, accountName),
      ensureBrowserHasBounds: () => ensureBrowserHasBounds(this.browser),
      disambiguator: this.disambiguator,
    }, label);
  }

  async debugHitBreakpoints(): Promise<string[]> {
    return debugHitBreakpoints();
  }

  async debugResume(command: "continue" | "step" | "stop"): Promise<{ stopped: boolean }> {
    return debugResume(command);
  }

  async debugListBreakpoints(): Promise<string[]> {
    return debugListBreakpoints();
  }

  async retryPhase(projectId: string, phase: string) {
    const requested = typeof phase === "string" ? phase.trim() : "";
    if (!requested) throw new Error("请选择要重试的失败阶段。");
    return this.runLocked(projectId, requested);
  }

  /**
   * 历史 bug 恢复：automation:retry 调用时先尝试窄恢复——若 run 处于
   * "业务全部成功、最后一步是截图失败" 的脏状态，按业务完成恢复
   * （succeeded + draft_saved），不重跑任何阶段；未命中返回 false，
   * 调用方继续走 retryPhase / start 的原路径。
   *
   * 互斥语义：与 start / retryOnePhase 共享同一个 `running` Set。持有期
   * 间任何并发 start / retryOnePhase / retryPhase 都会因 `running.has`
   * 抛"项目正在进行中"被拒；未命中立刻释放，下一次 retry 不会自锁。
   */
  async recoverLegacyScreenshotFalseFailure(projectId: string): Promise<boolean> {
    const lock = {
      acquire: () => {
        if (this.running.has(projectId)) return false;
        this.running.add(projectId);
        return true;
      },
      release: () => {
        this.running.delete(projectId);
      },
    };
    return recoverLegacyScreenshotFalseFailureFlow(this.runContext(), projectId, lock);
  }

/**
 * 「重新执行」按钮：单阶段重跑一个阶段、用于 review 执行效果。
 * 普通阶段要求 productId 已存在；销售控制作为产品壳入口允许在无
 * productId 但已有 automation 记录时重执行。
 */
async retryOnePhase(projectId: string, phase: string) {
    const requested = typeof phase === "string" ? phase.trim() : "";
    if (!requested) throw new Error("请选择要重新执行的阶段。");
    if (this.running.has(projectId)) throw new Error("该项目的自动录入正在进行中，请等待本轮结束。");
    const project = this.db.getProject(projectId);
    if (!project) throw projectNotFound(projectId);
    if (!project.automation) throw new Error("项目尚未开始自动录入。")
    if (project.automation.status === "running") throw new Error("自动录入正在进行中，不能重新执行。");

    if (requested === "saleControl") {
      if (project.productId) {
        throw new Error("产品壳已创建（已有 productId），不能重新执行销售控制，避免重复创建产品。");
      }
      return this.runSaleControlLocked(projectId);
    }

    // productId 存在是必要条件：某些阶段（如 package / preflight）需要在 VBK
    // 携程草稿页上点操作；远程草稿尚未创建时不能单阶段重跑。
    if (!project.productId) throw new Error("远程草稿尚未创建，不能重新执行阶段。");
    assertSinglePhaseRetryPrerequisites(parseProduct(project.product), requested);
    return this.runOnePhaseLocked(projectId, requested);
  }

  private runContext(): AutomationRunContext {
    return {
      db: this.db,
      browser: this.browser,
      advisor: this.advisor,
      disambiguator: this.disambiguator,
      resolveActiveButlerContext: (accountName) => resolveActiveButlerContext(this.db, accountName),
      emit: (projectId) => this.emit(projectId),
      markCancelled: (_projectId, run, persist) => markCancelled(run, persist),
      cancellationRequested: this.cancellationRequested,
      ensureBrowserHasBounds: () => ensureBrowserHasBounds(this.browser),
    };
  }

  private async run(projectId: string, retryFrom?: string) {
    return runAutomationFlow(this.runContext(), projectId, retryFrom);
  }

  private async runOnePhase(projectId: string, phaseName: string) {
    return runOnePhaseFlow(this.runContext(), projectId, phaseName);
  }

  private async runSaleControl(projectId: string) {
    return runSaleControlPhase(this.runContext(), projectId);
  }

/**
 * 完整跑互斥包装：避免同一 projectId 并发 + 重入前清 stale 取消信号。
 */
private async runLocked(projectId: string, retryFrom?: string) {
    if (this.running.has(projectId)) throw new Error("该项目的自动录入正在进行中，请等待本轮结束。");
    this.running.add(projectId);

    // 清理上一轮可能的取消信号 —— stop() 会写进 cancellationRequested，但
    // run 结束后 finally 会清理；保险起见重入前再清一次。
    this.cancellationRequested.delete(projectId);

    try {
      await this.run(projectId, retryFrom);
    } finally {
      this.running.delete(projectId);
    }
  }

/**
 * 单阶段重跑互斥包装：与 runLocked 同型，仅不依赖 retryFrom，多清一次 cancellationRequested。
 */
  private async runOnePhaseLocked(projectId: string, phaseName: string) {
    if (this.running.has(projectId)) throw new Error("该项目的自动录入正在进行中，请等待本轮结束。");
    this.running.add(projectId);
    this.cancellationRequested.delete(projectId);

    try {
      await this.runOnePhase(projectId, phaseName);
    } finally {
      this.running.delete(projectId);
      this.cancellationRequested.delete(projectId);
    }
  }

  private async runSaleControlLocked(projectId: string) {
    if (this.running.has(projectId)) throw new Error("该项目的自动录入正在进行中，请等待本轮结束。");
    this.running.add(projectId);
    this.cancellationRequested.delete(projectId);

    try {
      await this.runSaleControl(projectId);
    } finally {
      this.running.delete(projectId);
      this.cancellationRequested.delete(projectId);
    }
  }

  private emit(projectId: string) {
    const current = this.db.getProject(projectId);
    if (current) this.onUpdate(current);
  }
}
