import type { AutomationRunContext } from "./automation.main.context.js";
import type { AutomationRun, ProductDetail } from "../../../shared/contracts.js";
import { getVbkRequestPage } from "../../infrastructure/vbk-request-page.js";
import { verifyExistingProductShellApi } from "../ctrip/sale-control/api.js";

/** A persisted shell ID prevents creation; only authoritative readback permits continuation. */
export async function recoverCreatedShell(
  ctx: AutomationRunContext,
  product: ProductDetail,
  verify = verifyExistingProductShellApi,
): Promise<void> {
  const previous = product.automation;
  if (!product.productId) {
    const originalError = previous?.logs.filter(entry => entry.level === "error").at(-1)?.message;
    throw new Error("首次创建草稿失败后未保存携程产品编号，无法确认远端是否已创建。请先核查首次创建的草稿编号，再回读原草稿继续；直接重试可能重复创建。"
      + (originalError ? `\n首次失败：${originalError}` : ""));
  }
  if (previous?.status !== "failed" || previous.currentPhase !== "saleControl"
    || previous.phases.some(phase => phase.status !== "pending")) {
    throw new Error("销售控制断点状态不一致，需先核查已完成阶段。");
  }
  const page = await getVbkRequestPage(ctx.browser);
  await ctx.runVbkPageExclusive(() => verify(page, product.product, product.productId!));
  const next: AutomationRun = {
    ...previous,
    status: "queued",
    currentPhase: undefined,
    recovery: { phases: { ...previous.recovery?.phases,
      saleControl: { phase: "saleControl", state: "completed", attempts: previous.recovery?.phases.saleControl?.attempts ?? [] },
    } },
    logs: [...previous.logs, { at: new Date().toISOString(), level: "info",
      message: `已有产品壳 ${product.productId} 已通过销售控制回读，从基础信息继续，未重新创建产品。` }],
  };
  ctx.db.saveAutomation(product.id, next);
  product.automation = next;
  ctx.emit(product.id);
}
