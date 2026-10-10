import type { AgentQuestion, ProductDetail } from "../../shared/contracts.js";
import { hotelStayRequirement } from "../../shared/hotel-stay-requirement.js";
import { hotelDiamondFromTier } from "../../shared/hotel-tiers.js";
import { reusableHotelCandidates } from "../infrastructure/ctrip-hotel-candidate-cache.js";

export function isHotelRecoveryQuestion(question: AgentQuestion): boolean {
  return /^hotel\d+$/.test(question.id) && /住宿.*(?:未取得|未完成)/u.test(question.label);
}

/** Availability failure needs a concrete lodging choice, rather than another identical retry. */
export function hotelAvailabilityQuestions(product: ProductDetail, result: string): AgentQuestion[] {
  const queryFailures = [...result.matchAll(/第\s*(\d+)\s*天住宿[^\n]*未完成：([^\n]+)/g)]
    .filter(match => /未返回可用候选|未找到.*酒店检索地标|未包含可解析的酒店数据/u.test(match[2] ?? ""));
  const days = [...result.matchAll(/第\s*(\d+)\s*天住宿[^\n]*没有满足[^\n]*候选/g)].map(match => Number(match[1]));
  const itinerary = Array.isArray(product.product.itinerary) ? product.product.itinerary : [];
  return [...new Set([...days, ...queryFailures.map(match => Number(match[1]))])].flatMap<AgentQuestion>(dayNumber => {
    const day = itinerary.find(day => Number(day.day) === dayNumber);
    if (!day) return [];
    const requirement = hotelStayRequirement(product.product, day);
    const operations = product.product.operations as Record<string, unknown> | undefined;
    const tier = operations?.hotelTier;
    if (reusableHotelCandidates(day, typeof tier === "string" ? tier : undefined, requirement)) return [];
    const queryFailure = queryFailures.find(match => Number(match[1]) === dayNumber);
    if (queryFailure) return [{ id: `hotel${dayNumber}`, label: `第 ${dayNumber} 天 ${requirement?.anchorName ?? "原定地点"}住宿核验未完成：${queryFailure[2]?.replace(/[。]+$/u, "")}。这不代表当地没有酒店。请补充准确住宿地点或在审查页配置真实住宿候选；不会自动改变地点或档次。`, kind: "text" as const, required: true }];
    const grade = requirement?.diamond ?? hotelDiamondFromTier(typeof operations?.hotelTier === "string" ? operations.hotelTier : undefined);
    if (!grade || grade <= 2 || requirement?.ratingType === "homestay" || requirement?.ratingType === "star") return [];
    const lower = grade - 1;
    return [{ id: `hotel${dayNumber}`, label: `第 ${dayNumber} 天 ${requirement?.anchorName ?? "原定地点"}住宿未取得符合要求的酒店候选，请选择后续处理；降档仍须核验真实候选并保留原定住宿地点。`, kind: "single" as const, required: true, options: [
      { id: "keep", label: `保留当地${grade}钻酒店，手动配置符合原地点要求的真实候选` },
      { id: "lower_hotel", label: `接受当地${lower}钻酒店，保留原定住宿地点` },
      { id: "homestay", label: "接受3圆钻民宿，保留原定住宿地点" },
    ] }];
  });
}
