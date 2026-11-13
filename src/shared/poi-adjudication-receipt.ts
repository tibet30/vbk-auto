/**
 * 受控裁决凭证：路线规则无法证明地点、由 AI 在硬门内或运营从当前平台候选中
 * 明确选定的 POI 绑定。
 *
 * 凭证只由受控 POI 选择器或人工字段命令写入 diagnostics.poiAdjudications（AI patch 不能写），
 * 绑定在「当天原路线 key + 景点槽位 + poiId」上：运营改了原路线、改绑了 POI，
 * 凭证自动失效，复核与就绪检查回到规则判定。
 */

import { routeLocationKey } from './original-itinerary-route.js';
import { isItinerarySpotId, itinerarySpotKey } from './itinerary-spot-identity.js';
import { toPlatformShortLocationName } from './location-short-name.js';

type Json = Record<string, any>;

export interface PoiAdjudicationReceipt {
  day: number;
  spotId?: string;
  spotName: string;
  poiId: number;
  poiName: string;
  province?: string;
  city?: string;
  district?: string;
  routeKey: string;
  confidence: number;
  reasoning?: string;
  decidedAt: string;
}

export interface PoiAdjudicationMapping {
  day: number;
  spotId?: string;
  spotName: string;
  poiName: string;
  poiId: number;
  province?: string;
  city?: string;
  district?: string;
  adjudication?: { confidence: number; reasoning?: string };
}

/** 当前原路线下，该天该景点名对应的有效凭证（不要求已绑定）。 */
export function poiAdjudicationFor(product: Json, dayNumber: number, spotName: string): PoiAdjudicationReceipt | undefined {
  const receipt = currentSlotReceipt(product, dayNumber, spotName);
  if (!receipt) return undefined;
  // 产品省份改了，原路线 key 不一定变；裁决时的省份门也必须仍成立。
  const province = toPlatformShortLocationName(product.basicInfo?.province);
  return Boolean(province) && toPlatformShortLocationName(receipt.province) === province ? receipt : undefined;
}

/**
 * 写入护栏用：该槽位是否存在与本次绑定一致的受控凭证。
 *
 * 与 `hasCurrentPoiAdjudication` 的区别是不看省份门——省份门判断的是「凭证能否
 * 充当地域证据」，而护栏只问「这次绑定是否经受过控选择」。产品省份尚未落库时
 * 人工选点同样是受控的，不能因此被当成无凭证写入。
 */
export function poiBindingWasAdjudicated(product: Json, dayNumber: number, spotName: string, poiId: unknown): boolean {
  const receipt = currentSlotReceipt(product, dayNumber, spotName);
  return Boolean(receipt) && receipt!.poiId === Number(poiId);
}

/** 已保存绑定仍是凭证里那条 POI 时，凭证就是地域证据。 */
export function hasCurrentPoiAdjudication(product: Json, dayNumber: number, spotName: string, poiId: unknown): boolean {
  const receipt = poiAdjudicationFor(product, dayNumber, spotName);
  return Boolean(receipt) && receipt!.poiId === Number(poiId);
}

function currentSlotReceipt(product: Json, dayNumber: number, spotName: string): PoiAdjudicationReceipt | undefined {
  const day = (Array.isArray(product.itinerary) ? product.itinerary : []).find((value: Json) => Number(value?.day) === dayNumber);
  if (!day) return undefined;
  const spot = (Array.isArray(day.spots) ? day.spots : []).find((value: Json) => value && sameName(value.name, spotName));
  if (!spot) return undefined;
  const routeKey = routeLocationKey(product, day);
  return receipts(product).find(receipt => receipt.day === dayNumber && receipt.routeKey === routeKey && sameSlot(receipt, spot));
}

/**
 * 写回行程时更新凭证：本轮受控裁决的槽位换成新凭证；其余旧凭证只在原路线
 * 未变且槽位仍绑定同一 poiId 时保留。
 */
export function mergePoiAdjudications(product: Json, mappings: readonly PoiAdjudicationMapping[],
  decidedAt: string): PoiAdjudicationReceipt[] {
  const days: Json[] = Array.isArray(product.itinerary) ? product.itinerary : [];
  const fresh = mappings.flatMap((mapping): PoiAdjudicationReceipt[] => {
    const day = days.find(value => Number(value?.day) === mapping.day);
    if (!mapping.adjudication || !day) return [];
    return [{ day: mapping.day, ...(isItinerarySpotId(mapping.spotId) ? { spotId: mapping.spotId } : {}),
      spotName: mapping.spotName, poiId: mapping.poiId, poiName: mapping.poiName,
      ...(mapping.province ? { province: mapping.province } : {}), ...(mapping.city ? { city: mapping.city } : {}),
      ...(mapping.district ? { district: mapping.district } : {}),
      routeKey: routeLocationKey(product, day), confidence: mapping.adjudication.confidence,
      ...(mapping.adjudication.reasoning ? { reasoning: mapping.adjudication.reasoning } : {}), decidedAt }];
  });
  const kept = receipts(product).filter(receipt => !fresh.some(item => item.day === receipt.day
    && (sameName(item.spotName, receipt.spotName) || (item.spotId && item.spotId === receipt.spotId)))
    && poiAdjudicationFor(product, receipt.day, receipt.spotName) === receipt
    && boundPoiId(days, receipt) === receipt.poiId);
  return [...kept, ...fresh];
}

function boundPoiId(days: Json[], receipt: PoiAdjudicationReceipt): number {
  const day = days.find(value => Number(value?.day) === receipt.day);
  const spot = (Array.isArray(day?.spots) ? day.spots : []).find((value: Json) => value && sameSlot(receipt, value));
  return Number(spot?.poiId);
}

function receipts(product: Json): PoiAdjudicationReceipt[] {
  const values = product.diagnostics?.poiAdjudications;
  return (Array.isArray(values) ? values : []).filter((value: Json): value is PoiAdjudicationReceipt => Boolean(value)
    && Number.isInteger(value.day) && value.day > 0 && Number.isInteger(value.poiId) && value.poiId > 0
    && typeof value.spotName === 'string' && Boolean(value.spotName.trim())
    && typeof value.routeKey === 'string' && Boolean(value.routeKey));
}

function sameSlot(receipt: PoiAdjudicationReceipt, spot: Json): boolean {
  if (isItinerarySpotId(receipt.spotId) && isItinerarySpotId(spot.spotId)) return receipt.spotId === spot.spotId;
  return sameName(receipt.spotName, spot.name);
}

function sameName(left: unknown, right: unknown): boolean {
  const key = itinerarySpotKey(left);
  return Boolean(key) && key === itinerarySpotKey(right);
}
