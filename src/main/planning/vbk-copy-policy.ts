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
    alternatives: ["开班", "首次开班"],
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
    const badCase = VBK_COPY_BAD_CASES.find(({ term }) => value.includes(term));
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
