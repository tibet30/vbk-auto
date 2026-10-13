import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { ProductWorkflowCoordinator } from "../../src/main/application/product-workflow-coordinator.js";
import { HotelDraftRetry } from "../../src/main/operations/hotel-draft-retry.js";
import { hotelDraftRequestScope } from "../../src/main/operations/hotel-draft-request-scope.js";

function setup(context: any) {
  const root = mkdtempSync(join(tmpdir(), "vbk-hotel-draft-"));
  const db = new VbkDatabase(root);
  context.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const original = db.createProduct({ destination: "广安", days: 2, productForm: "privateTour" });
  db.saveLocalProductState({ ...original, vbkAccount: "vbk_test" }, 1, 0);
  const mutations = new ProductMutationService(db);
  mutations.replace(original.id, { ...original.product, basicInfo: { ...original.product.basicInfo, nights: 1, userIdea: "白塔公园—丽枫酒店" },
    operations: { hotelTier: "当地3钻酒店", hotelResource: { resourceId: 55195528 } },
    itinerary: [{ day: 1, title: "白塔公园—丽枫酒店", hotel: "丽枫酒店", hotelCity: "广安", spots: [] },
      { day: 2, title: "返程", hotel: "无当日住宿安排", spots: [] }] });
  db.setProductLifecycle(original.id, { productId: "100", status: "blocked", basicInfoSaved: true });
  const city = { cityId: 94, cityName: "广安" };
  const segments = [0, 1, 0].map((nights, index) => ({ segmentId: String(index + 1), productId: 900100,
    segmentBase: { segmentNumber: index + 1, stayNights: nights, minStayNights: nights, maxStayNights: nights,
      departureCity: city, destinationCity: city }, packages: [{ resourceId: 88 }],
    segmentResourceGroups: [{ resourceGroupId: 42 }], hotel: index === 1 ? { segmentRooms: [{ hotelID: 55195528 }] } : undefined })) as any[];
  const state = { account: "vbk_test", time: 1000, corrupt: false, saves: 0, calls: [] as string[] };
  const page: any = { nativeOnly: true, evaluate: async () => { throw new Error("禁止页面脚本"); }, vbkSessionFetch: async (request: any) => {
    assert.equal(request.referrer, "https://vbooking.ctrip.com/product/input/newResourceRule?productid=100&from=vbk");
    assert.equal(request.referrerPolicy, "no-referrer-when-downgrade");
    assert.equal(request.headers.cookieorigin, "https://vbooking.ctrip.com");
    const action = new URL(request.endpoint).pathname.split("/").at(-1)!;
    state.calls.push(action);
    assert.ok(["getSegments", "saveSegment"].includes(action), "禁止酒店查询、其他阶段及发布");
    if (action === "saveSegment") {
      const segment = structuredClone(request.body.segment);
      assert.equal(segment.hotel.systemHotel.goodHotel, "F");
      if (state.corrupt) segment.hotel.systemHotel.hotelStar = [4];
      segments[segments.findIndex(item => item.segmentId === segment.segmentId)] = segment; state.saves++;
    }
    return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, draftProductSegments: { segments: structuredClone(segments) } },
      durationMs: 1, ctx: {} };
  } };
  const coordinator = new ProductWorkflowCoordinator();
  const retry = new HotelDraftRetry({ getProduct: id => db.getProduct(id), accountKey: () => state.account, now: () => state.time,
    saveProduct: (id, product, expectedVersion) => mutations.replace(id, product, { expectedVersion, source: "manual" }),
    assertIdle: id => coordinator.assertIdle(id, "resource"), withLocks: (id, work) => coordinator.runExclusive(id, "resource", work),
    getPage: async () => page, message: (id, content) => db.addMessage(id, "assistant", content),
    record: (id, status, message, payload) => db.appendOperationLog({ id: randomUUID(), type: "automation", name: "仅酒店规则草稿",
      localProductId: id, status, message, payload, startedAt: new Date().toISOString() }) });
  return { retry, db, mutations, id: original.id, state, segments, page, root };
}

test("单酒店阶段保存草稿并独立连接回读本地转换和收据，不执行或发布其他阶段", async context => {
  const f = setup(context); const untouched = structuredClone(f.segments.map(({ hotel, ...rest }) => rest));
  const plan = f.retry.prepare(f.id);
  assert.deepEqual(plan.stays, [{ cityName: "广安", nights: 1 }]);
  assert.equal((f.db.getProduct(f.id)!.product.operations as any).hotelResource.resourceId, 55195528, "准备确认只读");
  const receipt = await f.retry.execute(plan.token);
  assert.equal(receipt.verified, true); assert.equal(receipt.draftOnly, true);
  assert.deepEqual(f.segments[1].hotel.segmentRooms, []);
  assert.deepEqual(f.segments[1].hotel.systemHotel.hotelStar, [3, 4, 5]);
  assert.deepEqual(f.segments.map(({ hotel, ...rest }) => rest), untouched);
  const reader = new VbkDatabase(f.root);
  try {
    const saved = reader.getProduct(f.id)!;
    assert.equal(saved.status, "blocked", "酒店草稿成功不能宣布整产品录入完成");
    assert.equal((saved.product.operations as any).hotelResource, undefined);
    assert.equal((saved.product.operations as any).hotelTier, undefined);
    assert.doesNotMatch(JSON.stringify(saved.product.itinerary), /丽枫/);
    assert.equal(reader.queryOperationLog({ localProductId: f.id }).filter(row => row.status === "succeeded").length, 1);
  } finally { reader.close(); }
  await assert.rejects(f.retry.execute(plan.token), /已过期或已使用/);
  await f.retry.execute(f.retry.prepare(f.id).token);
  assert.equal(f.state.saves, 1, "重复执行只查询已保存规则");
});

test("过期、方案变更及账号变更均在发送请求前拒绝，历史授权无效", async context => {
  const f = setup(context);
  const expired = f.retry.prepare(f.id); f.state.time += 300_001;
  await assert.rejects(f.retry.execute(expired.token), /过期/);
  const stale = f.retry.prepare(f.id);
  const current = f.db.getProduct(f.id)!;
  f.mutations.replace(f.id, { ...current.product, note: "内容变化" });
  await assert.rejects(f.retry.execute(stale.token), /方案已变化/);
  const wrongAccount = f.retry.prepare(f.id); f.state.account = "vbk_other";
  await assert.rejects(f.retry.execute(wrongAccount.token), /账号已变化/);
  assert.deepEqual(f.state.calls, []);
});

test("保存应答成功但规则回读错误不产生成功收据", async context => {
  const f = setup(context); f.state.corrupt = true;
  await assert.rejects(f.retry.execute(f.retry.prepare(f.id).token), /草稿回读不一致/);
  assert.equal(f.db.queryOperationLog({ localProductId: f.id }).some(row => row.status === "succeeded"), false);
});

test("无需用车的产品同样只保存草稿，禁止自动发布资源模块", async context => {
  const f = setup(context);
  const current = f.db.getProduct(f.id)!;
  f.mutations.replace(f.id, { ...current.product, sales: { productForm: "freeTravel" } });
  const result = await f.retry.execute(f.retry.prepare(f.id).token);
  assert.equal(result.draftOnly, true);
  assert.equal(result.verified, true);
  assert.deepEqual([...new Set(f.state.calls)], ["getSegments", "saveSegment"]);
});

test("酒店草稿请求白名单拒绝发布、跨产品及非酒店资源改写", async context => {
  const f = setup(context); const scope = hotelDraftRequestScope(f.page, "100", () => {});
  const request = (action: string, body: object) => scope.vbkSessionFetch!({ endpoint: `https://online.ctrip.com/restapi/soa2/15638/${action}`,
    body, errorLabel: "范围测试", headers: {}, includeCidQuery: false, requireReadableCid: false });
  await request("getSegments", { productId: 100 });
  for (const action of ["publishProductModules", "submitSegments", "saveSaleControlInfo"])
    await assert.rejects(request(action, { productId: 100 }), /禁止其他阶段/);
  await assert.rejects(request("getSegments", { productId: 101 }), /产品不一致/);
  await assert.rejects(request("createProductDraft", { productId: 100, module: "basic" }), /仅限资源模块/);
  await assert.rejects(request("saveSegment", { segment: { ...f.segments[1], packages: [{ resourceId: 99 }] } }), /禁止改写/);
  await assert.rejects(request("saveSegment", { segment: { ...f.segments[1], productId: 101 } }), /产品不一致/);
});
