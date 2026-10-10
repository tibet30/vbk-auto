/** Explicit user permission persists; a later refusal revokes it. */
export function hotelDowngradePermission(instruction: string): boolean | undefined {
  let decision: boolean | undefined;
  for (const sentence of instruction.replace(/\{[^{}\n]+\}/g, "").split(/[。；;\n，,]/u)) {
    const flexible = /(?:搜到|找到|有)(?:哪个|什么).*用(?:哪个|什么)|5\s*钻.*(?:无钻|不论钻)|(?:无钻|不限钻|不限制.*钻)/u.test(sentence);
    if (flexible && !/hotel\d|day\d|第\s*\d+\s*天|D\d/iu.test(sentence)) {
      decision = !/不允许|不得|禁止|不要|不同意|拒绝|不能/u.test(sentence);
      continue;
    }
    if (!/降档|降钻|降低钻级|降低.*(?:评级|等级|档次)|降级/u.test(sentence)) continue;
    // A per-day choice does not authorize downgrading other nights.
    if (/hotel\d|day\d|第\s*\d+\s*天|D\d|[1-5一二三四五]\s*(?:圆)?钻/iu.test(sentence)) continue;
    if (/不允许|不得|禁止|不要|不同意|拒绝|不能/u.test(sentence)) decision = false;
    else if (/可以|允许|同意|接受/u.test(sentence)) decision = true;
  }
  return decision;
}

/** Default planning fallback; explicit daily answers take precedence over global policy. */
export function hotelFallbackAllowed(instruction: string, day: number, persisted?: boolean): boolean {
  const global = hotelDowngradePermission(instruction) ?? persisted ?? true;
  const entries = [...instruction.matchAll(/\{[^{}\n]+\}/g)].flatMap(match => {
    try { return Object.entries(JSON.parse(match[0]) as Record<string, unknown>); } catch { return []; }
  });
  const entry = entries.reverse().find(([key]) => key === `hotel${day}`);
  const value = Array.isArray(entry?.[1]) && entry[1].length === 1 ? entry[1][0] : entry?.[1];
  if (typeof value !== "string") return global;
  if (/不允许|不得|禁止|不要|不同意|拒绝|不能|保留.*钻|保持.*钻/u.test(value)) return false;
  return hotelDowngradePermission(value) ?? global;
}
