/**
 * traffic-line/itinerary.ts（current-id 子模块）：
 *   currentTrafficLineTourInfoId：交通子产品只认平台明确的当前 tourInfoId，
 *   旧 audit/draft/preview 均不得兜底；"0" 视为未激活，返回空串。
 */

import { text } from "../client.js";
import type { FetchTourInfoIdResult } from "../../itinerary-api/steps.js";

/** 交通子产品只认平台明确的当前 tourInfoId，旧 audit/draft/preview 均不得兜底。 */
export function currentTrafficLineTourInfoId(linked: FetchTourInfoIdResult): string {
  const current = text(linked.tourInfo.tourInfoId);
  return current === "0" ? "" : current;
}