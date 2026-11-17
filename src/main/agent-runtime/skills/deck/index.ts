/**
 * 演示文稿 Skill：把结构化大纲渲染成可编辑 `.pptx`，写入任务授权目录。
 *
 * 写入路径与本地文件 Skill 共用同一套授权与收据机制：审批卡展示大纲预览，
 * 批准后才落盘；同名文件已存在时，旧版先归档到 `.agent-trash` 再写新版，
 * 因此每次生成都在磁盘与收据上留下可回读的版本记录。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveScopedPath } from "../../path-scope.js";
import type { AgentActionPreview, AgentActionResult, AgentActionTarget, AgentSkill, AgentSkillAction, AgentSkillContext } from "../../types.js";
import { LOCAL_FILE_ACCOUNT, trashRelativePath } from "../local-file/support.js";
import { deckFileName, deckOutline, deckPlanJsonSchema, parseDeckPlan, type DeckPlan } from "./plan.js";
import { renderDeck } from "./render.js";

const PPTX_SUFFIX = ".pptx";

function requestedPath(args: Record<string, unknown>, plan: DeckPlan): string {
  const explicit = args.path;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  return deckFileName(plan.title);
}

async function resolveDeckTarget(
  args: Record<string, unknown>,
  context: AgentSkillContext,
): Promise<{ plan: DeckPlan; relative: string; absolute: string; root: string; exists: boolean }> {
  const parsed = parseDeckPlan(args.plan);
  if ("error" in parsed) throw new Error(parsed.error);
  const relative = requestedPath(args, parsed.plan);
  const resolved = await resolveScopedPath(context.workingDirectory, relative);
  if (!resolved.absolute.toLowerCase().endsWith(PPTX_SUFFIX)) {
    throw new Error(`演示文稿必须写入 ${PPTX_SUFFIX} 文件：${relative}`);
  }
  return { plan: parsed.plan, relative: resolved.relative, absolute: resolved.absolute, root: resolved.root, exists: resolved.exists };
}

const generateAction: AgentSkillAction = {
  name: "deck.generate",
  kind: "write",
  label: "生成演示文稿",
  risk: "medium",
  description: "把结构化大纲渲染成可编辑 .pptx 并写入授权目录；省略 path 时按标题生成文件名，已存在则旧版归档到 .agent-trash。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "授权目录内的相对路径，需以 .pptx 结尾；省略时按标题命名" },
      plan: deckPlanJsonSchema,
    },
    required: ["plan"],
    additionalProperties: false,
  },
  validate(args) {
    const parsed = parseDeckPlan(args.plan);
    return "error" in parsed ? parsed.error : undefined;
  },
  async target(args, context): Promise<AgentActionTarget> {
    const target = await resolveDeckTarget(args, context);
    return {
      action: "deck.generate",
      targetKey: target.absolute,
      // 与本地文件写入共用同一账号，写操作天然串行。
      accountKey: LOCAL_FILE_ACCOUNT,
      risk: target.exists ? "high" : "medium",
      directory: target.root,
    };
  },
  async preview(args, context): Promise<AgentActionPreview> {
    const target = await resolveDeckTarget(args, context);
    const pages = target.plan.slides.length;
    return {
      summary: `生成 ${target.relative}（${pages} 页）${target.exists ? "，覆盖同名文件，旧版归档到 .agent-trash" : "，新建文件"}`,
      diff: deckOutline(target.plan),
    };
  },
  async execute(args, context): Promise<AgentActionResult> {
    const target = await resolveDeckTarget(args, context);
    let archived: string | undefined;
    let previousBytes = 0;
    if (target.exists) {
      previousBytes = (await fs.stat(target.absolute)).size;
      const trashRelative = trashRelativePath(target.absolute, target.root);
      const trash = await resolveScopedPath(context.workingDirectory, trashRelative);
      await fs.mkdir(path.dirname(trash.absolute), { recursive: true });
      await fs.rename(target.absolute, trash.absolute);
      archived = trashRelative;
    }
    const buffer = await renderDeck(target.plan);
    await fs.mkdir(path.dirname(target.absolute), { recursive: true });
    await fs.writeFile(target.absolute, buffer);
    const pages = target.plan.slides.length;
    return {
      content: `已生成 ${target.relative}（${pages} 页，${buffer.length} 字节）${archived ? `；旧版已归档到 ${archived}` : ""}。文件是可编辑的 .pptx。`,
      summary: `生成演示文稿 ${target.relative}（${pages} 页）${archived ? "，旧版已归档" : ""}`,
      before: target.exists ? `${previousBytes} 字节${archived ? `（已归档 ${archived}）` : ""}` : "",
      result: `写入 ${target.absolute}：${pages} 页 / ${buffer.length} 字节`,
      artifact: {
        kind: "file",
        path: target.absolute,
        files: [{ path: target.relative, bytes: buffer.length }],
        entry: target.relative,
      },
    };
  },
  async reconcile(args, context) {
    const target = await resolveDeckTarget(args, context);
    if (!target.exists) return { landed: false, detail: "目标文件不存在" };
    const stats = await fs.stat(target.absolute);
    return { landed: stats.size > 0, detail: `文件存在，${stats.size} 字节` };
  },
};

export const deckSkill: AgentSkill = {
  id: "deck",
  label: "演示文稿",
  description: "先形成结构化大纲，再渲染成可编辑 .pptx 写入授权目录；预览与生成分层，不做原生 PowerPoint 渲染。",
  actions: [generateAction],
};
