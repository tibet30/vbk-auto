import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { preserveItineraryRemovals } from "../../src/shared/preserve-itinerary-removals.js";
import { preserveOperatorActivityKinds } from "../../src/shared/preserve-operator-itinerary-kinds.js";

/**
 * 真实事故闭环：运营手动删除第 2 天景点、把第 4 天两景点改成「其他」，
 * 点「继续执行」后生成把类型改回景点并恢复删除项，POI 核查任务被重新打开。
 * 修复后写入应继承人工凭证，任务保持结清，缺项不再复现。
 */
test("继续执行重写行程不会复活人工修改，核查任务保持结清", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-operator-kind-loop-"));
  const db = new VbkDatabase(dir);
  const created = db.createProduct({ destination: "西宁", days: 4, productForm: "privateTour" });
  db.updateProduct(created.id, {
    ...created.product,
    itinerary: [
      { day: 1, spots: [{ name: "仙米国家森林公园" }] },
      { day: 2, spots: [{ name: "门源" }, { name: "岗什卡雪峰" }, { name: "阿咪东索景区" }] },
      { day: 3, spots: [{ name: "祁连 9 号公路" }, { name: "祁连黑河源" }] },
      { day: 4, spots: [{ name: "巴尔斯雪山", kind: "attraction" }, { name: "七彩丹霞", kind: "attraction" }] },
    ],
  });
  for (const name of ["巴尔斯雪山", "七彩丹霞", "阿咪东索景区"]) {
    db.addResearchTask(created.id, {
      label: `核查 ${name} 的 VBK POI 映射`, type: "vbk",
      detail: "已找到同名候选 POI，但其地域与当天原路线不一致；请确认当天行程地点范围或手动绑定 POI",
    });
  }

  // 人工操作：第 4 天改成「其他」，第 2 天删除阿咪东索景区。
  const manual = structuredClone(db.getProduct(created.id)!.product) as Record<string, any>;
  manual.itinerary[3].spots = manual.itinerary[3].spots.map((spot: Record<string, unknown>) => ({ ...spot, kind: "other", poiName: null, poiId: null }));
  manual.itinerary[1].spots = manual.itinerary[1].spots.filter((spot: Record<string, unknown>) => spot.name !== "阿咪东索景区");
  manual.manualReview = {
    itinerarySpotRemovals: [{ day: 2, name: "阿咪东索景区", removedAt: new Date().toISOString() }],
    itinerarySpotKinds: [
      { day: 4, name: "巴尔斯雪山", kind: "other", setAt: new Date().toISOString() },
      { day: 4, name: "七彩丹霞", kind: "other", setAt: new Date().toISOString() },
    ],
  };
  db.replaceProductAndSatisfyResearchTasks(created.id, manual);
  assert.deepEqual(db.getProduct(created.id)!.researchTasks.map((task) => task.state), ["confirmed", "confirmed", "confirmed"]);

  // 继续执行：模型重写行程，只认识景点、POI 全空，并把被删除的景点又写回来。
  const current = db.getProduct(created.id)!;
  const modelItinerary = (current.product.itinerary as Array<Record<string, any>>).map((day) => ({
    ...day,
    spots: [...day.spots.map((spot: Record<string, unknown>) => ({ ...spot, kind: "attraction", poiName: null, poiId: null })),
      ...(day.day === 2 ? [{ name: "阿咪东索景区", kind: "attraction", poiName: null, poiId: null }] : [])],
  }));
  const withKinds = preserveOperatorActivityKinds(current.product, { ...current.product, itinerary: modelItinerary }, current.researchTasks);
  db.replaceProductAndSatisfyResearchTasks(created.id, preserveItineraryRemovals(current.product, withKinds));

  const reloaded = db.getProduct(created.id)!;
  const day2 = (reloaded.product.itinerary as Array<Record<string, any>>)[1]!;
  const day4 = (reloaded.product.itinerary as Array<Record<string, any>>)[3]!;
  assert.deepEqual(day2.spots!.map((spot: Record<string, unknown>) => spot.name), ["门源", "岗什卡雪峰"]);
  assert.deepEqual(day4.spots!.map((spot: Record<string, unknown>) => [spot.name, spot.kind]),
    [["巴尔斯雪山", "other"], ["七彩丹霞", "other"]]);
  assert.deepEqual(reloaded.researchTasks.map((task) => task.state), ["confirmed", "confirmed", "confirmed"]);
  assert.ok(reloaded.researchTasks.every((task) => task.evidence.some((item) => item.title.includes("[itinerary-kind:no-poi]")
    || item.title.includes("[itinerary-operator:removed]"))));
});
