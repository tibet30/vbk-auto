import type { AgentApproval } from "../../../shared/contracts.js";
import type { WizardStageRetryPhase } from "../../../shared/wizard-stage-retry.js";
import { getVbkRequestPage } from "../../infrastructure/vbk-request-page.js";
import { productWizardRecoveryPhase, readProductMenus } from "../../automation/ctrip/product-menu-readback.js";
import { runQueuedApprovedWorkflow } from "../queued-approved-workflow.js";
import type { MainIpcContext } from "../../ipc/context.js";

export interface WizardStageRetryPlan {
  phase: WizardStageRetryPhase;
  scope: string[];
  summary: string;
  alreadyAdvanced: boolean;
}

const ORDER: readonly WizardStageRetryPhase[] = ["basic", "presentation"];

function label(phase: WizardStageRetryPhase): string {
  return phase === "basic" ? "产品信息" : "产品图文";
}

function nextApi(phase: WizardStageRetryPhase): string {
  return phase === "basic"
    ? "saveProductBaseInfo（saveType=2）"
    : "createProductDraft（desc）和 savedescriptioninfo（saveType=4）";
}

function isFullyUnlocked(menus: Awaited<ReturnType<typeof readProductMenus>>): boolean {
  return menus.fullyUnlocked;
}

/** Read only the canonical remote menu before offering a narrow recovery approval. */
export async function prepareWizardStageRetry(
  context: MainIpcContext,
  localProductId: string,
  phase: WizardStageRetryPhase,
): Promise<WizardStageRetryPlan> {
  const product = context.db.getProduct(localProductId);
  if (!product?.productId) throw new Error("远程草稿尚未创建，不能重新执行向导下一步。");
  const menus = await context.productWorkflows.runVbkPageExclusive(async () =>
    readProductMenus(await getVbkRequestPage(context.browser), product.productId!),
  );
  const remote = productWizardRecoveryPhase(menus);
  if (!remote) {
    if (isFullyUnlocked(menus)) {
      return {
        phase,
        scope: [`vbk.write_phase:${phase}`],
        summary: `已只读回读 VBK 菜单：${label(phase)}的官方下一步已完成，无需再次保存。`,
        alreadyAdvanced: true,
      };
    }
    throw new Error("VBK 菜单不是可识别的连续官方状态，不能自动重新执行下一步。");
  }
  const remoteIndex = ORDER.indexOf(remote as WizardStageRetryPhase);
  const requestedIndex = ORDER.indexOf(phase);
  if (remote === "itinerary" || remoteIndex > requestedIndex) {
    return {
      phase,
      scope: [`vbk.write_phase:${phase}`],
      summary: `已只读回读 VBK 菜单：${label(phase)}的官方下一步已完成，无需再次保存。`,
      alreadyAdvanced: true,
    };
  }
  if (remoteIndex < requestedIndex) {
    throw new Error(`VBK 菜单仍停在「${label(remote as WizardStageRetryPhase)}」，请先完成该页的官方下一步。`);
  }
  return {
    phase,
    scope: [`vbk.write_phase:${phase}`],
    summary: `已只读确认 VBK 停在「${label(phase)}」。确认后仅调用 ${nextApi(phase)} 并回读下一菜单；不进入行程、审核或发布。`,
    alreadyAdvanced: false,
  };
}

/** Queue only the approved wizard boundary; it never expands into itinerary review. */
export function handoffWizardStageRetry(
  context: MainIpcContext,
  localProductId: string,
  approval: AgentApproval,
): boolean {
  const retry = approval.wizardStageRetry;
  if (!retry) return false;
  if (retry.alreadyAdvanced) {
    void context.agentCore?.completeApprovedWorkflow(localProductId, approval.id);
    return true;
  }
  void runQueuedApprovedWorkflow({
    id: localProductId,
    approval,
    coordinator: context.productWorkflows,
    snapshot: () => context.db.getAgentSnapshot(localProductId) ?? undefined,
    execute: () => context.automation.executeApprovedWizardStage(localProductId, retry.phase),
    complete: () => context.agentCore?.completeApprovedWorkflow(localProductId, approval.id),
    pause: message => context.agentCore?.pauseApprovedWorkflow(localProductId, approval.id, message),
  });
  return true;
}
