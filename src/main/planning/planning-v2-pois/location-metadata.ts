/**
 * POI 地域元数据解析 + 匹配工具：
 *   - readLocationMetadata：从 suggestPoi textFields 中提取 province / city / district / address；
 *     优先用结构化字段（district + parents），textFields 仅兜底。
 *   - locationMatches：actual / expected 两边各自归一化为键集后做交集匹配。
 */

import { administrativeType, locationKeys } from "./aliases.js";

export function readLocationMetadata(fields: Array<{ path: string; value: string }>) {
  const read = (patterns: RegExp[]) => fields.find((field) => patterns.some((pattern) => pattern.test(field.path)))?.value?.trim();
  const districtRecords = new Map<string, { name?: string; type?: string; path: string }>();
  for (const field of fields) {
    const match = field.path.match(/^(.*(?:^|\.)(?:district|districtInfo)(?:\.parents\[\d+\])?)\.(districtName|districtType)$/i);
    if (!match) continue;
    const record = districtRecords.get(match[1]) ?? { path: match[1] };
    if (match[2].toLowerCase() === "districtname") record.name = field.value.trim();
    else record.type = field.value.trim();
    districtRecords.set(match[1], record);
  }
  let province: string | undefined;
  let city: string | undefined;
  let district: string | undefined;
  for (const record of districtRecords.values()) {
    const kind = administrativeType(record.type);
    if (kind === "province" || kind === "municipality") province ??= record.name;
    if (kind === "city" || kind === "municipality") city ??= record.name;
    if (kind === "district") district ??= record.name;
    if (!district && record.name && !record.path.includes(".parents[")) district = record.name;
  }
  return {
    province: province ?? read([/(?:provinceName|province)(?:\.|$)/i]),
    city: city ?? read([/(?:cityName|city)(?:\.|$)/i]),
    district: district ?? read([/(?:districtName|district|countyName)(?:\.|$)/i]),
    address: read([/(?:address|addressDetail|displayAddress)(?:\.|$)/i]),
  };
}

export function locationMatches(actual: string | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  const expectedKeys = locationKeys(expected);
  for (const key of locationKeys(actual)) {
    if (expectedKeys.has(key)) return true;
  }
  return false;
}

