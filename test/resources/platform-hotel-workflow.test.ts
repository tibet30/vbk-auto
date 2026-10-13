import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { restoreHotelResourceCheckpoint } from "../../src/main/operations/restore-hotel-resource.js";
import { draftPhasesFor } from "../../src/main/automation/automation.main/automation.main.phases.js";
import { requiredAgentPhases } from "../../src/main/agent/integration-gates.js";
import { resourcePhaseNamesForProduct } from "../../src/renderer/app/helpers/vbk-nav-sections.js";
import { completeUnsupportedVehiclePhase } from "../../src/main/automation/automation.main/automation.main.resource-handlers.js";
import { prepareQueuedPhaseResume } from "../../src/main/automation/phase-retry.js";

const itinerary = () => ["眉", "太白", "留坝", "洋", "汉中"].map((hotelCity, index) => ({
  day: index + 1, hotelCity, hotel: "使用携程平台酒店，自动匹配三钻、四钻、五钻酒店", spots: [],
})).concat([{ day: 6, hotelCity: "", hotel: "无当日住宿安排", spots: [] }]);

test("各团态含住宿且无具体酒店时仍保留住宿资源、审批与界面步骤", () => {
  for (const productForm of ["privateTour", "groupTour", "semiSelfGuided", "freeTravel"]) {
    const product: any = { sales: { productForm }, operations: { transport: "none", hotelMatchingMode: "rules" }, itinerary: itinerary() };
    assert.equal(draftPhasesFor(product).includes("hotelResource"), true);
    assert.equal(requiredAgentPhases({ product } as any).includes("hotelResource"), true);
    assert.equal(resourcePhaseNamesForProduct({ product } as any).includes("hotelResource"), true);
    assert.equal(completeUnsupportedVehiclePhase(product, {} as any, "hotelResource", 0,
      () => { throw new Error("不能把住宿资源标记跳过"); }, () => { throw new Error("不能伪造资源完成"); }), false);
  }
});

function setup(context: any) {
  const root = mkdtempSync(join(tmpdir(), "vbk-hotel-rules-")); const db = new VbkDatabase(root);
  context.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const original = db.createProduct({ destination: "西安", days: 6, productForm: "privateTour" });
  new ProductMutationService(db).replace(original.id, { ...original.product, itinerary: itinerary() });
  db.setProductLifecycle(original.id, { status: "draft_saved", productId: "79709410", basicInfoSaved: true });
  const at = new Date().toISOString();
  db.saveAutomation(original.id, { id: "automation", status: "succeeded", logs: [], phases:
    ["basic", "presentation", "itinerary", "package", "pricingInventory", "vehicleResource", "terms", "preflight"]
      .map(phase => ({ phase, status: "completed" as const })) });
  db.saveAgentSnapshot({ localProductId: original.id, run: { id: "agent", status: "completed", createdAt: at, updatedAt: at },
    events: [{ id: "approval", runId: "agent", type: "approval", createdAt: at, content: "历史授权", data: { approval: { id: "old", status: "approved" } } }] });
  return { db, root, id: original.id };
}

test("恢复被遗漏的住宿规则步骤并独立回读，不改方案、不伪造保存、不沿用旧授权", context => {
  const { db, root, id } = setup(context); const before = db.getProduct(id)!;
  restoreHotelResourceCheckpoint(db, id);
  const reader = new VbkDatabase(root);
  try {
    const saved = reader.getProduct(id)!; const snapshot = reader.getAgentSnapshot(id)!;
    assert.equal(saved.productId, "79709410"); assert.equal(saved.status, "review");
    assert.equal(saved.productJsonVersion, before.productJsonVersion);
    assert.deepEqual(saved.product.itinerary, before.product.itinerary);
    assert.equal(saved.automation!.status, "queued");
    for (const phase of ["hotelResource", "vehicleResource", "preflight"])
      assert.equal(saved.automation!.phases.find(p => p.phase === phase)?.status, "pending");
    for (const phase of ["basic", "presentation", "itinerary", "package", "pricingInventory", "terms"])
      assert.equal(saved.automation!.phases.find(p => p.phase === phase)?.status, "completed");
    assert.equal(snapshot.run!.status, "paused"); assert.equal(snapshot.pendingApproval, undefined);
    assert.equal((snapshot.events[0].data!.approval as any).status, "invalidated");
    const logs = reader.queryOperationLog({ localProductId: id }).filter(log => log.name === "恢复住宿规则资源步骤");
    assert.equal(logs.length, 1); assert.equal(JSON.parse(logs[0].payloadJson).remoteWrites, 0);
    restoreHotelResourceCheckpoint(db, id);
    assert.equal(reader.getAgentSnapshot(id)!.events.length, 2);
  } finally { reader.close(); }
});

test("恢复住宿步骤保留其他失败，不修改正在执行或不确定写入", context => {
  const { db, id } = setup(context); const snapshot = db.getAgentSnapshot(id)!;
  snapshot.run!.status = "running"; db.saveAgentSnapshot(snapshot);
  assert.throws(() => restoreHotelResourceCheckpoint(db, id), /任务正在执行/);
  snapshot.run!.status = "completed";
  snapshot.uncertainWrite = { toolCallId: "phase:terms", createdAt: new Date().toISOString(), message: "仍需核查" };
  db.saveAgentSnapshot(snapshot);
  assert.throws(() => restoreHotelResourceCheckpoint(db, id), /不确定写入/);
  delete snapshot.uncertainWrite; db.saveAgentSnapshot(snapshot);
  const run = db.getProduct(id)!.automation!; run.phases.find(p => p.phase === "terms")!.status = "failed";
  db.saveAutomation(id, run); restoreHotelResourceCheckpoint(db, id);
  assert.equal(db.getProduct(id)!.status, "blocked"); assert.equal(db.getProduct(id)!.automation!.status, "failed");
});

test("补齐住宿后继续用车和最终预检，不重新保存已完成的条款", context => {
  const { db, root, id } = setup(context);
  restoreHotelResourceCheckpoint(db, id);
  const repaired = db.getProduct(id)!.automation!;
  repaired.phases.find(p => p.phase === "hotelResource")!.status = "completed";
  db.saveAutomation(id, repaired);
  const reader = new VbkDatabase(root);
  try {
    const persisted = reader.getProduct(id)!.automation!;
    const resumed = prepareQueuedPhaseResume(persisted, persisted.phases.map(p => p.phase), "vehicleResource");
    assert.deepEqual(resumed.phases.filter(p => p.status === "pending").map(p => p.phase), ["vehicleResource", "preflight"]);
    assert.equal(resumed.phases.find(p => p.phase === "terms")!.status, "completed");
    // Even a stale completed preflight must be re-read after resumed resource writes.
    persisted.phases.find(p => p.phase === "preflight")!.status = "completed";
    const rechecked = prepareQueuedPhaseResume(persisted, persisted.phases.map(p => p.phase), "vehicleResource");
    assert.equal(rechecked.phases.find(p => p.phase === "preflight")!.status, "pending");
    assert.equal(rechecked.phases.find(p => p.phase === "terms")!.status, "completed");
    // A commercial repair still reopens dependent terms and pricing as before.
    persisted.phases.find(p => p.phase === "package")!.status = "pending";
    const commercial = prepareQueuedPhaseResume(persisted, persisted.phases.map(p => p.phase), "package");
    assert.equal(commercial.phases.find(p => p.phase === "pricingInventory")!.status, "pending");
    assert.equal(commercial.phases.find(p => p.phase === "terms")!.status, "pending");
  } finally { reader.close(); }
});
