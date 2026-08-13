import type { CtripLibraryImageCandidate, ProductCover } from "../../../shared/contracts.js";

export function readPreviousCover(product: { product?: unknown } | null | undefined): Record<string, unknown> | null {
  if (!product) return null;
  const productData = product.product;
  if (!productData || typeof productData !== "object") return null;
  const presentation = (productData as Record<string, unknown>).presentation;
  if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) return null;
  const cover = (presentation as Record<string, unknown>).cover;
  return cover && typeof cover === "object" && !Array.isArray(cover) ? cover as Record<string, unknown> : null;
}

export function deriveManualCoverFields(args: {
  previousCover: Record<string, unknown> | null;
  product: Record<string, unknown>;
  originalName: string;
}): { poi: string; description: string; minQuality: number } {
  const basic = args.product.basicInfo && typeof args.product.basicInfo === "object" && !Array.isArray(args.product.basicInfo)
    ? args.product.basicInfo as Record<string, unknown>
    : null;
  const trim = (value: unknown) => typeof value === "string" ? value.trim() : "";
  const fileName = stripExtension(args.originalName).trim();
  const poi = trim(args.previousCover?.poi)
    || trim(basic?.destinationCity)
    || trim(basic?.meetingCity)
    || fileName
    || "手动上传封面";
  const originalName = args.originalName.trim();
  const description = trim(args.previousCover?.description)
    || (originalName ? `手动上传：${originalName}` : "手动上传封面");
  const previousQuality = args.previousCover?.minQuality;
  const minQuality = typeof previousQuality === "number"
    && Number.isFinite(previousQuality)
    && previousQuality >= 0
    && previousQuality <= 5
    ? previousQuality
    : 3;
  return { poi, description, minQuality };
}

export function buildCtripLibraryCover(candidate: CtripLibraryImageCandidate): ProductCover {
  const imageId = typeof candidate.imageId === "number" && Number.isInteger(candidate.imageId) && candidate.imageId > 0
    ? candidate.imageId
    : null;
  const imageUrl = [candidate.imageUrl, candidate.previewUrl, candidate.thumbnailUrl]
    .find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
  if (imageId === null || imageUrl === null) {
    throw new Error("携程图库候选缺少 imageId 或 imageUrl，请重新查询并选择有图片的候选。");
  }

  const optionalFields: Record<string, unknown> = {};
  if (typeof candidate.score === "number" && Number.isFinite(candidate.score)) optionalFields.score = candidate.score;
  if (typeof candidate.resolution === "string" && candidate.resolution.trim()) optionalFields.resolution = candidate.resolution.trim();
  if (typeof candidate.poiId === "number" && Number.isInteger(candidate.poiId) && candidate.poiId > 0) optionalFields.poiId = candidate.poiId;
  if (typeof candidate.poiName === "string" && candidate.poiName.trim()) optionalFields.poiName = candidate.poiName.trim();
  if (typeof candidate.thumbnailUrl === "string" && candidate.thumbnailUrl.trim()) optionalFields.thumbnailUrl = candidate.thumbnailUrl.trim();
  if (typeof candidate.previewUrl === "string" && candidate.previewUrl.trim()) optionalFields.previewUrl = candidate.previewUrl.trim();

  const fallbackLabel = `携程图库图片 ${imageId}`;
  return {
    source: "ctripLibrary",
    imageId,
    imageUrl,
    poi: candidate.poiName || fallbackLabel,
    description: candidate.poiName || fallbackLabel,
    minQuality: 3,
    selectedAt: new Date().toISOString(),
    ...optionalFields,
  };
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}
