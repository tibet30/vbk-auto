import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { extractLockedConstraints } from "../../src/main/agent/prompt-helpers.js";
import { projectCompleteItinerary } from "../../src/main/planning/complete-itinerary-projection.js";
import {
  dailyRouteStructureProblem,
  needsDailyRouteStructure,
  routeFingerprint,
  storedDailyRouteOrder,
  structureDailyRoute,
  type DailyRouteStructure,
  type DailyRouteStructureGenerator,
} from "../../src/main/planning/daily-route-structure.js";
import { mergedDailyRouteSources } from "../../src/main/agent/daily-route-source.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

const IDEA = "D1：长沙 → 韶山，约1小时车程 → 滴水洞，晚上住在韶山\nD2：韶山，车行1.5h → 岳麓山：爱晚亭、麓山寺";
const AI_DAYS = [
  { day: 1, nodes: [{ name: "长沙", kind: "place" }, { name: "韶山", kind: "place" }, { name: "滴水洞", kind: "attraction" }] },
  { day: 2, nodes: [{ name: "岳麓山", kind: "attraction" }, { name: "爱晚亭", kind: "attraction" }, { name: "麓山寺", kind: "attraction" }] },
];

function draft(userIdea: string): ProductDetail {
  const product = buildProductSnapshot({ destination: "长沙", days: 2, productForm: "freeTravel" });
  Object.assign(product.product.basicInfo!, {
    days: 2, nights: 1, meetingCity: "长沙", destinationCity: "长沙", province: "湖南", userIdea,
  });
  product.product.itinerary = [];
  return product;
}

function withStructure(product: ProductDetail, structure: DailyRouteStructure): ProductDetail {
  product.product.diagnostics = { dailyRouteStructure: structure };
  return product;
}

test("AI 结构通过校验：节点逐字出自当天原文，指纹绑定原文", async () => {
  const requests: unknown[] = [];
  const generate: DailyRouteStructureGenerator = async (request) => { requests.push(request); return AI_DAYS; };
  const structure = await structureDailyRoute({ userIdea: IDEA, generate });
  assert.ok(structure);
  assert.equal(requests.length, 1);
  assert.equal(structure.fingerprint, routeFingerprint(mergedDailyRouteSources(IDEA)));
  assert.deepEqual(structure.days.map((day) => day.day), [1, 2]);
});

test("AI 编造原文没有的节点会被拒绝并带原因重试一次，仍不合格则放弃", async () => {
  const requests: Array<{ rejectedReason?: string }> = [];
  const generate: DailyRouteStructureGenerator = async (request) => {
    requests.push(request);
    return [AI_DAYS[0]!, { day: 2, nodes: [{ name: "橘子洲", kind: "attraction" }] }];
  };
  const warnings: string[] = [];
  const structure = await structureDailyRoute({ userIdea: IDEA, generate, onWarning: (m) => warnings.push(m) });
  assert.equal(structure, undefined);
  assert.equal(requests.length, 2);
  assert.match(requests[1]!.rejectedReason ?? "", /第 2 天节点「橘子洲」/);
  assert.match(warnings[0] ?? "", /回退规则解析/);
});

test("AI 少一天或乱序会被拒绝；调用失败回退而不是抛错", async () => {
  const sources = mergedDailyRouteSources(IDEA);
  assert.match(dailyRouteStructureProblem(sources, [{ day: 1, nodes: [] }]) ?? "", /天序/);
  const warnings: string[] = [];
  const structure = await structureDailyRoute({
    userIdea: IDEA, generate: async () => { throw new Error("网络超时"); }, onWarning: (m) => warnings.push(m),
  });
  assert.equal(structure, undefined);
  assert.match(warnings[0] ?? "", /网络超时/);
});

test("已验证结构替代规则解析成为锁定约束，highlight 进入不限顺序景点", async () => {
  const structure = await structureDailyRoute({ userIdea: IDEA, generate: async () => AI_DAYS });
  const product = withStructure(draft(IDEA), structure!);
  const order = extractLockedConstraints(product, []).itineraryOrder;
  assert.deepEqual(order[1]!.spots, ["岳麓山", "爱晚亭", "麓山寺"]);
  assert.ok(!order.flatMap((row) => row.spots).some((name) => /车程|车行|约1/.test(name)));
  const highlighted = withStructure(draft(IDEA), {
    ...structure!, days: [structure!.days[0]!, { day: 2, nodes: [
      { name: "岳麓山", kind: "attraction" }, { name: "爱晚亭", kind: "highlight" }] }],
  });
  assert.deepEqual(extractLockedConstraints(highlighted, []).itineraryOrder[1], { day: 2, spots: ["岳麓山"], unorderedSpots: ["爱晚亭"] });
});

test("原文变化后旧结构失效，需要重新结构化，且锁定约束回退规则解析", async () => {
  const structure = await structureDailyRoute({ userIdea: IDEA, generate: async () => AI_DAYS });
  const edited = withStructure(draft(`${IDEA}\n`.replace("滴水洞", "韶山冲")), structure!);
  const userIdea = edited.product.basicInfo!.userIdea!;
  assert.equal(storedDailyRouteOrder(edited.product, userIdea), undefined);
  assert.equal(needsDailyRouteStructure(edited.product, userIdea), true);
  assert.equal(needsDailyRouteStructure(withStructure(draft(IDEA), structure!).product, IDEA), false);
  assert.ok(extractLockedConstraints(edited, []).itineraryOrder.length > 0, "回退规则解析仍有结果");
});

test("没有逐日标记的原文不触发 AI 结构化", () => {
  assert.equal(needsDailyRouteStructure({}, "想去长沙玩两天，带孩子"), false);
});

test("AI 结构驱动完整行程投影：正则解析不了的写法也能得到正确景点与顺序", async () => {
  const idea = "D1：上午 韶山毛泽东故居，下午 滴水洞；晚上住在韶山\nD2：上午 橘子洲 下午 岳麓山 送机";
  const generate: DailyRouteStructureGenerator = async () => [
    { day: 1, nodes: [{ name: "韶山毛泽东故居", kind: "attraction" }, { name: "滴水洞", kind: "attraction" }] },
    { day: 2, nodes: [{ name: "橘子洲", kind: "attraction" }, { name: "岳麓山", kind: "attraction" }] },
  ];
  const structure = await structureDailyRoute({ userIdea: idea, generate });
  const product = withStructure(draft(idea), structure!);
  const itinerary = projectCompleteItinerary(product)?.modules[0]?.value as Array<Record<string, any>>;
  assert.ok(Array.isArray(itinerary));
  assert.deepEqual(itinerary[0]!.spots.map((spot: any) => spot.name), ["韶山毛泽东故居", "滴水洞"]);
  assert.deepEqual(itinerary[1]!.spots.map((spot: any) => spot.name), ["橘子洲", "岳麓山"]);
});

const OVERNIGHT_IDEA = "D1：抵达黄花机场 → 韶山（毛泽东故居、铜像广场、韶峰），车程约 1h；宿韶山\nD2：韶山 → 长沙市区（橘子洲、岳麓山）→ 送黄花机场";
const OVERNIGHT_DAYS = [
  { day: 1, nodes: [
    { name: "韶山", kind: "place" }, { name: "毛泽东故居", kind: "attraction" }, { name: "铜像广场", kind: "attraction" },
    { name: "韶峰", kind: "attraction" }, { name: "宿韶山", kind: "attraction" }] },
  { day: 2, nodes: [{ name: "橘子洲", kind: "attraction" }, { name: "岳麓山", kind: "attraction" }] },
];

test("AI 把「宿韶山」这类住宿动作当节点时被剔除，住宿不是景点", async () => {
  const structure = await structureDailyRoute({ userIdea: OVERNIGHT_IDEA, generate: async () => OVERNIGHT_DAYS });
  assert.ok(structure);
  assert.deepEqual(structure.days[0]!.nodes.map((node) => node.name), ["韶山", "毛泽东故居", "铜像广场", "韶峰"]);
});

test("已存的旧结构里带住宿节点也不进入锁定约束与投影；宿迁等地名不受影响", async () => {
  const stored: DailyRouteStructure = {
    version: 1, fingerprint: routeFingerprint(mergedDailyRouteSources(OVERNIGHT_IDEA)), days: OVERNIGHT_DAYS as DailyRouteStructure["days"],
  };
  const product = withStructure(draft(OVERNIGHT_IDEA), stored);
  const order = extractLockedConstraints(product, []).itineraryOrder;
  assert.ok(!order.flatMap((row) => row.spots).includes("宿韶山"), `锁定景点不应含宿韶山：${order[0]!.spots.join("、")}`);
  const itinerary = projectCompleteItinerary(product)?.modules[0]?.value as Array<Record<string, any>>;
  assert.ok(!itinerary[0]!.spots.some((spot: any) => spot.name === "宿韶山"));
  const sources = mergedDailyRouteSources("D1：长沙 → 宿迁（项王故里）\nD2：宿迁 → 长沙");
  const kept = [{ day: 1, nodes: [{ name: "宿迁", kind: "place" }, { name: "项王故里", kind: "attraction" }] }, { day: 2, nodes: [{ name: "宿迁", kind: "place" }] }];
  assert.equal(dailyRouteStructureProblem(sources, kept as DailyRouteStructure["days"]), undefined);
});

const ORIGIN_IDEA = "第1天：出发地-奉节：三峡之巅-夔州古城-三峡拗口\n第2天：奉节-巫山-出发地：船行巫峡-船观神女峰-神女大扶梯-三峡龙脊-返程";
const ORIGIN_DAYS = [
  { day: 1, nodes: [{ name: "出发地", kind: "place" }, { name: "奉节", kind: "place" }, { name: "三峡之巅", kind: "attraction" },
    { name: "夔州古城", kind: "attraction" }, { name: "三峡拗口", kind: "attraction" }] },
  { day: 2, nodes: [{ name: "奉节", kind: "place" }, { name: "巫山", kind: "place" }, { name: "船行巫峡", kind: "attraction" },
    { name: "船观神女峰", kind: "attraction" }, { name: "神女大扶梯", kind: "attraction" }, { name: "三峡龙脊", kind: "attraction" },
    { name: "出发地", kind: "place" }] },
];

test("「出发地」「客源地」只是客源城市占位，AI 结构里的这类节点不进锁定景点与投影", async () => {
  const stored: DailyRouteStructure = {
    version: 1, fingerprint: routeFingerprint(mergedDailyRouteSources(ORIGIN_IDEA)), days: ORIGIN_DAYS as DailyRouteStructure["days"],
  };
  const product = withStructure(draft(ORIGIN_IDEA), stored);
  const order = extractLockedConstraints(product, []).itineraryOrder;
  assert.ok(!order.flatMap((row) => row.spots).includes("出发地"), `锁定景点不应含出发地：${order.map((row) => row.spots.join("、")).join(" / ")}`);
  const fresh = await structureDailyRoute({ userIdea: ORIGIN_IDEA, generate: async () => ORIGIN_DAYS });
  assert.ok(!fresh!.days.flatMap((day) => day.nodes).some((node) => node.name === "出发地"));
});

test("AI 标为 place 的城市只是路程节点，不进锁定景点；整天只有城市时仍保留这一天", async () => {
  const stored: DailyRouteStructure = {
    version: 1, fingerprint: routeFingerprint(mergedDailyRouteSources(ORIGIN_IDEA)), days: ORIGIN_DAYS as DailyRouteStructure["days"],
  };
  const product = withStructure(draft(ORIGIN_IDEA), stored);
  const order = extractLockedConstraints(product, []).itineraryOrder;
  assert.deepEqual(order.map((row) => row.spots), [
    ["三峡之巅", "夔州古城", "三峡拗口"], ["船行巫峡", "船观神女峰", "神女大扶梯", "三峡龙脊"],
  ]);
  const itinerary = projectCompleteItinerary(product)?.modules[0]?.value as Array<Record<string, any>>;
  assert.deepEqual(itinerary[1]!.spots.map((spot: any) => spot.name), ["船行巫峡", "船观神女峰", "神女大扶梯", "三峡龙脊"]);
  assert.doesNotMatch(String(itinerary[1]!.description), /按用户原定顺序安排：巫山/);
  const returnIdea = "D1：长沙 → 韶山 → 滴水洞\nD2：韶山 → 长沙";
  const returnDays = [AI_DAYS[0]!, { day: 2, nodes: [{ name: "韶山", kind: "place" }, { name: "长沙", kind: "place" }] }];
  const returning = withStructure(draft(returnIdea), {
    version: 1, fingerprint: routeFingerprint(mergedDailyRouteSources(returnIdea)), days: returnDays as DailyRouteStructure["days"],
  });
  assert.deepEqual(extractLockedConstraints(returning, []).itineraryOrder.map((row) => row.day), [1, 2]);
});
