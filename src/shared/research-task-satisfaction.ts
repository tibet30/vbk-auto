import { HOTEL_TIER_VALUES } from "./hotel-tiers.js";
import { poiResearchTaskNames } from "./poi-research-tasks.js";
import { productNeedsVehicleResource } from "./product-form.js";
import { hasCompletePoi, requiresItineraryPoi } from "./itinerary-activity-kind.js";
import { hasVerifiedRouteAdministrativeNode } from "./route-administrative-nodes.js";
import { trustedOperatorItineraryRemovals } from "./trusted-operator-itinerary-removals.js";
import {
  hasBorderPermitItineraryTrigger,
  hasResolvedBorderPermitVisibleFields,
  isBorderPermitIssueText,
} from "./border-permit.js";
type ProductLike = Record<string, unknown>;
type ResearchTaskText = { label?: string; detail?: string | null; type?: string };

const vehiclePattern = /用车|车辆|接送|司机|资源组|vehicle|vehicleResource|resourceGroupId/i;
const hotelPattern = /酒店|住宿|客栈|民宿/;
const commercialPattern = /成人价|儿童价|成人成本|儿童成本|价格|起订人数|最低成团|库存|班期|每日配额|起止日期|配额|套餐名称|费用包含|不包含|退改|政策|成本口径|packageName|pricing|inventory|terms/i;
const obsoletePoiFailurePattern = /suggestPoi\s*未匹配|未找到对应的\s*VBK\s*POI|暂停营业|停止营业|永久关闭|已关闭|可能已关闭|temporarily\s+closed|permanently\s+closed|不能加入行程|不能写入行程|不能作为行程景点|请替换为(?:正常营业|可游览)景点|替换为(?:正常营业|可游览)景点|手动录入\s*POI|人工核查/i;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function poiNameSatisfaction(product: ProductLike, taskName: string): PoiResearchSatisfaction {
  const targetName = taskName.trim();
  if (!targetName || !Array.isArray(product.itinerary)) return null;
  let hasNonPoi = false;
  let hasVerified = false;
  let hasMissingAttraction = false;

  for (const day of product.itinerary) {
    const spots = objectValue(day)?.spots;
    if (!Array.isArray(spots)) continue;
    for (const spotValue of spots) {
      const spot = objectValue(spotValue);
      if (!spot) continue;
      const spotName = textValue(spot.name);
      const poiName = textValue(spot.poiName);
      const compact = (value: string) => value.replace(/\s+/gu, "");
      const isMatchingSpot = compact(spotName) === compact(targetName) || compact(poiName) === compact(targetName);
      if (!isMatchingSpot) continue;
      if (!requiresItineraryPoi(spot)) { hasNonPoi = true; continue; }
      if (poiName && positiveInteger(spot.poiId)) { hasVerified = true; continue; }
      hasMissingAttraction = true;
    }
  }

  if (hasMissingAttraction) return null;
  if (hasVerified) return "verified";
  // Absence alone is not evidence. Only trusted manual deletion receipts can
  // retire an absent POI question, including location/ambiguity failures.
  if (!hasNonPoi && trustedOperatorItineraryRemovals(product).some((receipt) =>
    receipt.name.replace(/\s+/gu, "") === targetName.replace(/\s+/gu, ""))) return "removed";
  if (hasVerifiedRouteAdministrativeNode(product, targetName)) return "non_poi";
  // An explicitly saved night shoot is an independent activity, not a new
  // sightseeing stop. Do not keep a stale POI question for its location once
  // that day's actual attractions are verified. Missing attractions above
  // still win, including when the same name is also used for a night shoot.
  const escaped = targetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nightTitle = new RegExp(`^${escaped}(?:星空(?:拍摄)?|夜拍|星空夜拍)$`, "u");
  if (product.itinerary.some(value => {
    const day = objectValue(value);
    const spots = Array.isArray(day?.spots) ? day.spots : [];
    const activities = Array.isArray(day?.activities) ? day.activities : [];
    return spots.filter(requiresItineraryPoi).every(hasCompletePoi) && activities.some(value => {
      const activity = objectValue(value);
      return activity?.type === "other" && textValue(activity.time) === "晚上"
        && nightTitle.test(textValue(activity.title));
    });
  })) return "non_poi";
  return hasNonPoi ? "non_poi" : null;
}

function hasPoiTaskSpot(product: ProductLike, taskName: string): boolean {
  if (!Array.isArray(product.itinerary)) return false;
  return product.itinerary.some((day) => {
    const spots = objectValue(day)?.spots;
    return Array.isArray(spots) && spots.some((spotValue) => {
      const spot = objectValue(spotValue);
      return spot && (textValue(spot.name) === taskName || textValue(spot.poiName) === taskName);
    });
  });
}

/** A manual free/other classification supersedes the POI research question.
 * It does not claim a POI match: the current activity simply has no POI
 * requirement.  Switching it back to attraction makes the same task pending
 * again unless a verified POI is present. */
export type PoiResearchSatisfaction = "verified" | "non_poi" | "removed" | null;

/** All names in an "A 或 B" task must be independently resolved. */
export function poiResearchTaskSatisfaction(task: ResearchTaskText, product: ProductLike): PoiResearchSatisfaction {
  const names = poiResearchTaskNames(task.label || "", task.type || "vbk");
  if (!names.length) return null;
  const results = names.map((name) => poiNameSatisfaction(product, name));
  if (results.some((result) => result === null)) return null;
  if (results.some((result) => result === "removed")) return "removed";
  return results.some((result) => result === "non_poi") ? "non_poi" : "verified";
}

function isObsoletePoiFailureDetail(detail: string | null | undefined): boolean {
  return obsoletePoiFailurePattern.test(detail || "");
}

export function hasSatisfiedVehicleResource(product: ProductLike): boolean {
  const operations = objectValue(product.operations);
  const vehicle = objectValue(operations?.vehicleResource);
  return positiveInteger(vehicle?.resourceGroupId) && Boolean(textValue(vehicle?.resourceGroupName));
}

export function hasSatisfiedHotelTier(product: ProductLike): boolean {
  const operations = objectValue(product.operations);
  return (HOTEL_TIER_VALUES as readonly string[]).includes(textValue(operations?.hotelTier));
}

export function isResearchTaskSatisfiedByProduct(
  task: ResearchTaskText,
  product: ProductLike,
): boolean {
  if (task.type === "image") return false;
  const poiTaskNames = poiResearchTaskNames(task.label || "", task.type || "vbk");
  if (poiTaskNames.length > 0) {
    // “A 或 B”不是单个 POI。仅当行程里每个备选项均有有效 poiName / poiId
    // 时才收敛，避免只完成一项便错误放过另一项。
    if (poiResearchTaskSatisfaction(task, product) !== null) return true;
    // A failed POI task may become obsolete after the operator replaces that
    // attraction in the current itinerary. Only explicit failure/replacement
    // states are auto-resolved; ordinary missing POI tasks remain actionable.
    if (isObsoletePoiFailureDetail(task.detail)) {
      return poiTaskNames.every((name) => !hasPoiTaskSpot(product, name));
    }
    return false;
  }
  const text = `${task.label || ""} ${task.detail || ""}`;
  if (isBorderPermitIssueText(text)) {
    return !hasBorderPermitItineraryTrigger(product) || hasResolvedBorderPermitVisibleFields(product);
  }
  if (hotelPattern.test(text)) return hasSatisfiedHotelTier(product);
  if (vehiclePattern.test(text)) return !productNeedsVehicleResource(product) || hasSatisfiedVehicleResource(product);
  if (commercialPattern.test(text)) return true;
  return false;
}
