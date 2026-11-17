/**
 * 静态网页模板渲染：确定性生成 index.html / styles.css / README.md。
 *
 * 所有用户/模型文本一律转义后再拼接，杜绝标签注入；样式沿用 DESIGN.md
 * 的浅色工作台语言（白底、zinc 墨色、teal 强调、细分隔线）。
 */

import type { WebPlan, WebSection } from "./plan.js";

export const INDEX_FILE = "index.html";
export const STYLE_FILE = "styles.css";
export const README_FILE = "README.md";

export interface RenderedWebFiles {
  files: Array<{ path: string; content: string }>;
  bytes: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/\n/gu, " ");
}

function renderSection(section: WebSection): string {
  const body = section.body ? `\n        <p class="body">${escapeHtml(section.body).replace(/\n/gu, "<br />")}</p>` : "";
  const bullets = section.bullets.length
    ? `\n        <ul>${section.bullets.map((bullet) => `\n          <li>${escapeHtml(bullet)}</li>`).join("")}\n        </ul>`
    : "";
  return `      <section>\n        <h2>${escapeHtml(section.heading)}</h2>${body}${bullets}\n      </section>`;
}

function renderHtml(plan: WebPlan): string {
  const description = plan.description ? `\n  <meta name="description" content="${escapeAttr(plan.description)}" />` : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(plan.title)}</title>${description}
  <link rel="stylesheet" href="${STYLE_FILE}" />
</head>
<body data-theme="${escapeAttr(plan.theme)}">
  <header class="hero">
    <p class="kicker">三人同游 · 智能体生成</p>
    <h1>${escapeHtml(plan.title)}</h1>
    ${plan.description ? `<p class="lede">${escapeHtml(plan.description)}</p>` : ""}
  </header>
  <main>
${plan.sections.map(renderSection).join("\n")}
  </main>
  <footer>由通用智能体按结构化计划生成；修改请回到对话里描述新版本。</footer>
</body>
</html>
`;
}

const THEME_STYLES: Record<WebPlan["theme"], string> = {
  "kaimu-light": `--bg: #ffffff; --surface: #fafafa; --ink: #09090b; --muted: #71717a; --border: #e4e4e7; --accent: #0d9488;`,
  graphite: `--bg: #18181b; --surface: #27272a; --ink: #fafafa; --muted: #a1a1aa; --border: #3f3f46; --accent: #5eead4;`,
};

function renderStyle(plan: WebPlan): string {
  return `:root { ${THEME_STYLES[plan.theme]} }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.7 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
.hero { max-width: 760px; margin: 0 auto; padding: 72px 24px 36px; border-bottom: 1px solid var(--border); }
.kicker { margin: 0 0 10px; color: var(--accent); font-size: 12px; letter-spacing: .08em; }
.hero h1 { margin: 0; font-size: 34px; line-height: 1.25; letter-spacing: -.02em; }
.lede { margin: 12px 0 0; color: var(--muted); font-size: 16px; }
main { max-width: 760px; margin: 0 auto; padding: 8px 24px 56px; }
section { padding: 26px 0; border-bottom: 1px solid var(--border); }
section h2 { margin: 0 0 10px; font-size: 20px; }
.body { margin: 0 0 10px; color: var(--ink); }
ul { margin: 0; padding-left: 20px; color: var(--muted); }
li { margin: 4px 0; }
footer { max-width: 760px; margin: 0 auto; padding: 20px 24px 48px; color: var(--muted); font-size: 12px; }
`;
}

function renderReadme(plan: WebPlan): string {
  return `# ${plan.title}

${plan.description ?? ""}

- 生成方式：通用智能体按结构化计划渲染静态页面
- 入口：\`${INDEX_FILE}\`（直接双击或用浏览器打开即可预览）
- 样式：\`${STYLE_FILE}\`
- 小节：${plan.sections.map((section) => section.heading).join("、")}
`;
}

export function renderWeb(plan: WebPlan): RenderedWebFiles {
  const files = [
    { path: INDEX_FILE, content: renderHtml(plan) },
    { path: STYLE_FILE, content: renderStyle(plan) },
    { path: README_FILE, content: renderReadme(plan) },
  ];
  const bytes = files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0);
  return { files, bytes };
}
