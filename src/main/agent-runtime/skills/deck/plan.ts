/**
 * 演示文稿计划：模型只能输出受 Zod 约束的结构化大纲，不接触渲染细节。
 *
 * 这里同时给出模型侧的 JSON Schema 与运行时的 Zod 校验，两者字段必须一致：
 * 模型看到什么字段，就必须通过同一套校验才能落盘。
 */

import { z } from "zod";

export const DECK_LAYOUTS = ["cover", "section", "bullets", "closing"] as const;
export const DECK_THEMES = ["kaimu-light", "graphite"] as const;

const MAX_SLIDES = 40;
const MAX_BULLETS = 8;
const MAX_BULLET_CHARS = 200;

const slideSchema = z.object({
  layout: z.enum(DECK_LAYOUTS).default("bullets"),
  title: z.string().trim().min(1).max(80),
  bullets: z.array(z.string().trim().min(1).max(MAX_BULLET_CHARS)).max(MAX_BULLETS).default([]),
  notes: z.string().trim().max(2000).optional(),
}).superRefine((slide, ctx) => {
  if (slide.layout === "bullets" && !slide.bullets.length) {
    ctx.addIssue({ code: "custom", message: "bullets 版式至少需要一条要点。", path: ["bullets"] });
  }
  if ((slide.layout === "cover" || slide.layout === "closing") && slide.bullets.length) {
    ctx.addIssue({ code: "custom", message: `${slide.layout} 版式不接受 bullets。`, path: ["bullets"] });
  }
});

export const deckPlanSchema = z.object({
  title: z.string().trim().min(1).max(80),
  subtitle: z.string().trim().max(120).optional(),
  theme: z.enum(DECK_THEMES).default("kaimu-light"),
  slides: z.array(slideSchema).min(1).max(MAX_SLIDES),
});

export type DeckPlan = z.infer<typeof deckPlanSchema>;
export type DeckSlide = DeckPlan["slides"][number];

export type DeckPlanParse = { plan: DeckPlan } | { error: string };

export function parseDeckPlan(input: unknown): DeckPlanParse {
  const result = deckPlanSchema.safeParse(input);
  if (result.success) return { plan: result.data };
  const issues = result.error.issues.slice(0, 6)
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(根)"}：${issue.message}`);
  return { error: `演示文稿计划不合法：${issues.join("；")}` };
}

/** 供模型阅读的大纲预览：审批卡与预览共用同一份文本。 */
export function deckOutline(plan: DeckPlan): string {
  const lines = plan.slides.map((slide, index) => {
    const nth = String(index + 1).padStart(2, "0");
    const head = `${nth}. [${slide.layout}] ${slide.title}`;
    return slide.bullets.length ? `${head}\n${slide.bullets.map((bullet) => `    · ${bullet}`).join("\n")}` : head;
  });
  return [`标题：${plan.title}${plan.subtitle ? `｜${plan.subtitle}` : ""}`, `主题：${plan.theme}`, `共 ${plan.slides.length} 页`, ...lines].join("\n");
}

/** 由标题推导默认文件名；保留中文，只清掉路径分隔符等不安全字符。 */
export function deckFileName(title: string): string {
  const base = title
    .replace(/[\\/:*?"<>|\n\r\t]/gu, "-")
    .replace(/\s+/gu, "")
    .replace(/-{2,}/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 60);
  return `${base || "演示文稿"}.pptx`;
}

/** 模型侧 JSON Schema：字段与上面的 Zod 校验保持一致。 */
export const deckPlanJsonSchema: Record<string, unknown> = {
  type: "object",
  description: "演示文稿结构化大纲",
  properties: {
    title: { type: "string", description: "演示文稿标题" },
    subtitle: { type: "string", description: "副标题，可选" },
    theme: { type: "string", enum: [...DECK_THEMES], description: "配色主题，默认 kaimu-light" },
    slides: {
      type: "array",
      minItems: 1,
      maxItems: MAX_SLIDES,
      items: {
        type: "object",
        properties: {
          layout: { type: "string", enum: [...DECK_LAYOUTS], description: "版式；bullets 需要 bullets" },
          title: { type: "string", description: "该页标题" },
          bullets: { type: "array", maxItems: MAX_BULLETS, items: { type: "string" }, description: "要点列表" },
          notes: { type: "string", description: "演讲备注，可选" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "slides"],
  additionalProperties: false,
};
