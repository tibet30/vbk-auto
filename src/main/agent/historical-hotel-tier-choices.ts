import type { ProductDetail } from "../../shared/contracts.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import { hotelAnswerInstruction } from "./hotel-answer-instruction.js";

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const brief = (product: ProductDetail) => String(record(product.product.basicInfo).userIdea ?? "").replace(/\s+/g, "").replace(/；/g, ";");
const policy = (product: ProductDetail) => record(record(product.product.operations).hotelFallbackPolicy);
const dayFor = (product: ProductDetail, day: number) => (Array.isArray(product.product.itinerary) ? product.product.itinerary.map(record) : []).find(item => Number(item.day) === day);

/** Reuse explicit lodging answers only for the same account, route and unchanged nightly location. */
export function historicalHotelTierInstruction(db: Pick<VbkDatabase, "listProducts" | "getProduct" | "getAgentSnapshot">, current: ProductDetail): string {
  if (!current.vbkAccount || !brief(current) || policy(current).allowDowngrade !== true) return "";
  const currentInstruction = hotelAnswerInstruction(db.getAgentSnapshot(current.id)?.events ?? []);
  if (/不(?:接受|允许|要|同意).*民宿|只(?:要|用|接受).*酒店/.test(currentInstruction)) return "";
  const instructions: Array<{ at: string; text: string }> = [];
  for (const summary of db.listProducts().filter(item => item.id !== current.id)) {
    const historical = db.getProduct(summary.id);
    if (!historical || historical.vbkAccount !== current.vbkAccount || brief(historical) !== brief(current)
      || record(historical.product.operations).hotelTier !== record(current.product.operations).hotelTier) continue;
    const events = db.getAgentSnapshot(summary.id)?.events ?? [];
    for (const [index, event] of events.entries()) {
      if (event.type !== "user") continue;
      const answerInstruction = hotelAnswerInstruction(events.slice(0, index + 1).filter(item => item.type === "input_request" || item === event));
      for (const chunk of answerInstruction.match(/\{[^{}\n]+\}/g) ?? []) {
        let answers: Json;
        try { answers = record(JSON.parse(chunk)); } catch { continue; }
        const safe: Json = {};
        for (const [key, value] of Object.entries(answers)) {
          const day = Number(key.match(/^hotel(\d+)$/i)?.[1]);
          if (!day) continue;
          if (new RegExp(`(?<!\\d)(?:hotel${day}(?=[\\"'\\s:：,，}\\]]|$)|D${day}(?!\\d)|第\\s*${day}\\s*天(?!\\d))`, "i").test(currentInstruction)) continue;
          const currentDay = dayFor(current, day);
          const previousDay = dayFor(historical, day);
          const next = record(currentDay?.hotelRequirement), previous = record(previousDay?.hotelRequirement);
          if (!next.anchorName || next.anchorName !== previous.anchorName || next.cityName !== previous.cityName
            || next.maxDistanceKm !== previous.maxDistanceKm) continue;
          // Relocation/radius decisions do not transfer to another product.
          const text = Array.isArray(value) && value.length === 1 ? value[0] : value;
          if (typeof text === "string" && /改住|放宽|扩大|距离|公里|\bkm\b/i.test(text)) continue;
          safe[`hotel${day}`] = value;
        }
        if (Object.keys(safe).length) instructions.push({ at: event.createdAt ?? summary.updatedAt, text: JSON.stringify(safe) });
      }
    }
  }
  return instructions.sort((a, b) => a.at.localeCompare(b.at)).map(item => item.text).join("\n");
}
