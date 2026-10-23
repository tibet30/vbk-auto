import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { DbOrchestratorRuntime } from "../../src/main/planning/runtime.js";
import { enrichItineraryPois } from "../../src/main/planning/poi-enrichment.js";
import { refreshSatisfiedResearchTasks } from "../../src/main/operations/research-refresh.js";
import { computeReadiness } from "../../src/main/readiness.js";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";

function fixture(t: TestContext, city: string | undefined = "汕头", province = "广东") {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-poi-review-"));
  const db = new VbkDatabase(dataPath);
  t.after(() => { db.close(); fs.rmSync(dataPath, { recursive: true, force: true }); });
  const created = db.createProduct({ destination: "潮汕", days: 1, productForm: "privateTour" });
  const itinerary = [{ day: 1, title: "城市游", description: "公园游览", hotel: "无", meals: "自理", spots: [
    { name: "小公园", poiName: "小公园", poiId: 148613054, province, city },
  ] }];
  db.updateProduct(created.id, { ...created.product,
    basicInfo: { ...created.product.basicInfo, destinationCity: "汕头", meetingCity: "汕头", province: "广东" }, itinerary });
  return { db, id: created.id, dataPath };
}

function readFromIndependentConnection<T>(dataPath: string, read: (db: VbkDatabase) => T): T {
  const reader = new VbkDatabase(dataPath);
  try { return read(reader); } finally { reader.close(); }
}

async function review(db: VbkDatabase, id: string, result: unknown) {
  const runtime = new DbOrchestratorRuntime(db);
  runtime.getPoiAvailabilities = async ids => new Map(ids.map(value => [value, { status: "available" as const }]));
  runtime.resolvePoiSelection = async () => {
    if (result instanceof Error) throw result;
    return result as any;
  };
  await enrichItineraryPois({ localProductId: id, destination: "潮汕", runtime,
    persistedTaskKeys: new Set(), reviewCompletePois: true, queryTimeoutMs: 20 });
}

for (const [name, result, wording] of [
  ["平台查询失败", new Error("network down"), /查询失败或超时/],
  ["当前未召回", { status: "uncertain", reason: "no_candidate" }, /未召回可确认候选/],
  ["候选地域不足", { status: "uncertain", reason: "location_mismatch" }, /地域信息不足/],
  ["候选歧义", { status: "uncertain", reason: "ambiguous" }, /多个候选/],
] as const) {
  test(`${name}保留无地域反证的旧绑定，并重开不可自动结清的本轮核验`, async (t) => {
    const { db, id, dataPath } = fixture(t);
    const taskId = db.addResearchTask(id, { label: "核查 小公园 的 VBK POI 映射", type: "vbk", detail: "旧核验" });
    db.markResearchAccepted(id, taskId, "旧人工核验");
    const oldEvidenceId = db.getProduct(id)!.researchTasks[0]!.evidence[0]!.id;

    await review(db, id, result);
    let reread = readFromIndependentConnection(dataPath, reader => reader.getProduct(id)!);
    const task = reread.researchTasks.find(value => value.id === taskId)!;
    assert.equal(reread.product.itinerary![0]!.spots![0]!.poiId, 148613054);
    assert.equal(task.state, "researching");
    assert.match(task.detail ?? "", wording);
    assert.equal(task.evidence[0]!.id, oldEvidenceId);
    const readiness = computeReadiness({ product: reread.product, researchTasks: reread.researchTasks });
    assert.equal(readiness.ready, false);
    assert.equal(readiness.issues.some(issue => issue.label.includes("小公园") && issue.detail.includes("本轮 POI 核验未完成")), true);
    assert.equal(readFromIndependentConnection(dataPath, reader => reader.getAgentSnapshot(id)?.pendingApproval), undefined);

    assert.equal(refreshSatisfiedResearchTasks(db, id).confirmed, 0);
    db.updateProduct(id, structuredClone(reread.product));
    reread = readFromIndependentConnection(dataPath, reader => reader.getProduct(id)!);
    assert.equal(reread.researchTasks.find(value => value.id === taskId)!.state, "researching");
  });
}

test("明确错城和暂停营业清空旧绑定", async (t) => {
  const wrong = fixture(t, "中山");
  await review(wrong.db, wrong.id, { status: "uncertain", reason: "location_mismatch" });
  assert.equal(wrong.db.getProduct(wrong.id)!.product.itinerary![0]!.spots![0]!.poiId, null);

  const suspended = fixture(t);
  const runtime = new DbOrchestratorRuntime(suspended.db);
  runtime.getPoiAvailabilities = async ids => new Map(ids.map(value => [value, { status: "suspended" as const }]));
  runtime.resolvePoiSelection = async () => { throw new Error("不应查询暂停 POI"); };
  await enrichItineraryPois({ localProductId: suspended.id, destination: "潮汕", runtime,
    persistedTaskKeys: new Set(), reviewCompletePois: true });
  assert.equal(suspended.db.getProduct(suspended.id)!.product.itinerary![0]!.spots![0]!.poiId, null);
});

test("缺城市时仍清空明确错省，但正确省份的缺失字段不构成反证", async (t) => {
  const wrongProvince = fixture(t, undefined, "福建");
  await review(wrongProvince.db, wrongProvince.id, new Error("timeout"));
  assert.equal(wrongProvince.db.getProduct(wrongProvince.id)!.product.itinerary![0]!.spots![0]!.poiId, null);

  const missingCity = fixture(t, undefined, "广东");
  await review(missingCity.db, missingCity.id, new Error("timeout"));
  const retained = missingCity.db.getProduct(missingCity.id)!;
  assert.equal(retained.product.itinerary![0]!.spots![0]!.poiId, 148613054);
  assert.equal(retained.researchTasks[0]!.state, "researching");
  assert.match(retained.researchTasks[0]!.detail ?? "", /本轮 POI 核验未完成/);
});

test("当前受控选择成功才追加新回执并结清本轮核验", async (t) => {
  const { db, id } = fixture(t);
  const taskId = db.addResearchTask(id, { label: "核查 小公园 的 VBK POI 映射", type: "vbk", detail: "旧核验" });
  db.markResearchAccepted(id, taskId, "旧人工核验");
  const oldReceipt = db.getProduct(id)!.researchTasks[0]!.evidence[0]!.id;
  await review(db, id, { status: "uncertain", reason: "no_candidate" });
  await review(db, id, { status: "available", match: {
    poiName: "小公园", poiId: 148613054, province: "广东", city: "汕头",
  } });
  const task = db.getProduct(id)!.researchTasks.find(value => value.id === taskId)!;
  assert.equal(task.state, "confirmed");
  assert.equal(task.evidence[0]!.id, oldReceipt);
  assert.notEqual(task.evidence.at(-1)!.id, oldReceipt);
  assert.match(task.evidence.at(-1)!.title, /\[itinerary-poi:verified\]/);
});

test("没有旧绑定的失败仍保持空绑定并阻塞", async (t) => {
  const { db, id } = fixture(t);
  const current = db.getProduct(id)!;
  const product = structuredClone(current.product);
  product.itinerary![0]!.spots![0]!.poiName = null;
  product.itinerary![0]!.spots![0]!.poiId = null;
  db.updateProduct(id, product);
  await review(db, id, { status: "uncertain", reason: "no_candidate" });
  const reread = db.getProduct(id)!;
  assert.equal(reread.product.itinerary![0]!.spots![0]!.poiId, null);
  assert.equal(reread.researchTasks.some(task => task.state === "researching"), true);
});

test("当前人工改为其他活动可按既有生产语义结清本轮核验", async (t) => {
  const { db, id } = fixture(t);
  await review(db, id, { status: "uncertain", reason: "no_candidate" });
  const current = db.getProduct(id)!;
  const product = structuredClone(current.product);
  product.itinerary![0]!.spots![0]!.kind = "other";
  db.updateProduct(id, product);
  assert.equal(refreshSatisfiedResearchTasks(db, id).confirmed, 1);
  const task = db.getProduct(id)!.researchTasks[0]!;
  assert.equal(task.state, "confirmed");
  assert.match(task.evidence.at(-1)!.title, /itinerary-kind:no-poi/);
});

test("当前运营删除命令生成可信凭证并结清本轮核验", async (t) => {
  const { db, id } = fixture(t);
  await review(db, id, { status: "uncertain", reason: "no_candidate" });
  const current = db.getProduct(id)!;
  const mutations = new ProductMutationService(db);
  mutations.commands.manualField({ localProductId: id, source: "user", expectedVersion: current.productJsonVersion ?? 0 },
    { field: "itinerarySpotRemove", dayIndex: 0, spotIndex: 0 });
  const refreshed = refreshSatisfiedResearchTasks(db, id);
  assert.equal(refreshed.confirmed, 0);
  const saved = db.getProduct(id)!;
  assert.deepEqual(saved.product.itinerary![0]!.spots, []);
  assert.equal(saved.researchTasks[0]!.state, "confirmed");
  assert.match(saved.researchTasks[0]!.evidence.at(-1)!.title, /itinerary-operator:removed/);
});
