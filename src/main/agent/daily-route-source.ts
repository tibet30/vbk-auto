import { daySections } from "../planning/day-sections.js";

export interface DailyRouteSource {
  day: number;
  /** 已去掉天头、配置尾巴与控制语句的当日路线原文。 */
  text: string;
}

/**
 * 用户原文 → 逐日路线文本。AI 结构化与正则兜底共用同一份切段结果，
 * 保证「送给 AI 的文本」与「校验 AI 输出所依据的文本」完全一致。
 */
export function dailyRouteSources(textValue: string): DailyRouteSource[] {
  const routeText = textValue.replace(/\\[nr]/gu, "\n").replace(/(?:^|[\n\r])\s*(?:住宿与商业配置|住宿配置|商业配置|录入配置|(?:已确认的?)?住宿(?:要求|安排)|已确认的?业务要求)[:：][\s\S]*$/u, "");
  // 逐日切分收敛在 day-sections：段首天头与段尾下一行的【】都不进正文。
  return daySections(routeText).map((section) => ({
    day: section.day,
    text: cleanDayConstraintText(trimPlanningControlTail(section.content)),
  }));
}

/** 同一天出现多次时合并成一段，供 AI 一次性理解。 */
export function mergedDailyRouteSources(textValue: string): DailyRouteSource[] {
  const byDay = new Map<number, string[]>();
  for (const source of dailyRouteSources(textValue)) {
    if (!source.text || /^(?:不要|不安排|别)/.test(source.text)) continue;
    byDay.set(source.day, [...(byDay.get(source.day) ?? []), source.text]);
  }
  return [...byDay.entries()].sort((left, right) => left[0] - right[0])
    .map(([day, parts]) => ({ day, text: parts.join("\n") }));
}

function cleanDayConstraintText(value: string): string {
  return value
    .replace(/\*\*/g, " ")
    .replace(/(?:^|[\n\r])\s*[0-9一二三四五六七八九十]+\s*月\s*[0-9一二三四五六七八九十]+\s*号\s*$/u, " ")
    .replace(/^[:：、，,\s]+/, "")
    .trim();
}

/**
 * A product brief can append execution preferences after the last daily route.
 * They are not itinerary constraints, even when the last route is introduced
 * by a D1/D2 marker. Keeping them here would turn "AI 自我修复" into a POI.
 */
function trimPlanningControlTail(value: string): string {
  return value
    .replace(/[，,。；;\n]\s*(?:景点顺序(?:保持|保留)|(?:保持|保留)(?:此|原|上述)?(?:顺序|行程顺序|景点顺序))[\s\S]*$/u, "")
    .replace(
    /(?:[\n。；;]\s*)+(?:沿用(?:最近)?产品要求[:：]|重新生成全部方案|端到端.*(?:测试|验证|复验)|本次已授权|重新创建新产品|修复共享问题|资料准备|期望在资料准备|如需处理|无需(?:再)?询问用户|不需要(?:再)?询问用户|请读取刚创建的产品|任何\s*VBK\s*写入)[\s\S]*$/u,
    "",
    )
    .replace(
      /(?:[\n。；;]\s*)(?=(?:接送团属于|自由活动用|这些不配置(?:POI)?|城市(?:固定|为)|酒店[0-9一二三四五六七八九十]+钻|成人[0-9一二三四五六七八九十]|儿童[0-9一二三四五六七八九十]|[0-9一二三四五六七八九十]+人成团|每班库存|出发(?:日期|时间)(?:为|是)?|出发(?=[0-9一二三四五六七八九十]{1,4}(?:年|[-/.]))|保持(?:跟团游|私家团)|只保存|不启用|不提交审核))[\s\S]*$/u,
      "",
    );
}
