import assert from "node:assert/strict";
import test from "node:test";
import { executeStageOutput } from "../../src/main/planning/stage-runner.js";
import { trustedPresentationPoiNames } from "../../src/main/planning/vbk-copy-identity.js";

test("图文豁免仅信任完整 POI 绑定和原始逐日路线名称", () => {
  const product = {
    basicInfo: { userIdea: "D1：原始路线景点—已绑定原名—最佳观景位" },
    itinerary: [{ day: 1, spots: [
      { name: "已绑定原名", poiName: "官方景点全名", poiId: 9 },
      { name: "原始路线景点", kind: "attraction", poiName: null, poiId: null },
      { name: "模型伪造景点", kind: "attraction", poiName: null, poiId: null },
      { name: "最佳观景位", kind: "other", poiName: null, poiId: null },
    ] }],
  };

  assert.deepEqual(trustedPresentationPoiNames(product), ["官方景点全名", "原始路线景点", "已绑定原名"]);
});

test("图文阶段不会把未绑定的模型地点名当作宣传词豁免", async () => {
  const writes: unknown[] = [];
  const result = await executeStageOutput({
    stage: "presentation",
    localProductId: "untrusted-presentation-name",
    runtime: {
      async loadCurrentProduct() {
        return { itinerary: [{ day: 1, spots: [
          { name: "最佳观景位", kind: "attraction", poiName: null, poiId: null },
        ] }] };
      },
      async writeModule(_id: string, _module: string, _path: string, value: unknown) {
        writes.push(value);
        return { ok: true as const };
      },
    } as any,
    output: { reply: "产品图文", modules: [{ module: "presentation", status: "accepted", value: {
      recommendationCategory: "缤纷景点",
      recommendation: "最佳观景位值得体验",
      recommendations: [
        { category: "缤纷景点", text: "1天行程围绕当地景观安排游览，结合每日路线体验自然风貌与文化内容" },
        { category: "服务保障", text: "全程2段用车衔接清晰，按每日安排提供出行提示与必要的协助服务" },
        { category: "特色美食", text: "结合每日节奏安排3顿当地餐食，感受地方风味与旅行中的轻松时光" },
      ],
      features: "<p>结合每日路线安排游览与体验。</p>",
    } }] },
  });

  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted.length, 1);
  assert.doesNotMatch((writes[0] as { recommendation: string }).recommendation, /最佳观景位/u);
});
