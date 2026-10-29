/**
 * 只读读取 VBK 产品当前行程天数（未提交草稿优先，其次正式/预览版本）。
 * 用于存量产品缺少「已录入天数」记录时的兜底：只调用查询接口，不写入。
 */

import { fetchTourDailyDetail, fetchTourInfoId } from "./steps.js";
import { linkedVersionId } from "./versioning.js";
import type { ApiPage } from "./transport.js";

export async function readRemoteItineraryDays(page: ApiPage, productId: string): Promise<number | undefined> {
  const { tourInfo } = await fetchTourInfoId(page, productId);
  const id = linkedVersionId(tourInfo, "draftTourInfoId") ?? linkedVersionId(tourInfo, "tourInfoId")
    ?? linkedVersionId(tourInfo, "previewTourInfoId");
  if (id === undefined) return undefined;
  const { descriptions } = await fetchTourDailyDetail(page, id);
  return descriptions.length > 0 ? descriptions.length : undefined;
}
