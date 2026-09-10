import { agentProductContext } from "./integration-context.js";
import { agentPatchOperations } from "./integration-patch.js";
import { agentProductVersion } from "./integration-gates.js";
export { agentProductVersion } from "./integration-gates.js";
export { hasCompletePresentationRecommendations, type AgentBusinessDependencies } from "./integration-generate.js";
import {
  createGenerationStageTools,
  hasCompletePresentationRecommendations,
  patchRequestsRecommendations,
  type AgentBusinessDependencies,
} from "./integration-generate.js";
import { denyPreparationTool } from "./preparation-action-guard.js";
import { enrichItineraryPois } from "../planning/poi-enrichment.js";
import { syncInitialTrafficLineAvailability } from "../planning/traffic-line-availability.js";
import { resolveProductTrafficLineAvailability } from "../automation/ctrip/traffic-line/planning-availability.js";
import type { TrafficLineStationDisambiguator } from "../automation/ctrip/traffic-line/endpoints.js";
import type { ProductDetail } from "../../shared/contracts.js";
import { searchVbkResources, firstHotelResource } from "../operations/hotel-resource.js";
import { buildVehicleResourceQuery, searchVehicleResourceGroups, extractResourceGroups, bestResourceGroup, resolveVehicleResource } from "../operations/vehicle-resource.js";
import { applyAutoCoverFill } from "../operations/cover-auto-fill.js";
import { suggestPoiDetail } from "../infrastructure/poi-suggest.js";
import { getCtripSightAvailabilities } from "../infrastructure/ctrip-sight-availability.js";
import { compactPoiQueryResult, poiCandidatesForAvailability } from "./poi-query-compact.js";
import { searchAirports, searchTrainStations } from "../automation/ctrip/itinerary-api/station-search.js";
import { resolveItineraryHotelCandidates } from "../infrastructure/ctrip-hotel-search.js";
import { getProductBaseInfoApi } from "../automation/ctrip/basic-info/api.js";
import { DbOrchestratorRuntime } from "../planning/runtime.js";
import { refreshSatisfiedResearchTasks } from "../operations/research-refresh.js";
import { selfRepairItineraryForVbk } from "../planning/itinerary-self-repair.js";
import { isTravelNodeName } from "../planning/itinerary-adoption.js";
import type { AgentTool } from "./types.js";

type JsonObject = Record<string, unknown>;

function absentTravelNodeResearchTask(label: string, presentSpotNames: ReadonlySet<string>): boolean {
  const match = label.match(/^核查\s+(.+?)\s+的\s+VBK\s+POI\s+映射$/i);
  const name = match?.[1]?.trim() ?? "";
  return Boolean(name && isTravelNodeName(name) && !presentSpotNames.has(name));
}

const ITINERARY_SPOT_PATCH_SCHEMA = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string" }, timeOfDay: { enum: ["morning", "afternoon", "evening"] }, relation: { enum: ["and", "or"] },
    poiName: { type: "string" }, poiId: { type: "number" },
  },
};
const ITINERARY_DAY_PATCH_SCHEMA = {
  type: "object",
  required: ["day"],
  properties: {
    day: { type: "number" }, title: { type: "string" }, description: { type: "string" }, hotel: { type: "string" },
    meals: { type: "string" }, hotelDescription: { type: "string" }, spots: { type: "array", items: ITINERARY_SPOT_PATCH_SCHEMA },
  },
};
const PRODUCT_PATCH_SCHEMA = {
  type: "object",
  required: ["patch"],
  properties: {
    patch: {
      type: "object",
      properties: {
        basicInfo: { type: "object" }, presentation: { type: "object" }, operations: { type: "object" }, commercial: { type: "object" },
        itinerary: { type: "array", items: ITINERARY_DAY_PATCH_SCHEMA },
      },
    },
  },
};

function productData(product: ProductDetail): JsonObject { return product.product as JsonObject; }
function cleanText(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function safeJson(value: unknown): string { return JSON.stringify(value, null, 2).slice(0, 24_000); }

function requirePatch(args: JsonObject): JsonObject {
  const patch = args.patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("patch 必须是对象。");
  const allowed = new Set(["basicInfo", "presentation", "itinerary", "operations", "commercial"]);
  for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new Error(`不允许修改字段：${key}`);
  return patch as JsonObject;
}

/**
 * 酒店检索是受控资源核验，不应只写 itinerary。把候选和资源来源一起保存，
 * 才能让后续阶段可靠地进入 hotelResource，而不是被旧的 nonPlatform 标签跳过。
 */
export function applyResolvedItineraryHotels(
  product: JsonObject,
  resolved: Awaited<ReturnType<typeof resolveItineraryHotelCandidates>>,
): JsonObject {
  const first = resolved.dailyCandidates[0]?.candidates[0];
  if (!first) throw new Error("酒店候选为空，无法写入酒店资源。");
  const operations = product.operations && typeof product.operations === "object" && !Array.isArray(product.operations)
    ? product.operations as JsonObject
    : {};
  return {
    ...structuredClone(product),
    itinerary: resolved.itinerary,
    operations: {
      ...operations,
      hotelResource: {
        source: "ctrip",
        resourceId: first.hotelId,
        resourceName: first.hotelName,
        diamond: first.diamond,
        candidates: resolved.dailyCandidates[0]!.candidates,
        dailyCandidates: resolved.dailyCandidates,
      },
    },
  };
}

function positiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label}必须是正整数。`);
  return number;
}

export function selectItinerarySpot(product: ProductDetail, day: number, spotName: string) {
  const itinerary = Array.isArray(product.product.itinerary) ? product.product.itinerary as JsonObject[] : [];
  const dayIndex = itinerary.findIndex((item) => Number(item.day) === day);
  if (dayIndex < 0) throw new Error(`未找到第 ${day} 天行程。`);
  const spots = Array.isArray(itinerary[dayIndex]?.spots) ? itinerary[dayIndex].spots as unknown[] : [];
  const candidates = spots
    .map((spot, spotIndex) => ({ spot, spotIndex }))
    .filter((item): item is { spot: JsonObject; spotIndex: number } =>
      Boolean(item.spot) && typeof item.spot === "object" && !Array.isArray(item.spot));
  const matches = candidates.filter(({ spot }) => cleanText(spot.name) === spotName || cleanText(spot.poiName) === spotName);
  const suffixMatches = matches.length === 0
    ? candidates.filter(({ spot }) => {
      const names = [cleanText(spot.name), cleanText(spot.poiName)].filter(Boolean);
      return names.some((name) => name.endsWith(spotName) || spotName.endsWith(name));
    })
    : matches;
  if (suffixMatches.length !== 1) throw new Error(suffixMatches.length ? `第 ${day} 天存在多个「${spotName}」，请先调整名称。` : `第 ${day} 天未找到景点「${spotName}」。`);
  return { dayIndex, spotIndex: suffixMatches[0]!.spotIndex, spot: suffixMatches[0]!.spot };
}

/** Strip unverified POI ids from a freshly generated itinerary without crashing on sparse/string spots. */
export function clearUnverifiedItineraryPois(itinerary: unknown): void {
  if (!Array.isArray(itinerary)) return;
  for (const day of itinerary) {
    if (!day || typeof day !== "object" || Array.isArray(day)) continue;
    const spots = (day as JsonObject).spots;
    if (!Array.isArray(spots)) continue;
    for (let index = 0; index < spots.length; index += 1) {
      const spot = spots[index];
      if (typeof spot === "string") {
        const name = spot.trim();
        spots[index] = name ? { name, poiName: null, poiId: null } : null;
        continue;
      }
      if (!spot || typeof spot !== "object" || Array.isArray(spot)) continue;
      (spot as JsonObject).poiId = null;
      (spot as JsonObject).poiName = null;
    }
    (day as JsonObject).spots = spots.filter((spot) => spot && typeof spot === "object" && !Array.isArray(spot));
  }
}

/** Tools expose bounded reads and locally persisted structured edits. VBK writes are phase-scoped. */
export function createAgentBusinessTools(deps: AgentBusinessDependencies): AgentTool[] {
  const get = (localProductId: string) => {
    const product = deps.db.getProduct(localProductId);
    if (!product) throw new Error("产品不存在。");
    return product;
  };
  const withPage = <T>(work: () => Promise<T>) => deps.productWorkflows.runVbkPageExclusive(work);
  const trafficStationDisambiguator = (localProductId: string): TrafficLineStationDisambiguator => async (request) =>
    deps.disambiguateStationOption({ localProductId, ...request });
  const resolveTrafficAvailability = (localProductId: string) => resolveProductTrafficLineAvailability({
    db: deps.db,
    browser: deps.browser,
    localProductId,
    runVbkPageExclusive: task => withPage(task),
    disambiguateStation: trafficStationDisambiguator(localProductId),
  });
  const resolveItineraryPoisAndTraffic = async (localProductId: string) => {
    const current = get(localProductId);
    const runtime = new DbOrchestratorRuntime(deps.db, deps.browser, deps.productMutations, task => withPage(task), resolveTrafficAvailability, deps.disambiguatePoiOption);
    const tasks = await enrichItineraryPois({
      localProductId,
      destination: cleanText((current.product.basicInfo as JsonObject)?.meetingCity),
      runtime,
      persistedTaskKeys: new Set(current.researchTasks.map(task => `${task.type}::${task.label}`)),
      reviewCompletePois: true,
    });
    const latest = get(localProductId);
    const repair = selfRepairItineraryForVbk(latest.product.itinerary);
    if (repair.changed) {
      deps.productMutations.replace(localProductId, {
        ...productData(latest),
        itinerary: repair.itinerary,
      }, { status: latest.status });
    }
    const removed = new Set([
      ...repair.removedTravelNodes,
      ...repair.selectedAlternatives.flatMap((item) => item.removed),
    ]);
    const presentSpotNames = new Set(repair.itinerary.flatMap((day) => Array.isArray(day.spots)
      ? day.spots.filter((spot): spot is JsonObject => Boolean(spot) && typeof spot === "object" && !Array.isArray(spot))
        .map((spot) => cleanText(spot.name || spot.poiName))
      : []));
    const satisfiedTaskIds = get(localProductId).researchTasks
      .filter((task) => [...removed].some((name) => task.label.includes(name))
        || absentTravelNodeResearchTask(task.label, presentSpotNames))
      .map((task) => task.id);
    deps.db.markResearchTasksSatisfied(localProductId, satisfiedTaskIds);
    await syncInitialTrafficLineAvailability(localProductId, runtime);
    return { tasks, repair };
  };
  const tools: AgentTool[] = [
    ...createGenerationStageTools({
      deps, get, resolveTrafficAvailability, resolveItineraryPoisAndTraffic, clearUnverifiedItineraryPois,
    }),
    {
      name: "read_product", description: "读取当前产品结构、生命周期和已保存的自动化阶段。", parameters: { type: "object", properties: {} },
      async execute(_args, ctx) { return { content: JSON.stringify(agentProductContext(get(ctx.localProductId), deps.db.getAgentSnapshot?.(ctx.localProductId))) }; },
    },
    {
      name: "patch_product", requiresApproval: false, description: "合并保存本地规划字段（basicInfo、presentation、itinerary、operations、commercial）；系统锁定既有 meetingCity。用户明确指定大交通抵达/返程端点时，只能写 operations.trafficLine.arrivalCity / departureCity；不得写交通方式或启用状态，系统会调用接口核验。未指定端点才默认产品目的地。itinerary 的数据结构严格为逐日对象数组：[{day:1, title:'...', spots:[{name:'...', timeOfDay:'morning', relation:'and'|'or'}]}]。二选一/多选一必须保留每个原始景点，连续写在同一天同一时段，且每项 relation:'or'，供 VBK 录入为“或”。不接受 {item:...}、嵌套数组或 hotels 顶层字段；不允许填写新的 poiId/poiName，已查询到的候选只能由 select_itinerary_poi 写入。", parameters: PRODUCT_PATCH_SCHEMA,
      async execute(args, ctx) {
        const patch = requirePatch(args);
        const operations = agentPatchOperations(get(ctx.localProductId), patch);
        const result = deps.productMutations.applyAiPatch(ctx.localProductId, operations);
        if (!result.applied) throw new Error("没有可安全应用的产品修改。");
        const saved = result.product;
        if (patchRequestsRecommendations(patch)
          && !hasCompletePresentationRecommendations(productData(saved).presentation)) {
          throw new Error("推荐理由未持久化：必须恰好保留 3 条分类不重复、文本非空的 recommendations；请调用 ensure_presentation_recommendations。");
        }
        return {
          content: "已保存本地产品结构化修改。",
          data: {
            productVersion: agentProductVersion(saved),
            ...(patchRequestsRecommendations(patch) ? { recommendationsVerified: true } : {}),
          },
        };
      },
    },
    {
      name: "query_poi", description: "按名称查询 VBK POI 候选和详情，并标注 usable（可查到且未暂停营业）；返回精简结果，不写入平台。", parameters: { type: "object", required: ["keyword"], properties: { keyword: { type: "string" } } },
      async execute(args) {
        const keyword = cleanText(args.keyword);
        if (!keyword) throw new Error("缺少地点名称。");
        return withPage(async () => {
          const detail = await suggestPoiDetail(await deps.browser.page(), keyword);
          const candidates = poiCandidatesForAvailability({ keyword, detail });
          const availability = await getCtripSightAvailabilities(undefined, candidates.map((item) => item.poiId!), deps.db);
          return { content: safeJson(compactPoiQueryResult({ keyword, detail, availability })) };
        });
      },
    },
    {
      name: "select_itinerary_poi", description: "将 query_poi 已返回的一个真实可用候选，安全绑定到当前行程中的既有景点。仅可选择本次按该景点名称查询到、地域匹配且正常营业的候选；用于别名/官方名与用户原名不同的情况，不能用 patch_product 直接填写 POI ID。", parameters: { type: "object", required: ["day", "spotName", "poiId"], properties: { day: { type: "number" }, spotName: { type: "string" }, poiId: { type: "number" } } },
      async execute(args, ctx) {
        const day = positiveInteger(args.day, "day");
        const spotName = cleanText(args.spotName);
        const poiId = positiveInteger(args.poiId, "poiId");
        if (!spotName) throw new Error("缺少现有景点名称。");
        const current = get(ctx.localProductId);
        const { dayIndex, spotIndex, spot } = selectItinerarySpot(current, day, spotName);
        const basic = productData(current).basicInfo as JsonObject | undefined;
        const detail = await withPage(async () => suggestPoiDetail(await deps.browser.page(), spotName, {
          destinationCity: cleanText(basic?.destinationCity || basic?.meetingCity), province: cleanText(basic?.province),
        }));
        const candidate = detail.candidates.find((item) => item.poiId === poiId && item.selectable && item.poiName);
        if (!candidate?.poiName) throw new Error(`POI ${poiId} 不在「${spotName}」的当前可选查询结果中。`);
        const availability = await getCtripSightAvailabilities(undefined, [poiId], deps.db);
        if (availability.get(poiId)?.status === "suspended") throw new Error(`POI「${candidate.poiName}」已暂停营业，不能写入行程。`);
        const nextSpot: JsonObject = {
          ...spot,
          poiName: candidate.poiName,
          poiId,
          province: cleanText(candidate.province) || null,
          city: cleanText(candidate.city) || null,
          district: cleanText(candidate.district) || null,
        };
        const result = deps.productMutations.applyAiPatch(ctx.localProductId, [
          { op: "replace", path: `/itinerary/${dayIndex}/spots/${spotIndex}`, value: nextSpot },
        ]);
        if (!result.applied) throw new Error("已核验的 POI 未能保存到行程。");
        refreshSatisfiedResearchTasks(deps.db, ctx.localProductId);
        deps.emitProduct(get(ctx.localProductId));
        return { content: safeJson({ day, spotName, poiName: candidate.poiName, poiId, province: candidate.province, city: candidate.city }) };
      },
    },
    {
      name: "query_hotel_resource", description: "读取 VBK 酒店资源候选，不创建或绑定资源。", parameters: { type: "object", properties: {} },
      async execute(_args, ctx) { return withPage(async () => { const product = get(ctx.localProductId); const payload = await searchVbkResources(await deps.browser.page()); const city = cleanText((productData(product).basicInfo as JsonObject | undefined)?.destinationCity); return { content: safeJson({ selected: firstHotelResource(payload, city), payload }) }; }); },
    },
    {
      name: "resolve_itinerary_hotels", description: "为已有逐日行程查询当天最后景点附近的真实酒店候选，并安全写回 itinerary。", parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        const current = get(ctx.localProductId); const data = productData(current);
        const itinerary = Array.isArray(data.itinerary) ? data.itinerary as JsonObject[] : [];
        const basicInfo = data.basicInfo as JsonObject | undefined;
        const operations = data.operations as JsonObject | undefined;
        const city = cleanText(basicInfo?.destinationCity);
        const nights = Number(basicInfo?.nights);
        const resolved = await resolveItineraryHotelCandidates(itinerary, city, nights, cleanText(operations?.hotelTier));
        deps.productMutations.replace(ctx.localProductId, applyResolvedItineraryHotels(data, resolved), { status: current.status });
        return { content: safeJson({ dailyCandidates: resolved.dailyCandidates, searchDates: resolved.searchDates }) };
      },
    },
    {
      name: "read_vbk_phase", description: "按当前 productId 从 VBK 读取基础信息，并返回本地阶段快照，用于核对不确定写入。", parameters: { type: "object", properties: {} },
      async execute(_args, ctx) { const product = get(ctx.localProductId); const remote = product.productId ? await withPage(async () => getProductBaseInfoApi(await deps.browser.page(), product.productId!)) : null; return { content: safeJson({ productId: product.productId, status: product.status, automation: product.automation, remote }) }; },
    },
    {
      name: "query_vehicle_resource", description: "按城市、座位和天数查询 VBK 用车资源候选，不绑定资源；seats 缺省为 5 座。", parameters: { type: "object", properties: { city: { type: "string" }, seats: { type: "number" }, days: { type: "number" }, tier: { type: "string" } } },
      async execute(args) { return withPage(async () => { const query = buildVehicleResourceQuery(args); const payload = await searchVehicleResourceGroups(await deps.browser.page(), query.query); const groups = extractResourceGroups(payload); return { content: safeJson({ query, selected: bestResourceGroup(payload), groups }) }; }); },
    },
    {
      name: "resolve_cover", description: "查询携程图库并将完整封面候选安全写入 presentation.cover。", parameters: { type: "object", properties: {} },
      async execute(_args, ctx) { const current = get(ctx.localProductId); const filled = await withPage(async () => applyAutoCoverFill({ page: await deps.browser.page(), product: productData(current) })); const result = deps.productMutations.replace(ctx.localProductId, filled.nextProduct, { status: current.status }); return { content: safeJson(filled.outcome), data: { productVersion: agentProductVersion(result) } }; },
    },
    {
      name: "resolve_vehicle_resource", description: "查询并选择真实 VBK 用车资源组，安全写入 operations.vehicleResource，不绑定到 VBK 产品。", parameters: { type: "object", properties: {} },
      async execute(_args, ctx) { const current = get(ctx.localProductId); const resolved = await withPage(async () => resolveVehicleResource(await deps.browser.page(), current)); const result = deps.productMutations.replace(ctx.localProductId, resolved.product, { status: current.status }); return { content: resolved.note, data: { productVersion: agentProductVersion(result) } }; },
    },
    {
      name: "query_station", description: "查询机场或火车站候选，不写入行程。", parameters: { type: "object", required: ["keyword", "kind"], properties: { keyword: { type: "string" }, kind: { enum: ["airport", "train"] } } },
      async execute(args) { return withPage(async () => { const keyword = cleanText(args.keyword); const page = await deps.browser.page(); const stations = args.kind === "train" ? await searchTrainStations(page, keyword) : await searchAirports(page, keyword); return { content: safeJson(stations) }; }); },
    },
    {
      name: "recheck_traffic_line_availability",
      description: "使用当前 VBK 会话重新核验飞机和火车端点；只把当前会话确认可用的方式写入本地 operations.trafficLine 子产品计划。不会创建、保存或写入任何 VBK 交通子产品。",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        const runtime = new DbOrchestratorRuntime(
          deps.db, deps.browser, deps.productMutations, task => withPage(task), resolveTrafficAvailability, deps.disambiguatePoiOption,
        );
        const result = await syncInitialTrafficLineAvailability(ctx.localProductId, runtime);
        const operations = productData(get(ctx.localProductId)).operations as JsonObject | undefined;
        return { content: safeJson({ result, trafficLine: operations?.trafficLine ?? null }) };
      },
    },
    {
      name: "resolve_itinerary_pois", description: "逐个核查当前行程的真实 POI、地区和营业状态，填入已验证 ID。普通未命中景点保持原名原位并进入人工确认；明确二选一/多选一只要至少一个原始选项已核验，就自动保留可录入选项并记录被排除项，不再中途询问。交通、接送和入住节点自动移出 POI 列表。", parameters: {type:"object",properties:{}},
      async execute(_args, ctx) {
        const result = await resolveItineraryPoisAndTraffic(ctx.localProductId);
        refreshSatisfiedResearchTasks(deps.db, ctx.localProductId);
        deps.emitProduct(get(ctx.localProductId));
        return {content:safeJson({...result,itinerary:get(ctx.localProductId).product.itinerary})};
      },
    },
  ];
  const localWrites = new Set(["generate_product_module", "ensure_presentation_recommendations", "patch_product", "select_itinerary_poi", "recheck_traffic_line_availability", "resolve_itinerary_pois", "resolve_itinerary_hotels", "resolve_cover", "resolve_vehicle_resource"]);
  return tools.map((tool) => {
    const execute = async (args: Record<string, unknown>, ctx: Parameters<AgentTool["execute"]>[1]) => {
      if (tool.name !== "read_product") {
        const current = get(ctx.localProductId);
        const denied = denyPreparationTool(current, deps.db.getAgentSnapshot?.(ctx.localProductId), tool.name, args);
        if (denied) return denied;
      }
      return tool.execute(args, ctx);
    };
    if (!localWrites.has(tool.name)) return { ...tool, execute };
    return {
      ...tool, write: true, requiresApproval: false,
      execute: async (args, ctx) => deps.productWorkflows.runExclusive(ctx.localProductId, "planning", async () => {
        const before = get(ctx.localProductId).product;
        const result = await execute(args, ctx);
        const after = get(ctx.localProductId);
        const changedSections = Object.keys(after.product).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after.product[key]));
        if (changedSections.length) deps.emitProduct(after);
        return { ...result, data: { ...result.data, changedSections } };
      }),
    };
  });
}
