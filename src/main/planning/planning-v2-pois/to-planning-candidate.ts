/**
 * PoiSuggestDetailResult → PlanningPoiCandidate 转换：
 *   - toPlanningCandidate：把 suggestPoi 的 best / candidates 收敛为规划阶段的 POI 候选；
 *     拒绝未命中真实 POI / 入口停车场等设施 / 地域不匹配，返回 resolved 候选。
 *
 * 地域匹配规则：
 *   - provinceMatches / cityMatches 只要其一为真即视为同地（行政区划嵌套时不重复核验）；
 *   - 真实结构化字段（district + parents）优先；textFields 仅作兜底。
 */

import type { PoiSuggestDetailResult } from "../../../shared/contracts-types.js";
import type { PlanningPoiCandidate } from "../../../shared/contracts-planning.js";
import { FACILITY_RE } from "./aliases.js";
import { locationMatches, readLocationMetadata } from "./location-metadata.js";

export function toPlanningCandidate(
  requestedName: string,
  detail: PoiSuggestDetailResult,
  province: string,
  city: string,
): PlanningPoiCandidate {
  const best = detail.best;
  if (!best || !Number.isInteger(best.poiId) || best.poiId <= 0 || !best.poiName.trim()) {
    return { requestedName, status: "rejected", reason: "未命中可确认的真实 POI" };
  }
  if (FACILITY_RE.test(best.poiName)) {
    return { requestedName, status: "rejected", reason: "命中的是入口、停车场或服务设施" };
  }
  const raw = detail.candidates.find((candidate) => candidate.poiId === best.poiId);
  const fromTextFields = readLocationMetadata(raw?.textFields ?? []);
  // 优先用 suggestPoi 契约解析出的结构化字段（district + parents），textFields 仅兜底。
  const metadata = {
    province: raw?.province || fromTextFields.province,
    city: raw?.city || fromTextFields.city,
    district: raw?.district || fromTextFields.district,
    address: raw?.address || fromTextFields.address,
  };
  const hasKnownLocation = Boolean(metadata.province || metadata.city);
  const provinceMatches = locationMatches(metadata.province, province);
  const cityMatches = locationMatches(metadata.city, city);
  if (!hasKnownLocation || (!provinceMatches && !cityMatches)) {
    const actual = [metadata.province, metadata.city].filter(Boolean).join("/") || "地域未知";
    return { requestedName, status: "rejected", reason: `POI 地域不匹配（${actual}）` };
  }
  return {
    requestedName,
    status: "resolved",
    poiId: best.poiId,
    poiName: best.poiName.trim(),
    province: metadata.province || province,
    city: metadata.city || city,
    district: metadata.district,
    address: metadata.address,
  };
}