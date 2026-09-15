/**
 * MiniMax JSON 残片修复：单引号、尾逗号、未加引号 key、补齐括号。
 */
export function parseRecoveredJson(raw: string): unknown | undefined {
  const withoutTrailingComma = trimTrailingComma(raw);
  const candidates = [
    raw,
    withoutTrailingComma,
    repairSingleQuotedJson(raw),
    repairSingleQuotedJson(withoutTrailingComma),
    repairSingleQuotedJson(completeJsonTail(raw)),
    repairSingleQuotedJson(completeJsonTail(withoutTrailingComma)),
    completeJsonTail(raw),
    completeJsonTail(withoutTrailingComma),
    quoteUnquotedKeys(repairSingleQuotedJson(raw)),
    quoteUnquotedKeys(repairSingleQuotedJson(withoutTrailingComma)),
    quoteUnquotedKeys(repairSingleQuotedJson(completeJsonTail(raw))),
    quoteUnquotedKeys(repairSingleQuotedJson(completeJsonTail(withoutTrailingComma))),
    quoteUnquotedKeys(completeJsonTail(raw)),
    quoteUnquotedKeys(completeJsonTail(withoutTrailingComma)),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    try {
      return JSON.parse(value);
    } catch {}
  }
  return undefined;
}

// 给未加引号的 key 加双引号（如 {key:value} -> {"key":"value"}）
/**
 * 用正则把 `{key:value}` / `,key:value` 这种未加引号的 key 改写成 `{"key":"value"}`，
 * 不影响已经带引号的 key，是修复单引号 JSON 的兜底步骤之一。
 */
export function quoteUnquotedKeys(raw: string): string {
  return raw.replace(/([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
}

/** 从 raw 的 start 位置按括号配对截取一个完整 JSON 对象片段。 */
export function extractJsonCandidate(raw: string, start: number): string {
  const fragment = raw.slice(start);
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < fragment.length; i += 1) {
    const ch = fragment[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0) return fragment.slice(0, i + 1);
      }
      continue;
    }
  }
  return fragment;
}

/**
 * 把单引号 JSON（如 {'reply': 'hi'}）的字符串部分统一改写成双引号，并把单引号字符串内的
 * 双引号转义，避免被外层双引号包裹冲突；不做语法修复，仅做引号转换。
 */
export function repairSingleQuotedJson(raw: string): string {
  let inString: "\"" | "'" | null = null;
  let escaped = false;
  let output = "";

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inString === null) {
      if (ch === "\"" || ch === "'") {
        inString = ch;
        output += "\"";
      } else {
        output += ch;
      }
      continue;
    }

    if (escaped) {
      if (inString === "'" && (ch === "\n" || ch === "\r" || ch === "\t" || ch === "\\")) {
        output += `\\${ch}`;
      } else if (inString === "'" && ch === "\"") {
        output += "\\\"";
      } else {
        output += ch;
      }
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      output += "\\";
      continue;
    }

    if (ch === inString) {
      output += "\"";
      inString = null;
      continue;
    }
    output += ch;
  }

  if (inString !== null) output += "\"";
  return output;
}

/**
 * 给截断的 JSON 自动补齐缺失的尾括号 / 尾引号（按配对栈推算），让 JSON.parse 不至于因为
 * 末尾缺失 `}` `]` 而抛错；不能识别的错位括号会原样返回 raw。
 */
export function completeJsonTail(raw: string): string {
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (const ch of raw) {
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") { inString = true; continue; }
    if (ch === "{") { stack.push("}"); continue; }
    if (ch === "[") { stack.push("]"); continue; }
    if (ch === "}") {
      if (!stack.length || stack[stack.length - 1] !== "}") return raw;
      stack.pop();
      continue;
    }
    if (ch === "]") {
      if (!stack.length || stack[stack.length - 1] !== "]") return raw;
      stack.pop();
    }
  }
  if (inString) {
    const fixedString = raw.replace(/\\+$/, "");
    return `${fixedString}"${stack.reverse().join("")}`;
  }
  if (escaped) return `${raw}"${stack.reverse().join("")}`;
  if (!stack.length) return raw;
  return raw + stack.reverse().join("");
}

/**
 * 删除 JSON 中 `[...,]` / `{...,}` 这类拖尾逗号；属于最常见的修复步骤之一。
 */
export function trimTrailingComma(raw: string): string {
  return raw.replace(/,\s*(?=[}\]])/g, "");
}
