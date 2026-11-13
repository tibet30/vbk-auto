import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveRecommendationCategoryPolicy,
  queryRecommendationCategoryPolicy,
} from "../../src/main/infrastructure/vbk-recommendation-category-policy.js";
import { EMPTY_VBK_SESSION_CONTEXT, type VbkSessionRequestBrowser } from "../../src/main/infrastructure/vbk-session-request.js";

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

/** 平台图文页目录全集 15 项；后 5 项在该合同下 disabled，本地写入门禁也不接受。 */
const fullDirectory = [
  "优选行程", "服务保障", "贴心赠送", "精选酒店", "缤纷景点", "特色美食", "度假首选", "超值赠送",
  "五星精选", "限时秒杀", "尊享入住", "大牌驾到", "优质交通", "优良资质", "缤纷体验",
].map((name, index) => ({ id: index + 1, name }));

test("平台目录里本地无法持久化的分类不进入规划可用清单", () => {
  const policy = deriveRecommendationCategoryPolicy({ enabled: false }, fullDirectory, { productPatternId: 2 });
  assert.deepEqual(policy.categories, ["优选行程", "服务保障", "贴心赠送", "精选酒店", "缤纷景点",
    "特色美食", "度假首选", "超值赠送", "五星精选", "缤纷体验"]);
  assert.equal(policy.categoryIds.length, policy.categories.length);
  assert.ok(!policy.categories.includes("限时秒杀"));
});

test("白名单只剩本地不可写分类时失败关闭，不把非法分类交给模型", () => {
  assert.throws(() => deriveRecommendationCategoryPolicy({ enabled: true, categoryWhitelist: [10, 11, 12] }, fullDirectory,
    { productPatternId: 2 }), /少于 3 项/);
});

/** 平台在线接口失败时 HTTP 仍是 200，真正原因只在 ResponseStatus.Errors 里。 */
function categoryBrowser(payload: unknown): VbkSessionRequestBrowser {
  return {
    nativeOnly: true,
    evaluate: async () => { throw new Error("nativeOnly 客户端不应走页面执行上下文"); },
    vbkSessionFetch: async () => ({
      status: 200, payload, durationMs: 1, ctx: EMPTY_VBK_SESSION_CONTEXT,
    }),
  };
}

const loginExpiredPayload = {
  ResponseStatus: {
    Ack: "Failure",
    Errors: [{ Message: "当前用户登录已失效,请重新登录", ErrorCode: "10007" }],
  },
};

test("登录失效时抛出平台原始原因与重新登录指引，而不是只报 Ack=Failure", async () => {
  await assert.rejects(
    queryRecommendationCategoryPolicy(categoryBrowser(loginExpiredPayload), { productPatternId: 4 }),
    (error: Error) => {
      assert.match(error.message, /10007/);
      assert.match(error.message, /当前用户登录已失效/);
      assert.match(error.message, /重新登录 VBK 账号后继续/);
      return true;
    },
  );
});

test("非登录类平台失败保留原始错误码，不错误提示重新登录", async () => {
  await assert.rejects(
    queryRecommendationCategoryPolicy(categoryBrowser({
      ResponseStatus: { Ack: "Failure", Errors: [{ Message: "策略配置错误", ErrorCode: "20001" }] },
    }), { productPatternId: 4 }),
    (error: Error) => {
      assert.match(error.message, /20001/);
      assert.doesNotMatch(error.message, /重新登录/);
      return true;
    },
  );
});
