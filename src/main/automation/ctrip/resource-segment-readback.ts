import { segmentsFromPayload } from "./vehicle-resource-api.js";

/** Draft creation remaps product/segment identity and their own nested references. */
export function unchangedResourceSegments(before: unknown, after: unknown): boolean {
  const previous = segmentsFromPayload(before);
  const current = segmentsFromPayload(after);
  if (!previous.length || previous.length !== current.length) return false;
  return canonical(previous.map(withoutSegmentId)) === canonical(current.map(withoutSegmentId));
}

function withoutSegmentId(segment: Record<string, unknown>) {
  const remap = (value: unknown, key?: string): unknown => {
    if (key === "segmentId" && String(value) === String(segment.segmentId)) return "own-segment";
    if (key === "productId" && String(value) === String(segment.productId)) return "own-product";
    if (Array.isArray(value)) return value.map(item => remap(item));
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).map(([field, item]) => [field, remap(item, field)]),
    );
    return value;
  };
  return remap(segment);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
