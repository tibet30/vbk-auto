import assert from "node:assert/strict";
import test from "node:test";
import { executeStageOutput, sanitiseModuleValue } from "../../src/main/planning/stage-runner.js";

const presentation = {
  recommendationCategory: "缤纷景点",
  recommendation: "龙江第一湾与中国最北点串联，最佳观景时段更从容",
  recommendations: [
    { category: "缤纷景点", text: "龙江第一湾与中国最北点保留原路线名称" },
    { category: "服务保障", text: "全程衔接清晰，优先核对每日集合时间" },
    { category: "特色美食", text: "按行程节奏安排当地餐食，体验更丰富" },
  ],
  features: "<p><strong>沿途亮点：</strong>龙江第一湾、中国最北点与北极村。</p>",
};

test("presentation 使用当前完整行程身份保护官方名称并修复名称外宣传词", async () => {
  const writes: unknown[] = [];
  const result = await executeStageOutput({
    stage: "presentation",
    localProductId: "presentation-identity",
    runtime: {
      async loadCurrentProduct() {
        return { itinerary: [{ spots: [
          { name: "龙江第一湾", poiName: "龙江第一湾风景区", poiId: 91861 },
          { name: "中国最北点", poiName: "中国北极点", poiId: 145511108 },
        ] }] };
      },
      async writeModule(_id: string, _module: string, _path: string, value: unknown) {
        writes.push(value);
        return { ok: true as const };
      },
    } as any,
    output: { reply: "产品图文", modules: [{ module: "presentation", status: "accepted", value: presentation }] },
  });

  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted.length, 1);
  const saved = writes[0] as typeof presentation;
  assert.match(saved.recommendation, /龙江第一湾与中国最北点/u);
  assert.match(saved.recommendation, /更佳观景时段/u);
  assert.match(saved.features, /龙江第一湾、中国最北点/u);
});

test("presentation 自身声明的身份不能规避文案门禁", () => {
  const result = sanitiseModuleValue("presentation", {
    ...presentation,
    recommendation: "营销第一湾是最佳选择",
    poiName: "营销第一湾",
  }, 1, ["龙江第一湾", "中国最北点"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /第一|最（极限表达）/u);
});

test("presentation 读取当前产品失败时不得退化为空身份继续写入", async () => {
  let writes = 0;
  await assert.rejects(executeStageOutput({
    stage: "presentation",
    localProductId: "presentation-load-error",
    runtime: {
      async loadCurrentProduct() { throw new Error("current product unavailable"); },
      async writeModule() { writes += 1; return { ok: true as const }; },
    } as any,
    output: { reply: "产品图文", modules: [{ module: "presentation", status: "accepted", value: presentation }] },
  }), /current product unavailable/u);
  assert.equal(writes, 0);
});
