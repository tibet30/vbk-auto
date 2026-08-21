import { AI_WRITABLE_PATHS } from "./schemas.js";
import type { OrchestratorRuntime } from "./types.js";
import type { ModuleOutcome } from "../../shared/contracts-planning.js";

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstVerifiedPoi(product: Record<string, unknown>): string {
  for (const day of Array.isArray(product.itinerary) ? product.itinerary : []) {
    const spots = objectValue(day)?.spots;
    if (!Array.isArray(spots)) continue;
    for (const item of spots) {
      const spot = objectValue(item);
      if (!spot) continue;
      const poiName = textValue(spot.poiName);
      const name = textValue(spot.name);
      const poiId = spot.poiId;
      if ((poiName || name) && typeof poiId === "number" && Number.isInteger(poiId) && poiId > 0) {
        return poiName || name;
      }
    }
  }
  return "";
}

export async function ensurePresentationCover(args: {
  localProductId: string;
  runtime: OrchestratorRuntime;
}): Promise<ModuleOutcome | undefined> {
  const product = await args.runtime.loadCurrentProduct(args.localProductId);
  const presentation = objectValue(product.presentation);
  if (!presentation) return undefined;
  if (objectValue(presentation.cover)) return undefined;

  const poi = firstVerifiedPoi(product);
  if (!poi) return undefined;
  const nextPresentation = {
    ...presentation,
    cover: {
      source: "ctripLibrary",
      poi,
      description: `${poi}代表性横版封面图`,
      minQuality: 3,
    },
  };
  const result = await args.runtime.writeModule(args.localProductId, "presentation", AI_WRITABLE_PATHS.presentation, nextPresentation);
  if (!result.ok) return { module: "presentation", status: "rejected", reason: result.reason || "封面配置写入失败" };
  return {
    module: "presentation",
    status: "accepted",
    writePath: AI_WRITABLE_PATHS.presentation,
    acceptedFields: ["cover"],
  };
}
