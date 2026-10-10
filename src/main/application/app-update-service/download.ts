/**
 * AppUpdateService 安装包下载：
 *   - selectInstallerFile：从 manifest `url:` 行挑出与当前平台 + version 匹配的文件
 *     （fallback 允许不严格匹配版本号）；
 *   - downloadFile：用 fetch + 流式 write 落盘到指定路径；每写一段就 report 进度。
 *
 * 进度回调的 ProgressInfo 字段：total / transferred / percent / bytesPerSecond / delta，
 * 给到上层 noteProgress 即可。
 */

import fs from "node:fs";
import type { ProgressInfo } from "electron-updater";
import { AppUpdateFailure } from "../app-update-diagnostics.js";
import { ensureTrailingSlash, feedUrl, installerKind } from "./feed.js";

export function selectInstallerFile(manifest: string, version: string): string {
  const { extension, label } = installerKind();
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedExtension = extension.replace(".", "\\.");
  const match = manifest.match(new RegExp(`url:\\s*([^\\n]+${escapedVersion}[^\\n]+${escapedExtension})\\s*$`, "m"));
  if (match) return match[1].trim().replace(/^['"]|['"]$/g, "");
  const fallback = manifest.match(new RegExp(`url:\\s*([^\\n]+${escapedExtension})\\s*$`, "m"));
  if (fallback) return fallback[1].trim().replace(/^['"]|['"]$/g, "");
  throw new AppUpdateFailure(
    "installer_missing",
    `更新清单里没有找到${label}（${extension}），请确认打包产物与清单一致后重新上传。`,
  );
}

export async function downloadFile(
  url: string,
  targetPath: string,
  onProgress: (progress: ProgressInfo) => void,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`下载安装包失败：${response.status}`);
  const total = Number(response.headers.get("content-length") || 0);
  const startedAt = Date.now();
  let transferred = 0;
  const file = fs.createWriteStream(targetPath);
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      transferred += buffer.byteLength;
      if (!file.write(buffer)) await new Promise((resolve) => file.once("drain", resolve));
      const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
      onProgress({
        total,
        transferred,
        percent: total ? (transferred / total) * 100 : 0,
        bytesPerSecond: Math.round(transferred / elapsedSeconds),
        delta: buffer.byteLength,
      });
    }
  } catch (error) {
    fs.rmSync(targetPath, { force: true });
    throw error;
  } finally {
    await new Promise<void>((resolve, reject) => {
      file.end((error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  if (transferred <= 0) {
    fs.rmSync(targetPath, { force: true });
    throw new Error("安装包下载为空，请重新下载。");
  }
}

export { ensureTrailingSlash, feedUrl };

export function ensureTrailingSlashUrl(value: string): string {
  // ensureTrailingSlash helper kept here for backwards compatibility with callers
  // that previously used URL.stringify on the feedUrl.
  return ensureTrailingSlash(value);
}