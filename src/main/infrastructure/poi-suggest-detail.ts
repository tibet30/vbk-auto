import type {
  PoiSuggestCandidate,
  PoiSuggestDetailResult,
  PoiSuggestTextField,
  PoiSuggestion,
} from "../../shared/contracts.js";

export interface PoiSuggestDetailResultWithRawPayload extends PoiSuggestDetailResult {
  rawPayload: unknown;
}

export function buildPoiSuggestDetailResult(args: {
  httpStatus: number;
  businessStatus: string | number | boolean | null;
  best: PoiSuggestion | null;
  payload: unknown;
  poiList: unknown[];
}): PoiSuggestDetailResultWithRawPayload {
  return {
    httpStatus: args.httpStatus,
    businessStatus: args.businessStatus,
    poiListCount: args.poiList.length,
    best: args.best,
    candidates: args.poiList.map(toPoiSuggestCandidate),
    rawPayload: sanitiseManualPoiPayload(args.payload),
  };
}

export function flattenPoiTextFields(value: unknown): PoiSuggestTextField[] {
  const fields: PoiSuggestTextField[] = [];
  collectPoiTextFields(value, "", fields);
  return fields;
}

function toPoiSuggestCandidate(item: unknown, index: number): PoiSuggestCandidate {
  const poi = asRecord(item);
  const poiName = stringValue(poi?.poiName);
  const poiId = positiveIntegerValue(poi?.poiId) ?? null;
  return {
    index,
    poiName,
    poiId,
    selectable: Boolean(poiName && poiId),
    textFields: flattenPoiTextFields(item),
  };
}

function collectPoiTextFields(value: unknown, path: string, fields: PoiSuggestTextField[]) {
  if (isPrimitiveTextValue(value)) {
    const text = String(value).trim();
    if (text) fields.push({ path: path || "value", value: truncateText(text, 500) });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPoiTextFields(item, `${path}[${index}]`, fields));
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    if (isSensitivePoiKey(key)) continue;
    collectPoiTextFields(child, path ? `${path}.${key}` : key, fields);
  }
}

function sanitiseManualPoiPayload(value: unknown, depth = 0): unknown {
  if (isPrimitiveTextValue(value)) return typeof value === "string" ? truncateText(value, 2_000) : value;
  if (value === null || value === undefined) return value;
  if (depth >= 8) return "[truncated:depth]";
  if (Array.isArray(value)) return value.slice(0, 120).map((item) => sanitiseManualPoiPayload(item, depth + 1));
  const record = asRecord(value);
  if (!record) return String(value);
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (isSensitivePoiKey(key)) continue;
    next[key] = sanitiseManualPoiPayload(child, depth + 1);
  }
  return next;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isPrimitiveTextValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isSensitivePoiKey(key: string): boolean {
  return /cookie|ticket|authorization|api[_-]?key|request[_-]?headers?|headers?|set-cookie|session|credential|password|secret|token/i.test(key);
}

function stringValue(value: unknown): string | null {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return text || null;
}

function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...[truncated]` : value;
}
