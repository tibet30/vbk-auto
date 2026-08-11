/**
 * 产品封面图片本地存储（manualUpload 路径）。
 *
 * 设计目标：
 *  - product JSON 只保留 fileId / 引用元数据，不直接保存图片二进制；
 *  - 同一 fileId 可被多个项目 / 多次编辑复用，文件层不重复落盘；
 *  - 通过 refCount 跟踪引用计数；0 时清除本地副本，避免覆盖磁盘增长；
 *  - 文件目录在 dataPath/covers/ 下，按 fileId 前两位分桶以便排查；
 *  - 只接受白名单 mime（image/jpeg / image/png / image/webp）与大小上限；
 *
 * 不与 VBK 浏览器 / 自动化阶段耦合：纯文件层 + 引用计数，可被 main IPC 与
 * future 自动化阶段共享。
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** 手动上传封面允许的 mime 白名单。 */
export const MANUAL_UPLOAD_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
/** 单张封面最大 8 MiB；超过直接拒绝。 */
export const MANUAL_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

// 复用 shared/contracts-types 的 IPC meta 形状，避免主进程 / shared 双定义漂移。
import type { ManualUploadCoverMeta } from "../../../../shared/contracts-types.js";
export type { ManualUploadCoverMeta };

interface StoredRecord extends ManualUploadCoverMeta {
  refCount: number;
}

const META_FILENAME = "cover-meta.json";

/**
 * 把图片字节落盘并返回 meta。重复 fileId 不存在；并发上传同字节会生成不同 fileId。
 * 校验失败（mime / size）抛错，不写半成品。
 */
export function storeManualCoverFile(args: {
  dataPath: string;
  originalName: string;
  mimeType: string;
  bytes: Uint8Array;
  now?: () => Date;
}): ManualUploadCoverMeta {
  if (!args.bytes || args.bytes.length === 0) {
    throw new Error("手动上传封面失败：文件为空。");
  }
  if (args.bytes.length > MANUAL_UPLOAD_MAX_BYTES) {
    throw new Error(`手动上传封面失败：文件超过 ${MANUAL_UPLOAD_MAX_BYTES / 1024 / 1024} MiB 上限。`);
  }
  const mimeType = args.mimeType;
  if (!(MANUAL_UPLOAD_MIME_TYPES as readonly string[]).includes(mimeType)) {
    throw new Error(`手动上传封面失败：仅支持 ${MANUAL_UPLOAD_MIME_TYPES.join("、")}，当前 ${mimeType || "未知"}。`);
  }
  const mimeTypeChecked: ManualUploadCoverMeta["mimeType"] = mimeType as ManualUploadCoverMeta["mimeType"];
  const originalName = (args.originalName || "").trim();
  if (!originalName) {
    throw new Error("手动上传封面失败：缺少文件名。");
  }
  const ext = pickExtension(originalName, mimeType);
  const fileId = randomUUID();
  const coversDir = path.join(args.dataPath, "covers");
  const bucket = path.join(coversDir, fileId.slice(0, 2));
  fs.mkdirSync(bucket, { recursive: true });
  const targetPath = path.join(bucket, `${fileId}${ext}`);
  fs.writeFileSync(targetPath, args.bytes);
  const uploadedAt = (args.now ?? (() => new Date()))().toISOString();
  const meta: ManualUploadCoverMeta = {
    fileId,
    originalName,
    mimeType: mimeTypeChecked,
    sizeBytes: args.bytes.length,
    uploadedAt,
  };
  const records = readMeta(args.dataPath);
  records[fileId] = { ...meta, refCount: 0 };
  writeMeta(args.dataPath, records);
  return meta;
}

/**
 * 增加 fileId 的引用计数。fileId 不存在抛错（防止写入半成品）。
 * 返回当前 refCount + meta，便于 renderer / 调试追溯。
 */
export function retainManualCoverFile(args: {
  dataPath: string;
  fileId: string;
}): StoredRecord {
  const records = readMeta(args.dataPath);
  const record = records[args.fileId];
  if (!record) {
    throw new Error("手动上传封面已被清理或不存在，请重新上传。");
  }
  record.refCount += 1;
  records[args.fileId] = record;
  writeMeta(args.dataPath, records);
  return record;
}

/**
 * 释放 fileId 的引用计数；归零时清除本地副本。
 * 文件不存在 / 已经被清理时不抛错（幂等）。
 */
export function releaseManualCoverFile(args: {
  dataPath: string;
  fileId: string;
}): void {
  const records = readMeta(args.dataPath);
  const record = records[args.fileId];
  if (!record) return;
  record.refCount = Math.max(0, record.refCount - 1);
  records[args.fileId] = record;
  writeMeta(args.dataPath, records);
  if (record.refCount === 0) {
    removeCoverFile(args.dataPath, record.fileId, record.originalName);
    delete records[args.fileId];
    writeMeta(args.dataPath, records);
  }
}

/**
 * 读取本地副本绝对路径。文件丢失时返回 null，调用方按"图片已失效"提示。
 */
export function resolveManualCoverPath(args: {
  dataPath: string;
  fileId: string;
  originalName: string;
}): string | null {
  const candidate = path.join(args.dataPath, "covers", args.fileId.slice(0, 2), `${args.fileId}${pickExtension(args.originalName, lookupMime(args.originalName))}`);
  return fs.existsSync(candidate) ? candidate : null;
}

/** 列出现存 meta，方便调试 / 测试。 */
export function listManualCoverMeta(dataPath: string): ManualUploadCoverMeta[] {
  const records = readMeta(dataPath);
  return Object.values(records).map((record) => ({
    fileId: record.fileId,
    originalName: record.originalName,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    uploadedAt: record.uploadedAt,
  }));
}

/**
 * 把手工上传图片读成 data URL 的纯函数：
 *  - 解析本地副本路径（resolveManualCoverPath），文件丢失 → url=null + meta；
 *  - meta.mimeType 优先；meta 缺失或非白名单 mime 时按扩展名兜底；
 *    都没有兜到 → image/jpeg（浏览器兼容默认）；
 *  - 字节读不到 / 解码失败 → url=null（不抛错，避免 IPC 表面 500），UI 走失效提示；
 *  - data URL **仅**本次调用返回，绝不写盘、不进缓存、不进 product JSON。
 *
 * 之所以放在 cover-storage.ts 而不是 cover-ipc.ts：
 *  - cover-storage.ts 是纯文件层 + 引用计数，不依赖 electron，可被 main /
 *    future 自动化阶段、甚至单元测试直接 import；
 *  - cover-ipc.ts 主要封装 IPC handler + trusted-sender；handler 可以再
 *    调本函数，业务行为与 IO 边界分清楚。
 *
 * 这是 storeManualCoverFile 的读取镜像，与 resolveManualCoverPath 的差别在
 * 多做了字节读取 + base64 编码。
 */
export async function readManualCoverDataUrl(args: {
  dataPath: string;
  fileId: string;
  originalName: string;
}): Promise<{
  url: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  uploadedAt: string | null;
  originalName: string | null;
}> {
  const { dataPath, fileId, originalName } = args;
  const records = readMeta(dataPath);
  const record = records[fileId] ?? null;
  const metaResult = {
    mimeType: record?.mimeType ?? null,
    sizeBytes: record?.sizeBytes ?? null,
    uploadedAt: record?.uploadedAt ?? null,
    originalName: record?.originalName ?? null,
  };
  const absolute = resolveManualCoverPath({
    dataPath,
    fileId,
    originalName: record?.originalName ?? originalName,
  });
  if (!absolute) {
    // 文件丢失：返回 null URL + 持久化 meta（如果有），让 UI 提示「图片已失效」。
    return { url: null, ...metaResult };
  }
  try {
    const bytes = await fsPromises.readFile(absolute);
    const mime = pickManualCoverMime(metaResult.mimeType, record?.originalName ?? originalName);
    const b64 = Buffer.isBuffer(bytes) ? bytes.toString("base64") : Buffer.from(bytes).toString("base64");
    return {
      url: `data:${mime};base64,${b64}`,
      ...metaResult,
    };
  } catch {
    // 读盘失败（权限 / 临时 IO 错误）：仍按「已失效」处理，UI 走重新上传提示。
    return { url: null, ...metaResult };
  }
}

/**
 * 推 data URL 用的 mime：meta 优先；meta 缺失或非白名单 mime 时按扩展名兜底；
 * 都识别不到时按 image/jpeg（浏览器对所有 <img> 都接受的一种兼容默认）。
 *
 * 显式独立成函数而不是嵌在 readManualCoverDataUrl 里，便于 cover-storage 测试
 * 单独覆盖 mime 推断分支，不依赖 fs 字节。
 */
export function pickManualCoverMime(metaMime: string | null, originalName: string): string {
  if (metaMime && (MANUAL_UPLOAD_MIME_TYPES as readonly string[]).includes(metaMime)) {
    return metaMime;
  }
  const lower = originalName.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "image/jpeg";
}

function readMeta(dataPath: string): Record<string, StoredRecord> {
  const metaPath = path.join(dataPath, "covers", META_FILENAME);
  if (!fs.existsSync(metaPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, StoredRecord>;
  } catch {
    return {};
  }
}

function writeMeta(dataPath: string, records: Record<string, StoredRecord>): void {
  const coversDir = path.join(dataPath, "covers");
  fs.mkdirSync(coversDir, { recursive: true });
  fs.writeFileSync(path.join(coversDir, META_FILENAME), JSON.stringify(records, null, 2));
}

function removeCoverFile(dataPath: string, fileId: string, originalName: string): void {
  const candidate = path.join(
    dataPath,
    "covers",
    fileId.slice(0, 2),
    `${fileId}${pickExtension(originalName, lookupMime(originalName))}`,
  );
  fs.rmSync(candidate, { force: true });
}

/** 根据文件名 + mime 推断扩展名；都不识别则空串（保留 UUID 文件名）。 */
function pickExtension(originalName: string, mimeType: string): string {
  const dot = originalName.lastIndexOf(".");
  if (dot >= 0 && dot < originalName.length - 1) {
    const candidate = originalName.slice(dot).toLowerCase();
    if (/\.(jpe?g|png|webp)$/.test(candidate)) return candidate;
  }
  switch (mimeType) {
    case "image/jpeg": return ".jpg";
    case "image/png": return ".png";
    case "image/webp": return ".webp";
    default: return "";
  }
}

function lookupMime(originalName: string): string {
  const dot = originalName.lastIndexOf(".");
  if (dot < 0 || dot >= originalName.length - 1) return "";
  const ext = originalName.slice(dot).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "";
}