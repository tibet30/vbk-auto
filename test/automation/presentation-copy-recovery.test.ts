import test from "node:test";
import assert from "node:assert/strict";
import { runPresentationCopyRecovery } from "../../src/main/automation/automation.main/presentation-copy-recovery.js";
import { PresentationCopyRejectedError } from "../../src/main/automation/ctrip/presentation/copy-errors.js";
import type { VbkCopyFeedbackStore, VbkCopyRecovery } from "../../src/main/planning/vbk-copy-feedback.js";
import type { AiResponse } from "../../src/shared/contracts.js";

function fixture() {
  return { presentation: {
    recommendation: "泸州两天一晚私家团", features: "<p>游览当地人文景观</p>",
    recommendations: [
      { category: "服务保障", text: "专车衔接当地景点，按照约定路线安排行程，方便集中出发与返回" },
      { category: "精选酒店", text: "当地酒店住宿一晚，游览结束后返回酒店休息，次日按约定时间出发" },
      { category: "特色美食", text: "自由品尝泸州本地江鲜与川南特色风味，餐饮按个人喜好自选，费用自行承担" },
    ], cover: { imageId: 19006785 },
  }, basicInfo: { meetingCity: "泸州" } };
}

function store(): VbkCopyFeedbackStore {
  const words = new Set<string>();
  let state: VbkCopyRecovery | undefined;
  return {
    listRejectedPresentationWords: () => [...words],
    recordCopyFeedback: entry => { words.add(entry.word); },
    getPresentationCopyRecovery: () => state && structuredClone(state),
    savePresentationCopyRecovery: (_id, next) => { state = structuredClone(next); },
  };
}

function response(product: ReturnType<typeof fixture>, text = "自由品尝泸州本地特色风味，餐饮按个人喜好自选，费用自行承担"): AiResponse {
  const presentation = structuredClone(product.presentation);
  presentation.recommendations[2]!.text = text;
  return { reply: "已调整", questions: [], researchTasks: [], patch: [{ op: "replace", path: "/presentation", value: presentation }] };
}

const rejected = (word = "江鲜") => new PresentationCopyRejectedError([word], 200, "savedescriptioninfo", `Ack=Warning：非法关键词：${word}`);
function harness() {
  const product = fixture();
  const db = store();
  const messages: string[] = [];
  let writes = 0;
  return {
    localProductId: "p", productId: "79231894", product, store: db,
    assertWritable: async () => {}, persist: () => { writes++; },
    log: (message: string) => { messages.push(message); },
    get writes() { return writes; }, messages,
  };
}

test("本次江鲜反馈自动改写、保存并继续，无需用户输入", async () => {
  const h = harness();
  const before = structuredClone(h.product);
  let submits = 0;
  const result = await runPresentationCopyRecovery({ ...h,
    save: async () => { if (++submits === 1) throw rejected(); return "continued"; },
    rewrite: async req => {
      assert.match(req.message, /江鲜/);
      return response(h.product);
    },
  });
  assert.equal(result, "continued");
  assert.equal(submits, 2);
  assert.equal(h.writes, 1);
  assert.deepEqual(h.product.basicInfo, before.basicInfo);
  assert.deepEqual(h.product.presentation.cover, before.presentation.cover);
  assert.equal(h.store.getPresentationCopyRecovery("p")?.status, "completed");
  assert.deepEqual(h.store.listRejectedPresentationWords(), ["江鲜"]);
  assert.match(h.messages.at(-1)!, /远端回读/);
});

test("后续产品已知词本地修复，不等待再次拒绝", async () => {
  const h = harness();
  h.store.recordCopyFeedback({ word: "江鲜", module: "presentation", paths: [], source: "savedescriptioninfo", detail: "" });
  let saves = 0;
  await runPresentationCopyRecovery({ ...h, save: async () => { saves++; }, rewrite: async () => response(h.product) });
  assert.equal(saves, 1);
  assert.equal(h.writes, 1);
});

test("新词累计，两轮后不能回引第一轮词", async () => {
  const h = harness();
  let saves = 0;
  let ai = 0;
  await runPresentationCopyRecovery({ ...h,
    save: async () => { if (++saves < 3) throw rejected(saves === 1 ? "江鲜" : "风味"); },
    rewrite: async req => {
      if (++ai === 2) { assert.match(req.message, /江鲜、风味/); return response(h.product, "自由体验泸州本地饮食文化，餐饮按个人喜好自选，费用自行承担"); }
      return response(h.product);
    },
  });
  assert.equal(ai, 2);
  assert.deepEqual(h.store.getPresentationCopyRecovery("p")?.words, ["江鲜", "风味"]);
});

test("无效 AI 输出重试也消耗预算，重启不会重置预算", async () => {
  const h = harness();
  let ai = 0;
  const args = { ...h, save: async () => { throw rejected(); }, rewrite: async () => { ai++; return response(h.product, "江鲜"); } };
  await assert.rejects(runPresentationCopyRecovery(args), /非法关键词/);
  assert.equal(h.writes, 0);
  assert.equal(ai, 2);
  await assert.rejects(runPresentationCopyRecovery(args), /2\/2/);
  assert.equal(ai, 2);
  assert.equal(h.store.getPresentationCopyRecovery("p")?.rewrites, 2);
});

test("AI 返回后暂停或产品变化时不应用候选，也不再次提交", async () => {
  const h = harness();
  let cancelled = false;
  let saves = 0;
  await assert.rejects(runPresentationCopyRecovery({ ...h,
    assertWritable: async () => { if (cancelled) throw new Error("用户已暂停或编辑产品"); },
    save: async () => { saves++; throw rejected(); },
    rewrite: async () => { cancelled = true; return response(h.product); },
  }), /已暂停或编辑/);
  assert.equal(h.writes, 0);
  assert.equal(saves, 1);
  assert.match(h.product.presentation.recommendations[2]!.text, /江鲜/);
});

test("未知 Warning 不调用 AI，也不学习非法词", async () => {
  const h = harness();
  let ai = 0;
  await assert.rejects(runPresentationCopyRecovery({ ...h,
    save: async () => { throw new Error("Ack=Warning：库存错误"); },
    rewrite: async () => { ai++; return response(h.product); },
  }), /库存错误/);
  assert.equal(ai, 0);
  assert.deepEqual(h.store.listRejectedPresentationWords(), []);
});

test("无法定位的反馈保留记录但不让 AI 修改未知字段", async () => {
  const h = harness();
  await assert.rejects(runPresentationCopyRecovery({ ...h, save: async () => { throw rejected("未知词"); } }), /无法.*定位/);
  assert.deepEqual(h.store.listRejectedPresentationWords(), ["未知词"]);
  assert.equal(h.writes, 0);
});
