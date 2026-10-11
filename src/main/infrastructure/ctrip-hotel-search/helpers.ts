type Coord = { latitude: number; longitude: number };
export function coordinates(row: Record<string, unknown> | null): Coord | null {
  if (!row) return null;
  const latitude = firstCoordinate(row.gdLat, row.gLat, row.lat);
  const longitude = firstCoordinate(row.gdLon, row.gLon, row.lon);
  return latitude !== null && longitude !== null ? { latitude, longitude } : null;
}
function firstCoordinate(...values: unknown[]): number | null {
  for (const value of values) { const parsed = number(value); if (parsed !== null && parsed !== 0) return parsed; }
  return null;
}
export function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
export function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
export function positive(value: unknown): number | null { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : null; }
function number(value: unknown): number | null { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
export function normalise(value: string): string { return value.replace(/\s+/g, "").replace(/[（(].*?[）)]/g, "").trim(); }
export function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
export function localDate(value: Date): string { return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, "0"), String(value.getDate()).padStart(2, "0")].join("-"); }
