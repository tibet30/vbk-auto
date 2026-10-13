import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { applyVerifiedHotelDraftState } from "../../src/main/operations/hotel-draft-state.js";
import { evaluateAutomationContract } from "../../src/main/automation/automation-contract.js";
import { validateSkeleton } from "../../src/main/planning/validation/validators-commercial.js";
import { detectAcceptedModulesFromProduct } from "../../src/main/planning/runtime-accepted-modules.js";
import { isResearchTaskSatisfiedByProduct } from "../../src/shared/research-task-satisfaction.js";
import { normalisePlatformHotelProduct } from "../../src/shared/platform-hotel-rules.js";
import type { HotelDraftRetryResult } from "../../src/shared/hotel-draft-retry.js";

const proof: HotelDraftRetryResult = { verified: true, productId: "100", segmentIds: ["stay"],
  rules: { autoMatch: true, grades: [3, 4, 5] }, specifiedHotels: [], draftOnly: true };
const hotelFailures = (product: any) => evaluateAutomationContract(product).failures.filter(f => f.field.path.startsWith("operations.hotel"));
const product = () => normalisePlatformHotelProduct({ basicInfo: { meetingCity: "广安", nights: 1 },
  operations: { pickupCity: "广安", transport: "charter" },
  itinerary: [{ day: 1, hotel: "酒店", hotelCity: "广安" }, { day: 2, hotel: "无当日住宿安排" }] });

test("平台住宿无需 hotelTier、候选酒店；规则缺失和错误仍阻塞", () => {
  const value = product();
  assert.deepEqual(hotelFailures(value), []);
  assert.equal(validateSkeleton(value, true), null);
  assert.ok(detectAcceptedModulesFromProduct(value).includes("skeleton"));
  for (const label of ["AI 规划：hotelTier 字段", "住宿资源未完成", "hotelCandidates 待处理"]) {
    assert.equal(isResearchTaskSatisfiedByProduct({ type: "vbk", label }, value), true);
  }
  for (const rules of [undefined, { autoMatch: false, grades: [3, 4, 5] }, { autoMatch: true, grades: [4] }, { autoMatch: true, grades: [3, 4, 5, 5] }]) {
    const bad = { ...value, operations: { ...value.operations, hotelRules: rules } };
    assert.deepEqual(hotelFailures(bad).map(f => f.field.path), ["operations.hotelRules"]);
    assert.match(validateSkeleton(bad, true)!.reason!, /酒店规则缺失或无效/);
    assert.equal(detectAcceptedModulesFromProduct(bad).includes("skeleton"), false);
    assert.equal(isResearchTaskSatisfiedByProduct({ type: "vbk", label: "hotelTier" }, bad), false);
  }
});

function setup(context: any) {
  const root = mkdtempSync(join(tmpdir(), "vbk-hotel-state-"));
  const db = new VbkDatabase(root);
  context.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const original = db.createProduct({ destination: "广安", days: 2, productForm: "privateTour" });
  new ProductMutationService(db).replace(original.id, { ...original.product, ...product() });
  db.setProductLifecycle(original.id, { productId: "100", status: "blocked", basicInfoSaved: true });
  const at = new Date().toISOString();
  db.saveAutomation(original.id, { id: "automation", status: "failed", currentPhase: "hotelResource", logs: [],
    phases: [{ phase: "hotelResource", status: "failed" }, { phase: "vehicleResource", status: "pending" }, { phase: "terms", status: "failed" }],
    recovery: { phases: {
      hotelResource: { phase: "hotelResource", state: "needs_user", finalError: "旧酒店保存失败", userInstruction: "准备酒店",
        attempts: [{ attempt: 1, error: "旧酒店保存失败", at }] },
      terms: { phase: "terms", state: "needs_user", finalError: "条款未完成", attempts: [] },
    } } });
  db.saveAgentSnapshot({ localProductId: original.id,
    run: { id: "agent", status: "paused", createdAt: at, updatedAt: at }, events: [],
    uncertainWrite: { toolCallId: "phase:terms", message: "条款回读待确认", createdAt: at } });
  return { db, root, id: original.id, version: db.getProduct(original.id)!.productJsonVersion! };
}

test("新鲜酒店回读只清理酒店检查点，独立连接确认其他阶段及暂停状态保持；重复操作幂等", context => {
  const f = setup(context), before = f.db.getProduct(f.id)!;
  applyVerifiedHotelDraftState(f.db, f.id, proof, f.version);
  const reader = new VbkDatabase(f.root);
  try {
    const saved = reader.getProduct(f.id)!, snapshot = reader.getAgentSnapshot(f.id)!;
    assert.equal(saved.status, "blocked");
    assert.equal(saved.productJsonVersion, f.version);
    const { diagnostics: afterDiagnostics, ...afterBusiness } = saved.product;
    const { diagnostics: beforeDiagnostics, ...beforeBusiness } = before.product;
    assert.deepEqual(afterBusiness, beforeBusiness);
    assert.match(JSON.stringify(afterDiagnostics), /无需准备酒店/);
    assert.equal(saved.automation!.status, "failed");
    assert.equal(saved.automation!.currentPhase, undefined);
    assert.deepEqual(saved.automation!.phases.slice(1), before.automation!.phases.slice(1));
    assert.deepEqual(saved.automation!.recovery!.phases.terms, before.automation!.recovery!.phases.terms);
    const hotel = saved.automation!.recovery!.phases.hotelResource;
    assert.equal(saved.automation!.phases[0].status, "completed");
    assert.equal(hotel.state, "completed"); assert.equal(hotel.finalError, undefined);
    assert.equal(hotel.userInstruction, undefined); assert.equal(hotel.attempts.length, 0);
    assert.equal(hotel.attemptsHistory!.length, 1);
    assert.equal(snapshot.run!.status, "paused");
    assert.equal(snapshot.uncertainWrite!.toolCallId, "phase:terms");
    assert.equal(snapshot.pendingApproval, undefined);
    assert.equal(reader.latestWorkflowTaskForProduct(f.id)!.status, "needs_attention");
    assert.equal(snapshot.events.length, 1);
    assert.match(snapshot.events[0].content, /无需准备酒店/);
    applyVerifiedHotelDraftState(f.db, f.id, proof, f.version);
    assert.equal(reader.getAgentSnapshot(f.id)!.events.length, 1);
    assert.equal(reader.queryOperationLog({ localProductId: f.id }).filter(row => row.name === "酒店草稿本地状态同步").length, 1);
  } finally { reader.close(); }
});

test("规则、草稿、产品版本或住宿段回读证据无效均保留失败状态", context => {
  const f = setup(context);
  for (const bad of [{ ...proof, verified: false }, { ...proof, draftOnly: false },
    { ...proof, rules: { autoMatch: false, grades: [3, 4, 5] } }, { ...proof, segmentIds: [] },
    { ...proof, segmentIds: [""] }, { ...proof, specifiedHotels: [12] }, { ...proof, productId: "101" }]) {
    assert.throws(() => applyVerifiedHotelDraftState(f.db, f.id, bad as any, f.version));
  }
  assert.throws(() => applyVerifiedHotelDraftState(f.db, f.id, proof, f.version + 1), /方案已变化/);
  assert.equal(f.db.getProduct(f.id)!.automation!.phases[0].status, "failed");
  assert.equal(f.db.getAgentSnapshot(f.id)!.events.length, 0);
});
