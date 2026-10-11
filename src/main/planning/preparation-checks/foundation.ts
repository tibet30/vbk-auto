import type { PreparationGap } from "../../../shared/contracts-preparation.js";
import { toPlatformShortLocationName } from "../../../shared/location-short-name.js";
import { asObject, textValue } from "./common.js";

export function foundationGaps(product: Record<string, unknown>): PreparationGap[] {
  const gaps: PreparationGap[] = [];
  const basic = asObject(product.basicInfo);
  const meetingCity = toPlatformShortLocationName(textValue(basic?.meetingCity || basic?.destinationCity));
  const destinationCity = toPlatformShortLocationName(textValue(basic?.destinationCity || basic?.meetingCity));
  const days = Number(basic?.days);
  const push = (label: string, detail: string) => gaps.push({ code: "foundation", label, detail, stage: "foundation", node: "skeleton" });
  if (!meetingCity) push("目的地", "需锁定目的地城市后才能进入后续阶段。");
  if (!Number.isInteger(days) || days < 1) push("出行天数", "需锁定出行天数后才能规划行程。");
  if (meetingCity && destinationCity && meetingCity !== destinationCity) {
    push("destinationCity", "destinationCity 必须与已锁定 meetingCity 相同。");
  }
  return gaps;
}
