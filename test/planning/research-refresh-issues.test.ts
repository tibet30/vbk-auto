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

test("刷新会修复已确认 POI task 的旧缺失说明且保留原 evidence", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "日喀则", days: 1, productForm: "privateTour" });
  db.updateProduct(product.id, {
    ...product.product,
    itinerary: [{ day: 1, title: "非遗中心", spots: [{
      name: "非遗中心参观", poiName: "非物质文化遗产展示中心", poiId: 150237367,
    }] }],
  });
  const taskId = db.addResearchTask(product.id, {
    label: "核查 非遗中心参观 的 VBK POI 映射", type: "vbk",
    detail: "未找到对应的 VBK POI，已保留原景点和原行程位置；请确认景点名称或手动录入 POI",
  });
  db.markResearchAccepted(product.id, taskId, "运营已手工保存 POI");
  const evidence = db.getProduct(product.id)!.researchTasks.find((task) => task.id === taskId)!.evidence;

  const result = refreshSatisfiedResearchTasks(db, product.id);
  assert.equal(result.updated, 1);
  assert.deepEqual(result.taskIds, [taskId]);
  const repaired = db.getProduct(product.id)!.researchTasks.find((task) => task.id === taskId)!;
  assert.equal(repaired.state, "confirmed");
  assert.equal(repaired.detail, "当前行程已保存有效的 VBK POI 映射。");
  assert.deepEqual(repaired.evidence, evidence);
  assert.equal(refreshSatisfiedResearchTasks(db, product.id).updated, 0);
});

test("满足 POI task 时保留不属于系统缺失模板的运营详情", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "西安", days: 1, productForm: "privateTour" });
  db.updateProduct(product.id, {
    ...product.product,
    itinerary: [{ day: 1, title: "城墙", spots: [{ name: "西安明城墙", poiName: "西安城墙", poiId: 75686 }] }],
  });
  const taskId = db.addResearchTask(product.id, {
    label: "核查 西安明城墙 的 VBK POI 映射", type: "vbk", detail: "运营备注：南门进入，保留人工复核记录",
  });
  assert.equal(refreshSatisfiedResearchTasks(db, product.id).updated, 1);
  assert.equal(db.getProduct(product.id)!.researchTasks.find((task) => task.id === taskId)?.detail,
    "运营备注：南门进入，保留人工复核记录");
});

test("刷新会把已确认任务的历史地域/身份失败说明修回已保存说明且保留 evidence", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "拉萨", days: 2, productForm: "privateTour" });
  db.updateProduct(product.id, {
    ...product.product,
    itinerary: [
      { day: 1, title: "羊卓雍措", spots: [{ name: "羊卓雍措", poiName: "羊卓雍错", poiId: 82105, province: "西藏", city: "山南", district: "浪卡子" }] },
      { day: 2, title: "佩枯措", spots: [{ name: "佩枯措", poiName: "佩枯错", poiId: 85085, province: "西藏", city: "日喀则", district: "吉隆" }] },
    ],
  });
  const details = [
    "已找到候选 POI，但其地域与产品主城市不一致；请确认当天行程地点范围或手动绑定 POI",
    "未找到与该景点一致、且不是其他景点或上下级景点的 VBK POI；请确认景点名称（可尝试简称），或手动绑定/删除该景点",
  ];
  const ids = ["羊卓雍措", "佩枯措"].map((name, index) => db.addResearchTask(product.id, {
    label: `核查 ${name} 的 VBK POI 映射`, type: "vbk", detail: details[index],
  }));
  for (const id of ids) db.markResearchAccepted(product.id, id, "旧版自动确认，说明未同步");
  const evidence = new Map(db.getProduct(product.id)!.researchTasks.map((task) => [task.id, task.evidence]));

  const result = refreshSatisfiedResearchTasks(db, product.id);
  assert.deepEqual(new Set(result.taskIds), new Set(ids));
  const tasks = new Map(db.getProduct(product.id)!.researchTasks.map((task) => [task.id, task]));
  for (const id of ids) {
    assert.equal(tasks.get(id)!.state, "confirmed");
    assert.equal(tasks.get(id)!.detail, "当前行程已保存有效的 VBK POI 映射。");
    assert.deepEqual(tasks.get(id)!.evidence, evidence.get(id));
  }
  assert.equal(refreshSatisfiedResearchTasks(db, product.id).updated, 0);
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

test("替换掉暂停营业景点后，历史 POI 待办会按当前行程自动收敛", () => {
  const product = {
    itinerary: [{
      day: 1,
      spots: [
        { name: "成都大熊猫繁育研究基地", poiName: "成都大熊猫繁育研究基地", poiId: 76342 },
        { name: "锦里", poiName: "锦里古街", poiId: 10558940 },
      ],
    }],
  };

  assert.equal(isResearchTaskSatisfiedByProduct({
    label: "核查 金沙遗址博物馆 的 VBK POI 映射",
    type: "vbk",
    detail: "携程景点详情标记为暂停营业，不能加入行程；请替换为正常营业景点",
  }, product), true);
  assert.equal(isResearchTaskSatisfiedByProduct({
    label: "核查 金沙遗址博物馆 的 VBK POI 映射",
    type: "vbk",
    detail: "历史遗留待处理",
  }, product), false);
});

test("刷新待处理事项会带 detail 判断并清理已替换的暂停营业 POI task", () => {
  const db = withDb();
  const product = db.createProduct({ destination: "成都", days: 2, productForm: "freeTravel" });
  db.updateProduct(product.id, {
    ...product.product,
    itinerary: [{
      day: 1,
      spots: [{ name: "成都大熊猫繁育研究基地", poiName: "成都大熊猫繁育研究基地", poiId: 76342 }],
    }],
  });
  const stalePoiId = db.addResearchTask(product.id, {
    label: "核查 金沙遗址博物馆 的 VBK POI 映射",
    type: "vbk",
    detail: "携程景点详情标记为暂停营业，不能加入行程；请替换为正常营业景点",
  });
  const ordinaryPoiId = openTask(db, product.id, "核查 金沙遗址公园 的 VBK POI 映射");

  const result = refreshSatisfiedResearchTasks(db, product.id);
  assert.equal(result.updated, 1);
  assert.deepEqual(result.taskIds, [stalePoiId]);

  const tasks = new Map(db.getProduct(product.id)!.researchTasks.map((task) => [task.id, task]));
  assert.equal(tasks.get(stalePoiId)?.state, "confirmed");
  assert.equal(tasks.get(stalePoiId)?.status, "succeeded");
  assert.equal(tasks.get(ordinaryPoiId)?.state, "researching");
});

test("替换掉非游览节点后，历史 POI 待办会按当前行程自动收敛", () => {
  const product = {
    itinerary: [{ day: 1, spots: [{ name: "日喀则市非物质文化中心", poiName: "日喀则非遗博物馆", poiId: 12345 }] }],
  };
  assert.equal(isResearchTaskSatisfiedByProduct({
    label: "核查 日喀则火车站 的 VBK POI 映射",
    type: "vbk",
    detail: "该名称是接送/交通/住宿节点，不能作为行程景点 POI；请替换为可游览景点",
  }, product), true);
  assert.equal(isResearchTaskSatisfiedByProduct({
    label: "核查 日喀则火车站 的 VBK POI 映射",
    type: "vbk",
    detail: "该名称是接送/交通/住宿节点，不能作为行程景点 POI；请替换为可游览景点",
  }, {
    itinerary: [{ day: 1, spots: [{ name: "日喀则火车站" }] }],
  }), false);
});

test("边防证旧任务在当前行程没有边境点位时自动收敛", () => {
  const product = {
    basicInfo: { userIdea: "旧路线包含亚东乃堆拉国门" },
    presentation: { recommendation: "旧文案提到边境通行" },
    itinerary: [{ day: 1, title: "日喀则市区游", spots: [{ name: "扎什伦布寺" }] }],
  };

  assert.equal(isResearchTaskSatisfiedByProduct({
    label: "边防证办理口径核查",
    type: "vbk",
    detail: "请人工核实亚东、乃堆拉国门的边防证办理流程。",
  }, product), true);
});

test("当前行程含边境点位时，边防证任务必须等基础信息或每日行程明确落地", () => {
  const base = {
    itinerary: [{ day: 2, title: "乃堆拉国门游览", spots: [{ name: "乃堆拉国门" }] }],
  };
  const task = {
    label: "边防证办理口径核查",
    type: "vbk",
    detail: "请人工核实边防证办理流程。",
  };

  assert.equal(isResearchTaskSatisfiedByProduct(task, {
    ...base,
    basicInfo: { operationNotes: "边防证办理口径以出行前最终确认为准。" },
  }), false);
  assert.equal(isResearchTaskSatisfiedByProduct(task, {
    ...base,
    commercial: { terms: { bookingNotes: "出行人须提前办理边境地区通行证，并携带有效身份证件。" } },
  }), false);
  assert.equal(isResearchTaskSatisfiedByProduct(task, {
    ...base,
    basicInfo: { operationNotes: "出行人须提前办理边境地区通行证，并携带有效身份证件。" },
  }), true);
  assert.equal(isResearchTaskSatisfiedByProduct(task, {
    itinerary: [{ day: 2, title: "乃堆拉国门游览", description: "出行人须提前办理边防证，并携带有效身份证件。", spots: [{ name: "乃堆拉国门" }] }],
  }), true);
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
