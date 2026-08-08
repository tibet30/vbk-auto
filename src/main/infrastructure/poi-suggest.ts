export interface PoiSuggestion { poiName: string; poiId: string }
import type { VbkBrowser } from "./vbk-browser.js";

export async function suggestPoi(browser: VbkBrowser, keyword: string): Promise<PoiSuggestion | null> {
  const payload = await browser.evaluate(async (input: string) => {
    const response = await fetch("https://online.ctrip.com/restapi/soa2/20049/suggestPoi", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestHeader: {}, poiTypes: [], count: 10, keyword: input, tagIds: [], useENameSort: false, districtSortDto: {}, contentType: "json" }) });
    if (!response.ok) throw new Error(`suggestPoi HTTP ${response.status}`);
    return response.json();
  }, keyword.trim());
  return pickBestPoi(keyword, payload);
}

export function pickBestPoi(keyword: string, payload: unknown): PoiSuggestion | null {
  const list = payload && typeof payload === "object" && Array.isArray((payload as any).poiList) ? (payload as any).poiList : [];
  const key = keyword.trim().toLowerCase();
  const hit = list.find((x: any) => String(x?.poiName ?? "").trim().toLowerCase() === key)
    ?? list.find((x: any) => String(x?.poiName ?? "").toLowerCase().includes(key));
  if (!hit || !String(hit.poiName ?? "").trim() || !String(hit.poiId ?? "").trim()) return null;
  return { poiName: String(hit.poiName).trim(), poiId: String(hit.poiId).trim() };
}
