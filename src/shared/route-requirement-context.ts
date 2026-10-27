import { parseProductBriefMessage } from './product-brief-message.js';

type Json = Record<string, any>;
export const ROUTE_DAY_MARKER = /(?:第\s*[0-9一二三四五六七八九十]+\s*天|\bD(?:ay)?\s*\d+|(?:^|\n)\s*\d+\s*[-、:：.])/iu;

/** Derived from real user messages on every read; never accepted from an AI patch. */
export function withRouteRequirements(product: Json, messages: Array<{ role: string; content: string }>): Json {
  const requirements = messages.filter(message => message.role === 'user' && !parseProductBriefMessage(message.content)
    && (ROUTE_DAY_MARKER.test(message.content)
      || /(?:改成|改为|调整|替换|删除|新增|取消).*(?:行程|路线|景点|城市|地点)|(?:行程|路线|景点|城市|地点).*(?:改成|改为|调整|替换|删除|新增|取消)/u.test(message.content)))
    .map(message => message.content);
  const diagnostics = { ...product.diagnostics };
  delete diagnostics.routeRequirementMessages;
  if (requirements.length) diagnostics.routeRequirementMessages = requirements;
  return { ...product, ...(Object.keys(diagnostics).length ? { diagnostics } : {}) };
}
