/**
 * VBK 文案 bad-case 目录。
 *
 * 每条线上实跑确认的文案限制只维护一次，并同时用于：
 *  - 规划 system prompt，约束 AI 首次生成；
 *  - 本地输出门禁，阻止违规文案落入 product JSON；
 *  - 重试错误反馈，让 AI 根据真实 bad case 自行改写。
 */
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
] as const;

export function buildVbkCopyPolicyPrompt(): string {
  const rules = VBK_COPY_BAD_CASES.map(
    ({ term, reason, alternatives }) =>
      `- 禁止词「${term}」：${reason}；请按语境改写为「${alternatives.join("」或「")}」`,
  ).join("\n");
  return `VBK 文案黑名单（适用于所有 AI 生成的可见文案，禁止原样输出）：\n${rules}`;
}

export function findVbkCopyBadCase(value: unknown, path = "value"):
  | { path: string; term: string; reason: string; alternatives: readonly string[] }
  | undefined {
  if (typeof value === "string") {
    const badCase = VBK_COPY_BAD_CASES.find(({ pattern }) => pattern.test(value));
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
