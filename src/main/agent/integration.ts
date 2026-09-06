import { agentProductContext } from "./integration-context.js";
import { agentPatchOperations } from "./integration-patch.js";
import { agentProductVersion, requiredAgentPhases } from "./integration-gates.js";
export { agentProductVersion } from "./integration-gates.js";
import { enrichItineraryPois } from "../planning/poi-enrichment.js";
import type { ProductDetail } from "../../shared/contracts.js";
import type { DraftAutomation } from "../automation/automation.js";
import { searchVbkResources, firstHotelResource } from "../operations/hotel-resource.js";
import { buildVehicleResourceQuery, searchVehicleResourceGroups, extractResourceGroups, bestResourceGroup, resolveVehicleResource } from "../operations/vehicle-resource.js";
import { applyAutoCoverFill } from "../operations/cover-auto-fill.js";
import { suggestPoiDetail } from "../infrastructure/poi-suggest.js";
import { getCtripSightAvailabilities } from "../infrastructure/ctrip-sight-availability.js";
import { compactPoiQueryResult, poiCandidatesForAvailability } from "./poi-query-compact.js";
import { searchAirports, searchTrainStations } from "../automation/ctrip/itinerary-api/station-search.js";
import { resolveItineraryHotelCandidates } from "../infrastructure/ctrip-hotel-search.js";
import { getProductBaseInfoApi } from "../automation/ctrip/basic-info/api.js";
import type { PlanningStage, PlanningStageOutput } from "../../shared/contracts-planning.js";
import { DbOrchestratorRuntime } from "../planning/runtime.js";
import { executeStageOutput } from "../planning/stage-runner.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import type { VbkBrowser } from "../infrastructure/vbk-browser.js";
import type { ProductWorkflowCoordinator } from "../application/product-workflow-coordinator.js";
import type { ProductMutationService } from "../application/product-mutation-service.js";
import type { AgentTool } from "./types.js";

type JsonObject = Record<string, unknown>;

const ITINERARY_SPOT_PATCH_SCHEMA = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string" }, timeOfDay: { enum: ["morning", "afternoon", "evening"] }, relation: { enum: ["or"] },
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

function positiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label}必须是正整数。`);
  return number;
}

function selectedItinerarySpot(product: ProductDetail, day: number, spotName: string) {
  const itinerary = Array.isArray(product.product.itinerary) ? product.product.itinerary as JsonObject[] : [];
  const dayIndex = itinerary.findIndex((item) => Number(item.day) === day);
  if (dayIndex < 0) throw new Error(`未找到第 ${day} 天行程。`);
  const spots = Array.isArray(itinerary[dayIndex]?.spots) ? itinerary[dayIndex].spots as JsonObject[] : [];
  const matches = spots.map((spot, spotIndex) => ({ spot, spotIndex }))
    .filter(({ spot }) => cleanText(spot.name) === spotName || cleanText(spot.poiName) === spotName);
  if (matches.length !== 1) throw new Error(matches.length ? `第 ${day} 天存在多个「${spotName}」，请先调整名称。` : `第 ${day} 天未找到景点「${spotName}」。`);
  return { dayIndex, spotIndex: matches[0]!.spotIndex };
}

export interface AgentBusinessDependencies {
  db: VbkDatabase;
  browser: VbkBrowser;
  automation: DraftAutomation;
  productWorkflows: ProductWorkflowCoordinator;
  productMutations: ProductMutationService;
  generateStage(localProductId: string, stage: Extract<PlanningStage, "skeleton" | "basicInfo" | "itinerary" | "presentation" | "commercial">): Promise<PlanningStageOutput>;
  emitProduct(product: ProductDetail): void;
}

/** Tools expose bounded reads and locally persisted structured edits. VBK writes are phase-scoped. */
export function createAgentBusinessTools(deps: AgentBusinessDependencies): AgentTool[] {
  const get = (localProductId: string) => {
    const product = deps.db.getProduct(localProductId);
    if (!product) throw new Error("产品不存在。");
    return product;
  };
  const withPage = <T>(work: () => Promise<T>) => deps.productWorkflows.runVbkPageExclusive(work);
  const tools: AgentTool[] = [
    {
      name: "generate_product_module", description: "用结构化规划模型生成一个且仅一个模块阶段。支持 skeleton、basicInfo、itinerary、presentation、commercial；输出经过该阶段的真实 schema、文案和城市锁定校验后才写入。", parameters: { type: "object", required: ["stage"], properties: { stage: { enum: ["skeleton", "basicInfo", "itinerary", "presentation", "commercial"] } } },
      async execute(args, ctx) {
        const stage = cleanText(args.stage) as Extract<PlanningStage, "skeleton" | "basicInfo" | "itinerary" | "presentation" | "commercial">;
        if (!(["skeleton", "basicInfo", "itinerary", "presentation", "commercial"] as string[]).includes(stage)) throw new Error("不支持的生成阶段。");
        const output = await deps.generateStage(ctx.localProductId, stage);
        if (stage === "itinerary") {
          for (const module of output.modules) if (module.module === "itinerary" && Array.isArray(module.value)) {
            for (const day of module.value) if (Array.isArray(day.spots)) {
              for (const spot of day.spots) { spot.poiId = null; spot.poiName = null; }
            }
          }
        }
        const runtime = new DbOrchestratorRuntime(deps.db, deps.browser, deps.productMutations, (task) => deps.productWorkflows.runVbkPageExclusive(task));
        const applied = await executeStageOutput({ stage, output, runtime, localProductId: ctx.localProductId });
        return { content: safeJson({ stage, accepted: applied.accepted, rejected: applied.rejected, researchTasks: applied.researchTasks }) };
      },
    },
    {
      name: "read_product", description: "读取当前产品结构、生命周期和已保存的自动化阶段。", parameters: { type: "object", properties: {} },
      async execute(_args, ctx) { return { content: JSON.stringify(agentProductContext(get(ctx.localProductId))) }; },
    },
    {
      name: "patch_product", requiresApproval: false, description: "合并保存本地规划字段（basicInfo、presentation、itinerary、operations、commercial）；系统锁定既有 meetingCity。itinerary 的数据结构严格为逐日对象数组：[{day:1, title:'...', spots:[{name:'...', timeOfDay:'morning'}]}]。不接受 {item:...}、嵌套数组或 hotels 顶层字段；不允许填写新的 poiId/poiName，已查询到的候选只能由 select_itinerary_poi 写入。", parameters: PRODUCT_PATCH_SCHEMA,
      async execute(args, ctx) {
        const patch = requirePatch(args);
        const operations = agentPatchOperations(get(ctx.localProductId), patch);
        const result = deps.productMutations.applyAiPatch(ctx.localProductId, operations);
        if (!result.applied) throw new Error("没有可安全应用的产品修改。");
        const saved = result.product;
        return { content: "已保存本地产品结构化修改。", data: { productVersion: agentProductVersion(saved) } };
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
        const { dayIndex, spotIndex } = selectedItinerarySpot(current, day, spotName);
        const basic = productData(current).basicInfo as JsonObject | undefined;
        const detail = await withPage(async () => suggestPoiDetail(await deps.browser.page(), spotName, {
          destinationCity: cleanText(basic?.destinationCity || basic?.meetingCity), province: cleanText(basic?.province),
        }));
        const candidate = detail.candidates.find((item) => item.poiId === poiId && item.selectable && item.poiName);
        if (!candidate?.poiName) throw new Error(`POI ${poiId} 不在「${spotName}」的当前可选查询结果中。`);
        const availability = await getCtripSightAvailabilities(undefined, [poiId], deps.db);
        if (availability.get(poiId)?.status === "suspended") throw new Error(`POI「${candidate.poiName}」已暂停营业，不能写入行程。`);
        const result = deps.productMutations.applyAiPatch(ctx.localProductId, [
          { op: "replace", path: `/itinerary/${dayIndex}/spots/${spotIndex}/poiName`, value: candidate.poiName },
          { op: "replace", path: `/itinerary/${dayIndex}/spots/${spotIndex}/poiId`, value: poiId },
        ]);
        if (!result.applied) throw new Error("已核验的 POI 未能保存到行程。");
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
        const city = cleanText((data.basicInfo as JsonObject | undefined)?.destinationCity);
        const resolved = await resolveItineraryHotelCandidates(itinerary, city);
        const result = deps.productMutations.applyAiPatch(ctx.localProductId, [{ op: "replace", path: "/itinerary", value: resolved.itinerary }]);
        if (!result.applied) throw new Error("酒店候选未能安全写回行程。");
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
      name: "execute_vbk_phase", write: true, approvalScope: (args) => [`vbk.write_phase:${cleanText(args.phase)}`], description: "执行一个已批准的 VBK 阶段并完成该阶段的远端读回；一次只能一个阶段。", parameters: { type: "object", required: ["phase"], properties: { phase: { enum: ["saleControl", "basic", "presentation", "itinerary", "package", "pricingInventory", "terms", "hotelResource", "vehicleResource", "trafficLine", "preflight"] } } },
      async execute(args, ctx) {
        if (!ctx.approval) throw new Error("VBK 写入需要先请求审批。");
        const phase = cleanText(args.phase);
        try {
          await deps.productWorkflows.runExclusive(ctx.localProductId, "automation", () => deps.automation.executeAgentPhase(ctx.localProductId, phase));
        } catch (error) {
          // A VBK request can fail after dispatch. Do not let the model blindly
          // repeat it: pause and require a fresh authoritative readback.
          if (!(error as {uncertainWrite?:boolean}).uncertainWrite) throw error;
          const message = error instanceof Error ? error.message : String(error);
          return { content: `阶段 ${phase} 的写入结果不确定：${message}。请先读取当前产品和远端阶段状态。`, uncertainWrite: true };
        }
        const saved = get(ctx.localProductId);
        return { content: `阶段 ${phase} 已结束；请以当前保存的阶段读回结果继续决策。`, data: { remoteWrite: true, verified: true, approvalId:ctx.approval.id, phase, productId: saved.productId ?? null, automation: saved.automation } };
      },
    },
    {
      name: "resolve_itinerary_pois", description: "逐个核查当前行程的真实 POI、地区和营业状态，填入已验证 ID；未命中返回待处理项。", parameters: {type:"object",properties:{}},
      async execute(_args, ctx) {
        const current = get(ctx.localProductId);
        const runtime = new DbOrchestratorRuntime(deps.db, deps.browser, deps.productMutations, task=>withPage(task));
        const tasks = await enrichItineraryPois({localProductId:ctx.localProductId, destination:cleanText((current.product.basicInfo as JsonObject)?.meetingCity), runtime, persistedTaskKeys:new Set(current.researchTasks.map(task=>`${task.type}::${task.label}`)), reviewCompletePois:true});
        deps.emitProduct(get(ctx.localProductId));
        return {content:safeJson({tasks,itinerary:get(ctx.localProductId).product.itinerary})};
      },
    },
  ];
  const localWrites = new Set(["generate_product_module", "patch_product", "select_itinerary_poi", "resolve_itinerary_pois", "resolve_itinerary_hotels", "resolve_cover", "resolve_vehicle_resource"]);
  return tools.map(tool => localWrites.has(tool.name) ? {...tool, write:true, requiresApproval:false,
    execute: async (args, ctx) => deps.productWorkflows.runExclusive(ctx.localProductId, "planning", async () => {
      const before = get(ctx.localProductId).product;
      const result = await tool.execute(args, ctx);
      const after = get(ctx.localProductId).product;
      const changedSections = Object.keys(after).filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key]));
      return {...result,data:{...result.data,changedSections}};
    })} : tool);
}
