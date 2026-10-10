import type { TrafficLinePage } from "./client.js";
import { advanceSavedProductWizard } from "./wizard-recovery.js";
import { readTrafficRouteReview, submitTrafficRouteReview } from "./route-review.js";

/** 审核由最终确认中独立的用户授权触发，服务自动匹配线路，不指定线路编号。 */
export async function ensureAuthorizedTrafficRouteReview(page: TrafficLinePage, productId: string,
  authorized: boolean, log: (message: string) => void) {
  if (!authorized) return;
  let result = await readTrafficRouteReview(page, productId);
  if (result.verified) return;
  log("正在按已确认授权提交玩法线路匹配审核，审核通过后继续交通套餐。");
  await advanceSavedProductWizard(page, productId, { authorization: "submit-route-review" });
  result = await submitTrafficRouteReview(page, productId, { authorization: "submit-route-review" });
  for (let attempt = 1; !result.verified && attempt <= 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1_500));
    result = await readTrafficRouteReview(page, productId);
  }
  if (!result.verified) throw new Error("玩法线路匹配审核尚未通过；已保留审核结果，请稍后继续，不能启用交通套餐。");
  log("玩法线路匹配审核已通过远端回读，继续录入交通套餐。");
}
