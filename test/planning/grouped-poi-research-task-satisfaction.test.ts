import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { refreshSatisfiedResearchTasks } from "../../src/main/operations/research-refresh.js";
import { poiResearchTaskNames } from "../../src/shared/poi-research-tasks.js";
import { isResearchTaskSatisfiedByProduct } from "../../src/shared/research-task-satisfaction.js";

const groupedTask = {
  label: "核查 日喀则市博物馆 或 日喀则非物质文化遗产中心 的 VBK POI 映射",
  type: "vbk",
};

const resolvedAlternatives = {
  itinerary: [{
    day: 2,
    spots: [
      { name: "日喀则市博物馆", poiName: "日喀则博物馆", poiId: 79437758 },
      { name: "日喀则非物质文化遗产中心", poiName: "非物质文化遗产展示中心", poiId: 150237367 },
    ],
  }],
};

test("组合备选 POI 任务逐项匹配，不能把 A 或 B 当成一个景点", () => {
  assert.deepEqual(poiResearchTaskNames(groupedTask.label, groupedTask.type), [
    "日喀则市博物馆",
    "日喀则非物质文化遗产中心",
  ]);
  assert.equal(isResearchTaskSatisfiedByProduct(groupedTask, resolvedAlternatives), true);
  assert.equal(isResearchTaskSatisfiedByProduct(groupedTask, {
    itinerary: [{ day: 2, spots: [resolvedAlternatives.itinerary[0].spots[0]] }],
  }), false, "只完成一个备选 POI 时，组合任务必须继续保留");
});

test("刷新待处理事项会结案已手工配置完成的组合备选 POI 任务", () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-grouped-poi-task-"));
  try {
    const db = new VbkDatabase(dataPath);
    const product = db.createProduct({ destination: "日喀则", days: 2, productForm: "privateTour" });
    db.updateProduct(product.id, { ...product.product, ...resolvedAlternatives });
    const taskId = db.addResearchTask(product.id, {
      ...groupedTask,
      detail: "未找到对应的 VBK POI，已保留原景点和原行程位置；请确认景点名称或手动录入 POI",
    });

    const result = refreshSatisfiedResearchTasks(db, product.id);
    assert.deepEqual(result.taskIds, [taskId]);
    const task = db.getProduct(product.id)!.researchTasks.find((item) => item.id === taskId)!;
    assert.equal(task.state, "confirmed");
    assert.equal(task.status, "succeeded");
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("& 连接的历史复合 POI 任务在各组件均已改判为非 POI 后结案", () => {
  const label = "核查 雪域主峰秘境穿越&雪地摩托 的 VBK POI 映射";
  assert.deepEqual(poiResearchTaskNames(label, "vbk"), ["雪域主峰秘境穿越", "雪地摩托"]);

  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-compound-non-poi-task-"));
  try {
    const db = new VbkDatabase(dataPath);
    const product = db.createProduct({ destination: "吉林", days: 6, productForm: "privateTour" });
    db.updateProduct(product.id, {
      ...product.product,
      itinerary: [{ day: 6, spots: [
        { name: "雪域主峰秘境穿越", kind: "other", poiName: null, poiId: null },
        { name: "雪地摩托", kind: "attraction", poiName: null, poiId: null },
      ] }],
    });
    const taskId = db.addResearchTask(product.id, {
      label,
      type: "vbk",
      detail: "已找到候选 POI，但其地域与产品主城市不一致",
    });

    assert.equal(refreshSatisfiedResearchTasks(db, product.id).updated, 0,
      "任一组成项仍是未绑定景点时，复合任务必须继续保留");
    const current = db.getProduct(product.id)!;
    db.updateProduct(product.id, {
      ...current.product,
      itinerary: [{ day: 6, spots: [
        { name: "雪域主峰秘境穿越", kind: "other", poiName: null, poiId: null },
        { name: "雪地摩托", kind: "other", poiName: null, poiId: null },
      ] }],
    });
    const result = refreshSatisfiedResearchTasks(db, product.id);
    assert.deepEqual(result.taskIds, [taskId]);
    const task = db.getProduct(product.id)!.researchTasks.find((item) => item.id === taskId)!;
    assert.equal(task.state, "confirmed");
    assert.match(task.evidence?.at(-1)?.title ?? "", /无需 POI 核查/);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
