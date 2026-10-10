import { hotelDowngradePermission } from "../../shared/hotel-downgrade-policy.js";
import type { AiResponse, ProductDetail } from '../../shared/contracts.js';
import { coerceProductFeaturesHtml } from '../domain/product/features-rich-text.js';
import { extractLockedConstraints } from './prompt-helpers.js';
import { itineraryInputContractError } from '../planning/itinerary-input-contract.js';
import { itineraryDaySchema } from '../planning/itinerary-day-schema.js';
import { normaliseHotelTier, inferHotelTierFromUserText, hotelDiamondFromTier } from '../../shared/hotel-tiers.js';

type Json = Record<string, unknown>;
type Patch = NonNullable<AiResponse['patch']>;
const roots = new Set(['basicInfo','presentation','itinerary','operations','commercial']);
const forbidden = ['supplierProductCode','butler','bookingControls','hotelResource','resourceId','resourceGroupId','resourceGroupName','imageId','imageUrl','providerId','contactCardId'];
function record(value: unknown): value is Json { return !!value && typeof value === 'object' && !Array.isArray(value); }

/** Leaf patches preserve unrelated fields and cannot smuggle IDs via a parent replacement. */
export function agentPatchOperations(product: ProductDetail, patch: Json, options: { hotelTierInstruction?: string } = {}): Patch {
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
  assertHotelTierPatch(product, effectivePatch, options.hotelTierInstruction);
  const fallback = record(effectivePatch.operations) && record(effectivePatch.operations.hotelFallbackPolicy) ? effectivePatch.operations.hotelFallbackPolicy : undefined;
  if (fallback && Object.hasOwn(fallback, "allowDowngrade")) {
    const currentOps = record(product.product.operations) ? product.product.operations : {};
    const currentPolicy = record(currentOps.hotelFallbackPolicy) ? currentOps.hotelFallbackPolicy : {};
    const userText = options.hotelTierInstruction ?? product.messages?.filter(item => item.role === "user").at(-1)?.content ?? "";
    if (typeof fallback.allowDowngrade !== "boolean" || (fallback.allowDowngrade !== currentPolicy.allowDowngrade
      && hotelDowngradePermission(userText) !== fallback.allowDowngrade)) throw new Error("自动降钻规则只能依据用户明确的允许或拒绝修改。");
  }
  assertDailyHotelRatingPatch(product, effectivePatch, options.hotelTierInstruction);
  assertDailyHotelLocationPatch(product, effectivePatch, options.hotelTierInstruction);
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

function assertDailyHotelLocationPatch(product: ProductDetail, patch: Json, instruction = ""): void {
  const before = Array.isArray(product.product.itinerary) ? product.product.itinerary.filter(record) : [];
  for (const day of Array.isArray(patch.itinerary) ? patch.itinerary.filter(record) : []) {
    const previous = before.find(item => Number(item.day) === Number(day.day));
    const current = record(previous?.hotelRequirement) ? previous.hotelRequirement : {};
    const next = record(day.hotelRequirement) ? day.hotelRequirement : {};
    const choice = structuredHotelChoice(instruction, Number(day.day));
    const movedStay = choice?.text.match(/改住\s*([\p{Script=Han}]{2,12}?)(?:市区)?[1-5一二三四五]钻/u)?.[1]?.trim();
    for (const key of ["anchorName", "cityName"] as const) {
      if (current[key] && next[key] !== current[key] && (!movedStay || next[key] !== movedStay)) {
        throw new Error(`第 ${day.day} 天住宿地点已锁定，降档不能改变住宿锚点或城市。`);
      }
    }
    if (typeof current.maxDistanceKm === "number" && (typeof next.maxDistanceKm !== "number" || next.maxDistanceKm > current.maxDistanceKm)
      && !movedStay && !(choice?.maxDistanceKm && choice.maxDistanceKm === next.maxDistanceKm)) throw new Error(`第 ${day.day} 天住宿距离范围不能未经明确选择扩大或移除。`);
  }
}

function assertDailyHotelRatingPatch(product: ProductDetail, patch: Json, instruction?: string): void {
  const before = Array.isArray(product.product.itinerary) ? product.product.itinerary.filter(record) : [];
  const after = Array.isArray(patch.itinerary) ? patch.itinerary.filter(record) : [];
  const message = instruction ?? product.messages?.filter(message => message.role === "user").at(-1)?.content ?? "";
  for (const day of after) {
    const next = record(day.hotelRequirement) ? day.hotelRequirement : {};
    const currentDay = before.find(item => item.day === day.day);
    const current = record(currentDay?.hotelRequirement) ? currentDay.hotelRequirement : {};
    if (next.diamond === current.diamond && next.ratingType === current.ratingType) continue;
    if (next.diamond === undefined && next.ratingType === undefined) continue;
    const ops = record(product.product.operations) ? product.product.operations : {};
    if (current.diamond === undefined && current.ratingType === undefined
      && next.diamond === hotelDiamondFromTier(typeof ops.hotelTier === "string" ? ops.hotelTier : undefined)
      && next.ratingType === "diamond") continue;
    // 初次设置每日等级可依据原始逐晚要求；已有等级变更仍只接受本次明确选择。
    const basic = record(product.product.basicInfo) ? product.product.basicInfo : {};
    const requirement = current.diamond === undefined && current.ratingType === undefined
      ? `${message}\n${typeof basic.userIdea === "string" ? basic.userIdea : ""}` : message;
    const structuredChoice = structuredHotelChoice(requirement, Number(day.day));
    const choice = structuredChoice?.text
      ?? requirement.match(new RegExp(`(?:D${day.day}|第\\s*${day.day}\\s*(?:天|晚))[^。；;\\n，,]*`, "i"))?.[0]
      ?? "";
    const explicitDiamond = structuredChoice?.diamond ?? hotelChoiceGrade(choice);
    const explicitType = structuredChoice?.ratingType
      ?? (/民宿|客栈|圆钻/.test(choice) ? "homestay" : /星级/.test(choice) ? "star" : /酒店|无钻|0\s*钻|[1-5一二三四五]\s*钻/.test(choice) ? "diamond" : undefined);
    if (/不允许|不得|禁止|不要|不同意|拒绝|不能/.test(choice) || (next.diamond !== undefined && next.diamond !== explicitDiamond)
      || (next.ratingType !== undefined && next.ratingType !== explicitType)) {
      throw new Error(`第 ${day.day} 天住宿评级变更必须有用户对该日期、等级和住宿类型的明确选择，不能自动降档。`);
    }
  }
}

function hotelChoiceGrade(text: string): number {
  if (/无钻|0\s*钻/u.test(text)) return 0;
  const raw = text.match(/([1-5一二三四五])\s*(?:民宿)?(?:圆)?(?:钻|星)/u)?.[1];
  return raw ? Number(raw) || "一二三四五".indexOf(raw) + 1 : NaN;
}

/** Structured ask_user answers are persisted as resolved key/value pairs. */
function structuredHotelChoice(message: string, day: number): { text: string; diamond?: number; maxDistanceKm?: number; ratingType?: "diamond" | "star" | "homestay" } | undefined {
  const candidates = [message.replace(/^用户回答：/, "").trim(), ...(message.match(/\{[^{}\n]+\}/g) ?? [])];
  const entry = candidates.flatMap((candidate) => {
    try {
      const parsed: unknown = JSON.parse(candidate);
      return record(parsed) ? Object.entries(parsed) : [];
    } catch { return []; }
  }).map(([key, value]) => [key, Array.isArray(value) && value.length === 1 ? value[0] : value] as const)
    .reverse().find(([key, value]) =>
      new RegExp(`^(?:(?:day|第)${day}(?:hotel|住宿|酒店)?(?:_|$)|hotel${day}$)`, "i").test(key));
  if (!entry) return undefined;
  if (typeof entry[1] !== "string") return undefined;
  const text = entry[1];
  const diamond = hotelChoiceGrade(text);
  const maxDistanceKm = Number(text.match(/(\d+(?:\.\d+)?)\s*公里|(?:放宽|距离)[^\d]{0,6}(\d+(?:\.\d+)?)\s*km/i)?.[1] ?? text.match(/(?:放宽|距离)[^\d]{0,6}(\d+(?:\.\d+)?)\s*km/i)?.[1]);
  const ratingType = /民宿|客栈|圆钻/.test(text) ? "homestay" : /星级/.test(text) ? "star" : /酒店|无钻|0\s*钻|[1-5一二三四五]\s*钻/.test(text) ? "diamond" : undefined;
  return { text, ...(Number.isInteger(diamond) && diamond >= 0 ? { diamond } : {}), ...(Number.isFinite(maxDistanceKm) && maxDistanceKm > 0 ? { maxDistanceKm } : {}), ...(ratingType ? { ratingType } : {}) };
}

/** Apply a persisted per-day hotel choice before the resolver runs again. */
export function applyPersistedHotelTierChoices(product: Json, instruction: string): Json {
  const itinerary = Array.isArray(product.itinerary) ? structuredClone(product.itinerary) as unknown[] : [];
  let changed = false;
  for (const value of itinerary) {
    if (!record(value)) continue;
    const day = Number(value.day);
    const choice = structuredHotelChoice(instruction, day);
    if (choice?.diamond === undefined || !choice.ratingType || /不允许|不得|禁止|不要|不同意|拒绝|不能/.test(choice.text)) continue;
    const current = record(value.hotelRequirement) ? value.hotelRequirement : {};
    const movedStay = choice.text.match(/改住\s*([\p{Script=Han}]{2,12}?)(?:市区)?[1-5一二三四五]钻/u)?.[1]?.trim();
    if (movedStay) {
      value.hotelRequirement = {
        ...current,
        anchorName: movedStay,
        cityName: movedStay,
        diamond: choice.diamond,
        ratingType: choice.ratingType,
      };
      delete (value.hotelRequirement as Json).maxDistanceKm;
      changed = true;
      continue;
    }
    const anchorName = typeof current.anchorName === "string" ? current.anchorName : "";
    const spots = Array.isArray(value.spots) ? value.spots.filter(record) : [];
    const locationSpot = spots.find((spot) => {
      const name = typeof spot.name === "string" ? spot.name : "";
      const poiName = typeof spot.poiName === "string" ? spot.poiName : "";
      return Boolean(anchorName && (name.includes(anchorName) || poiName.includes(anchorName) || anchorName.includes(name)));
    });
    const cityName = typeof locationSpot?.district === "string" && locationSpot.district.trim()
      ? locationSpot.district
      : typeof locationSpot?.city === "string" && locationSpot.city.trim()
        ? locationSpot.city
        : typeof current.cityName === "string" && current.cityName.trim() ? current.cityName : undefined;
    value.hotelRequirement = {
      ...current,
      diamond: choice.diamond,
      ratingType: choice.ratingType,
      ...(choice.maxDistanceKm ? { maxDistanceKm: choice.maxDistanceKm } : {}),
      ...(cityName ? { cityName } : {}),
    };
    changed = true;
  }
  return changed ? { ...structuredClone(product), itinerary } : product;
}

/** 酒店核验失败不是降档授权；无关“继续”消息不能继承旧的变更请求。 */
function assertHotelTierPatch(product: ProductDetail, patch: Json, instruction?: string): void {
  if (record(patch.basicInfo) && Object.hasOwn(patch.basicInfo, "hotelTier")) {
    throw new Error("酒店档次只使用 operations.hotelTier；basicInfo.hotelTier 不是有效业务字段。");
  }
  const operations = record(patch.operations) ? patch.operations : undefined;
  if (!operations || !Object.hasOwn(operations, "hotelTier")) return;
  const currentOperations = record(product.product.operations) ? product.product.operations : undefined;
  const current = normaliseHotelTier(currentOperations?.hotelTier);
  const next = normaliseHotelTier(operations.hotelTier);
  if (!next) throw new Error("酒店档次必须使用已核验的白名单值。");
  if (!current || current === next) return;
  const message = instruction ?? product.messages?.filter(message => message.role === "user").at(-1)?.content;
  if (inferHotelTierFromUserText(message) !== next) {
    throw new Error(`酒店档次已保存为 ${current}；未经用户明确改变住宿档次，不得为绕过检索失败改为 ${next}。`);
  }
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
    if (Object.hasOwn(candidate, 'activities') && !itineraryDaySchema.shape.activities.safeParse(candidate.activities).success) {
      throw new Error(`第 ${dayNumber} 天 activities 必须是含 time、title、detail、type 的活动数组，不能使用 {item:...} 包装；未保存任何修改。`);
    }
    const before = byDay.get(dayNumber);
    if (before && Array.isArray(before.spots) && before.spots.length > 0
      && Array.isArray(candidate.spots) && candidate.spots.length === 0) {
      throw new Error('不能通过局部补丁清空既有景点；请使用重新生成行程的受控入口。');
    }
    const hotelRequirement = record(candidate.hotelRequirement) ? { ...(record(before?.hotelRequirement) ? before.hotelRequirement : {}), ...candidate.hotelRequirement } : undefined;
    if (hotelRequirement) {
      for (const key of ["diamond", "maxDistanceKm"] as const) {
        const value = hotelRequirement[key];
        if (typeof value !== "string") continue;
        const numeric = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
        if (!Number.isFinite(numeric) || (key === "diamond" ? numeric < 0 : numeric <= 0) || key === "diamond" && (!Number.isInteger(numeric) || numeric > 5)) throw new Error(`住宿要求 ${key} 数值无效。`);
        hotelRequirement[key] = numeric;
      }
    }
    return { ...(before ?? {}), ...candidate, ...(hotelRequirement ? { hotelRequirement } : {}), day: dayNumber };
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
