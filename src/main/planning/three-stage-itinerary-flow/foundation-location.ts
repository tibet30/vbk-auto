/**
 * 第一阶段：补齐产品所在省份（同时锁定城市锚点）。
 *
 * 关键约束：
 *   - 城市由 UI 在创建产品时锁定；AI 不得覆盖 meetingCity / destinationCity；
 *   - 省级输入在查 POI 前自动提升为「已定义的主城市」，避免 province 临时
 *     写进城市锚点；真实城市输入仍保持用户锁定值；
 *   - 任何 attempt 失败都写入 patchNode，让 UI 能看见 attempted 次数与最近错误；
 *   - 累计尝试到 PLANNING_STAGE_RETRY_LIMIT 仍未通过 → fail() 退出并把
 *     plan.status 标记为 needs_user。
 */

import { PLANNING_STAGE_RETRY_LIMIT } from "../../../shared/contracts-planning.js";
import { toPlatformShortLocationName } from "../../../shared/location-short-name.js";
import { AI_WRITABLE_PATHS } from "../schemas.js";
import { isAcceptablePlanningRegionName, normaliseProvinceName, resolveTravelScope } from "../runtime.js";
import type { PatchNode, ThreeStageItineraryDependencies } from "./types.js";
import { asRecord, errorMessage, fail, text } from "./types.js";
import type { PlanningPlanV2 } from "../../../shared/contracts-planning.js";

/** 第一阶段只补齐省份；城市在创建时锁定，AI 不得覆盖。 */
export async function runFoundationLocation(
  deps: ThreeStageItineraryDependencies,
  initial: PlanningPlanV2,
  patchNode: PatchNode,
  getPlan: () => PlanningPlanV2,
): Promise<{ ok: boolean; plan: PlanningPlanV2 }> {
  let plan = initial;
  let previousError: { stage: "basicInfo"; attempt: number; code: string; message: string } | undefined;
  for (let attempt = 1; attempt <= PLANNING_STAGE_RETRY_LIMIT; attempt += 1) {
    await patchNode("skeleton", { status: "running", attempts: attempt, startedAt: new Date().toISOString(), error: undefined });
    plan = getPlan();
    try {
      const currentProduct = await deps.runtime.loadCurrentProduct(deps.localProductId);
      const currentBasic = asRecord(currentProduct.basicInfo) ?? {};
      const storedCity = text(currentBasic.meetingCity) || text(currentBasic.destinationCity) || deps.skeleton.city;
      const travelScope = resolveTravelScope(text(currentBasic.destination) || deps.skeleton.destination);
      // 新建旧版本曾把省名临时写进城市锚点。省级输入在开始查 POI 前统一提升到
      // 已定义的主城市；真实城市输入仍保持用户锁定值，AI 无权改写。
      const shouldPromoteProvinceAnchor = travelScope.isProvinceLevel
        && normaliseProvinceName(storedCity) === normaliseProvinceName(travelScope.input);
      const currentCity = toPlatformShortLocationName(
        shouldPromoteProvinceAnchor ? travelScope.primaryCity : storedCity,
      );
      const location = await deps.ai.structureLocation({
        destination: deps.skeleton.destination,
        currentProvince: text(currentBasic.province),
        currentDestinationCity: currentCity,
        previousError: previousError?.message,
      });
      const province = normaliseProvinceName(text(location.province));
      const errors: string[] = [];
      if (!province) errors.push("province 为空");
      else if (!isAcceptablePlanningRegionName(province, currentCity)) {
        errors.push(`province「${province}」不是可用的国家、地区或一级行政区名称`);
      }
      if (errors.length === 0) {
        const write = await deps.runtime.writeModule(
          deps.localProductId,
          "basicInfo",
          AI_WRITABLE_PATHS.basicInfo,
          {
            province,
            ...(shouldPromoteProvinceAnchor ? { meetingCity: currentCity, destinationCity: currentCity } : {}),
          },
        );
        if (!write.ok) throw new Error(write.reason || "标准目的地写入失败");
        deps.skeleton.province = province;
        deps.skeleton.city = currentCity;
        await patchNode("skeleton", {
          status: "completed", attempts: attempt, summary: `${province} · ${currentCity} · ${deps.skeleton.days}天`,
          error: undefined, completedAt: new Date().toISOString(),
        });
        return { ok: true, plan: getPlan() };
      }
      previousError = { stage: "basicInfo", attempt, code: "location_gate_failed", message: `第一阶段目的地准入失败：${errors.join("；")}` };
      await patchNode("skeleton", { status: "failed", attempts: attempt, error: previousError.message });
    } catch (error) {
      previousError = { stage: "basicInfo", attempt, code: "location_generation_failed", message: errorMessage(error) };
      await patchNode("skeleton", { status: "failed", attempts: attempt, error: previousError.message });
    }
    plan = getPlan();
  }
  return fail(patchNode, getPlan, "skeleton", previousError?.message ?? "第一阶段目的地准入失败");
}