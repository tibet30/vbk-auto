import { createHash } from "node:crypto";
import type { AgentQuestion, ProductDetail } from "../../shared/contracts.js";
import { poiResearchTaskNames } from "../../shared/poi-research-tasks.js";
import { hasCompletePoi, requiresItineraryPoi } from "../../shared/itinerary-activity-kind.js";

export type ManualPoiSlot = { day: number; name: string };

export function unmatchedCanonicalPoiSlots(product: ProductDetail): ManualPoiSlot[] {
  const names = new Set(product.researchTasks
    .filter((task) => /未找到对应的 VBK POI|未匹配真实 POI/.test(task.detail ?? ""))
    .flatMap((task) => poiResearchTaskNames(task.label, task.type)));
  const itinerary = Array.isArray(product.product.itinerary) ? product.product.itinerary : [];
  const slots: ManualPoiSlot[] = [];
  for (const [dayIndex, rawDay] of itinerary.entries()) {
    const day = record(rawDay); const spots = Array.isArray(day?.spots) ? day.spots : [];
    for (let spotIndex = 0; spotIndex < spots.length; spotIndex += 1) {
      const spot = record(spots[spotIndex]); const name = text(spot?.name);
      const dayNumber = Number(day?.day) || dayIndex + 1;
      if (!spot || !name || !requiresItineraryPoi(spot) || hasCompletePoi(spot) || !names.has(name)) continue;
      slots.push({ day: dayNumber, name });
    }
  }
  return slots.sort((left, right) => left.day - right.day || left.name.localeCompare(right.name));
}

/** All named attractions remain required until bound or explicitly deleted by an operator. */
export function requiredItineraryPoiSatisfaction(detail: ProductDetail | Record<string, unknown>): { hasRequiredPoi: boolean; satisfied: boolean } {
  const embedded = "product" in detail ? record(detail.product) : undefined;
  const product: Record<string, unknown> = embedded ?? detail as Record<string, unknown>;
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary : [];
  let hasRequiredPoi = false;
  for (const [dayIndex, rawDay] of itinerary.entries()) {
    const day = record(rawDay); const dayNumber = Number(day?.day) || dayIndex + 1;
    const spots = Array.isArray(day?.spots) ? day.spots : [];
    for (const rawSpot of spots) {
      const spot = record(rawSpot); const name = text(spot?.name);
      if (!spot || !name || !requiresItineraryPoi(spot)) continue;
      hasRequiredPoi = true;
      if (!hasCompletePoi(spot)) {
        return { hasRequiredPoi, satisfied: false };
      }
    }
  }
  return { hasRequiredPoi, satisfied: true };
}

export function manualPoiInput(slots: readonly ManualPoiSlot[]): { key: string; slots: readonly ManualPoiSlot[]; question: AgentQuestion } | undefined {
  if (!slots.length) return undefined;
  const key = createHash("sha256").update(JSON.stringify(slots)).digest("hex");
  const listed = slots.map((slot) => `第${slot.day}天「${slot.name}」`).join("、");
  return {
    key,
    slots: [...slots],
    question: {
      id: `manual-poi-${key.slice(0, 12)}`,
      label: `${listed} 未找到真实 POI。请按“原景点=准确名称”逐项回复；或前往产品审查→每日行程→待手动配置 POI 搜索并保存；如确需移除，请由运营在该行程中手动删除，Agent 不会代删。`,
      kind: "text",
      required: true,
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
