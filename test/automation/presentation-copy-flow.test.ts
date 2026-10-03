import test from "node:test";
import assert from "node:assert/strict";
import { fillPresentationWithSensitiveRewrite } from "../../src/main/automation/automation.main/presentation-sensitive-rewrite.js";
import { EMPTY_VBK_SESSION_CONTEXT } from "../../src/main/infrastructure/vbk-session-request.js";
import type { AutomationRunContext } from "../../src/main/automation/automation.main/automation.main.context.js";
import type { VbkCopyRecovery } from "../../src/main/planning/vbk-copy-feedback.js";
import { runPhaseWithRecovery } from "../../src/main/automation/recovery/recovery.js";
import { recoveryNeedsUser } from "../../src/renderer/app/helpers/constants.js";
import type { AutomationRun } from "../../src/shared/contracts.js";

function fixture() {
  const product = {
    basicInfo: { meetingCity: "泸州" },
    presentation: {
      recommendation: "泸州两天一晚私家团", recommendationCategory: "优选行程", features: "<p>游览当地人文景观</p>",
      recommendations: [
        { category: "服务保障", text: "专车衔接泸州当地景点，按既定行程安排接送" },
        { category: "精选酒店", text: "安排泸州当地酒店住宿一晚，便于各景点衔接" },
        { category: "特色美食", text: "自由品尝泸州本地江鲜与川南特色风味" },
      ],
      cover: { source: "ctripLibrary", imageId: 19006785, imageUrl: "https://example.test/cover.jpg", poi: "尧坝古镇", description: "古镇封面", minQuality: 3 },
    },
  };
  let version = 1;
  let recovery: VbkCopyRecovery | undefined;
  const words = new Set<string>();
  const calls: string[] = [];
  let images: any[] = [];
  let remote: any = {};
  let guards = 0;
  let cancelled = false;
  let aiCalls = 0;
  let rejectSave = true;
  let staleDuringAi = false;
  let refreshDuringGuard = false;
  const page = {
    url: () => "https://vbooking.ctrip.com/",
    async evaluate(_fn: unknown, args: { endpoint: string; body: any }) {
      const endpoint = args.endpoint.split("/").at(-1)!;
      calls.push(endpoint);
      let payload: any = { ResponseStatus: { Ack: "Success" } };
      if (endpoint === "getProductBaseInfo") payload.saleControlInfo = { pICategoryId: 1003, inputLocale: "zh-CN" };
      else if (endpoint === "searchProductImage.json") payload.productImages = images;
      else if (endpoint === "bindProductImage.json") { images = args.body.productImages; payload.success = true; }
      else if (endpoint === "getpmrcmdcategory.json") payload.pmRcmdCategories = ["服务保障", "精选酒店", "特色美食"].map((name, index) => ({ pmRcmdCategoryId: index + 1, pmRcmdCategoryName: name }));
      else if (endpoint === "getdescriptionInfo") payload.info = remote;
      else if (endpoint === "checkSensitiveWord") payload.sensitiveWords = [];
      else if (endpoint === "savedescriptioninfo") {
        if (rejectSave) payload = { ResponseStatus: { Ack: "Warning", Errors: [{ Message: "非法关键词：江鲜" }] } };
        else { remote = args.body.dto; payload.success = true; }
      }
      return { status: 200, payload, durationMs: 1, ctx: { ...EMPTY_VBK_SESSION_CONTEXT } };
    },
  };
  const ctx = {
    db: {
      getProduct: () => ({ product: structuredClone(product), productJsonVersion: version }),
      listRejectedPresentationWords: () => [...words],
      recordCopyFeedback: ({ word }: { word: string }) => { words.add(word); },
      getPresentationCopyRecovery: () => recovery && structuredClone(recovery),
      savePresentationCopyRecovery: (_id: string, state: VbkCopyRecovery) => { recovery = structuredClone(state); },
    },
    emit: () => {}, persistProduct: () => { version++; }, cancellationRequested: new Set<string>(),
    assertWriteAuthorized: async () => { guards++; if (refreshDuringGuard) version++; if (cancelled) throw new Error("录入已暂停"); },
    presentationCopyRewriter: async (request: { product: any }) => {
      aiCalls++;
      if (staleDuringAi) { version++; product.basicInfo.meetingCity = "成都"; }
      const generated = structuredClone(request.product.presentation);
      generated.recommendations[2].text = "自由品尝泸州本地特色风味，感受川南地方饮食";
      rejectSave = false;
      return { reply: "", questions: [], researchTasks: [], patch: [{ op: "replace", path: "/presentation", value: generated }] };
    },
  } as unknown as AutomationRunContext;
  return { product, page, ctx, calls, get guards() { return guards; }, get aiCalls() { return aiCalls; },
    set refreshDuringGuard(value: boolean) { refreshDuringGuard = value; },
    set staleDuringAi(value: boolean) { staleDuringAi = value; }, set cancelled(value: boolean) { cancelled = value; },
    get recovery() { return recovery; }, get words() { return [...words]; },
  };
}

async function run(f: ReturnType<typeof fixture>) {
  return fillPresentationWithSensitiveRewrite({ ...f, localProductId: "p", productId: "79231894", log: () => {} });
}

test("真实图文保存链路模拟平台江鲜拒绝，修复后回读成功且只绑定一次封面", async () => {
  const f = fixture();
  const result = await run(f) as any;
  assert.equal(result.savedWith.featuresSaved, true);
  assert.equal(f.calls.filter(call => call === "savedescriptioninfo").length, 2);
  assert.equal(f.calls.filter(call => call === "bindProductImage.json").length, 1);
  assert.equal(f.aiCalls, 1);
  assert.deepEqual(f.words, ["江鲜"]);
  assert.equal(f.recovery?.status, "completed");
  assert.ok(f.guards >= 6);
  assert.equal(f.product.presentation.recommendations[2]!.text, "自由品尝泸州本地特色风味，感受川南地方饮食");
});

test("实际包装器检测 AI 等待期间产品版本变化，不应用过期候选", async () => {
  const f = fixture();
  f.staleDuringAi = true;
  await assert.rejects(run(f), /产品内容已变更/);
  assert.match(f.product.presentation.recommendations[2]!.text, /江鲜/);
  assert.equal(f.calls.filter(call => call === "savedescriptioninfo").length, 1);
});

test("暂停时在任何图文或图片接口之前退出", async () => {
  const f = fixture();
  f.cancelled = true;
  await assert.rejects(run(f), /已暂停/);
  assert.deepEqual(f.calls, []);
});

test("失败恢复复用远端仍存在的图片检查点，修复预算不会重置", async () => {
  const f = fixture();
  const rewrite = f.ctx.presentationCopyRewriter!;
  let first = true;
  f.ctx.presentationCopyRewriter = async request => {
    if (first) { first = false; throw new Error("模型暂不可用"); }
    return rewrite(request);
  };
  await assert.rejects(run(f), /模型暂不可用/);
  assert.equal(f.recovery?.rewrites, 1);
  assert.ok(f.recovery?.images);
  assert.deepEqual(f.words, ["江鲜"]);
  await run(f);
  assert.equal(f.recovery?.rewrites, 2);
  assert.equal(f.recovery?.status, "completed");
  assert.equal(f.calls.filter(call => call === "bindProductImage.json").length, 1);
});

test("旧失败任务恢复后图文和后续阶段完成，当前阻塞清除且不请求人工建议", async () => {
  const f = fixture();
  const automation: AutomationRun = {
    id: "prior-run", status: "running", currentPhase: "presentation", logs: [],
    phases: [{ phase: "basic", status: "completed" }, { phase: "presentation", status: "pending" }, { phase: "itinerary", status: "pending" }],
    recovery: { phases: { presentation: { phase: "presentation", state: "needs_user", finalError: "Ack=Warning：非法关键词：江鲜", userInstruction: "等待用户", attempts: [{ attempt: 1, error: "江鲜", at: "2026-10-03T00:16:49Z" }] } } },
  };
  let advises = 0;
  let continued = false;
  const context = {
    run: automation, phase: "presentation", completedPhases: ["basic"], productIdExists: true, basicInfoSaved: true,
    execute: () => run(f), advisor: async () => { advises++; throw new Error("不应请求人工建议"); },
    applyAction: async () => {}, persist: () => {}, log: () => {},
  };
  assert.equal((await runPhaseWithRecovery(context)).status, "completed");
  assert.equal(recoveryNeedsUser(automation), null);
  assert.equal(automation.recovery?.phases.presentation?.finalError, undefined);
  assert.equal(automation.recovery?.phases.presentation?.attemptsHistory?.length, 1);
  assert.equal((await runPhaseWithRecovery({ ...context, phase: "itinerary", execute: async () => { continued = true; } })).status, "completed");
  assert.equal(continued, true);
  assert.equal(advises, 0);
  assert.equal(automation.phases[0]!.status, "completed");
});

 test("相同产品快照刷新版本不会误阻止已授权图文恢复", async () => {
  const f = fixture(); f.refreshDuringGuard = true; await run(f);
  assert.equal(f.recovery?.status, "completed");
  assert.equal(f.aiCalls, 1);
});

test("界面轮询仅刷新诊断信息时继续图文恢复，原始需求仍受保护", async () => {
  const f = fixture();
  const read = f.ctx.db.getProduct.bind(f.ctx.db);
  let polls = 0;
  f.ctx.db.getProduct = (() => {
    const current = read('p')!;
    current.product.diagnostics = { creationInput: { destination: '泸州' },
      runtime: { updatedAt: String(++polls) }, debugSnapshot: { pendingInput: polls > 1 } };
    return current;
  }) as typeof f.ctx.db.getProduct;
  await run(f);
  assert.equal(f.recovery?.status, 'completed');
  assert.ok(polls > 1);
});

test("新产品首次出现运行诊断不应被视为业务内容变更", async () => {
  const f = fixture();
  const read = f.ctx.db.getProduct.bind(f.ctx.db);
  let polls = 0;
  f.ctx.db.getProduct = (() => {
    const current = read('p')!;
    if (++polls > 1) current.product.diagnostics = {
      runtime: { updatedAt: String(polls) }, debugSnapshot: { pendingInput: false },
    };
    return current;
  }) as typeof f.ctx.db.getProduct;
  await run(f);
  assert.equal(f.recovery?.status, 'completed');
});

test("原始创建需求变化仍停止图文恢复", async () => {
  const f = fixture();
  const read = f.ctx.db.getProduct.bind(f.ctx.db);
  let polls = 0;
  f.ctx.db.getProduct = (() => {
    const current = read('p')!;
    current.product.diagnostics = { creationInput: { destination: ++polls === 1 ? '泸州' : '成都' } };
    return current;
  }) as typeof f.ctx.db.getProduct;
  await assert.rejects(() => run(f), /产品内容已变更/);
  assert.equal(f.calls.length, 0);
});
