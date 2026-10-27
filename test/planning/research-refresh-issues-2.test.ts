import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { refreshSatisfiedResearchTasks } from "../../src/main/operations/research-refresh.js";
import { isResearchTaskSatisfiedByProduct } from "../../src/shared/research-task-satisfaction.js";

function withDb() {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-refresh-issues-"));
  return new VbkDatabase(dataPath);
}

function openTask(db: VbkDatabase, localProductId: string, label: string, type: "vbk" | "web" | "cost" | "image" = "vbk") {
  return db.addResearchTask(localProductId, { label, type, detail: "历史遗留待处理" });
}

test("刷新待处理事项不会清理字段不完整的用车或非法酒店 task", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "西安", days: 2, productForm: "privateTour" });
  db.updateProduct(product.id, {
    ...product.product,
    operations: {
      hotelTier: "当地9钻酒店/-9",
      vehicleResource: { resourceGroupId: 2206240 },
    },
  });
  openTask(db, product.id, "核查用车资源组（按目的地 / 出行人数）");
  openTask(db, product.id, "核查酒店资源");

  const result = refreshSatisfiedResearchTasks(db, product.id);
  assert.equal(result.updated, 0);
  assert.ok(db.getProduct(product.id)!.researchTasks.every((task) => task.state === "researching"));
});

test("刷新待处理事项不会因 POI 名称含酒店 / 用车字样而误清理 POI 任务", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "西安", days: 2, productForm: "privateTour" });
  db.updateProduct(product.id, {
    ...product.product,
    operations: {
      hotelTier: "当地5钻酒店/-38",
      vehicleResource: { resourceGroupId: 2206240, resourceGroupName: "5座经济550+..." },
    },
  });
  const hotelPoiId = openTask(db, product.id, "核查 西安民宿客栈街 的 VBK POI 映射");
  const legacyPoiId = openTask(db, product.id, "待核查景点 接送中心广场 的 VBK POI");
  const coverId = openTask(db, product.id, "获取产品封面图", "image");

  const result = refreshSatisfiedResearchTasks(db, product.id);
  assert.equal(result.updated, 0);
  const tasks = new Map(db.getProduct(product.id)!.researchTasks.map((task) => [task.id, task]));
  for (const id of [hotelPoiId, legacyPoiId, coverId]) {
    assert.equal(tasks.get(id)?.state, "researching");
  }
});

test("刷新待处理事项幂等：第二次不重复写 evidence，也不改已 confirmed task", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "西安", days: 2, productForm: "privateTour" });
  db.updateProduct(product.id, {
    ...product.product,
    operations: {
      hotelTier: "当地5钻酒店/-38",
      vehicleResource: { resourceGroupId: 2206240, resourceGroupName: "5座经济550+..." },
    },
  });
  const vehicleId = openTask(db, product.id, "核查用车资源组");

  const first = refreshSatisfiedResearchTasks(db, product.id);
  const afterFirst = db.getProduct(product.id)!.researchTasks.find((task) => task.id === vehicleId)!;
  const second = refreshSatisfiedResearchTasks(db, product.id);
  const afterSecond = db.getProduct(product.id)!.researchTasks.find((task) => task.id === vehicleId)!;

  assert.equal(first.updated, 1);
  assert.equal(second.updated, 0);
  assert.deepEqual(afterSecond.evidence, afterFirst.evidence);
});

// =====================================================================
// image 类 research task（封面图）刷新收敛回归：以下用例必须根据 task.type === "image"
// + product.presentation.cover 的结构性字段（source/poi/description/minQuality +
// 持久化的可选元数据）精确判定，**不允许**依赖任何模糊的 label / detail 关键词。
// =====================================================================

const persistedCtripLibraryCover = {
  source: "ctripLibrary",
  imageId: 1810403829,
  imageUrl: "https://dimg04.c-ctrip.com/images/0Z71341234567890.jpg",
  poi: "云冈石窟",
  description: "横版云冈石窟外景或代表性造像",
  minQuality: 3,
  thumbnailUrl: "https://dimg04.c-ctrip.com/images/200/0Z71341234567890.jpg",
  previewUrl: "https://dimg04.c-ctrip.com/images/500/0Z71341234567890.jpg",
  score: 0.92,
  resolution: "1280*1917",
  poiId: 79413,
  poiName: "云冈石窟",
  selectedAt: "2025-08-09T12:34:56.000Z",
} as const;

const persistedManualUploadCover = {
  source: "manualUpload",
  fileId: "manual-2025-08-09-001",
  originalName: "cover.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 1048576,
  poi: "云冈石窟",
  description: "运营手动上传的封面图",
  minQuality: 3,
  uploadedAt: "2025-08-09T12:34:56.000Z",
} as const;

function openImageTask(db: VbkDatabase, localProductId: string, label = "获取产品封面图") {
  return db.addResearchTask(localProductId, { label, type: "image", detail: "POI 云冈石窟；描述：横版；最低质量 3。" });
}

test("image 类型封面任务在产品含完整 ctripLibrary 封面（持久化可选元数据齐全）时被确认", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "云冈石窟", days: 1, productForm: "privateTour" });
  const imageTaskId = openImageTask(db, product.id);

  // 第一轮：产品还没有封面 -> 不应被满足
  const firstPass = refreshSatisfiedResearchTasks(db, product.id);
  assert.equal(firstPass.updated, 0);
  const beforeCover = db.getProduct(product.id)!.researchTasks.find((task) => task.id === imageTaskId)!;
  assert.equal(beforeCover.state, "researching");

  // 写入与产品 JSON 中实际持久化的 ctripLibrary 完整封面（含 imageId/imageUrl/...）
  db.updateProduct(product.id, {
    ...product.product,
    presentation: { cover: persistedCtripLibraryCover },
  });

  // 第二轮：应被满足
  const secondPass = refreshSatisfiedResearchTasks(db, product.id);
  assert.equal(secondPass.updated, 1);
  assert.deepEqual(secondPass.taskIds, [imageTaskId]);
  const afterCover = db.getProduct(product.id)!.researchTasks.find((task) => task.id === imageTaskId)!;
  assert.equal(afterCover.state, "confirmed");
  assert.equal(afterCover.status, "succeeded");
  assert.equal(afterCover.evidence?.length, 1);
});

test("image 类型封面任务在产品含完整 manualUpload 封面（缺省任何旧字段也不破坏）时被确认", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "云冈石窟", days: 1, productForm: "privateTour" });
  const imageTaskId = openImageTask(db, product.id);
  db.updateProduct(product.id, {
    ...product.product,
    presentation: { cover: persistedManualUploadCover },
  });

  const result = refreshSatisfiedResearchTasks(db, product.id);
  assert.equal(result.updated, 1);
  assert.deepEqual(result.taskIds, [imageTaskId]);
  const task = db.getProduct(product.id)!.researchTasks.find((item) => item.id === imageTaskId)!;
  assert.equal(task.state, "confirmed");
  assert.equal(task.status, "succeeded");
  assert.equal(task.evidence?.length, 1);
});

test("image 类型封面任务在产品完全没有 cover 时仍不满足", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "云冈石窟", days: 1, productForm: "privateTour" });
  const imageTaskId = openImageTask(db, product.id);

  const result = refreshSatisfiedResearchTasks(db, product.id);
  assert.equal(result.updated, 0);
  const task = db.getProduct(product.id)!.researchTasks.find((item) => item.id === imageTaskId)!;
  assert.equal(task.state, "researching");
  assert.equal(task.status, "queued");
  assert.equal(task.evidence.length, 0);
});

test("image 类型封面任务在 product.presentation.cover 缺 source/poi 或来源非法时仍不满足", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "云冈石窟", days: 1, productForm: "privateTour" });
  const imageTaskId = openImageTask(db, product.id);

  // ctripLibrary 仅要求 source + 非空 poi；description / minQuality 是可选历史元数据。
  const incompleteCovers = [
    { source: "ctripLibrary", description: "横版", minQuality: 3 }, // 缺 poi
    { source: "ctripLibrary", poi: "", description: "横版", minQuality: 3 }, // 空 poi
    { poi: "云冈石窟", description: "横版", minQuality: 3 }, // 缺 source
    { source: "vendorLibrary", poi: "云冈石窟", description: "横版", minQuality: 3 }, // 非法 source
  ];

  for (const cover of incompleteCovers) {
    db.updateProduct(product.id, {
      ...product.product,
      presentation: { cover },
    });
    const result = refreshSatisfiedResearchTasks(db, product.id);
    assert.equal(result.updated, 0, `非法封面不应满足：${JSON.stringify(cover)}`);
    const task = db.getProduct(product.id)!.researchTasks.find((item) => item.id === imageTaskId)!;
    assert.equal(task.state, "researching");
  }
});

test("封面任务确认后的二次刷新幂等：不再重复写 evidence，也不再次计数", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "云冈石窟", days: 1, productForm: "privateTour" });
  const imageTaskId = openImageTask(db, product.id);
  db.updateProduct(product.id, {
    ...product.product,
    presentation: { cover: persistedCtripLibraryCover },
  });

  const first = refreshSatisfiedResearchTasks(db, product.id);
  assert.equal(first.updated, 1);
  const afterFirst = db.getProduct(product.id)!.researchTasks.find((task) => task.id === imageTaskId)!;

  const second = refreshSatisfiedResearchTasks(db, product.id);
  const afterSecond = db.getProduct(product.id)!.researchTasks.find((task) => task.id === imageTaskId)!;

  assert.equal(second.updated, 0);
  assert.equal(second.taskIds.length, 0);
  assert.deepEqual(afterSecond.evidence, afterFirst.evidence);
  assert.equal(afterSecond.state, "confirmed");
});

test("封面任务已 confirmed / resolved 时不再被二次覆盖（跳过收敛）", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "云冈石窟", days: 1, productForm: "privateTour" });
  const imageTaskId = openImageTask(db, product.id);
  db.updateProduct(product.id, {
    ...product.product,
    presentation: { cover: persistedCtripLibraryCover },
  });
  // 提前手动置为 confirmed
  db.markResearchTasksSatisfied(product.id, [imageTaskId]);
  const evidenceBefore = db.getProduct(product.id)!.researchTasks.find((task) => task.id === imageTaskId)!.evidence;

  const result = refreshSatisfiedResearchTasks(db, product.id);
  assert.equal(result.updated, 0);
  const after = db.getProduct(product.id)!.researchTasks.find((task) => task.id === imageTaskId)!;
  assert.deepEqual(after.evidence, evidenceBefore);
  assert.equal(after.state, "confirmed");
});

test("明确 other/free 使对应 POI 核查失效，刷新幂等；切回景点后重新待核查", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "潮汕", days: 1, productForm: "privateTour" });
  db.updateProduct(product.id, { ...product.product, itinerary: [{ day: 1, title: "D1", spots: [{ name: "潮汕接团", kind: "other", poiName: null, poiId: null }] }] });
  const taskId = openTask(db, product.id, "核查 潮汕接团 的 VBK POI 映射");
  assert.equal(isResearchTaskSatisfiedByProduct({ label: "核查 潮汕接团 的 VBK POI 映射", type: "vbk" }, db.getProduct(product.id)!.product), true);
  assert.equal(refreshSatisfiedResearchTasks(db, product.id).updated, 1);
  assert.equal(refreshSatisfiedResearchTasks(db, product.id).updated, 0);
  const saved = db.getProduct(product.id)!;
  assert.equal(saved.researchTasks.find((task) => task.id === taskId)?.state, "confirmed");
  const reverted = structuredClone(saved.product) as Record<string, any>;
  reverted.itinerary[0].spots[0] = { name: "潮汕接团", kind: "attraction", poiName: null, poiId: null };
  assert.equal(isResearchTaskSatisfiedByProduct({ label: "核查 潮汕接团 的 VBK POI 映射", type: "vbk" }, reverted), false);
});

test("SQLite 重连后仅重开由 free/other 关闭的 POI task，并保留关闭依据", () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-kind-reopen-"));
  let db = new VbkDatabase(dataPath);
  const created = db.createProduct({ destination: "潮汕", days: 1, productForm: "privateTour" });
  const taskId = openTask(db, created.id, "核查 潮汕接团 的 VBK POI 映射");
  const other = structuredClone(created.product) as Record<string, any>;
  other.itinerary = [{ day: 1, title: "D1", spots: [{ name: "潮汕接团", kind: "other", poiName: null, poiId: null }] }];
  const first = db.replaceProductAndSatisfyResearchTasks(created.id, other, { status: "review" });
  assert.deepEqual(first.confirmedTaskIds, [taskId]);
  const closed = first.product.researchTasks.find((task) => task.id === taskId)!;
  assert.equal(closed.state, "confirmed");
  assert.match(closed.evidence?.[0]?.title ?? "", /无需 POI 核查/);
  (db as any).db.close();
  db = new VbkDatabase(dataPath);
  const reopenedProduct = db.getProduct(created.id)!;
  const attraction = structuredClone(reopenedProduct.product) as Record<string, any>;
  attraction.itinerary[0].spots[0] = { name: "潮汕接团", kind: "attraction", poiName: null, poiId: null };
  const second = db.replaceProductAndSatisfyResearchTasks(created.id, attraction, { status: "review" });
  assert.deepEqual(second.confirmedTaskIds, []);
  const reopened = second.product.researchTasks.find((task) => task.id === taskId)!;
  assert.equal(reopened.state, "researching");
  assert.match(reopened.evidence?.[0]?.title ?? "", /无需 POI 核查/);
  assert.equal(refreshSatisfiedResearchTasks(db, created.id).updated, 0);
  (db as any).db.close();
  fs.rmSync(dataPath, { recursive: true, force: true });
});

test("refresh 路径以非 POI 依据关闭并在切回景点时重开", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "潮汕", days: 1, productForm: "privateTour" });
  const taskId = openTask(db, product.id, "核查 潮汕送团 的 VBK POI 映射");
  db.updateProduct(product.id, { ...product.product, itinerary: [{ day: 1, spots: [{ name: "潮汕送团", kind: "other", poiName: null, poiId: null }] }] });
  assert.equal(refreshSatisfiedResearchTasks(db, product.id).updated, 1);
  assert.match(db.getProduct(product.id)!.researchTasks.find((task) => task.id === taskId)?.evidence?.at(-1)?.title ?? "", /itinerary-kind:no-poi/);
  const saved = db.getProduct(product.id)!;
  db.updateProduct(product.id, { ...saved.product, itinerary: [{ day: 1, spots: [{ name: "潮汕送团", kind: "attraction", poiName: null, poiId: null }] }] });
  assert.equal(refreshSatisfiedResearchTasks(db, product.id).updated, 0);
  assert.equal(db.getProduct(product.id)!.researchTasks.find((task) => task.id === taskId)?.state, "researching");
});
