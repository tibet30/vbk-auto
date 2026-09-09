import type { AiResponse, ProductDetail } from '../../shared/contracts.js';
import { coerceProductFeaturesHtml } from '../domain/product/features-rich-text.js';
import { extractLockedConstraints } from './prompt-helpers.js';
import { itineraryInputContractError } from '../planning/itinerary-input-contract.js';

type Json = Record<string, unknown>;
type Patch = NonNullable<AiResponse['patch']>;
const roots = new Set(['basicInfo','presentation','itinerary','operations','commercial']);
const forbidden = ['supplierProductCode','butler','bookingControls','hotelResource','resourceId','resourceGroupId','resourceGroupName','imageId','imageUrl','providerId','contactCardId'];
function record(value: unknown): value is Json { return !!value && typeof value === 'object' && !Array.isArray(value); }

/** Leaf patches preserve unrelated fields and cannot smuggle IDs via a parent replacement. */
export function agentPatchOperations(product: ProductDetail, patch: Json): Patch {
  for (const key of Object.keys(patch)) if (!roots.has(key)) throw new Error(`不允许修改字段：${key}`);
  // `patch_product` is documented as a merge. A JSON patch replaces arrays,
  // though, so a request such as `{ itinerary: [{ day: 1, hotel: "..." }] }`
  // previously replaced the complete itinerary and silently discarded every
  // `spots` array. Keep generated/rebuilt itineraries on their dedicated tool;
  // this conversational patch path may only overlay the supplied days.
  const presentationPatch = record(patch.presentation) ? { ...patch.presentation } : undefined;
  if (presentationPatch && Object.hasOwn(presentationPatch, 'features')) {
    const features = coerceProductFeaturesHtml(presentationPatch.features);
    if (!features) throw new Error('presentation.features 必须是非空 HTML 字符串，不能是对象/数组。');
    presentationPatch.features = features;
  }
  const effectivePatch: Json = {
    ...patch,
    ...(presentationPatch ? { presentation: presentationPatch } : {}),
    ...(Object.hasOwn(patch, "itinerary")
      ? { itinerary: mergeItineraryDays(product.product.itinerary, patch.itinerary) }
      : {}),
  };
  assertTrafficLineEndpointPatch(effectivePatch);
  if (Array.isArray(effectivePatch.itinerary)) {
    const contractError = itineraryInputContractError(product, effectivePatch.itinerary);
    if (contractError) throw new Error(contractError);
  }
  assertLockedPlanningPatch(product, effectivePatch);
  const operations: Patch = [];
  const walk = (before: unknown, after: unknown, parts: string[]) => {
    const key = parts.at(-1)!;
    if (['__proto__','prototype','constructor'].includes(key)) throw new Error('字段路径不安全');
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    if (forbidden.includes(key)) throw new Error(`字段 ${parts.join('.')} 必须通过资源核验工具修改。`);
    if (key === 'vehicleResource' && record(after)) {
      for (const field of Object.keys(after)) if (field !== 'requestedTotalCost' && JSON.stringify(record(before) ? before[field] : undefined) !== JSON.stringify(after[field])) throw new Error('用车资源身份必须由匹配工具写入。');
    }
    if (record(after)) {
      for (const [child,value] of Object.entries(after)) walk(record(before) ? before[child] : undefined,value,[...parts,child]);
    } else {
      if (parts[0] === 'itinerary') assertPoiReferences(product, after);
      operations.push({op:'replace',path:`/${parts.map(part=>encodeURIComponent(part)).join('/')}`,value:after});
    }
  };
  for (const [key,value] of Object.entries(effectivePatch)) walk(product.product[key],value,[key]);
  if (!operations.length) throw new Error('没有需要修改的字段。');
  return operations;
}

/** AI may transcribe an explicit endpoint choice, but availability still owns the sellable variants. */
function assertTrafficLineEndpointPatch(patch: Json): void {
  const operations = record(patch.operations) ? patch.operations : undefined;
  if (!operations || !Object.hasOwn(operations, "trafficLine")) return;
  const trafficLine = operations.trafficLine;
  if (!record(trafficLine)) {
    throw new Error("大交通只能补充明确端点城市；飞机/火车是否可售必须由接口核验。");
  }
  for (const [key, value] of Object.entries(trafficLine)) {
    if (!["arrivalCity", "departureCity"].includes(key) || typeof value !== "string") {
      throw new Error("大交通只能补充明确端点城市；飞机/火车是否可售必须由接口核验。");
    }
  }
}

function assertLockedPlanningPatch(product: ProductDetail, patch: Json): void {
  const locked = extractLockedConstraints(product, (product.messages ?? []).filter((message) => message.role === "user"));
  const basic = record(patch.basicInfo) ? patch.basicInfo : undefined;
  const operations = record(patch.operations) ? patch.operations : undefined;
  if (locked.days && basic?.days !== undefined && Number(basic.days) !== locked.days) {
    throw new Error(`出行天数已锁定为 ${locked.days} 天，不能改为 ${basic.days}`);
  }
  if (locked.transport && operations?.transport !== undefined && operations.transport !== locked.transport) {
    throw new Error(`交通方式已锁定为 ${locked.transport}，不能覆盖`);
  }
}

function mergeItineraryDays(current: unknown, incoming: unknown): Json[] {
  if (!Array.isArray(incoming)) throw new Error('行程必须是逐日列表。');
  const existingDays = Array.isArray(current) ? current.filter(record) : [];
  const byDay = new Map(existingDays.map((day) => [Number(day.day), day]));
  const seen = new Set<number>();
  const merged: Json[] = incoming.map((candidate): Json => {
    if (!record(candidate)) throw new Error('行程日期格式无效。');
    const dayNumber = Number(candidate.day);
    if (!Number.isInteger(dayNumber) || dayNumber < 1 || seen.has(dayNumber)) {
      throw new Error('行程日期必须是唯一的正整数。');
    }
    seen.add(dayNumber);
    const before = byDay.get(dayNumber);
    if (before && Array.isArray(before.spots) && before.spots.length > 0
      && Array.isArray(candidate.spots) && candidate.spots.length === 0) {
      throw new Error('不能通过局部补丁清空既有景点；请使用重新生成行程的受控入口。');
    }
    return { ...(before ?? {}), ...candidate, day: dayNumber };
  });
  // Partial day updates must not delete days which the caller did not mention.
  for (const day of existingDays) if (!seen.has(Number(day.day))) merged.push(structuredClone(day));
  return merged.sort((left, right) => Number(left.day) - Number(right.day));
}
function assertPoiReferences(product: ProductDetail, itinerary: unknown): void {
  if (!Array.isArray(itinerary)) throw new Error('行程必须是逐日列表。');
  const originals = new Set<string>();
  for (const day of (product.product.itinerary ?? []) as Json[]) {
    for (const spot of (Array.isArray(day.spots) ? day.spots : []).filter(record)) {
      if (spot.poiId) originals.add(`${spot.poiId}:${spot.poiName}`);
    }
  }
  for (const day of itinerary) {
    if (!record(day)) throw new Error('行程日期格式无效。');
    for (const spot of Array.isArray(day.spots) ? day.spots : []) {
      if (record(spot) && spot.poiId && !originals.has(`${spot.poiId}:${spot.poiName}`)) {
        throw new Error('行程补丁不能携带新增或改名后的 POI ID。请仅提交 name、timeOfDay、relation 等非 POI 字段；随后调用 resolve_itinerary_pois 统一核验并绑定。');
      }
    }
    if (Array.isArray(day.hotelCandidates)) {
      const known = new Set(((product.product.itinerary ?? []) as Json[]).flatMap(d=>Array.isArray(d.hotelCandidates)?d.hotelCandidates:[]).map(c=>JSON.stringify(c)));
      if (day.hotelCandidates.some(candidate=>!known.has(JSON.stringify(candidate)))) throw new Error('酒店候选必须通过酒店核验工具生成。');
    }
  }
}
