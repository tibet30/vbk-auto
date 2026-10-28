/**
 * 子产品同步母产品行程：母产品改天数后，已存在的交通子产品仍是旧天数。
 *   - readParentItineraryForChild：只读比较母/子当前行程天数，不一致时返回母产品每日行程；
 *   - rebaseOnParentDescriptions：以母产品每日行程为子产品底稿，清空母版本的引用 ID，
 *     其余字段沿用子产品当前 tourInfo；随后由调用方合并首末交通节点并走正常校验写入。
 */

import { fetchTourDailyDetail, fetchTourInfoId } from "../../itinerary-api/steps.js";
import { linkedVersionId } from "../../itinerary-api/versioning.js";
import { list, type JsonRecord, type TrafficLinePage } from "../client.js";
import { currentTrafficLineTourInfoId } from "./current-id.js";

// 母产品版本内生成的引用 ID；写入子产品时必须由平台重新分配。
const PARENT_REFERENCE_FIELDS = new Set([
  "tourDailyDescriptionId", "tourDailyInfoId", "tourDailyPackageGatherId", "tourDailyDinnerId",
  "tourDailyPoiId", "tourDailyHotelId", "tourDailyPackageHotelId", "tourDailyPackageDismissId",
  "tourInfoId", "parentId",
]);

function withoutParentReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutParentReferences);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonRecord).map(([key, item]) =>
    [key, PARENT_REFERENCE_FIELDS.has(key) ? null : withoutParentReferences(item)]));
}

/** 母产品最新行程：未提交草稿优先，其次正式/预览版本。 */
function parentTourInfoId(relation: JsonRecord): string | undefined {
  const id = linkedVersionId(relation, "draftTourInfoId") ?? linkedVersionId(relation, "tourInfoId")
    ?? linkedVersionId(relation, "previewTourInfoId");
  return id === undefined ? undefined : String(id);
}

export async function readParentItineraryForChild(
  page: TrafficLinePage, parentProductId: string, childProductId: string,
): Promise<JsonRecord[] | undefined> {
  const childTourInfoId = currentTrafficLineTourInfoId(await fetchTourInfoId(page, childProductId));
  if (!childTourInfoId) return undefined;
  const parentId = parentTourInfoId((await fetchTourInfoId(page, parentProductId)).tourInfo);
  if (!parentId) throw new Error("母产品缺少可读取的当前行程版本，无法同步子产品行程天数。");
  const [parent, child] = await Promise.all([
    fetchTourDailyDetail(page, parentId), fetchTourDailyDetail(page, childTourInfoId),
  ]);
  const parentDays = list(parent.tourInfo?.tourDailyDescriptions);
  if (!parentDays.length) throw new Error("母产品当前行程没有每日内容，无法同步子产品行程天数。");
  return parentDays.length === list(child.tourInfo?.tourDailyDescriptions).length ? undefined : parentDays;
}

export function rebaseOnParentDescriptions(childTourInfo: JsonRecord, parentDescriptions: readonly JsonRecord[]): JsonRecord {
  const descriptions = withoutParentReferences(structuredClone(parentDescriptions)) as JsonRecord[];
  descriptions.forEach((day, index) => { day.orderDay = index + 1; });
  return { ...structuredClone(childTourInfo), days: descriptions.length, tourDailyDescriptions: descriptions };
}
