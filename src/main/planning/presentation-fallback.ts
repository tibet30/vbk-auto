import { PRIVATE_TOUR_SERVICE_FEATURE } from "../../shared/private-tour-copy.js";
import { fitVbkRecommendationText } from "./vbk-recommendation-length.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value.trim().replace(/黑独山/gu, "特色戈壁景观") : "";
const html = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** AI 内容缺失时仍使用实际行程，不虚构高品质酒店、含餐或额外服务。 */
export function presentationFallback(product: Record<string, unknown>) {
  const basic = record(product.basicInfo);
  const operations = record(product.operations);
  const privateTour = record(product.sales).productForm === "privateTour";
  const days = Array.isArray(product.itinerary) ? product.itinerary.map(record) : [];
  const names = days.flatMap(day => Array.isArray(day.spots) ? day.spots.map(spot => text(record(spot).poiName) || text(record(spot).name)) : [])
    .filter((name, index, all) => name && all.indexOf(name) === index);
  const route = names.slice(0, 2).join("与") || text(basic.meetingCity) || "目的地";
  const service = privateTour ? `${PRIVATE_TOUR_SERVICE_FEATURE}，独立成团，线上协助行程衔接与旅途咨询` : "各日游览安排清晰，具体服务与费用按产品说明确认，方便出发前了解行程";
  const recommendations = [
    { category: "优选行程", text: fitVbkRecommendationText(`串联${route}，按每日路线安排游览，结合实际行程体验当地风貌与特色`, undefined, "优选行程") },
    { category: "服务保障", text: fitVbkRecommendationText(service, undefined, "服务保障") },
    { category: "缤纷景点", text: fitVbkRecommendationText(`围绕${names[2] || names[0] || text(basic.meetingCity) || "当地景点"}安排游览体验，结合每日景点说明了解行程内容与游览顺序`, undefined, "缤纷景点") },
  ];
  const paragraphs = days.slice(0, 3).map(day => {
    const detail = text(day.description) || (Array.isArray(day.spots) ? day.spots.map(spot => text(record(spot).description) || text(record(spot).name)).join("；") : "");
    return `<p><strong>第${Number(day.day) || 1}天·${html(text(day.title))}：</strong>${html(detail.slice(0, 600))}</p>`;
  });
  if (!paragraphs.length) paragraphs.push(`<p><strong>游览安排：</strong>围绕${html(text(basic.meetingCity) || "目的地")}安排游览，具体景点及日序以行程说明为准。</p>`);
  paragraphs.push(`<p><strong>服务衔接：</strong>${html(service)}${operations.transport === "charter" ? "；每日专车衔接按行程安排。" : "。"}</p>`);
  paragraphs.push("<p><strong>出发前确认：</strong>请结合每日行程及套餐说明核对门票、住宿和餐食的包含范围，特色体验按已确认安排提供。</p>");
  return { recommendation: `${text(basic.meetingCity) || "目的地"}${Number(basic.days) || days.length || 1}日游览，串联${route}，按每日行程体验当地特色。`, recommendations, features: paragraphs.join("") };
}
