import { manualUploadCoverSchema } from "../automation/schema/schema-definitions.js";
import { isCtripLibraryCoverComplete } from "../operations/cover-auto-fill.js";
import { readCover } from "../operations/cover-info.js";

/** A search hint is not an image; only a saved, complete cover retires a question. */
export function persistedCoverSource(product: Record<string, unknown>): "manualUpload" | "ctripLibrary" | undefined {
  const cover = readCover(product);
  if (cover?.source === "manualUpload") {
    const presentation = product.presentation;
    const raw = presentation && typeof presentation === "object" && !Array.isArray(presentation)
      ? (presentation as Record<string, unknown>).cover : null;
    return manualUploadCoverSchema.safeParse(raw).success ? "manualUpload" : undefined;
  }
  if (cover?.source !== "ctripLibrary") return undefined;
  const presentation = product.presentation;
  const raw = presentation && typeof presentation === "object" && !Array.isArray(presentation)
    ? (presentation as Record<string, unknown>).cover : null;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    && isCtripLibraryCoverComplete(raw as Record<string, unknown>) ? "ctripLibrary" : undefined;
}
