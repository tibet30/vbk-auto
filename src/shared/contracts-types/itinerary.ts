/**
 * 行程 spot / day / activity kind 形状：
 *   - ItineraryActivityKind：活动类型白名单（来自 itinerary-activity-kind.ts）；
 *   - ItinerarySpot：单个有序条目的"POI / 图片 / 关系 / 时段"四要素；
 *   - ItineraryDay：单日所有 spot + 标题 + 住宿 + 餐食 / 描述。
 *
 * 行程持久化 / 模板化时（runtime / itinerary-content / cover）都依赖这里的形状；
 * 切勿在这里引 runtime / db 等"读取"侧依赖。
 */

import type { ItineraryActivityKind as ActivityKind } from "../itinerary-activity-kind.js";
import type { CtripLibraryCoverAlternate } from "../contracts-ctrip-cover.js";

export type ItineraryActivityKind = ActivityKind;

export interface ItinerarySpot {
  name: string;
  poiName: string | null;
  poiId: number | null;
  province?: string | null;
  city?: string | null;
  district?: string | null;
  /** 同一时段景点关系：and=全部参观；or=同组多选一。缺省按 and 处理。 */
  relation?: "and" | "or";
  timeOfDay?: "morning" | "afternoon";
  /**
   * 携程图库抓图时，封面用满（最多 10 张）后剩余图按 POI 归属写入对应景点。
   * 匹配规则：candidate.poiId === spot.poiId 优先；否则 candidate.poiName 与
   * spot.name / spot.poiName 互含。
   * 每个 spot 最多保留 10 张（与封面口径一致），按搜索返回顺序保留前 N 张；
   * 已经写进 presentation.cover 的 imageId 不会重复落到这里。
   */
  images?: CtripLibraryCoverAlternate[];
}

export interface ItineraryDay {
  day: number;
  title: string;
  spots?: ItinerarySpot[];
  description: string;
  hotel: string;
  meals: string;
}