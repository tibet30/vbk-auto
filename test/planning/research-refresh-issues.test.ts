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

test("刷新待处理事项会清理已满足的用车 / 酒店 / 商业旧 task，保留未满足 POI", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "西安", days: 2, productForm: "privateTour" });
  db.updateProduct(product.id, {
    ...product.product,
    operations: {
      hotelTier: "当地5钻酒店/-38",
      vehicleResource: { resourceGroupId: 2206240, resourceGroupName: "5座经济550+..." },
    },
  });
  const vehicleId = openTask(db, product.id, "核查用车资源组（按目的地 / 出行人数）");
  const hotelId = openTask(db, product.id, "核查酒店资源");
  const priceId = openTask(db, product.id, "核查成人价 / 儿童价 / 起订人数在 VBK 是否可发布");
  const inventoryId = openTask(db, product.id, "核查库存起止日期与每日配额在 VBK 是否生效");
  const packageId = openTask(db, product.id, "核查套餐名称与公开渠道展示一致", "web");
  const termsId = openTask(db, product.id, "核查费用包含 / 不包含 / 退改政策的运营成本口径", "cost");
  const poiId = openTask(db, product.id, "核查 回民街 的 VBK POI 映射");

  const result = refreshSatisfiedResearchTasks(db, product.id);
  assert.equal(result.updated, 6);
  assert.deepEqual(new Set(result.taskIds), new Set([vehicleId, hotelId, priceId, inventoryId, packageId, termsId]));

  const tasks = new Map(db.getProduct(product.id)!.researchTasks.map((task) => [task.id, task]));
  for (const id of [vehicleId, hotelId, priceId, inventoryId, packageId, termsId]) {
    assert.equal(tasks.get(id)?.state, "confirmed");
    assert.equal(tasks.get(id)?.status, "succeeded");
    assert.equal(tasks.get(id)?.evidence?.length, 1);
  }
  assert.equal(tasks.get(poiId)?.state, "researching");
});

test("刷新待处理事项会清理产品行程中已保存有效 POI 的 canonical POI task", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "西安", days: 2, productForm: "privateTour" });
  db.updateProduct(product.id, {
    ...product.product,
    itinerary: [
      {
        day: 2,
        title: "西安城墙",
        spots: [{ name: "西安明城墙", poiName: "西安城墙", poiId: 75686 }],
      },
    ],
  });
  const poiTaskId = openTask(db, product.id, "核查 西安明城墙 的 VBK POI 映射");

  assert.equal(isResearchTaskSatisfiedByProduct({
    label: "核查 西安明城墙 的 VBK POI 映射",
    type: "vbk",
  }, db.getProduct(product.id)!.product), true);

  const result = refreshSatisfiedResearchTasks(db, product.id);
  assert.equal(result.updated, 1);
  assert.deepEqual(result.taskIds, [poiTaskId]);
  const task = db.getProduct(product.id)!.researchTasks.find((item) => item.id === poiTaskId)!;
  assert.equal(task.state, "confirmed");
  assert.equal(task.status, "succeeded");
});

test("POI task 只有对应 spot 且保存非空 poiName / 正整数 poiId 时才满足", () => {
  const task = { label: "核查 西安明城墙 的 VBK POI 映射", type: "vbk" };
  const product = (spot: Record<string, unknown>) => ({ itinerary: [{ day: 1, spots: [spot] }] });

  assert.equal(isResearchTaskSatisfiedByProduct(task, product({
    name: "西安钟楼",
    poiName: "西安城墙",
    poiId: 75686,
  })), false);
  assert.equal(isResearchTaskSatisfiedByProduct(task, product({
    name: "西安明城墙",
    poiName: " ",
    poiId: 75686,
  })), false);
  assert.equal(isResearchTaskSatisfiedByProduct(task, product({
    name: "西安明城墙",
    poiName: "西安城墙",
    poiId: null,
  })), false);
  assert.equal(isResearchTaskSatisfiedByProduct(task, product({
    name: "西安明城墙",
    poiName: "西安城墙",
    poiId: "75686",
  })), false);
  assert.equal(isResearchTaskSatisfiedByProduct(task, product({
    name: "西安明城墙",
    poiName: "西安城墙",
    poiId: 0,
  })), false);
});

test("替换掉 suggestPoi 失败景点后，历史 POI 待办会按当前行程自动收敛", () => {
  const product = {
    itinerary: [{ day: 2, spots: [{ name: "夫子庙", poiName: "夫子庙", poiId: 150299051 }] }],
  };
  assert.equal(isResearchTaskSatisfiedByProduct({
    label: "核查 老门东历史文化街区 的 VBK POI 映射",
    type: "vbk",
    detail: "suggestPoi 未匹配，请人工核查",
  }, product), true);
  assert.equal(isResearchTaskSatisfiedByProduct({
    label: "核查 老门东历史文化街区 的 VBK POI 映射",
    type: "vbk",
    detail: "由目的地「南京」延伸",
  }, product), false);
});

test("legacy POI label 仍可在有有效 POI 时满足", () => {
  const product = {
    itinerary: [{ day: 1, spots: [{ name: "晋祠", poiName: "晋祠博物馆", poiId: 79413 }] }],
  };

  assert.equal(isResearchTaskSatisfiedByProduct({
    label: "待核查景点 晋祠 的 VBK POI",
    type: "vbk",
  }, product), true);
  assert.equal(isResearchTaskSatisfiedByProduct({
    label: "核查 晋祠博物馆 在 VBK 资源库的 city / poi 映射",
    type: "vbk",
  }, product), true);
});

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

test("image 类型封面任务在 product.presentation.cover 缺 source/poi/description/minQuality 中任一字段时仍不满足", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "云冈石窟", days: 1, productForm: "privateTour" });
  const imageTaskId = openImageTask(db, product.id);

  const incompleteCovers = [
    { source: "ctripLibrary", description: "横版", minQuality: 3 }, // 缺 poi
    { source: "ctripLibrary", poi: "云冈石窟", minQuality: 3 }, // 缺 description
    { source: "ctripLibrary", poi: "云冈石窟", description: "横版" }, // 缺 minQuality
    { poi: "云冈石窟", description: "横版", minQuality: 3 }, // 缺 source
    { source: "vendorLibrary", poi: "云冈石窟", description: "横版", minQuality: 3 }, // 非法 source
  ];

  for (const cover of incompleteCovers) {
    db.updateProduct(product.id, {
      ...product.product,
      presentation: { cover },
    });
    const result = refreshSatisfiedResearchTasks(db, product.id);
    assert.equal(result.updated, 0, `非法封面不应满足：${cover}`);
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
