import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import {
  hasCurrentVerifiedPoiEvidence,
  VERIFIED_POI_EVIDENCE_MARKER,
} from "../../src/main/infrastructure/database/parts/verified-poi-research.js";
import { poiResearchTaskLabel } from "../../src/shared/poi-research-tasks.js";

// 需要人工选择的歧义任务：只有受控凭证可以结清
const ambiguousDetail = "已找到多个候选 POI，但程序无法安全确定唯一地点；请手动选择 POI";
const SPOT_1 = "sp_aaaaaaaaaaa1";
const SPOT_2 = "sp_bbbbbbbbbbb2";

function withDb() {
  return new VbkDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "vbk-verified-poi-")));
}

function spot(name: string, spotId: string, poiId = 9, poiName = "A官方") {
  return { name, spotId, poiName, poiId };
}

function seed(db: VbkDatabase, itinerary: unknown[]) {
  const created = db.createProduct({ destination: "西安", days: 2, productForm: "privateTour" });
  db.updateProduct(created.id, { ...db.getProduct(created.id)!.product, itinerary });
  const taskId = db.addResearchTask(created.id, { label: poiResearchTaskLabel("A"), type: "vbk", detail: ambiguousDetail });
  return { id: created.id, taskId };
}

function taskOf(db: VbkDatabase, id: string, taskId: string) {
  return db.getProduct(id)!.researchTasks.find(task => task.id === taskId)!;
}

test("同名跨日两个槽位：只核验了第 1 天时任务不结清", () => {
  const db = withDb();
  const { id, taskId } = seed(db, [
    { day: 1, spots: [spot("A", SPOT_1)] },
    { day: 2, spots: [spot("A", SPOT_2)] },
  ]);
  const result = db.confirmVerifiedPoiResearchTasks(id, [
    { day: 1, spotId: SPOT_1, spotName: "A", poiName: "A官方", poiId: 9 },
  ]);
  assert.equal(result.updated, 0);
  assert.equal(taskOf(db, id, taskId).state, "researching");
});

test("凭证写入结构化 poiMappings 且可回读", () => {
  const db = withDb();
  const { id, taskId } = seed(db, [{ day: 1, spots: [spot("A", SPOT_1)] }]);
  const result = db.confirmVerifiedPoiResearchTasks(id, [
    { day: 1, spotId: SPOT_1, spotName: "A", poiName: "A官方", poiId: 9 },
  ]);
  assert.equal(result.updated, 1);
  const task = taskOf(db, id, taskId);
  assert.equal(task.state, "confirmed");
  const receipt = task.evidence!.at(-1)!;
  assert.deepEqual(receipt.poiMappings, [{ day: 1, spotId: SPOT_1, spotName: "A", poiName: "A官方", poiId: 9 }]);
  // 旧读取方仍能看到文本凭证
  assert.equal(receipt.title, `${VERIFIED_POI_EVIDENCE_MARKER} 第1天 A -> A官方 (9)`);
  const product = db.getProduct(id)!.product;
  assert.equal(hasCurrentVerifiedPoiEvidence(product, {
    label: task.label, type: task.type, evidence_json: JSON.stringify(task.evidence),
  }), true);
});

test("旧格式文本凭证仍可结清", () => {
  const product = { itinerary: [{ day: 1, spots: [spot("A", SPOT_1)] }] };
  const evidence = [{ id: "e1", title: `${VERIFIED_POI_EVIDENCE_MARKER} 第1天 A -> A官方 (9)`, source: "vbk", retrievedAt: "", accepted: true }];
  assert.equal(hasCurrentVerifiedPoiEvidence(product, {
    label: poiResearchTaskLabel("A"), type: "vbk", evidence_json: JSON.stringify(evidence),
  }), true);
});

test("景点改名但 spotId 与 poiId 未变，凭证仍有效", () => {
  const product = { itinerary: [{ day: 1, spots: [spot("A（含讲解）新名", SPOT_1)] }] };
  const evidence = [{
    id: "e1", title: `${VERIFIED_POI_EVIDENCE_MARKER} 第1天 A -> A官方 (9)`, source: "vbk", retrievedAt: "", accepted: true,
    poiMappings: [{ day: 1, spotId: SPOT_1, spotName: "A", poiName: "A官方", poiId: 9 }],
  }];
  assert.equal(hasCurrentVerifiedPoiEvidence(product, {
    label: poiResearchTaskLabel("A"), type: "vbk", evidence_json: JSON.stringify(evidence),
  }), true);
});

test("结构化凭证的 spotId 指向别的槽位时，同名同天也不能作证", () => {
  const product = { itinerary: [{ day: 1, spots: [spot("A", SPOT_2)] }] };
  const evidence = [{
    id: "e1", title: `${VERIFIED_POI_EVIDENCE_MARKER} 第1天 A -> A官方 (9)`, source: "vbk", retrievedAt: "", accepted: true,
    poiMappings: [{ day: 1, spotId: SPOT_1, spotName: "A", poiName: "A官方", poiId: 9 }],
  }];
  assert.equal(hasCurrentVerifiedPoiEvidence(product, {
    label: poiResearchTaskLabel("A"), type: "vbk", evidence_json: JSON.stringify(evidence),
  }), false);
});

test("spotId 相同但 poiId 已变，凭证失效", () => {
  const product = { itinerary: [{ day: 1, spots: [spot("A", SPOT_1, 10)] }] };
  const evidence = [{
    id: "e1", title: "", source: "vbk", retrievedAt: "", accepted: true,
    poiMappings: [{ day: 1, spotId: SPOT_1, spotName: "A", poiName: "A官方", poiId: 9 }],
  }];
  assert.equal(hasCurrentVerifiedPoiEvidence(product, {
    label: poiResearchTaskLabel("A"), type: "vbk", evidence_json: JSON.stringify(evidence),
  }), false);
});

test("改名后 restore 仍按 spotId 结清被重开的任务", () => {
  const db = withDb();
  const { id, taskId } = seed(db, [{ day: 1, spots: [spot("A", SPOT_1)] }]);
  assert.equal(db.confirmVerifiedPoiResearchTasks(id, [
    { day: 1, spotId: SPOT_1, spotName: "A", poiName: "A官方", poiId: 9 },
  ]).updated, 1);
  const product = db.getProduct(id)!.product;
  db.updateProduct(id, { ...product, itinerary: [{ day: 1, spots: [spot("A新名", SPOT_1)] }] });
  // 模拟历史重开路径：凭证保留、状态回到待处理
  (db as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
    .prepare("UPDATE research_tasks SET state='researching', status='queued' WHERE id=?").run(taskId);
  const restored = db.restoreCurrentVerifiedPoiResearchTasks(id);
  assert.deepEqual(restored.taskIds, [taskId]);
  assert.equal(taskOf(db, id, taskId).state, "confirmed");
});
