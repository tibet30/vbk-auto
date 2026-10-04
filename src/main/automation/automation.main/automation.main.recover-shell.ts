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
  if (!product.productId) throw new Error("请先核查 VBK 是否已生成草稿，避免重复创建。");
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
