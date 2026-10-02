/** Local marker for an operator placeholder uploaded only with an unpublished VBK draft. */
export interface CoverFallback {
  slotKey: "presentation.cover";
  assetKey: "cover-landscape";
  reason: "no_qualified_candidate" | "search_unavailable";
  createdAt: string;
  remoteImageId?: number;
}

export function readActiveCoverFallback(product: Record<string, unknown>): CoverFallback | null {
  const presentation = asRecord(product.presentation);
  const fallback = asRecord(presentation?.coverFallback);
  if (!fallback || fallback.slotKey !== "presentation.cover" || fallback.assetKey !== "cover-landscape") return null;
  if (fallback.reason !== "no_qualified_candidate" && fallback.reason !== "search_unavailable") return null;
  if (typeof fallback.createdAt !== "string" || !fallback.createdAt) return null;
  const cover = asRecord(presentation?.cover);
  if (cover?.source === "manualUpload" && typeof cover.fileId === "string" && cover.fileId) return null;
  if (cover?.source === "ctripLibrary" && Number.isInteger(cover.imageId) && Number(cover.imageId) > 0
    && typeof cover.imageUrl === "string" && cover.imageUrl.trim()) return null;
  return fallback as unknown as CoverFallback;
}

/** Placeholder covers may enter VBK only as an unpublished draft. */
export function placeholderDraftOnly(product: Record<string, unknown>): boolean {
  const fallback = readActiveCoverFallback(product);
  if (!fallback) return true;
  const commercial = asRecord(product.commercial);
  const release = asRecord(commercial?.release);
  return release?.submitReview === false && release.publishAfterApproval === false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
