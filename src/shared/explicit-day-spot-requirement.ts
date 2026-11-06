import { withoutScenicSuffix } from './poi-original-route-identity.js';

/** 「第四天要有九寨沟的景区」：要求当天必须有某个景点的动词。 */
export const REQUIRE_DAY_SPOT_VERB = /(?:要有|需要|必须|一定要|加上|补上|录入|录进)/u;
/** 带否定或删除语义的句子不是「必须有」。 */
export const REJECT_DAY_SPOT_VERB = /(?:不要|不需要|不用|无需|别|删除|删掉|去掉|移除|取消|剔除)/u;

const CHINESE_DAYS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

export function mentionsItineraryDay(content: string, day: number): boolean {
  const chinese = CHINESE_DAYS[day] ?? '';
  return new RegExp(`(?:第${day}(?:天|日)|[dD](?:ay)?\\s*${day}(?![0-9])|第${chinese}天)`, 'u').test(content);
}

/**
 * 运营消息指明日次、点名该地点并要求「要有 / 必须 / 加上」景区或景点。
 * 这类明确景点要求优先于平台行政区同名判定（九寨沟县 ↔ 九寨沟风景区）。
 */
export function isExplicitlyRequiredDaySpot(messages: ReadonlyArray<{ role: string; content: string }>, day: number, name: string): boolean {
  const bare = withoutScenicSuffix(name);
  if (bare.length < 2) return false;
  return messages.some(message => {
    if (message.role !== 'user') return false;
    const content = message.content.replace(/\s+/gu, '');
    return mentionsItineraryDay(content, day) && content.includes(bare)
      && /(?:景区|景点|POI)/iu.test(content)
      && REQUIRE_DAY_SPOT_VERB.test(content) && !REJECT_DAY_SPOT_VERB.test(content);
  });
}
