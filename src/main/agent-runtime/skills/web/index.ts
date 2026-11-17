/**
 * 网页 Skill：把结构化计划渲染成静态工程，写入任务授权目录。
 *
 * 与本地文件 Skill 共用授权与收据：一次调用只对应一个目标目录、一次审批、
 * 一张收据；目录已存在时整目录先归档到 `.agent-trash` 再重建，
 * 保证磁盘上不会把新旧两版文件混在一起。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveScopedPath } from "../../path-scope.js";
import type { AgentActionPreview, AgentActionResult, AgentActionTarget, AgentSkill, AgentSkillAction, AgentSkillContext } from "../../types.js";
import { LOCAL_FILE_ACCOUNT, trashRelativePath } from "../local-file/support.js";
import { parseWebPlan, webDirectoryName, webOutline, webPlanJsonSchema, type WebPlan } from "./plan.js";
import { INDEX_FILE, renderWeb } from "./render.js";

interface WebTarget {
  plan: WebPlan;
  relative: string;
  absolute: string;
  root: string;
  exists: boolean;
}

async function resolveWebTarget(args: Record<string, unknown>, context: AgentSkillContext): Promise<WebTarget> {
  const parsed = parseWebPlan(args.plan);
  if ("error" in parsed) throw new Error(parsed.error);
  const requested = typeof args.path === "string" && args.path.trim() ? args.path.trim() : webDirectoryName(parsed.plan.title);
  const resolved = await resolveScopedPath(context.workingDirectory, requested);
  if (resolved.exists) {
    const stats = await fs.lstat(resolved.absolute);
    if (!stats.isDirectory()) throw new Error(`目标已存在且不是目录：${resolved.relative}`);
  }
  return { plan: parsed.plan, relative: resolved.relative, absolute: resolved.absolute, root: resolved.root, exists: resolved.exists };
}

const buildAction: AgentSkillAction = {
  name: "web.build",
  kind: "write",
  label: "生成静态网页",
  risk: "medium",
  description: "把结构化内容渲染成静态网页工程（index.html / styles.css / README.md）写入授权目录；省略 path 时按标题建目录，已存在则整目录归档到 .agent-trash 后重建。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "授权目录内的相对目录名；省略时按标题命名" },
      plan: webPlanJsonSchema,
    },
    required: ["plan"],
    additionalProperties: false,
  },
  validate(args) {
    const parsed = parseWebPlan(args.plan);
    return "error" in parsed ? parsed.error : undefined;
  },
  async target(args, context): Promise<AgentActionTarget> {
    const target = await resolveWebTarget(args, context);
    return {
      action: "web.build",
      targetKey: target.absolute,
      accountKey: LOCAL_FILE_ACCOUNT,
      risk: target.exists ? "high" : "medium",
      directory: target.root,
    };
  },
  async preview(args, context): Promise<AgentActionPreview> {
    const target = await resolveWebTarget(args, context);
    const rendered = renderWeb(target.plan);
    return {
      summary: `生成静态网页 ${target.relative}/（${target.plan.sections.length} 个小节，${rendered.files.length} 个文件）${target.exists ? "，覆盖现有目录，旧版归档到 .agent-trash" : ""}`,
      diff: webOutline(target.plan),
    };
  },
  async execute(args, context): Promise<AgentActionResult> {
    const target = await resolveWebTarget(args, context);
    const rendered = renderWeb(target.plan);
    let archived: string | undefined;
    if (target.exists) {
      const trashRelative = trashRelativePath(target.absolute, target.root);
      const trash = await resolveScopedPath(context.workingDirectory, trashRelative);
      await fs.mkdir(path.dirname(trash.absolute), { recursive: true });
      await fs.rename(target.absolute, trash.absolute);
      archived = trashRelative;
    }
    await fs.mkdir(target.absolute, { recursive: true });
    for (const file of rendered.files) {
      const filePath = await resolveScopedPath(context.workingDirectory, path.posix.join(target.relative, file.path));
      await fs.writeFile(filePath.absolute, file.content, "utf8");
    }
    const listing = rendered.files.map((file) => `${file.path}（${Buffer.byteLength(file.content, "utf8")} 字节）`).join("、");
    return {
      content: `已生成静态网页 ${target.relative}/：${listing}${archived ? `；旧版已归档到 ${archived}` : ""}。打开 ${INDEX_FILE} 即可本地预览。`,
      summary: `生成静态网页 ${target.relative}/（${target.plan.sections.length} 个小节）${archived ? "，旧版已归档" : ""}`,
      before: target.exists ? `覆盖前目录已归档${archived ? `到 ${archived}` : ""}` : "",
      result: `写入 ${target.absolute}：${rendered.files.length} 个文件 / ${rendered.bytes} 字节`,
      artifact: {
        kind: "directory",
        path: target.absolute,
        files: rendered.files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content, "utf8") })),
        entry: INDEX_FILE,
      },
    };
  },
  async reconcile(args, context) {
    const target = await resolveWebTarget(args, context);
    const entry = await resolveScopedPath(context.workingDirectory, path.posix.join(target.relative, INDEX_FILE));
    if (!entry.exists) return { landed: false, detail: `${INDEX_FILE} 不存在` };
    const stats = await fs.stat(entry.absolute);
    return { landed: stats.size > 0, detail: `${INDEX_FILE} 存在，${stats.size} 字节` };
  },
};

export const webSkill: AgentSkill = {
  id: "web",
  label: "静态网页",
  description: "先形成结构化内容计划，再渲染成可直接在浏览器打开的静态工程；写入受目录权限约束。",
  actions: [buildAction],
};
