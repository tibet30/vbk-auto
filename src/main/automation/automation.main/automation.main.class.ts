import { approvalForRun, recoverEquivalentApproval } from "../../agent/integration-gates.js";
import type { AutomationRunContext } from "./automation.main.context.js";
import { productNotFound } from "../../infrastructure/db-errors.js";
import type { VbkDatabase } from "../../infrastructure/database/database.js";
import type { VbkBrowser } from "../../infrastructure/vbk-browser.js";
import type { AdvisorOutcome, AdvisorRequest, AiResponse, AutomationRun, ProductDetail } from "../../../shared/contracts.js";
import { recoverLegacyScreenshotFalseFailure as recoverLegacyScreenshotFalseFailureFlow } from "./automation.main.legacy-recovery.js";
import { assertSinglePhaseRetryPrerequisites } from "./automation.main.prerequisites.js";
import { parseProduct } from "../schema/schema.js";
import { ProductMutationService } from "../../application/product-mutation-service.js";
import { getProductBaseInfoApi } from "../ctrip/basic-info/api.js";
import { assertRemoteDraftCanBeReplaced, prepareLockedDraftReplacement } from "./automation.main.replace-locked-draft.js";
import {
  approvedRecoveryStartPhase,
  failedAutomationResumePhase,
} from "./automation.main.resume-phase.js";
import { automationStartPhase, approvedWorkflowPlan } from "./runtime/workflow-plan.js";
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

/** Stable API facade; workflow decisions and phase execution live in their own modules. */
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
      exclusive: task => this.runVbkPageExclusive(task),
    };
  }

  async start(localProductId: string) {
    return this.runLocked(localProductId, automationStartPhase(this.db.getProduct(localProductId)));
  }

  async resumeFromError(localProductId: string) {
    const product = this.db.getProduct(localProductId);
    if (!product) throw productNotFound(localProductId);
    const failedPhase = failedAutomationResumePhase(product.automation);
    if (!failedPhase) {
      throw new Error("无法从当前自动录入记录定位失败阶段，未从头重跑。");
    }
    return this.runLocked(localProductId, approvedRecoveryStartPhase(product, failedPhase));
  }

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

  isCancelRequested(localProductId: string): boolean {
    return this.cancellationRequested.has(localProductId);
  }

  async retryPhase(localProductId: string, phase: string) {
    const requested = typeof phase === "string" ? phase.trim() : "";
    if (!requested) throw new Error("请选择要重试的失败阶段。");
    return this.runLocked(localProductId, requested);
  }

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
    const plan = approvedWorkflowPlan(product, approval.replayOfAutomationRunId);
    if (plan.kind === "complete") return;
    if (plan.kind === "traffic-backfill") {
      await this.runApprovedBackfillLocked(localProductId);
    } else await this.runApprovedLocked(localProductId, plan.retryFrom);
    const result = this.db.getProduct(localProductId)?.automation;
    if (result?.status !== "succeeded") {
      const phase = result?.currentPhase;
      const failure = phase && result?.recovery?.phases[phase]?.finalError;
      throw new Error(failure || `自动录入未完成：${phase ?? result?.status ?? "缺少执行记录"}`);
    }
  }

  async replaceLockedDraft(localProductId: string): Promise<{ previousProductId: string }> {
    if (this.running.has(localProductId)) throw new Error("该产品的自动录入正在进行中，请等待本轮结束。");
    const product = this.db.getProduct(localProductId);
    if (!product) throw productNotFound(localProductId);
    const { previousProductId, replacementProduct } = prepareLockedDraftReplacement(product);
    const remote = await this.runVbkPageExclusive(async () =>
      getProductBaseInfoApi(await this.vbkPage(), previousProductId));
    assertRemoteDraftCanBeReplaced(remote);
    (this.productMutations ?? new ProductMutationService(this.db)).commands.mergeChanges(
      localProductId, product, replacementProduct, 'automation', { status: 'review', notify: false });
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

  private async runLocked(localProductId: string, retryFrom?: string) {
    if (this.agentWriteGuard) throw new Error("请通过 Agent 最终确认后按模块录入。");
    return runExclusive(this.bindings(), localProductId, () => this.run(localProductId, retryFrom));
  }

  private async runApprovedLocked(localProductId: string, retryFrom?: string) {
    return runExclusive(this.bindings(), localProductId, () => this.runApproved(localProductId, retryFrom));
  }

  private async runApprovedBackfillLocked(localProductId: string) {
    return runExclusive(this.bindings(), localProductId, async () => {
      await this.runOnePhase(localProductId, "trafficLine");
      if (this.db.getProduct(localProductId)?.automation?.status === "cancelled") {
        throw new Error("用户中止了自动录入");
      }
      await this.runOnePhase(localProductId, "preflight");
    });
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
