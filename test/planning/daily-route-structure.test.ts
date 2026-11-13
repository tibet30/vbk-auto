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
  structuredAlternativeGroups,
  storedRouteNodeNames,
  structuredOvernightName,
  structureDailyRoute,
  type DailyRouteStructure,
  type DailyRouteStructureGenerator,
} from "../../src/main/planning/daily-route-structure.js";
import { mergedDailyRouteSources } from "../../src/main/agent/daily-route-source.js";
import { explicitAlternativeGroups } from "../../src/main/planning/itinerary-input-contract/alternative.js";
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

const STAY_IDEA = "D1：长沙 → 韶山（毛泽东故居）当晚在韶山过夜\nD2：韶山 → 长沙 → 送长沙南站";
const STAY_DAYS = [
  { day: 1, nodes: [{ name: "长沙", kind: "place" }, { name: "韶山", kind: "place" }, { name: "毛泽东故居", kind: "attraction" }], overnight: "韶山" },
  { day: 2, nodes: [{ name: "韶山", kind: "place" }, { name: "长沙", kind: "place" }, { name: "长沙南站", kind: "place" }] },
];

test("当晚住宿地由 AI 从原文读出，本地只校验逐字出自原文与不是动作短语", async () => {
  const structure = await structureDailyRoute({ userIdea: STAY_IDEA, generate: async () => STAY_DAYS });
  assert.ok(structure);
  assert.equal(structure.version, 2);
  assert.equal(structure.days[0]!.overnight?.name, "韶山");
  assert.equal(structure.days[1]!.overnight, undefined);
  const sources = mergedDailyRouteSources(STAY_IDEA);
  const fabricated = [{ day: 1, nodes: [], overnight: { name: "张家界" } }, { day: 2, nodes: [] }];
  assert.match(dailyRouteStructureProblem(sources, fabricated as DailyRouteStructure["days"]) ?? "", /住宿地「张家界」没有逐字出现/);
  const action = [{ day: 1, nodes: [], overnight: { name: "宿韶山" } }, { day: 2, nodes: [] }];
  assert.match(dailyRouteStructureProblem(sources, action as DailyRouteStructure["days"]) ?? "", /住宿动作短语/);
});

test("下游读取住宿地以 AI 结构为准，原文改动后立即失效", () => {
  const product = draft(STAY_IDEA);
  product.product.basicInfo!.nights = 1;
  const structure: DailyRouteStructure = {
    version: 2, fingerprint: routeFingerprint(mergedDailyRouteSources(STAY_IDEA)),
    days: [{ day: 1, nodes: [], overnight: { name: "韶山" } }],
  };
  const withStored = withStructure(product, structure);
  assert.equal(structuredOvernightName(withStored.product, 1), "韶山");
  assert.equal(structuredOvernightName(withStored.product, 2), undefined);
  withStored.product.basicInfo!.userIdea = `${STAY_IDEA}\nD3：自由活动`;
  assert.equal(structuredOvernightName(withStored.product, 1), undefined, "原文变化后旧结构里的住宿地不得继续使用");
  const legacy: DailyRouteStructure = { version: 1, fingerprint: structure.fingerprint, days: [{ day: 1, nodes: [] }] };
  assert.equal(structuredOvernightName({ ...withStored.product, diagnostics: { dailyRouteStructure: legacy } }, 1), undefined);
});

test("v1 结构在含住宿夜的产品上会重新结构化一次补齐住宿地，之后不再触发", async () => {
  const product = draft(IDEA);
  product.product.basicInfo!.nights = 1;
  const legacy: DailyRouteStructure = {
    version: 1, fingerprint: routeFingerprint(mergedDailyRouteSources(IDEA)), days: AI_DAYS as DailyRouteStructure["days"],
  };
  assert.equal(needsDailyRouteStructure(withStructure(product, legacy).product, IDEA), true);
  const fresh = await structureDailyRoute({ userIdea: IDEA, generate: async () => AI_DAYS });
  assert.equal(needsDailyRouteStructure(withStructure(product, fresh!).product, IDEA), false);
  const noNights = draft(IDEA); noNights.product.basicInfo!.nights = 0;
  assert.equal(needsDailyRouteStructure(withStructure(noNights, legacy).product, IDEA), false, "没有住宿夜不需要重读住宿地");
});

test("行程投影的入住城市优先取 AI 读出的住宿地，正则认不出时也不丢", async () => {
  const structure = await structureDailyRoute({ userIdea: STAY_IDEA, generate: async () => STAY_DAYS });
  const product = withStructure(draft(STAY_IDEA), structure!);
  product.product.basicInfo!.nights = 1;
  const itinerary = projectCompleteItinerary(product)?.modules[0]?.value as Array<Record<string, any>>;
  assert.ok(Array.isArray(itinerary), "完整路线投影应产出行程");
  assert.equal(itinerary[0]!.hotelCity, "韶山");
});

const OR_IDEA = "D1：长沙 → 韶山（毛泽东故居 或 滴水洞，二选一）\nD2：韶山 → 长沙";
const OR_DAYS = [
  { day: 1, nodes: [
    { name: "长沙", kind: "place" }, { name: "韶山", kind: "place" },
    { name: "毛泽东故居", kind: "attraction", relation: "or" },
    { name: "滴水洞", kind: "attraction", relation: "or" }] },
  { day: 2, nodes: [{ name: "韶山", kind: "place" }, { name: "长沙", kind: "place" }] },
];

test("AI 读出二选一并标 relation=or，本地校验相邻与原文选择标记", async () => {
  const structure = await structureDailyRoute({ userIdea: OR_IDEA, generate: async () => OR_DAYS });
  assert.ok(structure);
  assert.deepEqual(structuredAlternativeGroups({ basicInfo: { userIdea: OR_IDEA }, diagnostics: { dailyRouteStructure: structure } }),
    [{ day: 1, names: ["毛泽东故居", "滴水洞"] }]);
  const plainIdea = "D1：长沙 → 韶山（毛泽东故居、滴水洞）\nD2：韶山 → 长沙";
  const plainSources = mergedDailyRouteSources(plainIdea);
  assert.match(dailyRouteStructureProblem(plainSources, OR_DAYS as DailyRouteStructure["days"]) ?? "", /选择标记/);
  const lonely = [{ day: 1, nodes: [{ name: "韶山", kind: "place" }, { name: "毛泽东故居", kind: "attraction", relation: "or" }] },
    { day: 2, nodes: [] }];
  assert.match(dailyRouteStructureProblem(mergedDailyRouteSources(OR_IDEA), lonely as DailyRouteStructure["days"]) ?? "", /至少两项/);
});

test("文本规则认不出的二选一，由 AI 结构补上并进入锁定约束", async () => {
  const idea = "D1：长沙 → 韶山，毛泽东故居、滴水洞 任选其一\nD2：韶山 → 长沙";
  const days = [
    { day: 1, nodes: [{ name: "长沙", kind: "place" }, { name: "韶山", kind: "place" },
      { name: "毛泽东故居", kind: "attraction", relation: "or" }, { name: "滴水洞", kind: "attraction", relation: "or" }] },
    { day: 2, nodes: [{ name: "韶山", kind: "place" }, { name: "长沙", kind: "place" }] },
  ];
  const structure = await structureDailyRoute({ userIdea: idea, generate: async () => days });
  const product = withStructure(draft(idea), structure!);
  assert.deepEqual(explicitAlternativeGroups(product), [{ day: 1, names: ["毛泽东故居", "滴水洞"] }]);
  const regexOnly = withStructure(draft(idea), { ...structure!, days: structure!.days.map((day) => ({
    ...day, nodes: day.nodes.map(({ relation: _relation, ...node }) => node) })) });
  assert.deepEqual(explicitAlternativeGroups(regexOnly), [], "没有 AI 标注时文本规则认不出这种写法");
});

test("远处的「或」不算候选的二选一标记，不能把几个景点误锁成一组", async () => {
  const idea = "D1：长沙 — 韶山 — 滴水洞（含接送或自理）\nD2：韶山 — 长沙";
  const days = [
    { day: 1, nodes: [{ name: "长沙", kind: "place" }, { name: "韶山", kind: "attraction", relation: "or" },
      { name: "滴水洞", kind: "attraction", relation: "or" }] },
    { day: 2, nodes: [{ name: "韶山", kind: "place" }, { name: "长沙", kind: "place" }] },
  ];
  const structure = await structureDailyRoute({ userIdea: idea, generate: async () => days });
  assert.equal(structure, undefined, "编造的二选一组会让整份结构被拒并重试一次");
});

test("结构里的收尾城市按原语义排除，不变成当天景点", async () => {
  const idea = "D1：祁连 — 巴尔斯雪山 - 七彩丹霞 | 张掖结束行程\nD2：张掖 — 兰州";
  const days = [
    { day: 1, nodes: [{ name: "祁连", kind: "place" }, { name: "巴尔斯雪山", kind: "attraction" },
      { name: "七彩丹霞", kind: "attraction" }, { name: "张掖", kind: "place" }] },
    { day: 2, nodes: [{ name: "张掖", kind: "place" }, { name: "兰州", kind: "place" }] },
  ];
  const structure = await structureDailyRoute({ userIdea: idea, generate: async () => days });
  const names = storedRouteNodeNames({ basicInfo: { userIdea: idea }, diagnostics: { dailyRouteStructure: structure } });
  assert.deepEqual(names.get(1), ["祁连", "巴尔斯雪山", "七彩丹霞"], "收尾城市张掖不应成为当天景点");
  assert.deepEqual(names.get(2), ["张掖", "兰州"]);
});

test("连字符编号路线也进入 AI 结构化，住宿地与节点仍逐字校验", async () => {
  const idea = "1-西安接---住太白山唐镇---泡温泉;\n2-五丈原---黄柏塬---太白县咀头镇住宿;\n3-太白县---张良庙---留侯住宿";
  const sources = mergedDailyRouteSources(idea);
  assert.deepEqual(sources.map(source => source.day), [1, 2, 3]);
  const structure = await structureDailyRoute({ userIdea: idea, generate: async () => [
    { day: 1, nodes: [], overnight: "太白山唐镇" },
    { day: 2, nodes: [{ name: "五丈原", kind: "attraction" }, { name: "黄柏塬", kind: "attraction" }], overnight: "太白县咀头镇" },
    { day: 3, nodes: [{ name: "张良庙", kind: "attraction" }], overnight: "留侯" },
  ] });
  assert.equal(structure?.version, 2);
  assert.deepEqual(structure?.days.map(day => day.overnight?.name), ["太白山唐镇", "太白县咀头镇", "留侯"]);
  assert.deepEqual(structure?.days.map(day => day.nodes.map(node => node.name)), [[], ["五丈原", "黄柏塬"], ["张良庙"]]);
});
