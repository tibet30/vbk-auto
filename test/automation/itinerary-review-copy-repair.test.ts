import test from "node:test";
import assert from "node:assert/strict";
import {
  domesticShortPoiDecisionMessage,
  isValidationOnlyReviewFailure,
  runItineraryReviewWithCopyRepair,
} from "../../src/main/automation/automation.main/itinerary-review-copy-repair.js";
import type { AutomationRunContext } from "../../src/main/automation/automation.main/automation.main.context.js";

const REJECTED = "行程审核校验失败（Ack=Failure）：保存第1天行程描述，提示非法关键词：药浴，请修改后重新提交";

function product() {
  return {
    itinerary: [{
      day: 1,
      title: "西安接站·太白山唐镇·温泉疗愈",
      description: "专车西安接站，前往太白山唐镇入住。",
      activities: [
        { time: "晚上", title: "泡温泉", detail: "体验太白山唐镇南山温泉，含室外汤池与药浴。", type: "free" },
      ],
    }],
  };
}

function fakeContext(options: { words?: string[]; rewriter?: (request: any) => Promise<any> } = {}) {
  const feedback: any[] = [];
  const ctx = {
    db: {
      listRejectedItineraryWords: () => options.words ?? [],
      recordCopyFeedback: (entry: any) => { feedback.push(entry); },
    },
    itineraryCopyRewriter: options.rewriter,
  } as unknown as AutomationRunContext;
  return { ctx, feedback };
}

function rejectingError() {
  return Object.assign(new Error(REJECTED), { itineraryReviewValidationOnly: true });
}

test("平台在只读校验驳回非法关键词时自动改写、重存草稿并重新提交", async () => {
  const value = product();
  const logs: string[] = [];
  const saved: unknown[] = [];
  let submitCalls = 0;
  const requests: any[] = [];
  const { ctx, feedback } = fakeContext({
    rewriter: async (request) => {
      requests.push(request);
      return { reply: "已改写", patch: [{
        op: "replace", path: "/itinerary/0/activities/0/detail", value: "体验太白山唐镇南山温泉室外汤池。",
      }], questions: [], researchTasks: [] };
    },
  });
  const result = await runItineraryReviewWithCopyRepair({
    ctx, localProductId: "local", product: value,
    log: (message) => { logs.push(message); },
    submitReview: async () => {
      submitCalls += 1;
      if (submitCalls === 1) throw rejectingError();
      return { verified: true };
    },
    saveDraft: async () => { saved.push(value.itinerary[0].activities[0].detail); return {}; },
    persist: () => { saved.push("persisted"); },
  });

  assert.deepEqual(result, { verified: true });
  assert.equal(submitCalls, 2);
  assert.equal(value.itinerary[0].activities[0].detail, "体验太白山唐镇南山温泉室外汤池。");
  assert.deepEqual(saved, ["persisted", "体验太白山唐镇南山温泉室外汤池。"]);
  assert.deepEqual(requests[0].targets, [{ path: "/itinerary/0/activities/0/detail", value: "体验太白山唐镇南山温泉，含室外汤池与药浴。" }]);
  assert.match(requests[0].message, /药浴/);
  assert.deepEqual(feedback.map((entry) => [entry.word, entry.module, entry.paths]), [
    ["药浴", "itinerary", ["/itinerary/0/activities/0/detail"]],
  ]);
  assert.ok(logs.some((line) => /自动改写/.test(line)));
});

test("已学习到的行程驳回词在首次提交前就被预处理", async () => {
  const value = product();
  let submitCalls = 0;
  const { ctx } = fakeContext({
    words: ["药浴"],
    rewriter: async () => ({ reply: "已改写", patch: [{
      op: "replace", path: "/itinerary/0/activities/0/detail", value: "体验太白山唐镇南山温泉室外汤池。",
    }], questions: [], researchTasks: [] }),
  });
  const result = await runItineraryReviewWithCopyRepair({
    ctx, localProductId: "local", product: value,
    log: () => {},
    submitReview: async () => { submitCalls += 1; return { verified: true }; },
    saveDraft: async () => ({}),
    persist: () => {},
  });
  assert.deepEqual(result, { verified: true });
  assert.equal(submitCalls, 1);
  assert.equal(value.itinerary[0].activities[0].detail, "体验太白山唐镇南山温泉室外汤池。");
});

test("非只读校验失败的错误不进入自动修复", async () => {
  const value = product();
  const { ctx } = fakeContext({ rewriter: async () => { throw new Error("不应调用"); } });
  let saveDraftCalls = 0;
  await assert.rejects(runItineraryReviewWithCopyRepair({
    ctx, localProductId: "local", product: value,
    log: () => {},
    submitReview: async () => { throw Object.assign(new Error("提交行程审核失败（Ack=Failure）：库存不足"), { uncertainWrite: true }); },
    saveDraft: async () => { saveDraftCalls += 1; return {}; },
    persist: () => {},
  }), /库存不足/);
  assert.equal(saveDraftCalls, 0);
});

test("境内短途与结构化 POI 风险必须交给用户决定且不自动重试", async () => {
  const value = {
    itinerary: [
      { day: 4, spots: [
        { name: "冈仁波齐", poiName: "冈仁波齐", poiId: 10758151 },
        { name: "冈仁波齐山体冰川遗迹", poiName: "冈仁波齐", poiId: 10758151 },
      ] },
      { day: 5, spots: [{ name: "远眺冈仁波齐", poiName: "冈仁波齐", poiId: 10758151 }] },
    ],
  };
  const raw = "行程审核校验失败（Ack=Failure）：数据风险，原因：POI：冈仁波齐 且 产品类型：境内短途旅游，请修改后重新操作";
  const riskError = Object.assign(new Error(raw), { itineraryReviewValidationOnly: true });
  const logs: string[] = [];
  let submits = 0;
  let saves = 0;
  let rewrites = 0;
  const { ctx } = fakeContext({ rewriter: async () => { rewrites += 1; return {}; } });

  await assert.rejects(runItineraryReviewWithCopyRepair({
    ctx, localProductId: "local", product: value,
    log: (message) => { logs.push(message); },
    submitReview: async () => { submits += 1; throw riskError; },
    saveDraft: async () => { saves += 1; return {}; },
    persist: () => {},
  }), (error: Error) => {
    assert.match(error.message, /行程审核需要用户决定/);
    assert.match(error.message, /第4天「冈仁波齐」「冈仁波齐山体冰川遗迹」/);
    assert.match(error.message, /第5天「远眺冈仁波齐」/);
    assert.match(error.message, /确认后.*剔除所有绑定为「冈仁波齐」的条目/);
    assert.match(error.message, /未修改 POI、未删除路线、未再次提交审核/);
    assert.match(error.message, /平台原始原因/);
    return true;
  });
  assert.equal(submits, 1);
  assert.equal(saves, 0);
  assert.equal(rewrites, 0);
  assert.equal(logs.length, 1);
});

test("非境内短途结构化 POI 风险不伪装成用户决策门禁", () => {
  assert.equal(domesticShortPoiDecisionMessage(new Error("库存不足"), product()), undefined);
  assert.equal(domesticShortPoiDecisionMessage(
    new Error("数据风险，原因：POI：冈仁波齐 且 产品类型：境内长线旅游"),
    product(),
  ), undefined);
});

test("没有可定位文案或超出修复预算时如实上抛，不伪造成功", async () => {
  const other = product();
  other.itinerary[0].activities = [{ time: "晚上", title: "泡温泉", detail: "体验南山温泉。", type: "free" }];
  const { ctx } = fakeContext({ rewriter: async () => { throw new Error("不应调用"); } });
  await assert.rejects(runItineraryReviewWithCopyRepair({
    ctx, localProductId: "local", product: other,
    log: () => {},
    submitReview: async () => { throw rejectingError(); },
    saveDraft: async () => ({}),
    persist: () => {},
  }), /未能在当前行程文案中定位命中字段/);

  // 平台每轮驳回另一个词：命中文案仍在时继续修复，预算用尽必须上抛原始错误。
  const value = {
    itinerary: [{
      day: 1,
      title: "西安接站·太白山唐镇",
      description: "傍晚体验药浴。",
      activities: [{ time: "晚上", title: "温泉体验", detail: "室外汤池。" }],
    }],
  };
  const rejectedWords = ["药浴", "温泉", "汤池"];
  let submits = 0;
  let rewrites = 0;
  const neutral = (text: string) => rejectedWords.reduce((result, word) => result.replaceAll(word, "汤泉"), text);
  const budget = fakeContext({
    rewriter: async (request) => {
      rewrites += 1;
      return { reply: "已改写", patch: request.targets.map((target: any) => ({
        op: "replace", path: target.path, value: neutral(target.value),
      })), questions: [], researchTasks: [] };
    },
  });
  await assert.rejects(runItineraryReviewWithCopyRepair({
    ctx: budget.ctx, localProductId: "local", product: value,
    log: () => {},
    submitReview: async () => {
      const word = rejectedWords[Math.min(submits, rejectedWords.length - 1)]!;
      submits += 1;
      throw Object.assign(new Error(`行程审核校验失败（Ack=Failure）：保存第1天行程描述，提示非法关键词：${word}，请修改后重新提交`), { itineraryReviewValidationOnly: true });
    },
    saveDraft: async () => ({}),
    persist: () => {},
  }), /非法关键词：汤池/);
  assert.equal(rewrites, 2);
});

test("只读校验失败标记可被识别", () => {
  assert.equal(isValidationOnlyReviewFailure(rejectingError()), true);
  assert.equal(isValidationOnlyReviewFailure(new Error("普通失败")), false);
  assert.equal(isValidationOnlyReviewFailure(undefined), false);
});
