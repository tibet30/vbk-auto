import { lodgingConflict } from './document-lodging-conflict.js';

/** 自由生成的陈述无法通过字符串匹配证明其含义；只放行固定的中性提问。 */
export function guardDocumentDialogueReply(reply: string, source: string, serviceQuotes: unknown = [], question = '', ready = false, confirmedLodging?: string): string {
  const safeQuestions = new Set(['请确认住宿城市', '请确认住宿城市。', '请确认路线和服务', '请确认路线和服务。', '请确认餐食安排。', '请确认门票和补费。', '请确认交通和接送服务。', '请确认保险服务。', '请确认赠送及儿童服务。']);
  // 必填项已齐全时不再抛出模型挑的随机问句，直接指向下一步；路线与服务在创建后由方案待处理事项逐项确认。
  const intro = ready ? '创建信息已齐全：请核对下方信息，勾选“我已核对以上创建信息”后点击“确认并创建”；路线与服务会在创建后逐项确认。'
    : safeQuestions.has(reply.trim()) ? reply.trim() : '已根据文档整理创建信息，请核对下方内容；需要调整的地方直接告诉我。';
  const serviceStart = source.search(/服务标准\s*[:：]?\s*\n/u);
  const serviceSection = serviceStart < 0 ? '' : source.slice(serviceStart).split(/(?:重要说明|温馨提示|【免责申明】)/u)[0]!;
  const lines = serviceSection.split(/\n/u).map(line => line.replace(/\s+/gu, ' ').trim()).filter(Boolean);
  const requested = Array.isArray(serviceQuotes) ? serviceQuotes.filter((item): item is string => typeof item === 'string') : [];
  const topics = [[/门票|票价|补费/u, /门票|票价|补费/u], [/用车|交通|接送/u, /用车|旅游车|交通|接送/u],
    [/住宿|酒店/u, /住宿|酒店/u], [/餐食|用餐|午餐|早餐/u, /用餐|餐食|早.*餐/u], [/保险/u, /保险|意外险/u]];
  const filters = topics.filter(([query]) => query!.test(question)).map(([, match]) => match!);
  const selected = lines.filter(line => line.length <= 180 && (requested.includes(line) || filters.some(filter => filter.test(line)))).slice(0, 5);
  const serviceNote = selected.length ? `\n文档服务原文摘录：\n${selected.join('\n')}` : '';
  const conflict = lodgingConflict(source);
  const conflictNote = conflict && confirmedLodging ? `\n已选择第${conflict.day}天住宿城市：${confirmedLodging}（文档原写${conflict.choices}）。`
    : conflict ? `\n第${conflict.day}天住宿城市待确认：${conflict.summary ? `行程简表写${conflict.summary}，` : ''}详细行程写${conflict.choices}，请在创建后核对该天的住宿安排。` : '';
  return `${intro}${serviceNote}${conflictNote}`;
}
