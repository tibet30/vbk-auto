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
  const poiName = stringValue(poi?.localName ?? poi?.poiName ?? poi?.name);
  const poiId = positiveIntegerValue(poi?.poiId) ?? null;
  const textFields = flattenPoiTextFields(item);
  const location = readDistrictLocation(poi);
  return {
    index,
    poiName,
    poiId,
    province: location.province,
    city: location.city,
    district: location.district,
    address: stringValue(poi?.address),
    selectable: Boolean(poiName && poiId),
    textFields,
  };
}

/**
 * suggestPoi 行政区契约（以真实响应为准，不做别名猜测）：
 * - `district.districtName` → 当前节点（可能是 City / County / District）
 * - `parents[]` 中 `districtType=City` → 城市（地级）
 * - `parents[]` 中 `districtType=Province` → 省/自治区
 * 例：Gyantse(City) → parents Shigatse(City) / Tibet(Province)
 */
function readDistrictLocation(poi: Record<string, unknown> | null) {
  const district = asRecord(poi?.district);
  const parents = Array.isArray(district?.parents)
    ? district.parents.map(asRecord).filter((parent): parent is Record<string, unknown> => Boolean(parent))
    : [];
  const parentOfType = (type: string) => parents.find((parent) => String(parent.districtType ?? "").toLowerCase() === type.toLowerCase());
  return {
    province: stringValue(parentOfType("Province")?.districtName),
    city: stringValue(parentOfType("City")?.districtName),
    district: stringValue(district?.districtName),
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
