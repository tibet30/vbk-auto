import test from "node:test";
import assert from "node:assert/strict";
import { hasValidVbkRecommendationLength, vbkRecommendationCharacterLength } from "../../src/main/planning/vbk-recommendation-length.js";
import { recommendationItemSchema } from "../../src/main/automation/schema/schema-definitions.js";
import { buildRecommendationReasonsPlan } from "../../src/main/automation/ctrip/presentation/recommendations.js";
import { hasValidPresentationRecommendations } from "../../src/main/automation/automation-contract.helpers.js";
import { hasCompletePresentationRecommendations } from "../../src/main/agent/integration-generate.js";
import { detectAcceptedModulesFromProduct } from "../../src/main/planning/runtime.js";
import { deepValidateModules } from "../../src/main/planning/validation.js";
import { validateModuleValue } from "../../src/main/planning/schemas.js";
import { applyStageDeterministicCompletion } from "../../src/main/planning/stage-deterministic-completion.js";
import type { OrchestratorRuntime } from "../../src/main/planning/types.js";
import type { PlanningSkeleton } from "../../src/shared/contracts-planning.js";

const skeleton: PlanningSkeleton = {
  destination: "成都", days: 1, nights: 0, productForm: "privateTour",
  productType: "domesticShort", supplierProductCode: "TEST",
};
function presentation(text: string) {
  return {
    recommendationCategory: "优选行程", recommendation: "文化之旅", features: "<p>行程安排</p>",
    recommendations: [
      { category: "优选行程", text },
      { category: "精选酒店", text: "A".repeat(30) },
      { category: "缤纷景点", text: "A".repeat(30) },
    ],
  };
}

for (const length of [29, 30, 80, 84, 85]) {
  test(`推荐理由 ${length} 字符在生成、草稿、就绪、持久化和录入门禁保持一致`, () => {
    const valid = length >= 30 && length <= 84;
    const text = "A".repeat(length);
    const value = presentation(text);
    const product = { presentation: value };
    assert.equal(hasValidVbkRecommendationLength(text), valid);
    assert.equal(recommendationItemSchema.safeParse(value.recommendations[0]).success, valid);
    assert.equal(validateModuleValue("presentation", value).ok, valid);
    assert.equal(hasValidPresentationRecommendations(product), valid);
    assert.equal(hasCompletePresentationRecommendations(value), valid);
    assert.equal(detectAcceptedModulesFromProduct(product).includes("presentation"), valid);
    assert.equal(deepValidateModules({ skeleton, product, acceptedModules: ["presentation"] }).invalid.length === 0, valid);
    if (valid) assert.equal(buildRecommendationReasonsPlan(value.recommendations)[0]?.text, text);
    else assert.equal(hasValidVbkRecommendationLength(buildRecommendationReasonsPlan(value.recommendations)[0]!.text), true, "平台录入前的长度收敛必须生成合法文案");
  });
}

test("字符计数包含中文、英文、标点和 Unicode 字符，排除首尾空格并归一平台标点", () => {
  assert.equal(vbkRecommendationCharacterLength(" 中A，😀 "), 9);
  assert.equal(vbkRecommendationCharacterLength("游".repeat(29) + "。"), 58);
  assert.equal(hasValidVbkRecommendationLength(" " + "A".repeat(30) + " "), true);
  assert.equal(hasValidVbkRecommendationLength("😀".repeat(30)), false);
});

test("图文兜底不保留长度不合规的旧推荐理由，生成内容均满足 30～84 字符", async () => {
  let written: unknown;
  const runtime = {
    loadCurrentProduct: async () => ({ basicInfo: { meetingCity: "成都", days: 1 }, presentation: presentation("短句") }),
    writeModule: async (_id: string, module: string, _path: string, value: unknown) => {
      if (module === "presentation") written = value;
      return { ok: true };
    },
    mutateProduct: async () => ({ ok: true }),
  } as unknown as OrchestratorRuntime;
  await applyStageDeterministicCompletion({ stage: "presentation", localProductId: "test", skeleton, runtime });
  assert.ok(written);
  assert.equal(validateModuleValue("presentation", written).ok, true);
});

test("实际平台已保存中文推荐理由计数与输入框一致", () => {
  for (const [text, length] of [["全程当地包车，用车衔接清晰，行程安排省心", 40], ["1晚市区当地5钻酒店住宿，住得较为安稳", 36], ["餐食敬请自理，便于按个人口味自由寻味", 36]] as const) {
    assert.equal(vbkRecommendationCharacterLength(text), length);
    assert.equal(hasValidVbkRecommendationLength(text), true);
  }
  assert.equal(hasValidVbkRecommendationLength("游".repeat(14)), false);
  assert.equal(hasValidVbkRecommendationLength("游".repeat(15)), true);
  assert.equal(hasValidVbkRecommendationLength("游".repeat(42)), true);
  assert.equal(hasValidVbkRecommendationLength("游".repeat(43)), false);
});
