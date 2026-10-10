/**
 * itinerary 稳定指纹：sha256(JSON.stringify(itinerary)) → 24 字符 hex。
 * 行程随计划持久化后，刷新仍能判断是否是同一版行程。
 */

import { createHash } from "node:crypto";

export function itineraryFingerprint(itinerary: unknown): string {
  return createHash("sha256").update(JSON.stringify(itinerary ?? null)).digest("hex").slice(0, 24);
}