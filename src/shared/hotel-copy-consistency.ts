import { hotelCandidateMeetsStay, hotelStayRequirement } from "./hotel-stay-requirement.js";

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown) => typeof value === "string" ? value : "";

/** Remove a uniform hotel promise as soon as a verified night contradicts it. */
export function reconcileHotelCopy(product: Json): Json {
  const days = (Array.isArray(product.itinerary) ? product.itinerary : []).map(record);
  const stays = days.flatMap(day => {
    const candidate = (Array.isArray(day.hotelCandidates) ? day.hotelCandidates : []).map(record)
      .find(item => item.hotelName === day.hotel && Number(item.hotelId) > 0
        && Number.isInteger(item.diamond) && Number(item.diamond) >= 0 && Number(item.diamond) <= 5
        && hotelCandidateMeetsStay(item, hotelStayRequirement(product, day)));
    return candidate ? [{ day: Number(day.day), grade: Number(candidate.diamond), type: text(candidate.ratingType) || "diamond" }] : [];
  });
  if (!stays.length) return product;
  let corrected = false;
  const rewrite = (value: unknown) => text(value).replace(
    /(?:全程|每晚|全部)(?:入住|安排|精选|当地|\s)*([1-5一二三四五])\s*(钻|星级|星)(?:酒店)?/gu,
    (claim, raw: string, rating: string) => {
      const grade = Number(raw) || "一二三四五".indexOf(raw) + 1;
      const type = rating === "钻" ? "diamond" : "star";
      if (stays.every(stay => stay.grade === grade && stay.type === type)) return claim;
      corrected = true;
      return "逐晚精选住宿";
    },
  );
  const next = structuredClone(product);
  const basic = record(next.basicInfo);
  if (typeof basic.operationNotes === "string") basic.operationNotes = rewrite(basic.operationNotes);
  const presentation = record(next.presentation);
  for (const key of ["recommendation", "features"] as const) {
    if (typeof presentation[key] === "string") presentation[key] = rewrite(presentation[key]);
  }
  if (Array.isArray(presentation.recommendations)) presentation.recommendations = presentation.recommendations.map(value => {
    const item = record(value);
    return typeof item.text === "string" ? { ...item, text: rewrite(item.text) } : value;
  });
  const summaryPrefix = "住宿评级：";
  if (corrected || text(basic.operationNotes).includes(summaryPrefix)) {
    const summary = stays.map(stay => `第${stay.day}晚${stay.grade === 0 ? "无" : stay.grade}${stay.type === "homestay" ? "民宿圆钻" : stay.type === "star" ? "星" : "钻酒店"}`).join("、");
    basic.operationNotes = `${text(basic.operationNotes).replace(/(?:\n)?住宿评级：[^\n]*/u, "").trim()}\n${summaryPrefix}${summary}`.trim();
  }
  if (next.basicInfo) next.basicInfo = basic;
  if (next.presentation) next.presentation = presentation;
  return next;
}
