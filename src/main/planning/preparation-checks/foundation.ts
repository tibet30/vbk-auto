import type { PreparationGap } from "../../../shared/contracts-preparation.js";
import { toPlatformShortLocationName } from "../../../shared/location-short-name.js";
import { isNonWritableCityAlias, toWritableAdministrativeCityName } from "../../../shared/region-overrides.js";
import { asObject, textValue } from "./common.js";

export function foundationGaps(product: Record<string, unknown>): PreparationGap[] {
  const gaps: PreparationGap[] = [];
  const basic = asObject(product.basicInfo);
  const operations = asObject(product.operations);
  const meetingCity = toPlatformShortLocationName(textValue(basic?.meetingCity || basic?.destinationCity));
  const destinationCity = toPlatformShortLocationName(textValue(basic?.destinationCity || basic?.meetingCity));
  const days = Number(basic?.days);
  const push = (label: string, detail: string) => gaps.push({ code: "foundation", label, detail, stage: "foundation", node: "skeleton" });
  if (!meetingCity) push("目的地", "需锁定目的地城市后才能进入后续阶段。");
  if (!Number.isInteger(days) || days < 1) push("出行天数", "需锁定出行天数后才能规划行程。");
  if (meetingCity && destinationCity && meetingCity !== destinationCity) {
    push("destinationCity", "destinationCity 必须与已锁定 meetingCity 相同。");
  }
  const pickupMismatch = meetingCityMismatch(basic, operations, meetingCity);
  if (pickupMismatch) push("集合城市", pickupMismatch);
  return gaps;
}

/**
 * 集合城市是携程产品出发城市锚点，必须能与接团城市对应。
 *
 * 只拦「接团城市是纯行政城市、集合城市不是已登记区域别名」的不一致：
 * 「潮汕」这类超统称按平台改写为汕头，不属于矛盾；「广安动车站」是站点名，
 * 无法据此判断城市，也不拦。大交通进出城市可以是异地（西宁进、敦煌出），
 * 不作为证据。
 */
function meetingCityMismatch(basic: Record<string, unknown> | undefined,
  operations: Record<string, unknown> | undefined, meetingCity: string): string {
  const pickupRaw = textValue(operations?.pickupCity);
  if (!pickupRaw || !meetingCity) return "";
  if (!/^[\p{Script=Han}]{2,8}$/u.test(pickupRaw)) return "";
  if (/(?:站|机场|港|码头|门|景区|镇|村|乡|酒店|宾馆|广场|古城|古镇)$/u.test(pickupRaw)) return "";
  const meetingRaw = textValue(basic?.meetingCity);
  if (isNonWritableCityAlias(meetingRaw)) return "";
  const pickupCity = toPlatformShortLocationName(toWritableAdministrativeCityName(pickupRaw));
  if (!pickupCity || pickupCity === meetingCity) return "";
  return `接团城市是「${pickupCity}」，产品集合城市是「${meetingCity}」：集合城市会作为携程出发城市与集合点口径，需与接团城市一致后再确认方案。`;
}
