const ACTIVITY_TYPES = new Set(["transport", "visit", "meal", "hotel", "free", "other"]);
export function normaliseActivity(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const time = textValue(record.time);
  const title = textValue(record.title) || textValue(record.name);
  const detail = textValue(record.detail);
  if (!time || !title || !detail) return undefined;
  const rawType = textValue(record.type);
  const type = ACTIVITY_TYPES.has(rawType) ? rawType : "other";
  const durationMinutes = positiveIntegerValue(record.durationMinutes);
  const source = record.source === "user" || record.source === "ai" ? record.source : undefined;
  return {
    time, title, detail, type,
    ...(durationMinutes ? { durationMinutes } : {}),
    ...(source ? { source } : {}),
  };
}

function textValue(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function positiveIntegerValue(value: unknown) { const v = Number(value); return Number.isInteger(v) && v > 0 ? v : undefined; }
