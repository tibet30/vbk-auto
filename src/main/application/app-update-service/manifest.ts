/**
 * AppUpdateService manifest 拉取 + 解析：
 *   - fetchLatestManifest：拉取 latest.yml / latest-mac.yml；区分 404 / HTML 响应 /
 *     空文件，全部归一到 AppUpdateFailure 让 renderer 在 IPC 层显式提示用户；
 *   - parseLatestManifest：从 manifest 文本里读 `version:` 与 `releaseDate:`；
 *   - compareSemver：朴素 semver 比对（仅三位）。
 *
 * 错误码：feed_unreachable / feed_missing / manifest_invalid。
 */

import { AppUpdateFailure } from "../app-update-diagnostics.js";
import { ensureTrailingSlash, feedUrl, manifestFileName } from "./feed.js";

export async function fetchLatestManifest(): Promise<string> {
  const manifestName = manifestFileName();
  const manifestUrl = new URL(manifestName, ensureTrailingSlash(feedUrl));
  let response: Response;
  try {
    response = await fetch(manifestUrl);
  } catch (error) {
    throw new AppUpdateFailure(
      "feed_unreachable",
      "连接更新服务器失败，请确认本机网络可以访问更新源后重试。",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (response.status === 404) {
    throw new AppUpdateFailure(
      "feed_missing",
      `更新源上还没有 ${manifestName}，请先把当前平台的更新包上传到更新目录。`,
      `HTTP 404 · ${manifestUrl.toString()}`,
    );
  }
  if (!response.ok) {
    throw new AppUpdateFailure(
      "feed_unreachable",
      `读取更新清单失败（HTTP ${response.status}），请稍后重试。`,
      manifestUrl.toString(),
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const head = text.trimStart().slice(0, 160);
  if (contentType.includes("text/html") || /^<!doctype html|^<html/i.test(head)) {
    throw new AppUpdateFailure(
      "feed_missing",
      `更新源返回的是网站页面而不是 ${manifestName}，说明服务器上还没有发布当前平台的更新文件。`,
      `content-type: ${contentType || "unknown"} · 响应开头：${head.slice(0, 100)}`,
    );
  }
  if (!text.trim()) {
    throw new AppUpdateFailure("manifest_invalid", `更新清单是空文件，请重新上传 ${manifestName}。`);
  }
  return text;
}

export function parseLatestManifest(source: string): { version: string; releaseDate?: string; source: string } {
  const version = source.match(/^version:\s*([^\s'"]+)\s*$/m)?.[1]?.trim();
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new AppUpdateFailure(
      "manifest_invalid",
      `更新清单缺少有效版本号，请确认 ${manifestFileName()} 已正确上传。`,
      source.trim().slice(0, 160),
    );
  }
  const releaseDate = source.match(/^releaseDate:\s*['"]?([^'"\n]+)['"]?\s*$/m)?.[1]?.trim();
  return { version, releaseDate, source };
}

export function compareSemver(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number(part));
  const rightParts = right.split(".").map((part) => Number(part));
  for (let i = 0; i < 3; i += 1) {
    const delta = leftParts[i] - rightParts[i];
    if (delta !== 0) return delta;
  }
  return 0;
}