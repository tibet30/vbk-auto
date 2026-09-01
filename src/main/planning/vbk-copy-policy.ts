/**
 * VBK 文案 bad-case 目录。
 *
 * 每条线上实跑确认的文案限制只维护一次，并同时用于：
 *  - 规划 system prompt，约束 AI 首次生成；
 *  - 本地输出门禁，阻止违规文案落入 product JSON；
 *  - 重试错误反馈，让 AI 根据真实 bad case 自行改写。
 */
const OFFICIAL_POI_IDENTITY_PATH = /\.(?:poiName|requestedName)$/;
const FREE_COPY_PATH = /^(?!.*\.(?:poiName|requestedName)$)/;

export const VBK_COPY_BAD_CASES = [
  {
    term: "首发",
    reason: "VBK 操作说明会判定为非法关键词",
    alternatives: ["开班", "本期开班"],
    pattern: /首发/,
  },
  {
    term: "首次",
    reason: "VBK 产品图文实跑会判定为非法关键词",
    alternatives: ["初到", "初游", "刚开始接触"],
    pattern: /首次/,
  },
  {
    term: "首选",
    reason: "VBK 产品图文实跑会判定为非法关键词",
    alternatives: ["之选", "推荐选择"],
    pattern: /首选/,
  },
  {
    term: "主席",
    reason: "VBK 行程描述实跑会判定为非法关键词",
    alternatives: ["重要人物", "相关负责人", "历史人物"],
    pattern: /主席/,
  },
  {
    term: "毛泽东",
    reason: "VBK 产品图文接口实跑会判定为非法关键词",
    alternatives: ["历史人物", "青年主题雕塑", "近现代文化地标"],
    pattern: /毛泽东/,
    // VBK suggestPoi 返回的官方实体名必须原样保留，不能为绕过文案校验
    // 而破坏 POI 身份；自由描述、标题和卖点仍全部受本规则约束。
    pathPattern: FREE_COPY_PATH,
  },
  {
    term: "礼佛",
    reason: "VBK 产品图文实跑会判定为非法关键词",
    alternatives: ["参观南普陀寺", "游览寺院", "参观人文景观"],
    pattern: /礼佛/,
  },
  {
    term: "旅游意外险",
    reason: "产品权益未经核实，且 VBK 产品图文实跑会判定相关表述为非法关键词",
    alternatives: ["直接删除该表述，不提及保险权益"],
    pattern: /(?:(?:赠送|送|含|包含|附赠|建议(?:另行)?购买)\s*)?旅游意外险(?:一份)?/,
    replacement: "",
  },
  {
    term: "祈福",
    reason: "VBK 行程描述实跑会判定为非法关键词",
    alternatives: ["参观天坛", "游览祭坛建筑", "了解皇家祭祀文化"],
    pattern: /祈福/,
  },
  {
    term: "野长城",
    reason: "VBK 行程描述实跑会判定为非法关键词",
    alternatives: ["郊区长城", "长城郊游", "长城景观"],
    pattern: /野长城/,
  },
  {
    term: "之巅",
    reason: "VBK 产品图文接口实跑会判定为非法关键词",
    alternatives: ["高处", "峰顶", "代表性景观"],
    pattern: /之巅/,
  },
  {
    term: "第一（宣传排名用语）",
    reason: "避免未经证明的排名或极限宣传；“第一天”等行程序号不受影响",
    alternatives: ["重点", "优先", "前列"],
    pattern: /第一(?!天|日|晚|站|餐|段)/,
  },
  {
    term: "最（极限表达）",
    reason: "VBK 会拦截“最”字开头的绝对化表达，避免最佳、最高、最优等宣传用语",
    alternatives: ["更", "较为", "重点"],
    pattern: /最(?!后|终)/,
  },
  {
    term: "其他绝对化用语",
    reason: "避免唯一、顶级、绝对、百分百、全网、史上、零风险等无法核实的承诺",
    alternatives: ["特色", "优质", "尽量"],
    pattern: /唯一|顶级|绝对|百分之百|100%|No\.?\s*1|全网|史上|遥遥领先|零风险|零差评|永久有效|保证满意/i,
  },
  {
    term: "导游否定描述",
    reason: "产品图文的推荐语、推荐理由或产品特色写“不配随队导游”“不含导游”等，可能与导游条款“含导游”不一致",
    alternatives: ["当地服务衔接清晰", "行程安排清晰", "用车接送安排明确"],
    pattern: /不配随队导游|不含(?:随队)?导游|不提供(?:随队)?导游|无(?:随队)?导游|不安排(?:随队)?导游/,
    pathPattern: /(^|\.)(?:presentation\.)?(?:recommendation|features|recommendations(?:\[\d+\]|\.\d+)\.text)$/,
  },
] as const;

/**
 * POI 的这两个字段是远端实体身份，不是面向用户的自由文案。
 * 只有这两个字段允许保留官方返回的敏感词；其余路径一律按可见文案处理。
 */
export function isVbkOfficialPoiIdentityPath(path: string): boolean {
  return OFFICIAL_POI_IDENTITY_PATH.test(path);
}

export function buildVbkCopyPolicyPrompt(): string {
  const rules = VBK_COPY_BAD_CASES.map(
    (badCase) => "replacement" in badCase && badCase.replacement === ""
      ? `- 禁止词「${badCase.term}」：${badCase.reason}；直接删除相关表述，不要改写成其他保险承诺`
      : `- 禁止词「${badCase.term}」：${badCase.reason}；请按语境改写为「${badCase.alternatives.join("」或「")}」`,
  ).join("\n");
  return [
    "VBK 文案黑名单（适用于所有 AI 生成的可见文案，禁止原样输出）：",
    rules,
    "例外仅限官方 POI 身份字段 poiName 和 requestedName：它们必须原样保留远端官方名称，不得改写；不要把敏感词放进 title、description、features、recommendation、recommendations 或其他自由文案字段来规避限制。",
  ].join("\n");
}

/**
 * 用户原始想法不是平台宣传文案，数据库中应保持原样；但送入 AI 前移除
 * 未经核实的极限/排名承诺，避免模型把这些词继续扩散到产品可见文案。
 */
export function sanitiseUserIdeaForAi(value: string): string {
  const absoluteCases = VBK_COPY_BAD_CASES.filter(({ term }) =>
    term === "第一（宣传排名用语）"
      || term === "最（极限表达）"
      || term === "其他绝对化用语");
  const withoutAbsolutePhrases = value.trim().replace(/最(?:佳|高|优|好|强|大|低|快|全|完整|专业|值得)/g, "");
  const sanitised = absoluteCases.reduce((text, badCase) => {
    const pattern = new RegExp(
      badCase.pattern.source,
      badCase.pattern.flags.includes("g") ? badCase.pattern.flags : `${badCase.pattern.flags}g`,
    );
    return text.replace(pattern, "");
  }, withoutAbsolutePhrases);
  return sanitised
    .replace(/[ \t]{2,}/g, " ")
    .replace(/([，、；。])\1+/g, "$1")
    .replace(/[，、；]\s*(?=的)/g, "")
    .replace(/^[，、；。\s]+|[，、；。\s]+$/g, "");
}

export function findVbkCopyBadCase(value: unknown, path = "value"):
  | { path: string; term: string; reason: string; alternatives: readonly string[] }
  | undefined {
  if (typeof value === "string") {
    const badCase = VBK_COPY_BAD_CASES.find((item) =>
      (!("pathPattern" in item) || item.pathPattern.test(path)) && item.pattern.test(value));
    return badCase ? { path, ...badCase } : undefined;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = findVbkCopyBadCase(value[index], `${path}[${index}]`);
      if (hit) return hit;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const hit = findVbkCopyBadCase(child, `${path}.${key}`);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** 返回产品内全部命中，便于一次性修复所有阻断文案。 */
export function findAllVbkCopyBadCases(value: unknown, path = "value"):
  Array<{ path: string; term: string; reason: string; alternatives: readonly string[] }> {
  const hits: Array<{ path: string; term: string; reason: string; alternatives: readonly string[] }> = [];
  if (typeof value === "string") {
    for (const badCase of VBK_COPY_BAD_CASES) {
      if ((!("pathPattern" in badCase) || badCase.pathPattern.test(path)) && badCase.pattern.test(value)) {
        hits.push({ path, ...badCase });
      }
    }
    return hits;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => hits.push(...findAllVbkCopyBadCases(child, `${path}[${index}]`)));
    return hits;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      hits.push(...findAllVbkCopyBadCases(child, `${path}.${key}`));
    }
  }
  return hits;
}

/**
 * 仅修复 AI 输出中的自由可见文案，作为规划阶段的确定性兜底。
 *
 * 本函数不把修复视为放宽门禁：官方 POI 身份字段保持原样，且调用方必须在
 * 修复后再次通过完整的 copy-policy 与 schema 校验才可写入产品。
 */
export function repairVbkCopyPolicyValue(value: unknown, path = "value"): unknown {
  if (typeof value === "string") {
    if (isVbkOfficialPoiIdentityPath(path)) return value;

    // "首次到访" is the common phrase that triggered the live failure.  Its
    // preferred alternative replaces the whole phrase, rather than producing
    // the awkward "初到到访" from a character-only substitution below.
    const phraseRepaired = value.replace(/首次到访/g, "初到");
    const removedCopyFragment = VBK_COPY_BAD_CASES.some(
      (badCase) => "replacement" in badCase && badCase.replacement === "" && badCase.pattern.test(value),
    );
    const repairedValue = VBK_COPY_BAD_CASES.reduce((repaired, badCase) => {
      if ("pathPattern" in badCase && !badCase.pathPattern.test(path)) return repaired;
      const preferredAlternative = "replacement" in badCase
        ? badCase.replacement
        : badCase.alternatives[0];
      const pattern = new RegExp(
        badCase.pattern.source,
        badCase.pattern.flags.includes("g") ? badCase.pattern.flags : `${badCase.pattern.flags}g`,
      );
      return repaired.replace(pattern, preferredAlternative);
    }, phraseRepaired);
    if (!removedCopyFragment) return repairedValue;
    return repairedValue
      .replace(/([，、；。])(?:\s*[，、；。])+/g, "$1")
      .replace(/^[，、；。\s]+|[，、；\s]+$/g, "");
  }
  if (Array.isArray(value)) {
    return value.map((child, index) => repairVbkCopyPolicyValue(child, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      repairVbkCopyPolicyValue(child, `${path}.${key}`),
    ]));
  }
  return value;
}
