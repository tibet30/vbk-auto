/** 产品特色的 AI 输出约束与安全 HTML 归一化。 */

const ALLOWED_TAG = /^<\s*(\/?)\s*(p|strong|em|ul|ol|li|br)\b[^>]*>$/i;
const RICH_TAG = /<\/?(?:p|strong|em|ul|ol|li|br)\b/i;

export const PRODUCT_FEATURES_RICH_TEXT_GUIDE = `features 是 VBK 富文本字段，必须输出 HTML 片段：
- 写 3～5 个与本产品事实一致的亮点，每个亮点使用 <p><strong>短标题：</strong>具体说明</p>；需要列举时可用 <ul><li>...</li></ul>。
- 只允许 p、strong、em、ul、ol、li、br 标签；禁止 Markdown、外层 html/body、style/class/id 等属性，以及 a、img、table、script、iframe。
- 标题简短、内容具体，不虚构服务、资源或承诺；同时遵守 VBK 文案黑名单。`;

function escapeText(value: string): string {
  return value
    .replace(/&(?!(?:amp|lt|gt|quot|#39|#\d+);)/gi, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 把 AI/历史 features 转成可交给 UEditor 的安全 HTML：
 * - 纯文本按行包装成 p，保持旧产品兼容；
 * - HTML 只保留无属性的白名单标签；危险块连同内容移除。
 */
export function formatProductFeaturesHtml(value: unknown): string {
  const source = String(value ?? "").trim();
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
