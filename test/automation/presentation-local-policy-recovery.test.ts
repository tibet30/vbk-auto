import test from "node:test";
import assert from "node:assert/strict";
import { runPresentationCopyRecovery } from "../../src/main/automation/automation.main/presentation-copy-recovery.js";
import { findVbkCopyBadCase } from "../../src/main/planning/vbk-copy-policy.js";
import { poiIdentityNames } from "../../src/main/planning/vbk-copy-identity.js";
import type { VbkCopyFeedbackStore, VbkCopyRecovery } from "../../src/main/planning/vbk-copy-feedback.js";
import { PresentationCopyRejectedError } from "../../src/main/automation/ctrip/presentation/copy-errors.js";

function harness() {
  const product = {
    basicInfo: { meetingCity: "哈尔滨" }, pricing: { price: 1234 },
    itinerary: [{ day: 1, spots: [
      { name: "龙江第一湾", poiName: "龙江第一湾风景区", poiId: 1 },
      { name: "中国最北点", poiName: "中国最北点", poiId: 2 },
    ] }],
    presentation: {
      recommendation: "哈尔滨与漠河沿线游览，结合原定路线了解当地风貌",
      features: "<p>龙江第一湾、中国最北点按原定日序游览。</p>",
      recommendations: [
        { category: "缤纷体验", text: "串联龙江第一湾风景区与中国最北点，按每日路线安排游览，结合实际行程体验当地风貌与特色" },
        { category: "服务保障", text: "一单一团与线上管家协助，按照原定路线出行，协助处理行程衔接与旅途咨询" },
        { category: "精选酒店", text: "围绕乌苏里浅滩安排游览体验，结合每日景点说明了解行程内容与游览顺序" },
      ], cover: { imageId: 21605766 },
    },
  };
  let state: VbkCopyRecovery | undefined;
  let writes = 0;
  let saves = 0;
  const feedback: string[] = [];
  const store: VbkCopyFeedbackStore = {
    listRejectedPresentationWords: () => feedback,
    recordCopyFeedback: entry => { feedback.push(entry.word); },
    getPresentationCopyRecovery: () => state && structuredClone(state),
    savePresentationCopyRecovery: (_id, next) => { state = structuredClone(next); },
  };
  return {
    localProductId: "harbin", productId: "80294418", product, store,
    assertWritable: async () => {}, persist: () => { writes++; }, log: () => {},
    save: async () => {
      saves++;
      assert.equal(findVbkCopyBadCase(product.presentation, "value.presentation", poiIdentityNames({ itinerary: product.itinerary })), undefined);
      return "continued";
    },
    get state() { return state; }, get writes() { return writes; }, get saves() { return saves; }, feedback,
  };
}

test("本地宣传关键词自动修复后继续保存，官方名、路线和资源不变", async () => {
  const h = harness();
  const before = structuredClone(h.product);
  h.product.presentation.recommendation = "首次到访哈尔滨，沿既定路线游览龙江第一湾风景区与中国最北点";
  assert.equal(await runPresentationCopyRecovery(h), "continued");
  assert.equal(h.writes, 1);
  assert.equal(h.saves, 1);
  assert.equal(h.product.presentation.recommendation, "初到哈尔滨，沿既定路线游览龙江第一湾风景区与中国最北点");
  assert.deepEqual(h.product.itinerary, before.itinerary);
  assert.deepEqual(h.product.pricing, before.pricing);
  assert.deepEqual(h.product.presentation.cover, before.presentation.cover);
  assert.deepEqual(h.product.presentation.recommendations, before.presentation.recommendations);
  assert.deepEqual(h.feedback, [], "本地宣传规则不污染真实平台反馈词库");
  assert.equal(h.state?.history[0]?.source, "local-policy");
  assert.equal(h.state?.status, "completed");
});

test("用当前 POI 精确校正历史黑名单误改名称，再自动续跑", async () => {
  const h = harness();
  h.product.presentation.features = "<p>龙江重点湾、中国更北点按原定日序游览。</p>";
  await runPresentationCopyRecovery(h);
  assert.equal(h.product.presentation.features, "<p>龙江第一湾、中国最北点按原定日序游览。</p>");
  assert.equal(h.writes, 1);
  assert.equal(h.state?.rewrites, 0);
});

test("旧误改名对应多个当前 POI 时不能猜测恢复", async () => {
  const h = harness();
  h.product.itinerary[0]!.spots = [
    { name: "第一重点湾", poiName: "第一重点湾", poiId: 1 },
    { name: "重点第一湾", poiName: "重点第一湾", poiId: 2 },
  ];
  h.product.presentation.features = "<p>重点重点湾按原定日序游览。</p>";
  await assert.rejects(runPresentationCopyRecovery(h), /无法唯一对应.*返回规划/);
  assert.equal(h.saves, 0);
  assert.equal(h.writes, 0);
});

test("合法官方名称直接保存，不调用模型或产生修复写入", async () => {
  const h = harness();
  await runPresentationCopyRecovery(h);
  assert.equal(h.writes, 0);
  assert.equal(h.saves, 1);
});

test("本地修复持久化失败或授权失效时不提交远端", async () => {
  const h = harness();
  h.product.presentation.recommendation = "首次到访哈尔滨，按原定日序游览";
  const before = structuredClone(h.product);
  await assert.rejects(runPresentationCopyRecovery({ ...h, persist: () => { throw new Error("保存失败"); } }), /保存失败/);
  assert.deepEqual(h.product, before);
  assert.equal(h.saves, 0);
  await assert.rejects(runPresentationCopyRecovery({ ...h, assertWritable: async () => { throw new Error("授权失效"); } }), /授权失效/);
  assert.equal(h.saves, 0);
});

test("关键词修复需要删除权益时中止自动录入，要求回规划", async () => {
  const h = harness();
  h.product.presentation.features = "<p>赠送旅游意外险，按原定日序游览。</p>";
  await assert.rejects(runPresentationCopyRecovery(h), /权益|规划/);
  assert.equal(h.saves, 0);
  assert.equal(h.writes, 0);
});

test("其他产品学来的第一禁词不能误拦本产品官方景点名", async () => {
  const h = harness();
  h.feedback.push("第一", "最");
  await runPresentationCopyRecovery(h);
  assert.equal(h.saves, 1);
  assert.equal(h.writes, 0);
});

test("继承关键词仅修复名称外宣传，名称内引用保留", async () => {
  const h = harness();
  h.feedback.push("第一");
  h.product.presentation.features = "<p>龙江第一湾排名第一，按原定日序游览。</p>";
  await runPresentationCopyRecovery(h);
  assert.equal(h.product.presentation.features, "<p>龙江第一湾排名重点，按原定日序游览。</p>");
  assert.equal(h.saves, 1);
});

test("本产品真实平台拒绝官方名时停止且重启不会将拒绝当历史豁免", async () => {
  const h = harness();
  let submits = 0;
  let rewrites = 0;
  const args = { ...h, save: async () => {
    submits++;
    throw new PresentationCopyRejectedError(["第一"], 200, "savedescriptioninfo", "非法关键词：第一");
  }, rewrite: async () => { rewrites++; throw new Error("不应改名"); } };
  await assert.rejects(runPresentationCopyRecovery(args), /官方 POI 名称.*返回规划/);
  assert.equal(submits, 1);
  assert.equal(rewrites, 0);
  await assert.rejects(runPresentationCopyRecovery(args), /官方 POI 名称.*返回规划/);
  assert.equal(submits, 1);
  assert.deepEqual(h.state?.words, ["第一"]);
});
