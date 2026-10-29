import type { MainIpcContext } from "../../ipc/context.js";
import { getVbkRequestPage } from "../../infrastructure/vbk-request-page.js";
import { readRemoteItineraryDays } from "../../automation/ctrip/itinerary-api/remote-days.js";
import { enteredRemoteItineraryDays } from "../../../shared/duration-replacement.js";
import { logWarn } from "../../../shared/log-timestamp.js";
import type { ApiPage } from "../../automation/ctrip/itinerary-api/transport.js";

/**
 * 存量产品没有 enteredItineraryDays（本功能上线前录入的产品）时，在生成确认卡前
 * 只读查询一次 VBK 当前行程天数并记入当前运行记录，使改天数的确认卡能带上
 * 「VBK 拒绝时保留旧草稿并新建产品」的说明。读取失败保持未知（不转新建），不阻断确认，只记告警。
 * readDays 仅供测试注入，默认走真实只读查询。
 */
export async function backfillEnteredItineraryDays(
  context: MainIpcContext, localProductId: string,
  readDays: (page: ApiPage, productId: string) => Promise<number | undefined> = readRemoteItineraryDays,
): Promise<void> {
  const { db, productWorkflows } = context;
  const product = db.getProduct(localProductId);
  const run = product?.automation;
  if (!product?.productId || !run || run.status === "running" || enteredRemoteItineraryDays(product) !== undefined) return;
  const productId = product.productId;
  const days = await productWorkflows.runVbkPageExclusive(async () =>
    readDays(await getVbkRequestPage(context.browser) as ApiPage, productId)).catch((error: unknown) => {
    logWarn("[duration] 远端天数只读查询失败", { localProductId, productId, error });
    return undefined;
  });
  if (!days) return;
  const latest = db.getProduct(localProductId);
  if (!latest?.automation || latest.automation.id !== run.id || latest.productId !== productId
    || enteredRemoteItineraryDays(latest) !== undefined) return;
  db.saveAutomation(localProductId, { ...latest.automation, enteredItineraryDays: days });
}
