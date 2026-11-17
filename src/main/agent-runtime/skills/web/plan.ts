/**
 * 网页计划：模型只输出结构化内容，HTML/CSS 由模板确定性渲染。
 *
 * 与演示文稿同一套思路：计划受 Zod 约束，模型不接触 HTML 拼接，
 * 因此不会因为模型输出而引入脚本注入或任意标签。
 */

import { z } from "zod";

export const WEB_THEMES = ["kaimu-light", "graphite"] as const;

const MAX_SECTIONS = 20;
const MAX_BULLETS = 8;

const sectionSchema = z.object({
  heading: z.string().trim().min(1).max(80),
  body: z.string().trim().max(1200).optional(),
  bullets: z.array(z.string().trim().min(1).max(200)).max(MAX_BULLETS).default([]),
});

export const webPlanSchema = z.object({
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(200).optional(),
  theme: z.enum(WEB_THEMES).default("kaimu-light"),
  sections: z.array(sectionSchema).min(1).max(MAX_SECTIONS),
});

export type WebPlan = z.infer<typeof webPlanSchema>;
export type WebSection = WebPlan["sections"][number];

export type WebPlanParse = { plan: WebPlan } | { error: string };

export function parseWebPlan(input: unknown): WebPlanParse {
  const result = webPlanSchema.safeParse(input);
  if (result.success) return { plan: result.data };
  const issues = result.error.issues.slice(0, 6)
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(根)"}：${issue.message}`);
  return { error: `网页计划不合法：${issues.join("；")}` };
}

/** 由标题推导默认目录名；只做安全字符替换，不做音译。 */
export function webDirectoryName(title: string): string {
  const base = title
    .replace(/[\\/:*?"<>|\n\r\t]/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 40);
  return base || "网页";
}

export function webOutline(plan: WebPlan): string {
  const lines = plan.sections.map((section, index) => {
    const parts = [`${String(index + 1).padStart(2, "0")}. ${section.heading}`];
    if (section.body) parts.push(`    正文：${section.body.length} 字`);
    if (section.bullets.length) parts.push(...section.bullets.map((bullet) => `    · ${bullet}`));
    return parts.join("\n");
  });
  return [
    `标题：${plan.title}`,
    plan.description ? `描述：${plan.description}` : "",
    `主题：${plan.theme}`,
    `共 ${plan.sections.length} 个小节`,
    ...lines,
  ].filter(Boolean).join("\n");
}

/** 模型侧 JSON Schema：字段与 Zod 校验保持一致。 */
export const webPlanJsonSchema: Record<string, unknown> = {
  type: "object",
  description: "网页结构化内容计划",
  properties: {
    title: { type: "string", description: "页面标题" },
    description: { type: "string", description: "一句话描述，可选" },
    theme: { type: "string", enum: [...WEB_THEMES], description: "配色主题，默认 kaimu-light" },
    sections: {
      type: "array",
      minItems: 1,
      maxItems: MAX_SECTIONS,
      items: {
        type: "object",
        properties: {
          heading: { type: "string", description: "小节标题" },
          body: { type: "string", description: "小节正文，可选" },
          bullets: { type: "array", maxItems: MAX_BULLETS, items: { type: "string" }, description: "要点列表，可选" },
        },
        required: ["heading"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "sections"],
  additionalProperties: false,
};
