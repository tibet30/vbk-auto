import test from "node:test";
import assert from "node:assert/strict";
import { recommendationQualityProblems } from "../../src/main/planning/validation/recommendation-quality.js";
import { fitVbkRecommendationText } from "../../src/main/planning/vbk-recommendation-length.js";
import { deepValidateModules } from "../../src/main/planning/validation.js";
import { executeStageOutput } from "../../src/main/planning/stage-runner.js";
import type { OrchestratorRuntime } from "../../src/main/planning/types.js";
import type { PlanningSkeleton } from "../../src/shared/contracts-planning.js";

const product = {
  basicInfo: { meetingCity: "拉萨", days: 2 },
  itinerary: [
    { day: 1, hotelCity: "拉萨", spots: [{ name: "布达拉宫", poiName: "布达拉宫", poiId: 1 }, { name: "大昭寺", poiName: "大昭寺", poiId: 2 }] },
    { day: 2, spots: [{ name: "羊卓雍措", poiName: "羊卓雍措", poiId: 3 }] },
  ],
};
const concreteA = "上午登布达拉宫看红宫壁画，下午转大昭寺八廓街，感受千年藏地信仰";
const concreteB = "沿G318翻越岗巴拉山口，远眺圣湖蓝色湖面，沿途停靠观景台拍照留念";
const concreteC = "全程专车接送，拉萨城区与湖区往返无需换乘，行李随车更轻松";

test("空泛推荐理由缺少具体景点名或数字时逐条写明原因", () => {
  const problems = recommendationQualityProblems(product, ["行程安排清晰，游览节奏舒适", concreteB, concreteC]);
  assert.ok(problems.includes("第1条缺少具体景点名或数字"), problems.join("；"));
  assert.equal(problems.length, 1);
});

test("含景点名（含间隔号写法）或道路编号的推荐理由视为具体", () => {
  assert.deepEqual(recommendationQualityProblems(product, [concreteC, "串联布达拉宫·大昭寺，读懂拉萨老城的晨昏转经节奏与建筑细节", concreteB]), []);
  assert.deepEqual(recommendationQualityProblems(product, [concreteC, "沿G318一路向西，雪山草甸与牧场交替出现，车窗外即是风景", concreteA]), []);
});

test("两条字符二元组相似度过高时报重复，只共用一个景点名不报", () => {
  const near = "上午登布达拉宫看红宫壁画，下午转大昭寺八廓街，感受千年藏地信仰文化";
  assert.ok(recommendationQualityProblems(product, [concreteA, near, concreteC]).includes("第1条与第2条内容重复"));
  const sharedSpot = "布达拉宫广场夜景灯光璀璨，晚饭后可步行前往拍摄宫殿倒影";
  assert.deepEqual(recommendationQualityProblems(product, [concreteA, sharedSpot, concreteC]), []);
});

test("超长且无法按分句截短的推荐理由直接抛错，不再替换为泛化短句", () => {
  assert.throws(() => fitVbkRecommendationText("无标点的超长推荐理由".repeat(8), undefined, "服务保障"),
    /推荐理由超过 84 平台字符且无法按分句截短/);
});

test("深度校验把具体性问题并入 presentation 拒绝原因", () => {
  const skeleton: PlanningSkeleton = { destination: "拉萨", days: 2, nights: 1, productForm: "privateTour", productType: "domesticShort", supplierProductCode: "T" };
  const out = deepValidateModules({ skeleton, acceptedModules: ["presentation"], product: { ...product, presentation: {
    recommendationCategory: "服务保障", recommendation: "拉萨两日", features: "<p>特色</p>",
    recommendations: [
      { category: "服务保障", text: "行程安排清晰，游览节奏舒适，各环节衔接明确" },
      { category: "精选酒店", text: concreteB },
      { category: "缤纷体验", text: concreteA },
    ] } } });
  const invalid = out.invalid.find((item) => item.module === "presentation");
  assert.match(invalid?.reason ?? "", /第1条缺少具体景点名或数字/);
});

test("规划写入出口拒绝空泛推荐理由并附原因，供阶段重试回传", async () => {
  let written = false;
  const runtime = {
    loadCurrentProduct: async () => product,
    writeModule: async () => { written = true; return { ok: true }; },
  } as unknown as OrchestratorRuntime;
  const result = await executeStageOutput({ stage: "presentation", localProductId: "p", runtime, output: { reply: "", modules: [{
    module: "presentation", status: "accepted", value: {
      recommendationCategory: "服务保障", recommendation: "拉萨两日", features: "<p>特色</p>",
      recommendations: [
        { category: "服务保障", text: "行程安排清晰，游览节奏舒适，各环节衔接明确" },
        { category: "精选酒店", text: concreteB },
        { category: "缤纷体验", text: concreteA },
      ] } }] } });
  assert.equal(written, false);
  assert.match(result.rejected[0]?.reason ?? "", /第1条缺少具体景点名或数字/);
});
