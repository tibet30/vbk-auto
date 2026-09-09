/** 产品特色的 AI 输出约束与安全 HTML 归一化。 */

const ALLOWED_TAG = /^<\s*(\/?)\s*(p|strong|em|ul|ol|li|br)\b[^>]*>$/i;
const RICH_TAG = /<\/?(?:p|strong|em|ul|ol|li|br)\b/i;

export const PRODUCT_FEATURES_RICH_TEXT_GUIDE = `features 必须是 JSON 字符串值，绝对禁止输出对象、数组、AST 或 null；字符串内容才是 VBK 富文本 HTML 片段：
- 写 3～5 个与本产品事实一致的亮点，每个亮点使用 <p><strong>短标题：</strong>具体说明</p>；需要列举时可用 <ul><li>...</li></ul>。
- 字符串内容必须直接以富文本标签开始和结束，不得在 HTML 片段首尾额外添加英文或中文双引号；JSON 自身的语法引号不属于内容。
- 只允许 p、strong、em、ul、ol、li、br 标签；禁止 Markdown、外层 html/body、style/class/id 等属性，以及 a、img、table、script、iframe。
- 产品特色不得描述“不配随队导游”“不含导游”“无导游”等导游否定信息，避免与导游条款显示“含导游”产生不一致。
- 标题简短、内容具体，不虚构服务、资源或承诺；同时遵守 VBK 文案黑名单。`;

function escapeText(value: string): string {
  return value
    .replace(/&(?!(?:amp|lt|gt|quot|#39|#\d+);)/gi, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripWrappingDoubleQuotes(value: string): string {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["“", "”"],
    ["&quot;", "&quot;"],
  ];
  for (const [opening, closing] of pairs) {
    if (value.startsWith(opening) && value.endsWith(closing)) {
      return value.slice(opening.length, -closing.length).trim();
    }
  }
  return value;
}

/**
 * 把 AI/历史 features 转成可交给 UEditor 的安全 HTML：
 * - 纯文本按行包装成 p，保持旧产品兼容；
 * - HTML 只保留无属性的白名单标签；危险块连同内容移除。
 */
export function formatProductFeaturesHtml(value: unknown): string {
  if (typeof value !== "string") return "";
  const source = stripWrappingDoubleQuotes(value.trim());
  if (!source) return "";
  if (!RICH_TAG.test(source)) {
    return source.split(/\r?\n/).map((line) => `<p>${escapeText(line)}</p>`).join("");
  }
  const withoutDangerousBlocks = source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|svg)[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  return withoutDangerousBlocks.split(/(<[^>]*>)/g).map((token) => {
    if (!token.startsWith("<")) return escapeText(token);
    const match = token.match(ALLOWED_TAG);
    if (!match) return "";
    const closing = match[1] === "/";
    const tag = match[2]!.toLowerCase();
    if (tag === "br") return "<br>";
    return closing ? `</${tag}>` : `<${tag}>`;
  }).join("");
}

function textLeaf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function collectFeatureLines(value: unknown, into: string[] = []): string[] {
  if (value == null) return into;
  if (typeof value === "string") {
    const text = textLeaf(value);
    if (text) into.push(text);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFeatureLines(item, into);
    return into;
  }
  if (typeof value !== "object") return into;
  const record = value as Record<string, unknown>;
  // Common model mistake: `{ p: [{ strong: "标题：", $text: "说明" }] }`.
  const strong = textLeaf(record.strong ?? record.title ?? record.heading);
  const body = textLeaf(record.$text ?? record.text ?? record.content ?? record.description);
  if (strong || body) {
    into.push(strong && body ? `${strong}${/[:：]$/.test(strong) ? "" : "："}${body}` : strong || body);
    return into;
  }
  for (const child of Object.values(record)) collectFeatureLines(child, into);
  return into;
}

/**
 * Accept the required HTML string, or coerce a mistaken rich-text AST/object
 * into the same safe HTML shape used by VBK. Empty results mean the caller
 * must reject the write instead of persisting a non-string features value.
 */
export function coerceProductFeaturesHtml(value: unknown): string {
  if (typeof value === "string") return formatProductFeaturesHtml(value);
  if (value == null) return "";
  const lines = collectFeatureLines(value).filter(Boolean);
  if (!lines.length) return "";
  return formatProductFeaturesHtml(lines.join("\n"));
}


/** UEditor HTML 转为普通输入框/回读比较使用的文本。 */
export function productFeaturesPlainText(value: unknown): string {
  return String(value ?? "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|li|ul|ol)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
