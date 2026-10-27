/**
 * POI 名称的稳定比较键。
 *
 * 同一个景点在「用户原文 / 行程 spot.name / VBK 官方 poiName」之间经常只差
 * 括号注释或尾随动作词，例如「广济桥（不上桥）」与「广济桥」、「非遗中心参观」
 * 与「非遗中心」、「2 号公路」与「2号公路」。
 *
 * 删除凭证（manualReview.itinerarySpotRemovals）、POI 核查任务结案与编号路线
 * 校验必须共用同一把尺子，否则运营已经在「每日行程」删掉的 POI 会继续被
 * 要求处理。这里只做「去注释 + 去空白 + 去尾随动作词」的等价判定，不做
 * 子串包含，避免把同城不同景点（「汉中」与「汉中市古汉台博物馆」）混为一谈。
 */

import { isKnownPoiNameAlias } from "./poi-name-aliases.js";

const BRACKETED = /[（(【[][^）)】\]]*[）)】\]]/gu;
const SPACES = /[\s\u3000]+/gu;
const TRAILING_ACTION = /(?:参观|游览|打卡|体验)$/u;

export function poiNameKey(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(BRACKETED, "")
    .replace(SPACES, "")
    .replace(TRAILING_ACTION, "")
    .trim();
}

/** 两个名称是否指向同一个 POI 条目（按 poiNameKey 等价）。 */
export function samePoiName(left: unknown, right: unknown): boolean {
  const a = poiNameKey(left);
  return Boolean(a) && (a === poiNameKey(right)
    || (typeof left === "string" && typeof right === "string" && isKnownPoiNameAlias(left, right)));
}
