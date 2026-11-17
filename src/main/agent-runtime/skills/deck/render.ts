/**
 * 演示文稿模板渲染。
 *
 * 只负责把结构化计划渲染成可编辑的 OOXML `.pptx`，不做预览渲染——
 * 预览由审批卡里的大纲承担，PptxGenJS 不承担原生 PowerPoint 渲染。
 * 视觉沿用 DESIGN.md：白底、zinc 墨色、teal 强调、细分隔线，不用渐变与阴影。
 */

import PptxGenJSNamespace from "pptxgenjs";
import type { DeckPlan, DeckSlide } from "./plan.js";

/**
 * pptxgenjs 4.0.1 的 .d.ts 在 NodeNext 下把默认导入解析成模块命名空间，
 * 直接 `new` 与命名空间取类型都会报错。这里用最小结构类型约束真正用到的 API，
 * 既不关掉类型检查，也不假装能拿到完整类型。
 *
 * 运行期还有一层：原生 ESM 下默认导出就是类，而 tsx / CJS 互操作下会包一层
 * `{ default: 类 }`，所以两种形态都要兼容，否则测试环境能过、打包后反而炸。
 */
type PptxSlide = {
  addText(text: unknown, options?: Record<string, unknown>): void;
  addShape(shape: string, options: Record<string, unknown>): void;
  addNotes(text: string): void;
};

type PptxDocument = {
  defineLayout(input: { name: string; width: number; height: number }): void;
  layout: string;
  title: string;
  author: string;
  subject: string;
  background: { color: string };
  addSlide(): PptxSlide;
  write(props: { outputType: "nodebuffer" }): Promise<Uint8Array>;
};

type PptxConstructor = new () => PptxDocument;

function resolveConstructor(value: unknown): PptxConstructor {
  const candidate = (value as { default?: unknown } | undefined)?.default ?? value;
  if (typeof candidate !== "function") throw new Error("pptxgenjs 导出形态异常，无法构造演示文稿。");
  return candidate as PptxConstructor;
}

const PptxGenJS = resolveConstructor(PptxGenJSNamespace);

const FONT_FACE = "PingFang SC";
const SLIDE_WIDTH = 13.333;
const SLIDE_HEIGHT = 7.5;
const MARGIN = 0.85;

interface DeckTheme {
  background: string;
  ink: string;
  muted: string;
  accent: string;
  line: string;
}

const THEMES: Record<DeckPlan["theme"], DeckTheme> = {
  "kaimu-light": { background: "FFFFFF", ink: "09090B", muted: "71717A", accent: "0D9488", line: "E4E4E7" },
  graphite: { background: "18181B", ink: "FAFAFA", muted: "A1A1AA", accent: "5EEAD4", line: "3F3F46" },
};

function addFooter(slide: PptxSlide, index: number, total: number, theme: DeckTheme): void {
  slide.addShape("line", { x: MARGIN, y: 6.85, w: SLIDE_WIDTH - MARGIN * 2, h: 0, line: { color: theme.line, width: 0.75 } });
  slide.addText("三人同游 · 智能体生成", {
    x: MARGIN, y: 6.95, w: 6, h: 0.3, fontSize: 9, color: theme.muted, fontFace: FONT_FACE,
  });
  slide.addText(`${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`, {
    x: SLIDE_WIDTH - MARGIN - 2, y: 6.95, w: 2, h: 0.3, fontSize: 9, color: theme.muted, align: "right", fontFace: FONT_FACE,
  });
}

function renderCover(slide: PptxSlide, plan: DeckPlan, theme: DeckTheme): void {
  slide.addShape("rect", { x: MARGIN, y: 2.55, w: 0.09, h: 1.55, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addText(plan.title, {
    x: MARGIN + 0.4, y: 2.5, w: SLIDE_WIDTH - MARGIN * 2 - 0.4, h: 1.1,
    fontSize: 40, bold: true, color: theme.ink, fontFace: FONT_FACE,
  });
  if (plan.subtitle) {
    slide.addText(plan.subtitle, {
      x: MARGIN + 0.4, y: 3.55, w: SLIDE_WIDTH - MARGIN * 2 - 0.4, h: 0.6,
      fontSize: 16, color: theme.muted, fontFace: FONT_FACE,
    });
  }
}

function renderSection(slide: PptxSlide, content: DeckSlide, theme: DeckTheme): void {
  slide.addShape("rect", { x: MARGIN, y: 3.1, w: 1.1, h: 0.06, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addText(content.title, {
    x: MARGIN, y: 3.3, w: SLIDE_WIDTH - MARGIN * 2, h: 1.0,
    fontSize: 34, bold: true, color: theme.ink, fontFace: FONT_FACE,
  });
}

function renderBullets(slide: PptxSlide, content: DeckSlide, theme: DeckTheme): void {
  slide.addText(content.title, {
    x: MARGIN, y: 0.75, w: SLIDE_WIDTH - MARGIN * 2, h: 0.85,
    fontSize: 28, bold: true, color: theme.ink, fontFace: FONT_FACE,
  });
  slide.addShape("line", { x: MARGIN, y: 1.62, w: SLIDE_WIDTH - MARGIN * 2, h: 0, line: { color: theme.line, width: 0.75 } });
  slide.addText(
    content.bullets.map((bullet) => ({
      text: bullet,
      options: { bullet: { characterCode: "25CF" }, fontSize: content.bullets.length > 5 ? 16 : 19, color: theme.ink, breakLine: true },
    })),
    { x: MARGIN + 0.1, y: 1.95, w: SLIDE_WIDTH - MARGIN * 2 - 0.1, h: 4.4, fontFace: FONT_FACE, lineSpacingMultiple: 1.35 },
  );
}

function renderClosing(slide: PptxSlide, content: DeckSlide, theme: DeckTheme): void {
  slide.addText(content.title, {
    x: MARGIN, y: 3.05, w: SLIDE_WIDTH - MARGIN * 2, h: 1.0,
    fontSize: 34, bold: true, color: theme.ink, align: "center", fontFace: FONT_FACE,
  });
  slide.addShape("rect", { x: SLIDE_WIDTH / 2 - 0.55, y: 4.15, w: 1.1, h: 0.06, fill: { color: theme.accent }, line: { color: theme.accent } });
}

export async function renderDeck(plan: DeckPlan): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "VBK_WIDE", width: SLIDE_WIDTH, height: SLIDE_HEIGHT });
  pptx.layout = "VBK_WIDE";
  pptx.title = plan.title;
  pptx.author = "三人同游智能体";
  pptx.subject = plan.subtitle ?? plan.title;
  const theme = THEMES[plan.theme];
  pptx.background = { color: theme.background };

  plan.slides.forEach((content, index) => {
    const slide = pptx.addSlide();
    switch (content.layout) {
      case "cover": renderCover(slide, plan, theme); break;
      case "section": renderSection(slide, content, theme); break;
      case "closing": renderClosing(slide, content, theme); break;
      default: renderBullets(slide, content, theme);
    }
    if (content.notes) slide.addNotes(content.notes);
    addFooter(slide, index, plan.slides.length, theme);
  });

  const data = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.from(data as Uint8Array);
}
