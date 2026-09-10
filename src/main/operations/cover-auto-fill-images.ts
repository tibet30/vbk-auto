import type { CtripLibraryCoverAlternate, CtripLibraryImageCandidate } from "../../shared/contracts-types.js";

export function buildCtripLibraryCoverFromCandidate(args: {
  existingCover: Record<string, unknown> | null | undefined;
  candidate: CtripLibraryImageCandidate & { imageId: number; imageUrl: string };
  keyword: string;
  selectedAt: string;
}): Record<string, unknown> {
  const existing = safeObject(args.existingCover);
  const image = buildCtripLibraryCoverImageFromCandidate(args);
  const next: Record<string, unknown> = {
    source: "ctripLibrary",
    ...image,
  };
  const description = textValue(existing?.description);
  if (description) next.description = description;
  const minQuality = existing?.minQuality;
  if (typeof minQuality === "number" && Number.isFinite(minQuality)) next.minQuality = minQuality;
  return next;
}

export function buildCtripLibraryCoverAlternateFromCandidate(args: {
  existingCover: Record<string, unknown> | null | undefined;
  candidate: CtripLibraryImageCandidate & { imageId: number; imageUrl: string };
  keyword: string;
  selectedAt: string;
}): CtripLibraryCoverAlternate {
  return buildCtripLibraryCoverImageFromCandidate(args);
}

export function readPreparedCoverImages(cover: Record<string, unknown> | null | undefined): CtripLibraryCoverAlternate[] {
  if (!cover || !isPreparedCtripLibraryCover(cover)) return [];
  const primary = preparedCoverImage(cover);
  if (!primary) return [];
  const alternates = Array.isArray(cover.alternates)
    ? cover.alternates.flatMap((item) => {
        const image = safeObject(item);
        const parsed = preparedCoverImage(image);
        return parsed ? [parsed] : [];
      })
    : [];
  const seen = new Set<number>();
  return [primary, ...alternates].filter((item) => {
    if (seen.has(item.imageId)) return false;
    seen.add(item.imageId);
    return true;
  });
}

export function coverImagePoiKey(image: CtripLibraryCoverAlternate): string {
  return (textValue(image.poiName) || textValue(image.poi) || String(image.poiId ?? "")).toLowerCase();
}

export function candidatePoiKey(candidate: CtripLibraryImageCandidate, keyword: string): string {
  return (textValue(candidate.poiName) || textValue(keyword) || String(candidate.poiId ?? "")).toLowerCase();
}

function buildCtripLibraryCoverImageFromCandidate(args: {
  existingCover: Record<string, unknown> | null | undefined;
  candidate: CtripLibraryImageCandidate & { imageId: number; imageUrl: string };
  keyword: string;
  selectedAt: string;
}): CtripLibraryCoverAlternate {
  const existing = safeObject(args.existingCover);
  const poi =
    textValue(args.candidate.poiName)
    || textValue(args.keyword)
    || (existing ? textValue(existing.poi) : "");
  const image: CtripLibraryCoverAlternate = {
    imageId: args.candidate.imageId,
    imageUrl: args.candidate.imageUrl,
    poi,
    selectedAt: args.selectedAt,
  };
  const thumbnailUrl = textValue(args.candidate.thumbnailUrl);
  if (thumbnailUrl) image.thumbnailUrl = thumbnailUrl;
  const previewUrl = textValue(args.candidate.previewUrl);
  if (previewUrl) image.previewUrl = previewUrl;
  if (typeof args.candidate.score === "number") image.score = args.candidate.score;
  const resolution = textValue(args.candidate.resolution);
  if (resolution) image.resolution = resolution;
  if (positiveInteger(args.candidate.poiId)) image.poiId = args.candidate.poiId;
  const poiName = textValue(args.candidate.poiName);
  if (poiName) image.poiName = poiName;
  return image;
}

function preparedCoverImage(value: Record<string, unknown> | null | undefined): CtripLibraryCoverAlternate | null {
  if (!value) return null;
  const imageId = value.imageId;
  const imageUrl = textValue(value.imageUrl);
  const poi = textValue(value.poi);
  if (!positiveInteger(imageId) || !imageUrl || !poi) return null;
  const image: CtripLibraryCoverAlternate = { imageId, imageUrl, poi };
  for (const key of ["thumbnailUrl", "previewUrl", "resolution", "poiName", "selectedAt"] as const) {
    const text = textValue(value[key]);
    if (text) image[key] = text;
  }
  if (typeof value.score === "number" && Number.isFinite(value.score)) image.score = value.score;
  if (positiveInteger(value.poiId)) image.poiId = value.poiId;
  return image;
}

function isPreparedCtripLibraryCover(cover: Record<string, unknown>): boolean {
  return textValue(cover.source) === "ctripLibrary"
    && positiveInteger(cover.imageId)
    && textValue(cover.imageUrl).length > 0;
}

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
