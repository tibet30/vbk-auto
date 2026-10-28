import { unchangedResourceSegments } from "./resource-segment-readback.js";
import { toPlatformShortLocationName } from "../../../shared/location-short-name.js";
import { toVbkCityName } from "../../../shared/region-overrides.js";
import { normalisePlatformHotelProduct, platformHotelStayGroups, validPlatformHotelRules } from "../../../shared/platform-hotel-rules.js";
import { hasItineraryHotelStay } from "../../../shared/itinerary-hotel.js";
import { productNeedsVehicleResource } from "../../../shared/product-form.js";
import { normalizeHotelResourceLayout } from "./hotel-resource-api.js";
import { ensureResourceSegmentsDraftApi, getProductSegmentsApi, segmentsFromPayload, saveProductSegmentApi, initializeResourceSegmentsDraftApi } from "./vehicle-resource-api.js";
import { finalizeParentResourceSegments } from "./resource-segment-finalization.js";
import { buildPlatformHotelRule, platformHotelRuleMatches, platformHotelRuleFailureDetail } from "./hotel-rule-protocol.js";
import { resolveHotelRuleRouteCities } from './hotel-rule-cities.js';

export async function ensurePlatformHotelRulesApi(page: any, input: any, productId: string, options: { draftOnly?: boolean } = {}) {
  const product = normalisePlatformHotelProduct(input);
  const days = product.itinerary.filter((day: any) => hasItineraryHotelStay(day.hotel));
  if (!days.length) return { skipped: "行程不含住宿", verified: true };
  const rules = product.operations.hotelRules;
  if (!validPlatformHotelRules(rules)) throw new Error("酒店规则缺失或无效");
  const routeCities = await resolveHotelRuleRouteCities(page, product);
  const payload = await ensureResourceSegmentsDraftApi(page, productId);
  const layout = await normalizeHotelResourceLayout({ page, productId, resolvedDays: days, payload, source: "rules",
    provinceForCity: (city, dayNumbers) => toPlatformShortLocationName(routeCities.get(city)?.provinceName) || hotelRuleProvince(product, city, dayNumbers) });
  let fresh: any = await getProductSegmentsApi(page, productId);
  if (options.draftOnly && !Array.isArray(fresh?.draftProductSegments?.segments)) throw new Error("平台酒店规则未返回草稿，不能确认草稿保存");
  const count = segmentsFromPayload(fresh).slice(1).filter((s: any) => Number(s.segmentBase?.stayNights) > 0).length;
  for (let index = 0; index < count; index++) {
    const lodging = segmentsFromPayload(fresh).slice(1).filter((s: any) => Number(s.segmentBase?.stayNights) > 0);
    let segment = lodging[index];
    if (!platformHotelRuleMatches(segment, rules)) {
      const restore = async () => {
        const restored = await initializeResourceSegmentsDraftApi(page, productId);
        if (!unchangedResourceSegments(fresh, restored)) throw new Error("酒店规则草稿恢复后内容变化，停止写入");
        fresh = restored;
        segment = assertHotelRulesLayout(fresh, product, false, routeCities)[index];
      };
      if (!Array.isArray(fresh?.draftProductSegments?.segments)) await restore();
      const save = () => saveProductSegmentApi(page, { ...segment, hotel: buildPlatformHotelRule(segment, rules) }, "VBK 平台酒店规则保存");
      try { await save(); } catch (error) {
        if (!/20016116|产品还没有创建草稿/.test(String(error))) throw error;
        const after = await getProductSegmentsApi(page, productId);
        if (!unchangedResourceSegments(fresh, after)) throw new Error("酒店规则保存结果不确定：内容变化，停止重试并保留现场");
        fresh = after;
        await restore();
        await save();
      }
      fresh = await getProductSegmentsApi(page, productId);
      assertHotelRulesLayout(fresh, product, false, routeCities);
    }
  }
  const lodging = assertHotelRulesLayout(fresh, product, false, routeCities);
  if (options.draftOnly && !Array.isArray(fresh?.draftProductSegments?.segments)) throw new Error("平台酒店规则未返回草稿，不能确认草稿回读");
  const mismatches = lodging.filter((s: any) => !platformHotelRuleMatches(s, rules));
  if (mismatches.length) throw new Error(`平台酒店规则草稿回读不一致：${JSON.stringify(mismatches.map(platformHotelRuleFailureDetail))}`);
  const finalization = options.draftOnly ? { deferred: true, reason: "仅保存酒店规则草稿，不提交或发布" }
    : productNeedsVehicleResource(product) ? { deferred: true, reason: "等待用车资源阶段统一发布" }
    : await finalizeParentResourceSegments(page, productId, fresh, {});
  return { source: "rules", verified: true, rules, layout, finalization,
    positiveSegmentCount: lodging.length, segmentIds: lodging.map((s: any) => String(s.segmentId)) };
}
export function assertHotelRulesLayout(payload: any, product: any, formalOnly = false, routeCities = new Map<string, Record<string, any>>()) {
  const expected = platformHotelStayGroups(product);
  const segments = segmentsFromPayload(payload, { formalOnly });
  if (!segments.length || segments.some((s: any, index: number) => {
    const base = s.segmentBase ?? {};
    return ["stayNights", "minStayNights", "maxStayNights"].some(key =>
      !Number.isSafeInteger(Number(base[key])) || Number(base[key]) < 0 || index === 0 && Number(base[key]) !== 0);
  })) throw new Error("平台酒店规则行程段住宿晚数无效，全程段必须为零晚");
  if (segments.some((s: any, index: number) => (index === 0 || Number(s.segmentBase?.stayNights) === 0)
    && (s.hotel?.systemHotel || s.hotel?.segmentRooms?.length))) throw new Error("无住宿段仍配置了酒店");
  const lodging = segments.slice(1).filter((s: any) => Number(s.segmentBase?.stayNights) > 0);
  if (expected.length !== lodging.length) throw new Error("平台酒店规则住宿段数量不一致");
  lodging.forEach((segment: any, index: number) => {
    const base = segment.segmentBase;
    const wanted = expected[index]!;
    // 平台回读的是可写城市：万州等直辖市下辖区县写入后回读为重庆。
    const wantedCityName = toVbkCityName(wanted.cityName);
    const routeCity = routeCities.get(wanted.cityName);
    const province = toPlatformShortLocationName(routeCity?.provinceName) || hotelRuleProvince(product, wanted.cityName, wanted.dayNumbers);
    if (toPlatformShortLocationName(base.destinationCity?.cityName) !== wantedCityName
      || province && (toPlatformShortLocationName(base.destinationCity?.provinceName) !== province || base.destinationCity?.countryName !== "中国")
      || routeCity && Number(base.destinationCity?.cityId) !== Number(routeCity.cityId)
      || ["stayNights", "minStayNights", "maxStayNights"].some(key => Number(base[key]) !== wanted.nights))
      throw new Error("平台酒店规则住宿城市或晚数回读不一致");
  });
  return lodging;
}

/** Cross-province routes use the lodging city's own POI geography, never the arrival province.
 * A lodging city without its own POIs (西宁) falls back to the stay days and their next days:
 * only one shared province among those spots counts as evidence. */
export function hotelRuleProvince(product: any, cityName: string, dayNumbers: number[] = []): string | undefined {
  const spots = (product.itinerary ?? []).flatMap((day: any) => day.spots ?? []);
  const provinces = new Set<string>(spots.map((spot: any) => toPlatformShortLocationName(spot.province)).filter(Boolean));
  const matching = new Set<string>(spots.filter((spot: any) => [spot.city, spot.district]
    .some(name => toPlatformShortLocationName(name) === cityName))
    .map((spot: any) => toPlatformShortLocationName(spot.province)).filter(Boolean));
  if (matching.size === 1) return [...matching][0];
  const base = toPlatformShortLocationName(product.basicInfo?.province);
  if (base && [...provinces].every(province => province === base)) return base;
  const nearby = new Set(dayNumbers.flatMap(day => [day, day + 1]));
  const adjacent = new Set<string>((product.itinerary ?? []).filter((day: any) => nearby.has(Number(day.day)))
    .flatMap((day: any) => day.spots ?? []).map((spot: any) => toPlatformShortLocationName(spot.province)).filter(Boolean));
  return adjacent.size === 1 ? [...adjacent][0] : undefined;
}
export async function verifyPlatformHotelRulesReadback(page: any, product: any, productId: string) {
  const normalized = normalisePlatformHotelProduct(product);
  if (!normalized.itinerary.some((day: any) => hasItineraryHotelStay(day.hotel))) return { skipped: "行程不含住宿", verified: true };
  const routeCities = await resolveHotelRuleRouteCities(page, normalized);
  const lodging = assertHotelRulesLayout(await getProductSegmentsApi(page, productId), normalized, true, routeCities);
  if (!validPlatformHotelRules(normalized.operations.hotelRules) || lodging.some((s: any) => !platformHotelRuleMatches(s, normalized.operations.hotelRules)))
    throw new Error("平台酒店规则正式回读不一致");
  return { source: "rules", verified: true, positiveSegmentCount: lodging.length, rules: normalized.operations.hotelRules };
}
/** Refresh an existing draft without initializing, repairing, saving or publishing resources. */
export async function verifyPlatformHotelDraftRulesReadback(page: any, product: any, productId: string) {
  const rules = product.operations?.hotelRules;
  if (!validPlatformHotelRules(rules)) throw new Error("酒店规则缺失或无效");
  const routeCities = await resolveHotelRuleRouteCities(page, product);
  const payload: any = await getProductSegmentsApi(page, productId);
  if (!Array.isArray(payload?.draftProductSegments?.segments)) throw new Error("未返回酒店规则草稿，不能清除失败提示");
  const lodging = assertHotelRulesLayout(payload, product, false, routeCities);
  if (lodging.some(segment => !platformHotelRuleMatches(segment, rules))) throw new Error("平台酒店规则草稿回读不一致");
  return { verified: true as const, productId, segmentIds: lodging.map(s => String(s.segmentId)),
    rules: { autoMatch: true as const, grades: [3, 4, 5] }, specifiedHotels: [] as [], draftOnly: true as const };
}
