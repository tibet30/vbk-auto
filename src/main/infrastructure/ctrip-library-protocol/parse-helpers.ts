/**
 * 携程图库响应解析共用工具：
 *   - asRecord：unknown → Record<string,unknown> | null；
 *   - optionalString：把任意值规整为非空字符串或 null；
 *   - positiveInteger：正整数识别（number / 数字字符串 / 0 / 负数 → null）；
 *   - isBusinessSuccess：判定 ResponseStatus.Ack（"Success" / "SUCCESS" / true / "true"）；
 *   - failureReason：失败时拼一段供上层展示的简介；
 *   - pickPoiList / pickImageList：从 payload 顶层 / data.* 多形态里挑出候选数组；
 *   - readImageId：从单条 entry 里识别 imageId（imageId / id / picId / pic_id / imageID
 *     或 { image: { imageId } } 嵌套形态）；
 *   - parsePoiFromEntry：单条 POI 解析（共享字段名归一）。
 */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

export function isBusinessSuccess(ack: unknown): boolean {
  return ack === "Success" || ack === "SUCCESS" || ack === true || ack === "true";
}

export function failureReason(status: Record<string, unknown> | null): string {
  const errors = Array.isArray(status?.Errors) ? status?.Errors : [];
  const first = asRecord(errors[0]);
  const reason = first?.Message ?? first?.message ?? first?.Code ?? status?.Ack ?? "ResponseStatus 未确认成功";
  return String(reason).replace(/[\r\n\t]/g, " ").slice(0, 300);
}

export function pickPoiList(root: Record<string, unknown> | null): unknown[] {
  if (!root) return [];
  if (Array.isArray(root.body)) return root.body;
  if (Array.isArray(root.poiList)) return root.poiList;
  if (Array.isArray(root.poiDtos)) return root.poiDtos;
  const data = asRecord(root.data);
  if (data && Array.isArray(data.poiList)) return data.poiList;
  if (data && Array.isArray(data.poiDtos)) return data.poiDtos;
  if (data && Array.isArray(data.body)) return data.body;
  return [];
}

export function pickImageList(root: Record<string, unknown> | null): unknown[] {
  if (!root) return [];
  if (Array.isArray(root.imageIds)) return root.imageIds;
  if (Array.isArray(root.imageList)) return root.imageList;
  if (Array.isArray(root.images)) return root.images;
  if (Array.isArray(root.body)) return root.body;
  const data = asRecord(root.data);
  if (!data) return [];
  if (Array.isArray(data.imageIds)) return data.imageIds;
  if (Array.isArray(data.imageList)) return data.imageList;
  if (Array.isArray(data.images)) return data.images;
  if (Array.isArray(data.body)) return data.body;
  return [];
}

export function readImageId(entry: unknown): number | null {
  const record = asRecord(entry);
  if (!record) {
    if (typeof entry === "number") return positiveInteger(entry);
    if (typeof entry === "string") return positiveInteger(entry);
    return null;
  }
  const id = positiveInteger(record.imageId)
    ?? positiveInteger(record.id)
    ?? positiveInteger(record.picId)
    ?? positiveInteger(record.pic_id)
    ?? positiveInteger(record.imageID);
  if (id !== null) return id;
  // 兜底：可能是 { image: { imageId: ... } }
  const nested = asRecord(record.image);
  if (nested) {
    return positiveInteger(nested.imageId)
      ?? positiveInteger(nested.id)
      ?? positiveInteger(nested.picId);
  }
  return null;
}

export function parsePoiFromEntry(poi: Record<string, unknown>): import("./types.js").SuggestPoiParsedPoi | null {
  const poiId = positiveInteger(poi.poiId);
  const rawName = optionalString(poi.poiName) ?? optionalString(poi.name) ?? "";
  if (poiId === null || !rawName) return null;
  return {
    poiId,
    poiName: rawName,
    address: optionalString(poi.address ?? poi.addr),
    province: optionalString(poi.provinceName ?? poi.province ?? poi.province_name),
    city: optionalString(poi.cityName ?? poi.city ?? poi.city_name),
    district: optionalString(poi.districtName ?? poi.district ?? poi.district_name ?? poi.areaName),
  };
}