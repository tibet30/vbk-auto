import { readActiveCoverFallback } from "../../shared/cover-fallback.js";

/** Stage an internal image when gallery search is exhausted or temporarily unavailable. */
export function applyCoverFallback(
  product: Record<string, unknown>,
  reason: "no_qualified_candidate" | "search_unavailable",
  now: () => string = () => new Date().toISOString(),
): { nextProduct: Record<string, unknown>; written: boolean } {
  const presentation = asRecord(product.presentation);
  const cover = asRecord(presentation?.cover);
  if (cover?.source === "manualUpload") return { nextProduct: product, written: false };
  if (cover?.source === "ctripLibrary" && Number.isInteger(cover.imageId) && Number(cover.imageId) > 0
    && typeof cover.imageUrl === "string" && cover.imageUrl.trim()) return { nextProduct: product, written: false };
  if (readActiveCoverFallback(product)?.reason === reason) return { nextProduct: product, written: false };
  const commercial = asRecord(product.commercial);
  const release = asRecord(commercial?.release);
  return {
    nextProduct: {
      ...product,
      ...(release ? { commercial: {
        ...commercial,
        release: { ...release, submitReview: false, publishAfterApproval: false },
      } } : {}),
      presentation: {
        ...presentation,
        coverFallback: {
          slotKey: "presentation.cover",
          assetKey: "cover-landscape",
          reason,
          createdAt: now(),
        },
      },
    },
    written: true,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
