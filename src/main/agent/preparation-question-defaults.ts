import type { AgentQuestion } from "../../shared/contracts.js";

function optionId(question: AgentQuestion, pattern: RegExp): string | undefined {
  return question.options?.find((option) => pattern.test(`${option.id} ${option.label}`))?.id;
}

function asAnswer(question: AgentQuestion, value: string | string[]): string | string[] {
  return question.kind === "multiple" ? (Array.isArray(value) ? value : [value]) : (Array.isArray(value) ? value[0] : value);
}

function firstOrdinaryOption(question: AgentQuestion): string | undefined {
  return question.options?.find((option) => !/其他|手动|人工|暂停|保持当前|保留当前/.test(option.label))?.id;
}

/**
 * Preparation is an autonomous local workflow. These choices are mechanical
 * consequences of the saved brief or safe recovery policy, not product input.
 * Keep genuine, product-changing ambiguity visible to the operator.
 */
export function automaticPreparationAnswer(question: AgentQuestion): string | string[] | undefined {
  const text = `${question.id} ${question.label}`.replace(/\s+/g, "");

  if (/出发地|pickupCity/i.test(text)) {
    const local = firstOrdinaryOption(question);
    if (local) return asAnswer(question, local);
  }
  if (/火车站.*(?:端点|接站|送站)|(?:接站|送站).*火车站/.test(text)) {
    const station = optionId(question, /默认/) ?? firstOrdinaryOption(question);
    if (station) return asAnswer(question, station);
  }
  if (/二选一|多选一/.test(text)) {
    const keepAlternatives = optionId(question, /同时保留|保留.*二选一|relation\s*=\s*or/i);
    if (keepAlternatives) return asAnswer(question, keepAlternatives);
  }
  if (/未匹配|没有可用候选/.test(text) && /POI|景点|遗产中心|博物馆/i.test(text)) {
    const preserve = optionId(question, /保持原名|保留原名|原位/);
    if (preserve) return asAnswer(question, preserve);
  }
  if (/POI/.test(text) && /(?:自动.*绑定|推荐|可用候选|如何结束|冲突)/.test(text)) {
    const accept = optionId(question, /接受.*(?:绑定|推荐)|keep_bind|accept_bind/i);
    if (accept) return asAnswer(question, accept);
  }
  if (/(?:入住|接站|送站|火车站)/.test(text) && /(?:景点|POI|处理|研究任务|闭环)/i.test(text)) {
    const removeTravelNode = optionId(question, /移出景点|删除.*景点|不作为景点|住宿节点.*关闭|关闭.*研究任务|无需POI|skip|close/i);
    if (removeTravelNode) return asAnswer(question, removeTravelNode);
  }
  if (/非景点|混入.*文本|官方名|写错|错写|错字|规范/.test(text) && /景点|POI|行程/.test(text)) {
    if (/二选一|多选一|原景点|明确景点|锁定景点/.test(text)) return undefined;
    const normalise = optionId(question, /规范|官方名|rename|standard/i);
    if (normalise) return asAnswer(question, normalise);
    // A model label is not evidence that an explicitly named attraction is
    // disposable. Keep deletion visible to an operator unless it is a known
    // transfer/check-in node handled by the dedicated branch above.
    return undefined;
  }
  if (/研究任务|research/i.test(text) && /闭环|处理|推进|resolve/i.test(text)) {
    const close = optionId(question, /关闭|无需POI|住宿节点|推进|skip|close/i);
    if (close) return asAnswer(question, close);
  }
  if (/用车.*(?:档位|资源组)|(?:档位|资源组).*用车/.test(text)) {
    const economy = optionId(question, /经济|economy/i);
    if (economy) return asAnswer(question, economy);
  }
  if (/阶段.*(?:推进|门禁)|(?:推进|门禁).*阶段|解锁.*(?:展示|商业)|next_stage/i.test(text)) {
    const proceed = optionId(question, /尽力写入|继续|自动|推进|强制|proceed|best_effort/i);
    if (proceed) return asAnswer(question, proceed);
  }
  if (/酒店|hotel/i.test(text) && /(?:锚点|候选|重跑|重新匹配|finalValidation)/i.test(text)) {
    const retry = optionId(question, /退回|回退|重跑|重新匹配|rollback|retry/i);
    if (retry) return asAnswer(question, retry);
  }
  if (/修复|恢复|重试|recovery/i.test(text)) {
    const retry = optionId(question, /重试|retry/i);
    if (retry) return asAnswer(question, retry);
  }
  if (/封面|cover/i.test(text)) {
    if (/规格|尺寸|像素|高清|原图|重新上传|重传|resize|quality/i.test(text)) return undefined;
    // An existing manual upload is a real user choice. Never infer consent to
    // replace it merely because the model listed Ctrip as the first option.
    if (question.options?.some((option) => /保留.*(?:手动|上传)|keep_manual/i.test(`${option.id} ${option.label}`))
      && question.options.some((option) => /切换.*图库|提供.*image\s*id|switch_to_ctrip|supply_ctrip/i.test(`${option.id} ${option.label}`))) {
      return undefined;
    }
    const cover = firstOrdinaryOption(question);
    if (cover) return asAnswer(question, cover);
  }
  if (/套餐名称|package_name/i.test(text)) {
    const standard = optionId(question, /标准|standard/i) ?? firstOrdinaryOption(question);
    if (standard) return asAnswer(question, standard);
  }
  if (/酒店/.test(text) && /候选|备选|选择|资源/.test(text) && question.options?.length) {
    const hotels = question.options.slice(0, 5).map((option) => option.id);
    if (hotels.length) return asAnswer(question, hotels);
  }
  if (/用车.*座位|座位数|vehicle_seats/i.test(text)) {
    const fiveSeat = optionId(question, /(?:5\s*座|五座|^5\s)/);
    if (fiveSeat) return asAnswer(question, fiveSeat);
    if (question.kind === "text") return "5座";
  }
  if (/(?:出发城市)?交通方式|往返交通|大交通/.test(text)) {
    if (question.kind === "multiple") {
      const flight = optionId(question, /(?:飞机.*往返|往返.*飞机|机票)/);
      const train = optionId(question, /(?:火车.*往返|往返.*火车|高铁.*往返|往返.*高铁|火车票|高铁票)/);
      const answers = [flight, train].filter((value): value is string => Boolean(value));
      if (answers.length >= 2) return answers;
    }
    const roundTrip = optionId(question, /(?:飞机.*火车|火车.*飞机|机票.*火车票|火车票.*机票)/);
    if (roundTrip) return roundTrip;
  }
  return undefined;
}

export function asksForCommercialPricing(question: AgentQuestion): boolean {
  const text = `${question.id} ${question.label}`.replace(/\s+/g, "");
  return /成人价|儿童价|起订人数|minimumtravelers|定价|报价|单房差|加床费|price_plan/i.test(text);
}

export function asksForPrematureApproval(question: AgentQuestion): boolean {
  const text = `${question.id} ${question.label}`.replace(/\s+/g, "");
  return /授权|审批|approval_scope|request_approval/i.test(text) && /VBK|录入|写入|approval/i.test(text);
}
