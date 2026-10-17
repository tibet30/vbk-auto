import test from "node:test";
import assert from "node:assert/strict";
import { deriveRecommendationCategoryPolicy } from "../../src/main/infrastructure/vbk-recommendation-category-policy.js";

const directory = [
  { id: 1, name: "服务保障" }, { id: 2, name: "贴心赠送" }, { id: 3, name: "精选酒店" },
  { id: 5, name: "特色美食" }, { id: 9, name: "优选行程" }, { id: 15, name: "缤纷体验" },
];
const scope = {
  enabled: true,
  patternIds: [1, 3, 4],
  localePatternIds: { "zh-CN": [1, 3, 4] },
  categoryWhitelist: [1, 2, 3, 5, 15],
};

test("私家团命中 QConfig 后只返回白名单类别", () => {
  const policy = deriveRecommendationCategoryPolicy(scope, directory, { productPatternId: 4, inputLocale: "zh-CN" });
  assert.equal(policy.limited, true);
  assert.deepEqual(policy.categories, ["服务保障", "贴心赠送", "精选酒店", "特色美食", "缤纷体验"]);
});

test("自由行不命中限制范围时使用类别目录全集", () => {
  const policy = deriveRecommendationCategoryPolicy(scope, directory, { productPatternId: 2, inputLocale: "zh-CN" });
  assert.equal(policy.limited, false);
  assert.deepEqual(policy.categories, directory.map((item) => item.name));
});

test("语言专属 patternIds 覆盖通用范围，排除标签会关闭限制", () => {
  const localePolicy = deriveRecommendationCategoryPolicy({ ...scope, localePatternIds: { "zh-CN": [2] } }, directory,
    { productPatternId: 4, inputLocale: "zh-CN" });
  assert.equal(localePolicy.limited, false);
  const tagPolicy = deriveRecommendationCategoryPolicy({ ...scope, excludeTagIds: [2437] }, directory,
    { productPatternId: 4, inputLocale: "zh-CN", activeTagIds: [2437] });
  assert.equal(tagPolicy.limited, false);
});

test("策略引用未知类别或可用项少于三项时失败关闭", () => {
  assert.throws(() => deriveRecommendationCategoryPolicy({ ...scope, categoryWhitelist: [1, 2, 99] }, directory,
    { productPatternId: 4 }), /缺少策略 ID：99/);
  assert.throws(() => deriveRecommendationCategoryPolicy({ ...scope, categoryWhitelist: [1, 2] }, directory,
    { productPatternId: 4 }), /少于 3 项/);
});
