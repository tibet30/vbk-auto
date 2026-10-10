/**
 * DraftAutomation：自动化阶段对外暴露的统一门面类。
 *   - start / stop / retryPhase / retryOnePhase / executeApprovedWorkflow /
 *     replaceLockedDraft / recoverLegacyScreenshotFalseFailure：业务侧 API；
 *   - running / cancellationRequested：互斥与取消状态字段；
 *   - runVbkPageExclusive / agentWriteGuard：运行时可选注入的互斥与写守卫。
 *
 * 调用方（IPC handler）只需要 new DraftAutomation(...) 即可获得 dashboard 需要的全部方法。
 *
 * 子文件分工：
 *   - lifecycle.ts：canRestartPreWriteAuthorizationFailure（写失败时能否从 saleControl 重跑）；
 *   - runners.ts   ：buildRunContext / runFull / runOne / runSaleControl / runExclusive
 *                    / withNavigationPin，主类私有 helper 集中此处。
 */

import { runAutomationExclusive } from "./automation.main.execution.js";
import { approvalForRun, recoverEquivalentApproval } from "../../agent/integration-gates.js";
import { makeAutomationRunContext } from "./automation.main.make-context.js";
import type { AutomationRunContext } from "./automation.main.context.js";
import { productNotFound } from "../../infrastructure/db-errors.js";
import type { VbkDatabase } from "../../infrastructure/database/database.js";
import type { VbkBrowser } from "../../infrastructure/vbk-browser.js";
import type { AdvisorOutcome, AdvisorRequest, AiResponse, AutomationRun, ProductDetail } from "../../../shared/contracts.js";
import { recoverLegacyScreenshotFalseFailure as recoverLegacyScreenshotFalseFailureFlow } from "./automation.main.legacy-recovery.js";
import { assertSinglePhaseRetryPrerequisites } from "./automation.main.prerequisites.js";
import { parseProduct } from "../schema/schema.js";
import type { ProductMutationService } from "../../application/product-mutation-service.js";
import { getProductBaseInfoApi } from "../ctrip/basic-info/api.js";
import { assertRemoteDraftCanBeReplaced, prepareLockedDraftReplacement } from "./automation.main.replace-locked-draft.js";
import { draftPhasesFor } from "./automation.main.phases.js";
import { needsTrafficLineBackfill } from "../traffic-line-backfill.js";
import {
  approvedRecoveryStartPhase,
  failedAutomationResumePhase,
  interruptedAutomationResumePhase,
  isVerifiedAutomationComplete,
} from "./automation.main.resume-phase.js";
import { canRestartPreWriteAuthorizationFailure } from "./automation.main.class/lifecycle.js";
import {
  buildRunContext,
  runExclusive,
  runFull,
  runOne,
  runSaleControl,
  type RunContextBindings,
} from "./automation.main.class/runners.js";

export { approvedRecoveryStartPhase, interruptedAutomationResumePhase, failedAutomationResumePhase } from "./automation.main.resume-phase.js";
export { canRestartPreWriteAuthorizationFailure };

/**
 * DraftAutomation 主页面：
 *   - 持有 db / browser / onUpdate / advisor / disambiguator 等依赖；
 *   - 持有 running + cancellationRequested 两个 Sets 防并发 / 支持取消。
 */
export class DraftAutomation {
  private running = new Set<string>();
  private agentWriteGuard?: (localProductId: string, phase: string) => Promise<void>;
  setAgentWriteGuard(guard: (localProductId: string, phase: string) => Promise<void>): void { this.agentWriteGuard = guard; }
  private runVbkPageExclusive = async <T>(task: () => Promise<T>): Promise<T> => task();
  private productMutations?: ProductMutationService;
  // 用户主动中止的 localProductId：runner 在阶段之间和 attempt 之间检查这个集合。
  // 用 Set 而不是 boolean：避免上一次取消信号污染下一轮 run。
  private cancellationRequested = new Set<string>();

  constructor(
    private db: VbkDatabase,
    private browser: VbkBrowser,
    private onUpdate: (product: ProductDetail) => void,
    private advisor: (req: AdvisorRequest) => Promise<AdvisorOutcome>,
    private disambiguator?: (req: {
      kind: "province" | "city" | "spot" | "station";
      stationSubtype?: "airport" | "train";
      desired: string;
      candidates: Array<{ id?: string; text: string }>;
      product: Record<string, unknown>;
    }) => Promise<{ pickedText: string | null; reasoning: string }>,
    private presentationCopyRewriter?: (req: { message: string; product: Record<string, unknown> }) => Promise<AiResponse>,
  ) {}

  setRunVbkPageExclusive(run: <T>(task: () => Promise<T>) => Promise<T>) {
    this.runVbkPageExclusive = run;
  }

  setProductMutations(mutations: ProductMutationService): void {
    this.productMutations = mutations;
  }

  private bindings(): RunContextBindings {
    return {
      db: this.db,
      browser: this.browser,
      onUpdate: this.onUpdate,
      advisor: this.advisor,
      disambiguator: this.disambiguator,
      presentationCopyRewriter: this.presentationCopyRewriter,
      productMutations: this.productMutations,
      agentWriteGuard: this.agentWriteGuard,
      running: this.running,
      cancellationRequested: this.cancellationRequested,
    };
  }

  private get runVbkPageExclusiveBinding() {
    return (task: () => Promise<unknown>) => this.runVbkPageExclusive(task as () => Promise<never>);
  }

  /**
   * 启动自动录入：首次从 basic 开始；单阶段修复后若有 queued 断点，则从首个
   * pending 阶段继续，避免重写已经真实保存的内容。
   */
  async start(localProductId: string) {
    const product = this.db.getProduct(localProductId);
    const interruptedPhase = interruptedAutomationResumePhase(product?.automation);
    if (interruptedPhase) {
      const resumable = product?.automation?.phases.some((phase) =>
        phase.phase === interruptedPhase && phase.status === "failed");
      if (!resumable && !(interruptedPhase === "saleControl" && product?.productId)) {
        throw new Error("应用在销售控制创建产品壳期间退出，请先核查 VBK 是否已生成草稿，避免重复创建。");
      }
      return this.runLocked(localProductId, interruptedPhase);
    }
    const queuedPhase = product?.automation?.status === "queued"
      ? product.automation.phases.find((phase) => phase.status === "pending")?.phase
      : undefined;
    if (queuedPhase) return this.runLocked(localProductId, queuedPhase);
    return this.runLocked(localProductId);
  }

  /** 用户选择"从报错处继续"时只复用当前 AutomationRun 的失败阶段。 */
  async resumeFromError(localProductId: string) {
    const product = this.db.getProduct(localProductId);
    if (!product) throw productNotFound(localProductId);
    const failedPhase = failedAutomationResumePhase(product.automation);
    if (!failedPhase) {
      throw new Error("无法从当前自动录入记录定位失败阶段，未从头重跑。");
    }
    return this.runLocked(localProductId, approvedRecoveryStartPhase(product, failedPhase));
  }

  /**
   * 用户点击「停止」时调用。语义：
   *   1. 立即把当前 AutomationRun 标记为 cancelled 并落盘（emit 到 UI），
   *      让顶栏状态切到「已停止」；
   *   2. 在 cancellationRequested 里登记 localProductId，runner 在下一次
   *      checkpoint（阶段之间 / attempt 之间）抛 AutomationCancelledError，
   *      跳出循环并把产品状态置为 blocked（不是 failed，避免误导运营以为
   *      出了 VBK 端问题）。
   *   3. 不能立刻 abort 当前 Playwright 调用：playwright page.click 跨进程 await
   *      无安全中断点，强制 cancel 反而可能让浏览器留下半完成的 UI 状态。让当
   *      前阶段的 handler 自然结束更安全。
   */
  async stop(localProductId: string) {
    const product = this.db.getProduct(localProductId);
    if (!product) return;
    const run = product.automation;
    if (!run || run.status !== "running") return;
    this.cancellationRequested.add(localProductId);
    this.db.executionClock?.setEnabled(localProductId, false, "automation");

    // 即时更新 UI：把 run 切成 cancelled。runner 也会再写一次最终状态，
    // 这里先落盘让「停止」点击立刻可见，无需等待下一个 checkpoint。
    const next: AutomationRun = {
      ...run,
      status: "cancelled",
      phases: run.phases.map(phase => phase.phase === run.currentPhase && phase.status !== "completed"
        ? { ...phase, status: "failed" as const } : phase),
      logs: [
        ...run.logs,
        { at: new Date().toISOString(), message: "用户中止了自动录入", level: "warning" },
      ],
    };
    this.db.saveAutomation(localProductId, next);
    this.emit(localProductId);
  }

  /**
   * 仅供测试使用：查询产品是否被标记为取消。
   */
  isCancelRequested(localProductId: string): boolean {
    return this.cancellationRequested.has(localProductId);
  }

  async retryPhase(localProductId: string, phase: string) {
    const requested = typeof phase === "string" ? phase.trim() : "";
    if (!requested) throw new Error("请选择要重试的失败阶段。");
    return this.runLocked(localProductId, requested);
  }

  /**
   * 历史 bug 恢复：automation:retry 调用时先尝试窄恢复——若 run 处于
   * "业务全部成功、最后一步是截图失败" 的脏状态，按业务完成恢复
   * （succeeded + draft_saved），不重跑任何阶段；未命中返回 false，
   * 调用方继续走 retryPhase / start 的原路径。
   *
   * 互斥语义：与 start / retryOnePhase 共享同一个 `running` Set。持有期
   * 间任何并发 start / retryOnePhase / retryPhase 都会因 `running.has`
   * 抛"产品正在进行中"被拒；未命中立刻释放，下一次 retry 不会自锁。
   */
  async recoverLegacyScreenshotFalseFailure(localProductId: string): Promise<boolean> {
    const lock = {
      acquire: () => {
        if (this.running.has(localProductId)) return false;
        this.running.add(localProductId);
        return true;
      },
      release: () => {
        this.running.delete(localProductId);
      },
    };
    return recoverLegacyScreenshotFalseFailureFlow(this.runContext(), localProductId, lock);
  }

  /**
   * 「重新执行」按钮：单阶段重跑一个阶段、用于 review 执行效果。
   * 普通阶段要求 productId 已存在；销售控制作为产品壳入口允许在无
   * productId 但已有 automation 记录时重执行。
   */
  async retryOnePhase(localProductId: string, phase: string) {
    if (this.agentWriteGuard) throw new Error("请通过方案协作确认后重新执行阶段。");
    const requested = typeof phase === "string" ? phase.trim() : "";
    if (!requested) throw new Error("请选择要重新执行的阶段。");
    if (this.running.has(localProductId)) throw new Error("该产品的自动录入正在进行中，请等待本轮结束。");
    const product = this.db.getProduct(localProductId);
    if (!product) throw productNotFound(localProductId);
    if (!product.automation) throw new Error("产品尚未开始自动录入。")
    if (product.automation.status === "running") throw new Error("自动录入正在进行中，不能重新执行。");

    if (requested === "saleControl") {
      if (product.productId) {
        throw new Error("产品壳已创建（已有 productId），不能重新执行销售控制，避免重复创建产品。");
      }
      return this.runSaleControlLocked(localProductId);
    }

    // productId 存在是必要条件：某些阶段（如 package / preflight）需要在 VBK
    // 携程草稿页上点操作；远程草稿尚未创建时不能单阶段重跑。
    if (!product.productId) throw new Error("远程草稿尚未创建，不能重新执行阶段。");
    assertSinglePhaseRetryPrerequisites(parseProduct(product.product), requested);
    return this.runOnePhaseLocked(localProductId, requested);
  }

  /**
   * Final approval transfers phase ordering and recovery to this deterministic runner.
   */
  async executeApprovedWorkflow(localProductId: string): Promise<void> {
    const product = this.db.getProduct(localProductId);
    if (!product) throw productNotFound(localProductId);
    const agent = this.db.getAgentSnapshot(localProductId);
    if (!agent?.run) throw new Error("缺少 Agent 任务，不能录入。");
    if (!this.agentWriteGuard) throw new Error("录入确认校验尚未就绪。");
    // The deterministic retry button can be used after a recovered agent run
    // has completed. Reuse a historical approval only through the same strict
    // fingerprint + recovery-only-instruction gate used by AgentCore.
    const approval = approvalForRun(agent) ?? recoverEquivalentApproval(product, agent);
    if (!approval) throw new Error("缺少最终确认，不能录入。");
    const fullReplay = approval.replayOfAutomationRunId === product.automation?.id && Boolean(product.automation?.id);
    if (!fullReplay && needsTrafficLineBackfill(product)) {
      await this.runOnePhaseLocked(localProductId, "trafficLine");
      await this.runOnePhaseLocked(localProductId, "preflight");
      return;
    }
    if (!fullReplay && isVerifiedAutomationComplete(product)) return;
    const retryFrom = fullReplay ? undefined : approvedRecoveryStartPhase(product, failedAutomationResumePhase(product.automation));
    const restartPreWriteGuardFailure = canRestartPreWriteAuthorizationFailure(product.automation, product.productId);
    if (product.automation?.status === "failed" && !retryFrom && !restartPreWriteGuardFailure && !fullReplay) {
      throw new Error("当前失败记录没有可安全恢复的阶段，需先进行权威核查。");
    }
    await this.runApprovedLocked(localProductId, retryFrom);
    const result = this.db.getProduct(localProductId)?.automation;
    if (result?.status !== "succeeded") {
      const phase = result?.currentPhase;
      const failure = phase && result?.recovery?.phases[phase]?.finalError;
      throw new Error(failure || `自动录入未完成：${phase ?? result?.status ?? "缺少执行记录"}`);
    }
  }

  /** 保留失败的不可改型远端草稿，重置本地绑定以创建新的可用替代草稿。 */
  async replaceLockedDraft(localProductId: string): Promise<{ previousProductId: string }> {
    if (this.running.has(localProductId)) throw new Error("该产品的自动录入正在进行中，请等待本轮结束。");
    const product = this.db.getProduct(localProductId);
    if (!product) throw productNotFound(localProductId);
    const { previousProductId, replacementProduct } = prepareLockedDraftReplacement(product);
    const remote = await this.runVbkPageExclusive(async () =>
      getProductBaseInfoApi(await this.vbkPage(), previousProductId));
    assertRemoteDraftCanBeReplaced(remote);
    this.db.updateProduct(localProductId, replacementProduct, "review");
    this.db.setProductLifecycle(localProductId, { productId: null, status: "review", basicInfoSaved: false });
    this.db.addMessage(
      localProductId,
      "assistant",
      `旧 VBK 草稿 ${previousProductId} 的产品类型已被平台锁定，已保留且未删除；将创建境内短途替代草稿。`,
    );
    this.emit(localProductId);
    return { previousProductId };
  }

  private vbkPage() {
    return import("../../infrastructure/vbk-request-page.js").then(mod => mod.getVbkRequestPage(this.browser));
  }

  private runContext(localProductId?: string, phase?: string): AutomationRunContext {
    return buildRunContext(this.bindings(), localProductId, phase);
  }

  private async run(localProductId: string, retryFrom?: string) {
    return runFull(this.bindings(), this.runContext(), localProductId, retryFrom);
  }

  private async runApproved(localProductId: string, retryFrom?: string) {
    return runFull(this.bindings(), this.runContext(localProductId), localProductId, retryFrom);
  }

  private async runOnePhase(localProductId: string, phaseName: string) {
    return runOne(this.bindings(), this.runContext(localProductId, phaseName), localProductId, phaseName);
  }

  private async runSaleControl(localProductId: string) {
    return runSaleControl(this.bindings(), this.runContext(localProductId, "saleControl"), localProductId);
  }

  /**
   * 完整跑互斥包装：避免同一 localProductId 并发 + 重入前清 stale 取消信号。
   */
  private async runLocked(localProductId: string, retryFrom?: string) {
    if (this.agentWriteGuard) throw new Error("请通过 Agent 最终确认后按模块录入。");
    return runExclusive(this.bindings(), localProductId, () => this.run(localProductId, retryFrom));
  }

  private async runApprovedLocked(localProductId: string, retryFrom?: string) {
    return runExclusive(this.bindings(), localProductId, () => this.runApproved(localProductId, retryFrom));
  }

  private async runOnePhaseLocked(localProductId: string, phaseName: string) {
    return runExclusive(this.bindings(), localProductId, () => this.runOnePhase(localProductId, phaseName));
  }

  private async runSaleControlLocked(localProductId: string) {
    return runExclusive(this.bindings(), localProductId, () => this.runSaleControl(localProductId));
  }

  private emit(localProductId: string) {
    const current = this.db.getProduct(localProductId);
    if (current) this.onUpdate(current);
  }
}