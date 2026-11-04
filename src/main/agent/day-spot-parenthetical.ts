import { isIndependentItineraryExperience } from "../../shared/independent-itinerary-experience.js";
import { isItineraryActivityPhrase } from "../../shared/itinerary-activity-phrase.js";

/**
 * `韶山（毛泽东故居、铜像广场、韶峰）` 括号里用顿号列出的是该节点下的子景点，
 * 需要按原顺序展开成独立景点；否则它们只剩一句「原始补充」文字，既不进景点
 * 列表也不参与 POI 核验，每日行程就只剩一个笼统的大地名。
 *
 * 只有括号内**至少两项、且每一项都像景点名**时才展开。`松花湖（滑雪、雪圈）`
 * 这类活动、`（含门票、讲解）` 这类服务、`（早餐、午餐）` 这类餐食说明都保持
 * 原样，由调用方当作说明文字处理。
 */
const NOT_A_SPOT = /^(?:含|不含|赠|送|需|可|约|共|全程)|门票|讲解|导游|早餐|午餐|晚餐|正餐|用餐|餐|自费|自理|自由|二选一|多选一|任选|住宿|酒店|接送|专车|包车|拍照|打卡/u;

export function expandParentheticalSubSpots(source: string): string {
  return source.replace(/[（(]([^）)\n]*)[）)]/gu, (whole, inner: string) => {
    if (!/[、，,]/u.test(inner)) return whole;
    const items = inner.split(/[、，,]/u).map((item) => item.trim()).filter(Boolean);
    return items.length >= 2 && items.every(isSubSpotName) ? `，${items.join("，")}，` : whole;
  });
}

function isSubSpotName(item: string): boolean {
  if (item.length < 2 || item.length > 20) return false;
  if (NOT_A_SPOT.test(item)) return false;
  if (/\d/u.test(item)) return false;
  return !isItineraryActivityPhrase(item) && !isIndependentItineraryExperience(item);
}

/** `车程约 1h`、`约2小时` 是路程说明，不是可绑定 POI 的景点。 */
export function isTravelDurationNote(item: string): boolean {
  const value = item.replace(/\s+/gu, "");
  return /^(?:全程)?车程/u.test(value)
    || /^(?:约|大约)?\d+(?:\.\d+)?(?:h|小时|分钟|公里|km)$/iu.test(value);
}
