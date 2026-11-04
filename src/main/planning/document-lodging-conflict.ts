/** 提取逐日住宿栏中的并列城市；只能表明原文有歧义，不是运营决定。 */
export function lodgingConflict(text: string): { day: string; choices: string; summary?: string } | undefined {
  const match = text.match(/第\s*([一二三四五六七八九十\d]+)\s*天[^\n]{0,120}?住宿\s*[:：]\s*([\p{Script=Han}]{2,8}\s*[/／或]\s*[\p{Script=Han}]{2,8})/u);
  if (!match) return undefined;
  const dayOne = /^(?:一|1)$/u.test(match[1]!);
  const row = dayOne ? text.match(/DAY\s*1\s+[^\n]+/iu)?.[0] : undefined;
  const summary = row?.match(/(?:^|\s)([\p{Script=Han}]{2,8})\s*$/u)?.[1];
  return { day: match[1]!, choices: match[2]!.replace(/\s+/gu, ''), ...(summary ? { summary } : {}) };
}

/** 运营在对话里明确回答的住宿城市；只接受文档候选，疑问、否定句不算确认。 */
export function lodgingAnswer(messages: Array<{ role: string; content: string }>, conflict: { choices: string }): string | undefined {
  const candidates = conflict.choices.split(/[/／或]/u).filter(Boolean);
  const clauses = messages.filter(message => message.role === 'user')
    .flatMap(message => message.content.split(/[。；;\n，,、]/u).map(part => part.trim()))
    .filter(part => part && !/[?？]|吗|是否|可能|也许|待确认|不确定/u.test(part));
  for (const part of clauses.reverse()) {
    if (/(?:不|没|非|别|勿)\s*(?:住|宿|入住)/u.test(part)) continue;
    const hit = candidates.find(city => new RegExp(`^(?:第[一二三四五六七八九十\\d]+天)?\\s*(?:确认|确定|改)?(?:住宿|入住|住|宿)\\s*(?:城市|地点|地)?\\s*(?:为|是|在|：|:)?\\s*${city}(?:市|酒店|当地酒店)?$`, 'u').test(part));
    if (hit) return hit;
  }
  return undefined;
}
