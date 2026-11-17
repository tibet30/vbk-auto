/**
 * 产物打开：只接受"本任务收据登记过的产物"，并在打开前按任务授权目录重新校验。
 *
 * renderer 传的是收据 id 而不是路径——主进程不提供通用文件打开器，
 * 否则目录授权就形同虚设。
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentArtifact } from "../../shared/contracts-agent-runtime.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import { isPathInside, resolveScopedPath } from "./path-scope.js";

export interface ResolvedArtifact {
  artifact: AgentArtifact;
  /** 校验后的产物根绝对路径。 */
  absolute: string;
  /** 交给系统打开的路径：目录产物打开入口文件，文件产物打开自身。 */
  openPath: string;
  /** 供界面展示的目录（授权目录）。 */
  directory: string;
}

export async function resolveArtifactForOpen(input: {
  db: VbkDatabase;
  ownerUserId: number;
  threadId: string;
  receiptId: string;
  workingDirectory?: string;
}): Promise<ResolvedArtifact> {
  const receipt = input.db.getAgentActionReceipt(input.ownerUserId, input.receiptId);
  if (!receipt || receipt.threadId !== input.threadId) throw new Error("该任务没有这条收据。");
  if (receipt.status !== "succeeded") throw new Error("只有成功收据登记的产物才能打开。");
  const artifact = receipt.artifact;
  if (!artifact) throw new Error("该收据没有登记产物。");

  const root = await resolveScopedPath(input.workingDirectory, ".");
  if (!isPathInside(root.root, artifact.path)) {
    throw new Error("产物不在当前任务的授权目录内。");
  }
  const artifactPath = await resolveScopedPath(input.workingDirectory, path.relative(root.root, artifact.path));
  if (!artifactPath.exists) throw new Error("产物已不存在，可能已被移动或删除。");

  const entryRelative = artifact.kind === "directory" && artifact.entry
    ? path.posix.join(artifactPath.relative, artifact.entry)
    : artifactPath.relative;
  const entry = await resolveScopedPath(input.workingDirectory, entryRelative);
  if (!entry.exists) throw new Error("产物的预览入口已不存在。");

  return {
    artifact,
    absolute: artifactPath.absolute,
    openPath: entry.absolute,
    directory: root.root,
  };
}

/** 预览附件上限：超过就截断，避免把大文件塞进渲染进程。 */
const PREVIEW_BYTE_LIMIT = 512 * 1024;

export interface ArtifactPreview {
  /** 已内联样式的 HTML；渲染层用 sandbox iframe 承载。 */
  html: string;
  entry: string;
  truncated: boolean;
}

/**
 * 生成应用内预览：目录产物的入口 HTML + 同目录被引用的样式表内联。
 *
 * 只做"读文件 + 内联相对样式"，不启动本地服务、不放开 file:// 权限；
 * 引用路径仍然逐个走 `resolveScopedPath`，越出产物目录的引用一律丢弃。
 */
export async function buildArtifactPreview(input: {
  db: VbkDatabase;
  ownerUserId: number;
  threadId: string;
  receiptId: string;
  workingDirectory?: string;
}): Promise<ArtifactPreview> {
  const resolved = await resolveArtifactForOpen(input);
  if (resolved.artifact.kind !== "directory") {
    throw new Error("只有目录型产物（网页工程）支持应用内预览；演示文稿请用系统程序打开。");
  }
  const entryRelative = path.relative(resolved.directory, resolved.openPath);
  const entry = await resolveScopedPath(input.workingDirectory, entryRelative);
  if (!entry.exists) throw new Error("预览入口已不存在。");
  const raw = await fs.readFile(entry.absolute, "utf8");
  const truncated = Buffer.byteLength(raw, "utf8") > PREVIEW_BYTE_LIMIT;
  const limited = truncated ? raw.slice(0, PREVIEW_BYTE_LIMIT) : raw;

  const artifactRoot = resolved.absolute;
  const inlined = await inlineStylesheets(limited, async (href) => {
    if (/^(?:[a-z]+:)?\/\//iu.test(href) || href.startsWith("/") || href.startsWith("..")) return undefined;
    try {
      const target = await resolveScopedPath(
        input.workingDirectory,
        path.posix.join(path.relative(resolved.directory, artifactRoot).split(path.sep).join("/"), href),
      );
      if (!target.exists || !isPathInside(artifactRoot, target.absolute)) return undefined;
      return await fs.readFile(target.absolute, "utf8");
    } catch {
      return undefined;
    }
  });

  return { html: inlined, entry: path.relative(artifactRoot, entry.absolute), truncated };
}

async function inlineStylesheets(
  html: string,
  readLocal: (href: string) => Promise<string | undefined>,
): Promise<string> {
  const pattern = /<link\b[^>]*rel=["']stylesheet["'][^>]*>/giu;
  const matches = [...html.matchAll(pattern)];
  let output = html;
  for (const match of matches) {
    const tag = match[0];
    const href = tag.match(/href=["']([^"']+)["']/iu)?.[1];
    if (!href) continue;
    const css = await readLocal(href);
    if (css === undefined) continue;
    output = output.replace(tag, `<style>\n${css}\n</style>`);
  }
  return output;
}
