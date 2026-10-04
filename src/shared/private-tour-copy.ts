import { itineraryAttractions } from "./itinerary-activity-kind.js";

export const PRIVATE_TOUR_SERVICE_FEATURE = "一单一团+24h线上管家";

type Spot = { name?: unknown; poiName?: unknown; poiId?: unknown; kind?: unknown; ticketType?: { key?: unknown } | null; description?: unknown };

/** 门票类型来自平台；外观游览不作为收费门票卖点。 */
export function isPaidTourSpot(spot: Spot): boolean {
  return Number(spot.ticketType?.key) === 1
    && !/(外观|远观|不入内|不进景区|不上桥)/u.test(String(spot.description ?? ""));
}

export function tourTitleSpots(spots: Spot[]): Spot[] {
  const unique = itineraryAttractions(spots).filter((spot, index, all) => Number(spot.poiId) > 0
    && all.findIndex(other => Number(other.poiId) === Number(spot.poiId)) === index);
  const paid = unique.filter(isPaidTourSpot);
  // 全免费路线仍保留真实代表景点，不能虚构收费景点。
  return (paid.length ? paid : unique).slice(0, 3);
}

export function vbkCopyWidth(value: string): number {
  return Array.from(value).reduce((sum, char) => sum + (/^[\x00-\xff]$/u.test(char) ? 1 : 2), 0);
}

function fitWidth(value: string, maximum: number): string {
  let result = "";
  for (const char of value) {
    if (vbkCopyWidth(result + char) > maximum) break;
    result += char;
  }
  return result.replace(/[，、｜+·\s]+$/u, "");
}

/** 固定服务特色放在前面，确保截短时不会丢失；其余文字不重复主标题。 */
export function privateTourSubtitle(value: unknown, mainSpotNames: string[] = []): string {
  let highlight = String(value ?? "").trim().replaceAll(PRIVATE_TOUR_SERVICE_FEATURE, "")
    .replace(/一单一团|24\s*[hH小时]+线上管家|\d+\s*[天日](?:\d+\s*晚)?|私家团/gu, "");
  for (const name of [...mainSpotNames].sort((a, b) => b.length - a.length)) {
    if (name) highlight = highlight.replaceAll(name, "");
  }
  highlight = highlight.replace(/^[，、｜+·\s]+|[，、｜+·\s]+$/gu, "")
    .replace(/[，、｜+·]{2,}/gu, "｜");
  if (vbkCopyWidth(highlight) < 8) highlight = "按行程游览，出行安排清晰";
  return fitWidth(`${PRIVATE_TOUR_SERVICE_FEATURE}｜${highlight}`, 80);
}

export const PRIVATE_TOUR_COPY_GUIDE = `私家团副标题必须包含「${PRIVATE_TOUR_SERVICE_FEATURE}」。主标题优先展示收费门票景点，副标题其余文字不要重复罗列这些景点、城市、天数或产品形态，提炼主标题未体现且有行程依据的路线组合、文化体验、游览节奏或客群特色。推荐理由分别突出具体路线与体验、游览安排、私家团服务，避免三条重复或只写“省心、舒适、丰富”。每条建议 30～40 个汉字，按平台中文2、英文1计数控制在60～80，硬范围30～84。产品特色写3～5段，每段点名实际行程或已确认服务并解释游客能获得的体验，避免用短句或景点名单代替介绍。不得编造门票包含、餐食赠送、导游讲解或酒店权益。`;
