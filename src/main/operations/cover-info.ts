/**
 * 产品封面信息查询 / readiness 辅助：
 *   - readCover：从 product.presentation.cover 安全读出当前封面；
 *   - coverReadyForAutomation：判定「自动化阶段能否消费当前 cover」；
 *     ctripLibrary 已由 fillAndSavePresentation 支持；manualUpload 当前
 *     自动化不支持，必须在 readiness 阶段阻断；缺失 cover 留给其它 readiness 流程。
 *
 * 注意：写入路径由 applyManualReviewField.handle productCover 接管（与
 * pricing / butlerContact 同级）；本文件只做读 + 阻断判断，不参与写。
 *
 * 切换 source 时旧 manualUpload fileId 的引用计数释放由 cover-storage
 * 单独完成（retainManualCoverFile / releaseManualCoverFile），主流程按
 * 需调用即可。
 */
import type { ManualUploadCoverMeta } from "../infrastructure/database/parts/cover-storage.js";
import {
  MANUAL_UPLOAD_MAX_BYTES,
  MANUAL_UPLOAD_MIME_TYPES,
  releaseManualCoverFile,
} from "../infrastructure/database/parts/cover-storage.js";

/** ManualUpload 字段白名单（与 cover-storage 同步）。 */
export const MANUAL_UPLOAD_MIME_LIST = MANUAL_UPLOAD_MIME_TYPES as readonly string[];
export const MANUAL_UPLOAD_MAX_SIZE_BYTES = MANUAL_UPLOAD_MAX_BYTES;

/** 取 product 当前 cover 对象（任意来源）；缺失 / 非法均返回 null。 */
export function readCover(product: Record<string, unknown>): null | {
  source: "ctripLibrary" | "manualUpload";
  fileId?: string;
  poi: string;
  description: string;
  minQuality: number;
} {
  const presentation = product.presentation;
  if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) return null;
  const cover = (presentation as Record<string, unknown>).cover;
  if (!cover || typeof cover !== "object" || Array.isArray(cover)) return null;
  const record = cover as Record<string, unknown>;
  const source = record.source;
  if (source !== "ctripLibrary" && source !== "manualUpload") return null;
  const poi = typeof record.poi === "string" ? record.poi.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const minQuality = typeof record.minQuality === "number" && Number.isFinite(record.minQuality)
    ? record.minQuality
    : 3;
  if (!poi || !description) return null;
  if (source === "manualUpload") {
    const fileId = typeof record.fileId === "string" ? record.fileId.trim() : "";
    if (!fileId) return null;
    return { source, fileId, poi, description, minQuality };
  }
  return { source, poi, description, minQuality };
}

/**
 * 「自动化阶段能否消费当前 cover」判定：
 *  - ctripLibrary：fillAndSavePresentation 已经实现；
 *  - manualUpload：当前自动化阶段不支持，必须在 readiness 阶段阻断；
 *  - 缺失 cover：按缺值处理，依赖其它 readiness 流程。
 */
export function coverReadyForAutomation(product: Record<string, unknown>): {
  ok: boolean;
  reason: "manualUploadNotSupported" | "missing" | "ok";
} {
  const cover = readCover(product);
  if (!cover) return { ok: false, reason: "missing" };
  if (cover.source === "manualUpload") {
    return { ok: false, reason: "manualUploadNotSupported" };
  }
  return { ok: true, reason: "ok" };
}

/**
 * 切换 product 当前 cover 时若旧 cover 是 manualUpload，必须释放旧 fileId 的
 * 引用计数。该函数由上层（主流程）显式调用：仅在确认新 cover 已落库后释放，
 * 避免新写入失败导致文件孤岛。null / 非 manualUpload 时静默 no-op。
 */
export function releaseManualUploadIfReplaced(args: {
  dataPath: string;
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
}): void {
  const previous = readCover(args.previous);
  const next = readCover(args.next);
  if (!previous || previous.source !== "manualUpload" || !previous.fileId) return;
  if (next && next.source === "manualUpload" && next.fileId === previous.fileId) return;
  releaseManualCoverFile({ dataPath: args.dataPath, fileId: previous.fileId });
}

/**
 * 把 ManualUploadCoverMeta（IPC 返回）转为「可直接序列化进 product JSON」的
 * 形状——只保留必要字段，去掉 refCount 等内部字段。
 */
export function manualUploadMetaToProduct(meta: ManualUploadCoverMeta): {
  source: "manualUpload";
  fileId: string;
  originalName: string;
  mimeType: ManualUploadCoverMeta["mimeType"];
  sizeBytes: number;
  uploadedAt: string;
} {
  return {
    source: "manualUpload",
    fileId: meta.fileId,
    originalName: meta.originalName,
    mimeType: meta.mimeType,
    sizeBytes: meta.sizeBytes,
    uploadedAt: meta.uploadedAt,
  };
}

/**
 * 手动上传封面时自动补全 poi / description / minQuality：
 *  - poi：优先沿用旧 cover.poi（保持 POI 名称一致），其次用 basicInfo.destinationCity /
 *    basicInfo.meetingCity，最后回退到去掉扩展名的文件名，再不行用「手动上传封面」占位；
 *  - description：优先沿用旧 cover.description，否则用 `手动上传：${originalName}`；
 *  - minQuality：优先沿用旧值，否则用 3（与 schema minQuality 默认保持一致）。
 *
 * 这是纯函数，方便 tsx --test 直接覆盖边界（缺 product / 缺 city / 文件名无扩展名等）。
 * Renderer action `uploadAndSaveManualCover` 拿到 file + 当前 cover 后调用，
 * 不需要再向用户索取 POI / 描述 / 质量分。
 */
export interface DerivedManualCoverFields {
  poi: string;
  description: string;
  minQuality: number;
}

export function deriveManualCoverFields(args: {
  previousCover: Record<string, unknown> | null;
  product: Record<string, unknown>;
  originalName: string;
}): DerivedManualCoverFields {
  const poi = pickPoiForManualUpload({
    previousCover: args.previousCover,
    product: args.product,
    originalName: args.originalName,
  });
  const description = pickDescriptionForManualUpload({
    previousCover: args.previousCover,
    originalName: args.originalName,
  });
  const minQuality = pickMinQualityForManualUpload({
    previousCover: args.previousCover,
  });
  return { poi, description, minQuality };
}

function pickPoiForManualUpload(args: {
  previousCover: Record<string, unknown> | null;
  product: Record<string, unknown>;
  originalName: string;
}): string {
  const fromPrevious = trimToString(safeObject(args.previousCover)?.poi);
  if (fromPrevious) return fromPrevious;
  const product = safeObject(args.product) ?? {};
  const basic = safeObject(product.basicInfo) ?? {};
  const fromDestination = trimToString(basic.destinationCity);
  if (fromDestination) return fromDestination;
  const fromMeeting = trimToString(basic.meetingCity);
  if (fromMeeting) return fromMeeting;
  const fromFileName = stripExtension(args.originalName).trim();
  if (fromFileName) return fromFileName;
  return "手动上传封面";
}

function pickDescriptionForManualUpload(args: {
  previousCover: Record<string, unknown> | null;
  originalName: string;
}): string {
  const fromPrevious = trimToString(safeObject(args.previousCover)?.description);
  if (fromPrevious) return fromPrevious;
  const originalName = args.originalName.trim();
  return originalName ? `手动上传：${originalName}` : "手动上传封面";
}

function pickMinQualityForManualUpload(args: {
  previousCover: Record<string, unknown> | null;
}): number {
  const previous = safeObject(args.previousCover);
  const value = previous?.minQuality;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 5) {
    return value;
  }
  return 3;
}

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimToString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function stripExtension(originalName: string): string {
  const dot = originalName.lastIndexOf(".");
  if (dot <= 0) return originalName.trim();
  return originalName.slice(0, dot).trim();
}