/**
 * 写入与删除动作。全部需要运营授权；每个动作都提供差异预览与回读核查。
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentSkillAction } from "../../types.js";
import { requireScopedPath, resolveScopedPath } from "../../path-scope.js";
import {
  LOCAL_FILE_ACCOUNT,
  buildDiff,
  optionalBoolean,
  optionalString,
  requireString,
  requireText,
  trashRelativePath,
} from "./support.js";

async function readTextIfFile(absolute: string): Promise<string> {
  const stats = await fs.stat(absolute);
  if (!stats.isFile()) throw new Error(`目标不是文件：${absolute}`);
  return fs.readFile(absolute, "utf8");
}

export const createAction: AgentSkillAction = {
  name: "file.create",
  kind: "write",
  label: "新建文件",
  risk: "medium",
  description: "在授权目录内新建文件；目标已存在时失败，不会覆盖。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "授权目录内文件的相对路径" },
      content: { type: "string", description: "文件内容" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async target(args, context) {
    const resolved = await resolveScopedPath(context.workingDirectory, requireString(args, "path"));
    if (resolved.exists) throw new Error(`文件已存在，请改用 file.overwrite：${resolved.relative}`);
    return { action: "file.create", targetKey: resolved.absolute, accountKey: LOCAL_FILE_ACCOUNT, risk: "medium", directory: resolved.root };
  },
  async preview(args) {
    return { summary: `新建文件 ${String(args.path)}`, diff: buildDiff("", requireText(args, "content")) };
  },
  async execute(args, context) {
    const resolved = await resolveScopedPath(context.workingDirectory, requireString(args, "path"));
    const content = requireText(args, "content");
    await fs.mkdir(path.dirname(resolved.absolute), { recursive: true });
    await fs.writeFile(resolved.absolute, content, { encoding: "utf8", flag: "wx" });
    return {
      content: `已新建 ${resolved.relative}（${content.length} 字符）。`,
      summary: `新建文件 ${resolved.relative}`,
      before: "",
      result: `创建 ${resolved.absolute}：${content.length} 字符`,
    };
  },
  async reconcile(args, context) {
    const resolved = await resolveScopedPath(context.workingDirectory, requireString(args, "path"));
    const expected = requireText(args, "content");
    const actual = resolved.exists ? await fs.readFile(resolved.absolute, "utf8").catch(() => undefined) : undefined;
    return { landed: actual === expected, detail: actual === undefined ? "文件不存在" : "已按预期写入" };
  },
};

function replaceAction(config: {
  name: string;
  label: string;
  risk: "medium" | "high";
  requireExisting: boolean;
  description: string;
}): AgentSkillAction {
  return {
    name: config.name,
    kind: "write",
    label: config.label,
    risk: config.risk,
    description: config.description,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "授权目录内文件的相对路径" },
        content: { type: "string", description: "写入后的完整文件内容" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async target(args, context) {
      const resolved = await resolveScopedPath(context.workingDirectory, requireString(args, "path"));
      if (config.requireExisting && !resolved.exists) throw new Error(`目标文件不存在：${resolved.relative}`);
      if (resolved.exists) await readTextIfFile(resolved.absolute);
      return { action: config.name, targetKey: resolved.absolute, accountKey: LOCAL_FILE_ACCOUNT, risk: config.risk, directory: resolved.root };
    },
    async preview(args, context) {
      const resolved = await resolveScopedPath(context.workingDirectory, requireString(args, "path"));
      const before = resolved.exists ? await fs.readFile(resolved.absolute, "utf8").catch(() => "") : "";
      return { summary: `${config.label} ${resolved.relative}`, diff: buildDiff(before, requireText(args, "content")) };
    },
    async execute(args, context) {
      const resolved = await resolveScopedPath(context.workingDirectory, requireString(args, "path"));
      const content = requireText(args, "content");
      const before = resolved.exists ? await fs.readFile(resolved.absolute, "utf8").catch(() => "") : "";
      await fs.mkdir(path.dirname(resolved.absolute), { recursive: true });
      await fs.writeFile(resolved.absolute, content, "utf8");
      return {
        content: `已${config.label} ${resolved.relative}（${content.length} 字符）。`,
        summary: `${config.label} ${resolved.relative}`,
        before,
        result: `写入 ${resolved.absolute}：${content.length} 字符`,
      };
    },
    async reconcile(args, context) {
      const resolved = await resolveScopedPath(context.workingDirectory, requireString(args, "path"));
      const expected = requireText(args, "content");
      const actual = resolved.exists ? await fs.readFile(resolved.absolute, "utf8").catch(() => undefined) : undefined;
      return { landed: actual === expected, detail: actual === undefined ? "文件不存在" : "内容与预期一致" };
    },
  };
}

export const modifyAction = replaceAction({
  name: "file.modify",
  label: "修改文件",
  risk: "medium",
  requireExisting: true,
  description: "用给定内容替换授权目录内已有文件的完整内容。",
});

export const overwriteAction = replaceAction({
  name: "file.overwrite",
  label: "覆盖文件",
  risk: "high",
  requireExisting: false,
  description: "无条件写入授权目录内的文件：已存在则覆盖，不存在则创建。",
});

export const moveAction: AgentSkillAction = {
  name: "file.move",
  kind: "write",
  label: "移动或重命名",
  risk: "medium",
  description: "在授权目录内移动或重命名文件/目录；目标已存在时失败。",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "源相对路径" },
      to: { type: "string", description: "目标相对路径" },
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
  async target(args, context) {
    const source = await requireScopedPath(context.workingDirectory, requireString(args, "from"));
    const destination = await resolveScopedPath(context.workingDirectory, requireString(args, "to"));
    if (destination.exists) throw new Error(`目标已存在，请先删除：${destination.relative}`);
    return { action: "file.move", targetKey: source.absolute, accountKey: LOCAL_FILE_ACCOUNT, risk: "medium", directory: source.root };
  },
  async preview(args) {
    return { summary: `移动 ${String(args.from)} → ${String(args.to)}` };
  },
  async execute(args, context) {
    const source = await requireScopedPath(context.workingDirectory, requireString(args, "from"));
    const destination = await resolveScopedPath(context.workingDirectory, requireString(args, "to"));
    if (destination.exists) throw new Error(`目标已存在，请先删除：${destination.relative}`);
    await fs.mkdir(path.dirname(destination.absolute), { recursive: true });
    try {
      await fs.rename(source.absolute, destination.absolute);
    } catch (error) {
      // 跨卷移动：退化为复制后删除，失败时明确报错而不是留半截结果。
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await fs.cp(source.absolute, destination.absolute, { recursive: true });
      await fs.rm(source.absolute, { recursive: true, force: true });
    }
    return {
      content: `已把 ${source.relative} 移动到 ${destination.relative}。`,
      summary: `移动 ${source.relative} → ${destination.relative}`,
      before: source.relative,
      result: `移动 ${source.absolute} → ${destination.absolute}`,
    };
  },
  async reconcile(args, context) {
    const source = await resolveScopedPath(context.workingDirectory, requireString(args, "from"));
    const destination = await resolveScopedPath(context.workingDirectory, requireString(args, "to"));
    return {
      landed: !source.exists && destination.exists,
      detail: !source.exists && destination.exists ? "源已不存在且目标已生成" : "移动未见落地",
    };
  },
};

export const deleteAction: AgentSkillAction = {
  name: "file.delete",
  kind: "delete",
  label: "删除",
  risk: "high",
  description: "删除授权目录内的文件或目录；默认移入 .agent-trash 可恢复，permanent=true 才真正删除。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "要删除的相对路径" },
      permanent: { type: "boolean", description: "为 true 时不可恢复地删除，默认 false" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async target(args, context) {
    const resolved = await requireScopedPath(context.workingDirectory, requireString(args, "path"));
    if (resolved.absolute === resolved.root) throw new Error("不能删除授权目录本身。");
    return { action: "file.delete", targetKey: resolved.absolute, accountKey: LOCAL_FILE_ACCOUNT, risk: "high", directory: resolved.root };
  },
  async preview(args, context) {
    const resolved = await requireScopedPath(context.workingDirectory, requireString(args, "path"));
    const permanent = optionalBoolean(args, "permanent");
    return {
      summary: permanent
        ? `永久删除 ${resolved.relative}（不可恢复）`
        : `删除 ${resolved.relative}（移入 ${trashRelativePath(resolved.absolute, resolved.root)}，可恢复）`,
    };
  },
  async execute(args, context) {
    const resolved = await requireScopedPath(context.workingDirectory, requireString(args, "path"));
    if (resolved.absolute === resolved.root) throw new Error("不能删除授权目录本身。");
    const permanent = optionalBoolean(args, "permanent");
    if (permanent) {
      await fs.rm(resolved.absolute, { recursive: true, force: true });
      return {
        content: `已永久删除 ${resolved.relative}。`,
        summary: `永久删除 ${resolved.relative}`,
        before: resolved.relative,
        result: `删除 ${resolved.absolute}（永久）`,
      };
    }
    const relative = trashRelativePath(resolved.absolute, resolved.root);
    const target = await resolveScopedPath(context.workingDirectory, relative);
    await fs.mkdir(path.dirname(target.absolute), { recursive: true });
    await fs.rename(resolved.absolute, target.absolute);
    return {
      content: `已把 ${resolved.relative} 移入可恢复回收区：${relative}。`,
      summary: `删除 ${resolved.relative}（可在 ${relative} 恢复）`,
      before: resolved.relative,
      result: `移动到回收区 ${relative}`,
    };
  },
  async reconcile(args, context) {
    const resolved = await resolveScopedPath(context.workingDirectory, optionalString(args, "path") ?? "");
    return { landed: !resolved.exists, detail: resolved.exists ? "目标仍存在" : "目标已不存在" };
  },
};
