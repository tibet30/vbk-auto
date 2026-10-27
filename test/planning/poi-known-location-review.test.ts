import test from "node:test";
import assert from "node:assert/strict";
import { resolvePlanningPoiAutoSelection } from "../../src/main/planning/poi-auto-selection.js";
import { enrichItineraryPois } from "../../src/main/planning/poi-enrichment.js";
import { DbOrchestratorRuntime } from "../../src/main/planning/runtime.js";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function fixture() {
  const db = new VbkDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "vbk-poi-location-")));
  const detail = db.createProduct({ destination: "潮汕", days: 1, productForm: "privateTour", userIdea: "D1: 炮台公园 > 小公园" });
  const itinerary = [{ day: 1, title: "汕头人文", description: "汕头公园游览", hotel: "无", meals: "自理", spots: [
    { name: "炮台公园", poiName: "炮台公园", poiId: 145664761, province: "广东", city: "中山" },
    { name: "小公园", poiName: "小公园", poiId: 148613054, province: "广东", city: "汕头" },
  ] }];
  db.updateProduct(detail.id, { ...detail.product, basicInfo: { ...detail.product.basicInfo, province: "广东" }, itinerary });
  return { db, id: detail.id, itinerary };
}

test("同省唯一同名也不能把明确的汕头当日景点匹配到中山", async () => {
  const { db, id } = fixture();
  const candidate = { index: 0, poiName: "炮台公园", poiId: 145664761, province: "广东", city: "中山", selectable: true, textFields: [] };
  let checked = false;
  const result = await resolvePlanningPoiAutoSelection({ localProductId: id, keyword: "炮台公园",
    product: db.getProduct(id)!.product, context: { destinationCity: "汕头", province: "广东" },
    detail: { httpStatus: 200, businessStatus: "Success", poiListCount: 1, best: candidate, candidates: [candidate] },
    disambiguate: async () => { throw new Error("外地候选不应交给模型"); },
    checkAvailability: async () => { checked = true; return { status: "available" }; },
  });
  assert.equal(result.reason, "location_mismatch");
  assert.equal(checked, false);
});

test("复核模式清空明确错城绑定，但暂时无法确认时保留无反证旧绑定并阻塞", async () => {
  const { db, id } = fixture();
  const runtime = new DbOrchestratorRuntime(db);
  const queried: string[] = [];
  runtime.resolvePoiSelection = async (_id, keyword) => { queried.push(keyword); return { status: "uncertain", reason: "location_mismatch" }; };
  runtime.getPoiAvailabilities = async ids => new Map(ids.map(id => [id, { status: "available" }]));
  const tasks = await enrichItineraryPois({ localProductId: id, destination: "潮汕", runtime, persistedTaskKeys: new Set(), reviewCompletePois: true });
  assert.deepEqual(queried, ["炮台公园", "小公园"]);
  const spots = db.getProduct(id)!.product.itinerary![0]!.spots!;
  assert.equal(spots[0]!.poiId, null);
  assert.equal(spots[0]!.name, "炮台公园");
  assert.equal(spots[1]!.poiId, 148613054);
  assert.equal(tasks[0]!.label, "核查 炮台公园 的 VBK POI 映射");
  assert.equal(tasks[1]!.label, "核查 小公园 的 VBK POI 映射");
  const pending = db.getProduct(id)!.researchTasks.find(task => task.label.includes("小公园"))!;
  assert.equal(pending.state, "researching");
  assert.match(pending.detail ?? "", /本轮 POI 核验未完成/);
});

test("核验期间人工改动行程时，拒绝用旧结果覆盖", async () => {
  const { db, id, itinerary } = fixture();
  const runtime = new DbOrchestratorRuntime(db);
  const current = db.getProduct(id)!;
  const changed = structuredClone(itinerary); changed[0]!.description = "运营的新指示";
  db.updateProduct(id, { ...current.product, itinerary: changed });
  const result = await runtime.writeResolvedItineraryPois(id, itinerary, itinerary);
  assert.equal(result.ok, false);
  assert.equal(db.getProduct(id)!.product.itinerary![0]!.description, "运营的新指示");
});

test("复核清除身份不符的旧绑定后，已确认任务按落库后的行程重新打开", async () => {
  const db = new VbkDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "vbk-poi-reopen-")));
  // 真实错绑样本（拉萨 27d3fe9a）：古格王朝曾被绑到主子层级不符的「古格王朝遗址-红殿」。
  const detail = db.createProduct({ destination: "阿里", days: 1, productForm: "privateTour", userIdea: "D1: 古格王朝" });
  db.updateProduct(detail.id, { ...detail.product, basicInfo: { ...detail.product.basicInfo, province: "西藏" },
    itinerary: [{ day: 1, title: "札达", description: "札达", hotel: "无", meals: "自理", spots: [
      { name: "古格王朝", poiName: "古格王朝遗址-红殿", poiId: 145360250, province: "西藏", city: "阿里" },
    ] }] });
  const taskId = db.addResearchTask(detail.id, { label: "核查 古格王朝 的 VBK POI 映射", type: "vbk", detail: "旧" });
  // 旧凭证与当前（错误）绑定一致：只看落库前的行程会误判为「仍有有效凭证」。
  db.markResearchAccepted(detail.id, taskId, "[itinerary-poi:verified] 第1天 古格王朝 -> 古格王朝遗址-红殿 (145360250)", "vbk");
  assert.equal(db.getProduct(detail.id)!.researchTasks.find(task => task.id === taskId)!.state, "confirmed");
  const runtime = new DbOrchestratorRuntime(db);
  runtime.resolvePoiSelection = async () => ({ status: "uncertain", reason: "identity_mismatch" });
  runtime.getPoiAvailabilities = async ids => new Map(ids.map(id => [id, { status: "available" }]));
  await enrichItineraryPois({ localProductId: detail.id, destination: "阿里", runtime, persistedTaskKeys: new Set(), reviewCompletePois: true });
  const saved = db.getProduct(detail.id)!;
  assert.equal(saved.product.itinerary![0]!.spots![0]!.poiId, null);
  const task = saved.researchTasks.find(item => item.id === taskId)!;
  assert.equal(task.state, "researching");
  assert.match(task.detail ?? "", /已清除/);
});
