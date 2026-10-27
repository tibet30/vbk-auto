import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { DbOrchestratorRuntime } from "../../src/main/planning/runtime.js";
import { enrichItineraryPois } from "../../src/main/planning/poi-enrichment.js";

const CURRENT = "本轮 POI 核验未完成：当前查询召回多个候选，无法安全确定唯一地点，已保留先前绑定；请重新查询或手动选择 POI";

function fixture(t: TestContext, spot: Record<string, unknown>) {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-poi-official-review-"));
  const db = new VbkDatabase(dataPath);
  t.after(() => { db.close(); fs.rmSync(dataPath, { recursive: true, force: true }); });
  const created = db.createProduct({ destination: "万州", days: 1, productForm: "privateTour" });
  db.updateProduct(created.id, { ...created.product,
    basicInfo: { ...created.product.basicInfo, destinationCity: "万州", meetingCity: "万州", province: "重庆" },
    itinerary: [{ day: 1, title: "巫峡", description: "船观神女峰", hotel: "无", meals: "自理", spots: [spot] }],
  });
  return { db, id: created.id };
}

function review(db: VbkDatabase, id: string, select: (keyword: string) => unknown, contexts: Array<Record<string, unknown> | undefined> = []) {
  const queried: string[] = [];
  const runtime = new DbOrchestratorRuntime(db);
  runtime.getPoiAvailabilities = async ids => new Map(ids.map(value => [value, { status: "available" as const }]));
  runtime.resolvePoiSelection = async (_id, keyword, context) => { queried.push(keyword); contexts.push(context as any); return select(keyword) as any; };
  return enrichItineraryPois({ localProductId: id, destination: "万州", runtime,
    persistedTaskKeys: new Set(), reviewCompletePois: true, queryTimeoutMs: 50 }).then(() => queried);
}

const SHENNV = { poiName: "神女峰", poiId: 76364, province: "重庆", city: "重庆", district: "巫山" };

test("别名绑定复核改用官方名回查同一 poiId，结清本轮核验并追加新回执", async (t) => {
  const { db, id } = fixture(t, { name: "船观神女峰", poiName: "神女峰", poiId: 76364, kind: "attraction" });
  const taskId = db.addResearchTask(id, { label: "核查 船观神女峰 的 VBK POI 映射", type: "vbk", detail: CURRENT });
  const contexts: Array<Record<string, unknown> | undefined> = [];
  const queried = await review(db, id, keyword => keyword === "神女峰"
    ? { status: "available", match: SHENNV }
    : { status: "uncertain", reason: "ambiguous" }, contexts);
  assert.deepEqual(queried, ["船观神女峰", "神女峰"]);
  // 选择器按 context.spotName 覆写身份关键词：官方名回查必须同时改上下文。
  assert.equal(contexts[1]?.spotName, "神女峰");
  const reread = db.getProduct(id)!;
  assert.equal(reread.product.itinerary![0]!.spots![0]!.poiId, 76364);
  const task = reread.researchTasks.find(value => value.id === taskId)!;
  assert.equal(task.state, "confirmed");
  assert.equal(task.status, "succeeded");
  assert.match(task.evidence.at(-1)!.title ?? "", /\[itinerary-poi:verified\] 第1天 船观神女峰 -> 神女峰 \(76364\)/u);
});

test("官方名回查落到另一个 poiId 时保留原绑定并继续阻塞", async (t) => {
  const { db, id } = fixture(t, { name: "船观神女峰", poiName: "神女峰", poiId: 76364, kind: "attraction" });
  const taskId = db.addResearchTask(id, { label: "核查 船观神女峰 的 VBK POI 映射", type: "vbk", detail: "旧核验" });
  await review(db, id, keyword => keyword === "神女峰"
    ? { status: "available", match: { ...SHENNV, poiId: 999 } }
    : { status: "uncertain", reason: "ambiguous" });
  const reread = db.getProduct(id)!;
  assert.equal(reread.product.itinerary![0]!.spots![0]!.poiId, 76364);
  const task = reread.researchTasks.find(value => value.id === taskId)!;
  assert.equal(task.state, "researching");
  assert.match(task.detail ?? "", /本轮 POI 核验未完成/);
});

test("原始名与官方名相同时不追加回查，复核语义不变", async (t) => {
  const { db, id } = fixture(t, { name: "小公园", poiName: "小公园", poiId: 148613054, kind: "attraction" });
  const taskId = db.addResearchTask(id, { label: "核查 小公园 的 VBK POI 映射", type: "vbk", detail: CURRENT });
  const queried = await review(db, id, () => ({ status: "uncertain", reason: "no_candidate" }));
  assert.deepEqual(queried, ["小公园"]);
  const task = db.getProduct(id)!.researchTasks.find(value => value.id === taskId)!;
  assert.equal(task.state, "researching");
  assert.match(task.detail ?? "", /未召回可确认候选/u);
});

test("首轮原名地点未证实也要在补核轮执行官方名回查，回到同一 poiId 即复核通过", async (t) => {
  const { db, id } = fixture(t, { name: "船观神女峰", poiName: "神女峰", poiId: 76364, kind: "attraction" });
  const taskId = db.addResearchTask(id, { label: "核查 船观神女峰 的 VBK POI 映射", type: "vbk", detail: CURRENT });
  const queried = await review(db, id, keyword => keyword === "神女峰"
    ? { status: "available", match: SHENNV }
    : { status: "uncertain", reason: "location_mismatch" });
  assert.deepEqual(queried, ["船观神女峰", "神女峰"]);
  const detail = db.getProduct(id)!;
  assert.equal(detail.product.itinerary![0]!.spots![0]!.poiId, 76364);
  assert.notEqual(detail.researchTasks.find(task => task.id === taskId)!.state, "researching");
});

test("补核轮平台查询失败时，非复核景点不生成「未找到 POI」任务", async (t) => {
  const { db, id } = fixture(t, { name: "船观神女峰", kind: "attraction" });
  let calls = 0;
  const runtime = new DbOrchestratorRuntime(db);
  runtime.resolvePoiSelection = async () => {
    calls += 1;
    if (calls === 1) return { status: "uncertain", reason: "location_mismatch" } as any;
    throw new Error("固定查询超时");
  };
  // 首轮之后没有新增坐标参考：补核轮复用首轮原名结论，只跑一次。
  await enrichItineraryPois({ localProductId: id, destination: "万州", runtime, persistedTaskKeys: new Set(), queryTimeoutMs: 50 });
  assert.equal(calls, 1);
  assert.match(db.getProduct(id)!.researchTasks.find(task => task.label.includes("船观神女峰"))?.detail ?? "", /地域/);
});
