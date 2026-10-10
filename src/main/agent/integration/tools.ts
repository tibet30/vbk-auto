/**
 * createAgentBusinessTools：把 generation / itineraryDraft / creationRecovery 三组
 * 子工具合并为一个 AgentTool[]，并对每个 tool 包装：
 *   - read_product 之外的 tool 都先过 denyPreparationTool（preparation 阶段禁用）；
 *   - 列入 localWrites 的 tool（patch_product / select_itinerary_poi / ...）走
 *     productWorkflows.runExclusive("planning") 互斥锁，写入完成后比对 changedSections
 *     并 emitProduct 通知 renderer；
 *
 * 内部变量 withPage / trafficStationDisambiguator / resolveTrafficAvailability /
 * resolveItineraryPoisAndTraffic 把 deps + closure 串起来，避免每个工具单独
 * 重复连接。
 */

import { PRODUCT_PATCH_SCHEMA } from "../integration-patch-schema.js";
import { resolveAdministrativeRouteNodes } from "../integration-route-administrative.js";
import { historicalHotelTierInstruction } from "../historical-hotel-tier-choices.js";
import { hotelAnswerInstruction } from "../hotel-answer-instruction.js";
import { createItineraryHotelTool } from "../integration-itinerary-hotel-tool.js";
import { getVbkRequestPage } from "../../infrastructure/vbk-request-page.js";
import { agentProductContext } from "../integration-context.js";
import { agentPatchOperations, applyPersistedHotelTierChoices } from "../integration-patch.js";
import { agentProductVersion } from "../integration-gates.js";
import {
  createGenerationStageTools,
  hasCompletePresentationRecommendations,
  patchRequestsRecommendations,
  type AgentBusinessDependencies,
} from "../integration-generate.js";
import { denyPreparationTool } from "../preparation-action-guard.js";
import { enrichItineraryPois } from "../../planning/poi-enrichment.js";
import { isPlanningPoiCandidateInContext } from "../../planning/poi-auto-selection.js";
import { syncInitialTrafficLineAvailability } from "../../planning/traffic-line-availability.js";
import { resolveProductTrafficLineAvailability } from "../../automation/ctrip/traffic-line/planning-availability.js";
import type { TrafficLineStationDisambiguator } from "../../automation/ctrip/traffic-line/endpoints.js";
import type { ProductDetail } from "../../../shared/contracts.js";
import { requiresItineraryPoi } from "../../../shared/itinerary-activity-kind.js";
import { searchVbkResources, firstHotelResource } from "../../operations/hotel-resource.js";
import { buildVehicleResourceQuery, searchVehicleResourceGroups, extractResourceGroups, bestResourceGroup, resolveVehicleResource } from "../../operations/vehicle-resource.js";
import { applyAutoCoverFill } from "../../operations/cover-auto-fill.js";
import { suggestPoiDetail } from "../../infrastructure/poi-suggest.js";
import { getCtripSightAvailabilities } from "../../infrastructure/ctrip-sight-availability.js";
import { compactPoiQueryResult, poiCandidatesForAvailability } from "../poi-query-compact.js";
import { searchAirports, searchTrainStations } from "../../automation/ctrip/itinerary-api/station-search.js";
import { getProductBaseInfoApi } from "../../automation/ctrip/basic-info/api.js";
import { DbOrchestratorRuntime } from "../../planning/runtime.js";
import { refreshSatisfiedResearchTasks } from "../../operations/research-refresh.js";
import { selfRepairItineraryForVbk } from "../../planning/itinerary-self-repair.js";
import { createItineraryDraftTools } from "../integration-itinerary-draft-tools.js";
import { createCreationRecoveryTools } from "../integration-creation-recovery-tools.js";
import type { AgentTool } from "../types.js";
import { cleanText, productData, positiveInteger, requirePatch, safeJson, selectItinerarySpot, type JsonObject, clearUnverifiedItineraryPois as clearUnverifiedItineraryPoisImpl } from "./util.js";

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
    const { current, converted } = await resolveAdministrativeRouteNodes(get(localProductId), deps, withPage);
    const runtime = new DbOrchestratorRuntime(deps.db, deps.browser, deps.productMutations, task => withPage(task), resolveTrafficAvailability, deps.disambiguatePoiOption);
    const tasks = await enrichItineraryPois({
      localProductId,
      destination: cleanText((current.product.basicInfo as JsonObject)?.meetingCity),
      runtime,
      persistedTaskKeys: new Set(current.researchTasks.map(task => `${task.type}::${task.label}`)),
      reviewCompletePois: true,
    });
    const latest = get(localProductId);
    const repair = selfRepairItineraryForVbk(latest.product.itinerary, Number((latest.product.basicInfo as JsonObject)?.nights));
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
        || absentTravelNodeResearchTaskLocal(task.label, presentSpotNames))
      .map((task) => task.id);
    deps.db.markResearchTasksSatisfied(localProductId, satisfiedTaskIds);
    await syncInitialTrafficLineAvailability(localProductId, runtime);
    return { tasks, repair, administrativeNodes: converted };
  };
  const tools: AgentTool[] = [
    ...createGenerationStageTools({
      deps, get, resolveTrafficAvailability, resolveItineraryPoisAndTraffic, clearUnverifiedItineraryPois: clearUnverifiedItineraryPoisImpl,
    }),
    ...createItineraryDraftTools({ browserFor: () => deps.browser, get, withPage }),
    ...createCreationRecoveryTools(deps, get),
    {
      name: "continue_approved_workflow",
      requiresApproval: true,
      description: "在当前产品已有有效录入授权时，继续执行已确认的自动录入阶段。不会重新规划或创建母产品；由自动化执行器负责既有交通子产品的资源同步、保存和最终回读。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_args, ctx) {
        await deps.automation.executeApprovedWorkflow(ctx.localProductId);
        return { content: "已启动当前授权范围内的自动录入阶段，等待资源保存与最终远端回读。", terminal: true };
      },
    },
    {
      name: "read_product", description: "读取当前产品结构、生命周期和已保存的自动化阶段。", parameters: { type: "object", properties: {} },
      async execute(_args, ctx) { return { content: JSON.stringify(agentProductContext(
        get(ctx.localProductId), deps.db.getAgentSnapshot?.(ctx.localProductId), deps.readiness?.(ctx.localProductId),
      )) }; },
    },
    {
      name: "patch_product", requiresApproval: false, description: "合并保存本地规划字段（basicInfo、presentation、itinerary、operations、commercial）；系统锁定既有 meetingCity。用户明确指定大交通抵达/返程端点时，只能写 operations.trafficLine.arrivalCity / departureCity；不得写交通方式或启用状态，系统会调用接口核验。未指定端点才默认产品目的地。itinerary 的数据结构严格为逐日对象数组：[{day:1, title:'...', spots:[{name:'...', timeOfDay:'morning', relation:'and'|'or'}]}]。二选一/多选一必须保留每个原始景点，连续写在同一天同一时段，且每项 relation:'or'，供 VBK 录入为“或”。不接受 {item:...}、嵌套数组或 hotels 顶层字段；不允许填写新的 poiId/poiName，已查询到的候选只能由 select_itinerary_poi 写入。", parameters: PRODUCT_PATCH_SCHEMA,
      async execute(args, ctx) {
        const patch = requirePatch(args);
        const instruction = [historicalHotelTierInstruction(deps.db, get(ctx.localProductId)), hotelAnswerInstruction(deps.db.getAgentSnapshot?.(ctx.localProductId)?.events ?? [])].filter(Boolean).join("\n");
        const operations = agentPatchOperations(get(ctx.localProductId), patch, { hotelTierInstruction: instruction });
        const result = deps.productMutations.applyAiPatch(ctx.localProductId, operations);
        if (!result.applied) throw new Error("没有可安全应用的产品修改。");
        const persistedChoices = applyPersistedHotelTierChoices(productData(result.product), instruction);
        const saved = JSON.stringify(persistedChoices) === JSON.stringify(productData(result.product))
          ? result.product
          : deps.productMutations.replace(ctx.localProductId, persistedChoices, { status: result.product.status });
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
          const detail = await suggestPoiDetail(await getVbkRequestPage(deps.browser), keyword);
          const candidates = poiCandidatesForAvailability({ keyword, detail });
          const availability = await getCtripSightAvailabilities(undefined, candidates.map((item) => item.poiId!), deps.db);
          return { content: safeJson(compactPoiQueryResult({ keyword, detail, availability })) };
        });
      },
    },
    {
      name: "select_itinerary_poi", description: "将 query_poi 已返回的一个真实可用候选，安全绑定到当前行程中的既有景点。spotName 必须是原行程名称；别名查询时传 queryKeyword，候选仍须通过原行程日的地域与营业核验。不能用 patch_product 直接填写 POI ID。", parameters: { type: "object", required: ["day", "spotName", "poiId"], properties: { day: { type: "number" }, spotName: { type: "string" }, queryKeyword: { type: "string" }, poiId: { type: "number" } } },
      async execute(args, ctx) {
        const day = positiveInteger(args.day, "day");
        const spotName = cleanText(args.spotName);
        const queryKeyword = cleanText(args.queryKeyword) || spotName;
        const poiId = positiveInteger(args.poiId, "poiId");
        if (!spotName) throw new Error("缺少现有景点名称。");
        const current = get(ctx.localProductId);
        const { dayIndex, spotIndex, spot } = selectItinerarySpot(current, day, spotName);
        if (!requiresItineraryPoi(spot)) throw new Error("自由活动或其他活动无需配置 POI；请先切换为景点。");
        const basic = productData(current).basicInfo as JsonObject | undefined;
        const context = {
          destinationCity: cleanText(basic?.destinationCity || basic?.meetingCity), province: cleanText(basic?.province),
        };
        const detail = await withPage(async () => suggestPoiDetail(await getVbkRequestPage(deps.browser), queryKeyword, context));
        const candidate = detail.candidates.find((item) => item.poiId === poiId && item.selectable && item.poiName);
        if (!candidate?.poiName) throw new Error(`POI ${poiId} 不在「${queryKeyword}」的当前可选查询结果中。`);
        if (!isPlanningPoiCandidateInContext(candidate, context, productData(current), spotName, detail.candidates)) {
          throw new Error(`POI「${candidate.poiName}」与第 ${day} 天原景点「${spotName}」的地域约束不匹配。`);
        }
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
        return { content: safeJson({ day, spotName, queryKeyword, poiName: candidate.poiName, poiId, province: candidate.province, city: candidate.city }) };
      },
    },
    {
      name: "query_hotel_resource", description: "读取 VBK 酒店资源候选，不创建或绑定资源。", parameters: { type: "object", properties: {} },
      async execute(_args, ctx) { return withPage(async () => { const product = get(ctx.localProductId); const payload = await searchVbkResources(await getVbkRequestPage(deps.browser)); const city = cleanText((productData(product).basicInfo as JsonObject | undefined)?.destinationCity); return { content: safeJson({ selected: firstHotelResource(payload, city), payload }) }; }); },
    },
    createItineraryHotelTool(deps, get),
    {
      name: "read_vbk_phase", description: "按当前 productId 从 VBK 读取基础信息，并返回本地阶段快照，用于核对不确定写入。", parameters: { type: "object", properties: {} },
      async execute(_args, ctx) { const product = get(ctx.localProductId); const remote = product.productId ? await withPage(async () => getProductBaseInfoApi(await getVbkRequestPage(deps.browser), product.productId!)) : null; return { content: safeJson({ productId: product.productId, status: product.status, automation: product.automation, remote }) }; },
    },
    {
      name: "query_vehicle_resource", description: "按城市、座位和天数查询 VBK 用车资源候选，不绑定资源；seats 缺省为 5 座。", parameters: { type: "object", properties: { city: { type: "string" }, seats: { type: "number" }, days: { type: "number" }, tier: { type: "string" } } },
      async execute(args) { return withPage(async () => { const query = buildVehicleResourceQuery(args); const payload = await searchVehicleResourceGroups(await getVbkRequestPage(deps.browser), query.query); const groups = extractResourceGroups(payload); return { content: safeJson({ query, selected: bestResourceGroup(payload), groups }) }; }); },
    },
    {
      name: "resolve_cover", description: "查询携程图库并将完整封面候选安全写入 presentation.cover，尽量逐一覆盖付费景点；缺少景点配图只记录提示，不阻止确认或录入。", parameters: { type: "object", properties: {} },
      async execute(_args, ctx) { const current = get(ctx.localProductId); const filled = await withPage(async () => applyAutoCoverFill({ page: await getVbkRequestPage(deps.browser), product: productData(current) })); const result = filled.outcome.written ? deps.productMutations.replace(ctx.localProductId, filled.nextProduct, { status: current.status }) : current; return { content: safeJson(filled.outcome), data: { productVersion: agentProductVersion(result) } }; },
    },
    {
      name: "resolve_vehicle_resource", description: "查询并选择真实 VBK 用车资源组，安全写入 operations.vehicleResource，不绑定到 VBK 产品。", parameters: { type: "object", properties: {} },
      async execute(_args, ctx) { const current = get(ctx.localProductId); const resolved = await withPage(async () => resolveVehicleResource(await getVbkRequestPage(deps.browser), current)); const result = deps.productMutations.replace(ctx.localProductId, resolved.product, { status: current.status }); return { content: resolved.note, data: { productVersion: agentProductVersion(result) } }; },
    },
    {
      name: "query_station", description: "查询机场或火车站候选，不写入行程。", parameters: { type: "object", required: ["keyword", "kind"], properties: { keyword: { type: "string" }, kind: { enum: ["airport", "train"] } } },
      async execute(args) { return withPage(async () => { const keyword = cleanText(args.keyword); const page = await getVbkRequestPage(deps.browser); const stations = args.kind === "train" ? await searchTrainStations(page, keyword) : await searchAirports(page, keyword); return { content: safeJson(stations) }; }); },
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
      name: "resolve_itinerary_pois", description: "逐个核查当前行程的真实 POI、地区和营业状态，填入已验证 ID。所有运营明确命名的景点（含二选一/多选一的每个原始选项）都保持原名、原位、原顺序并各自核验；未命中时进入运营手动 POI 配置或由运营手动删除，Agent 不得删除。交通、接送和入住节点不作为 POI 景点处理。", parameters: {type:"object",properties:{}},
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

// Local helpers reused inside tool bodies.
import { isTravelNodeName } from "../../planning/itinerary-adoption.js";

function absentTravelNodeResearchTaskLocal(label: string, presentSpotNames: ReadonlySet<string>): boolean {
  const match = label.match(/^核查\s+(.+?)\s+的\s+VBK\s+POI\s+映射$/i);
  const name = match?.[1]?.trim() ?? "";
  return Boolean(name && isTravelNodeName(name) && !presentSpotNames.has(name));
}