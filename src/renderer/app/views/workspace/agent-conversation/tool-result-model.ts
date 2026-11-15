/**
 * 工具结果的可渲染视图模型。
 *
 * 数据源是 tool_result 事件的 content：多数工具用 `safeJson(...)` 序列化，
 * 少数返回自然语言说明，失败则统一是「工具失败：…」。这里只做归一化，
 * 不猜测缺失字段，也不重排业务语义；渲染层只消费本文件的判别联合。
 */
export interface PoiCandidateView {
  name: string;
  poiId?: number;
  location?: string;
  bindable: boolean;
  note?: string;
}

export type ToolResultView =
  | { kind: "poi"; keyword?: string; scope?: string; issue?: string; candidates: PoiCandidateView[] }
  | { kind: "hotel"; persisted: boolean; grades: number[]; note?: string }
  | { kind: "cover"; written: boolean; imageCount: number }
  | { kind: "text"; text: string }
  | { kind: "json"; value: unknown }
  | { kind: "failure"; message: string };

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseJson(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function toPoiCandidate(value: unknown): PoiCandidateView | undefined {
  const item = asRecord(value);
  const name = asString(item?.poiName);
  if (!item || !name) return undefined;
  const location = [asString(item.city), asString(item.district)].filter(Boolean).join(" · ");
  const status = asString(item.availabilityStatus);
  const bindable = item.usable === true;
  const note = bindable ? undefined
    : status === "suspended" ? "暂停营业"
    : status === "unavailable" ? "不可用"
    : asString(item.availabilityReason) ?? "不可绑定";
  return {
    name,
    ...(asNumber(item.poiId) !== undefined ? { poiId: asNumber(item.poiId) } : {}),
    ...(location ? { location } : {}),
    bindable,
    ...(note ? { note } : {}),
  };
}

function poiView(value: Json): ToolResultView {
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.flatMap((item) => {
        const candidate = toPoiCandidate(item);
        return candidate ? [candidate] : [];
      })
    : [];
  const scope = asRecord(value.scope);
  const day = asNumber(scope?.day);
  const spotName = asString(scope?.spotName);
  return {
    kind: "poi",
    ...(asString(value.keyword) ? { keyword: asString(value.keyword)! } : {}),
    ...(day !== undefined && spotName ? { scope: `第 ${day} 天 · ${spotName}` } : {}),
    ...(asString(value.bindingIssue) ? { issue: asString(value.bindingIssue)! } : {}),
    candidates,
  };
}

function hotelView(value: Json): ToolResultView {
  const rules = asRecord(value.rules);
  const grades = Array.isArray(rules?.grades)
    ? rules.grades.flatMap((grade) => (asNumber(grade) !== undefined ? [asNumber(grade)!] : []))
    : [];
  return {
    kind: "hotel",
    persisted: value.persisted === true,
    grades,
    ...(asString(value.persistenceNote) ? { note: asString(value.persistenceNote)! } : {}),
  };
}

function coverImageView(value: Json): number {
  const cover = asRecord(asRecord(asRecord(value.nextProduct)?.presentation)?.cover);
  if (!cover) return 0;
  const alternates = Array.isArray(cover.alternates) ? cover.alternates.length : 0;
  const main = asString(cover.imageUrl) ? 1 : 0;
  return main + alternates;
}

export function buildToolResultView(name: string, content: string): ToolResultView {
  if (content.startsWith("工具失败：")) return { kind: "failure", message: content };
  const parsed = parseJson(content);
  const record = asRecord(parsed);
  if (record) {
    if (name === "query_poi" && Array.isArray(record.candidates)) return poiView(record);
    if (name === "resolve_itinerary_hotels" && record.rules !== undefined) return hotelView(record);
    if (name === "resolve_cover") {
      return { kind: "cover", written: record.written === true, imageCount: coverImageView(record) };
    }
  }
  if (parsed !== undefined) return { kind: "json", value: parsed };
  return { kind: "text", text: content };
}
