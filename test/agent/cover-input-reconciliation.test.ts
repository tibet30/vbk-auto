import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import { persistedCoverSource } from "../../src/main/agent/cover-input-reconciliation.js";
import { resolvedProductQuestions } from "../../src/main/agent/pending-question-reconciliation.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { agentTaskContext } from "../../src/main/agent/integration-context.js";
import type { AgentSnapshot } from "../../src/shared/contracts.js";

const uploaded = {
  source: "manualUpload", fileId: "fe4437f3-a91f-4cbc-8bd5-f3299d035d2f",
  originalName: "cover.png", mimeType: "image/png", sizeBytes: 1713113,
  poi: "泸州", description: "已上传封面", minQuality: 3,
  uploadedAt: "2026-09-28T16:13:34.700Z",
};

function waitingSnapshot(questions = [{ id: "cover_final", label: "封面图最终方案", kind: "text" as const, required: true,
  placeholder: "请提供 imageId 与 imageUrl" }]): AgentSnapshot {
  return {
    localProductId: "product", run: { id: "run", status: "waiting_input", createdAt: "t", updatedAt: "t" },
    pendingInput: { id: "request", questions, createdAt: "t" },
    events: [{ id: "call", runId: "run", type: "input_request", content: "需要用户补充信息", createdAt: "t",
      data: { toolCallId: "tool", request: { id: "request", questions, createdAt: "t" } } }],
  };
}

function coreWithProduct(product: Record<string, unknown>) {
  let saved = waitingSnapshot();
  const core = new AgentCore({
    tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }),
    resolvedPendingQuestions: (_id, questions) => resolvedProductQuestions(product, questions),
    now: () => new Date("2026-09-29T00:00:00.000Z"), id: () => crypto.randomUUID(),
  }, {
    getAgentSnapshot: () => saved,
    saveAgentSnapshot: (value) => { saved = structuredClone(value); },
  });
  return core;
}

test("a complete manual upload is present, while a Ctrip search hint is not", () => {
  const product = buildProductSnapshot({ destination: "泸州", days: 2, productForm: "privateTour" });
  product.product.presentation = { cover: uploaded };
  assert.equal(persistedCoverSource(product.product), "manualUpload");
  const parsed = JSON.parse(agentTaskContext({ getProduct: () => product, getAgentSnapshot: () => undefined } as never, product.id));
  assert.equal(parsed.missing.includes("封面图（携程图库）"), false);
  assert.equal(parsed.missing.includes("封面来源"), false);
  assert.equal(parsed.allowedActions.includes("resolve_cover"), false);
  assert.ok(parsed.rules.some((rule: string) => rule.includes("不得说缺封面")));

  product.product.presentation = { cover: { source: "ctripLibrary", poi: "金龙寺", description: "待选图", minQuality: 3 } };
  assert.equal(persistedCoverSource(product.product), undefined);
});

test("reading a product retires a stale cover-only question after manual upload", async () => {
  const core = coreWithProduct({ presentation: { cover: uploaded } });
  const current = await core.get("product");
  assert.equal(current.pendingInput, undefined);
  assert.equal(current.run?.status, "paused");
  assert.ok(current.events.some((event) => event.type === "status" && event.content.includes("封面并不缺失")));
  assert.ok(current.events.some((event) => event.type === "tool_result" && event.data?.cancelled === true));
});

test("the real product's Ctrip image-ID request is obsolete after a manual cover is saved", () => {
  const questions = [{
    id: "ctrip_image_input", label: "携程图库封面 imageId 与 imageUrl", kind: "text" as const,
    required: true, placeholder: "格式：imageId|imageUrl",
  }];
  assert.deepEqual(resolvedProductQuestions({ presentation: { cover: uploaded } }, questions).map((item) => item.id),
    ["ctrip_image_input"]);
});

test("the real product's source choice follows the saved manual upload", () => {
  const questions = [{
    id: "cover_resolution", label: "封面最终处理", kind: "single" as const, required: true,
    options: [
      { id: "switch_to_ctrip", label: "切换为携程图库封面，提供 imageId 与 imageUrl" },
      { id: "keep_manual_upload", label: "保留手动上传封面" },
    ],
  }];
  const resolved = resolvedProductQuestions({ presentation: { cover: uploaded } }, questions);
  assert.equal(resolved[0]?.answer, "keep_manual_upload");
  assert.equal(resolved[0]?.pause, true);
});

test("saved cover does not answer a new question about replacing an undersized file", () => {
  const questions = [{
    id: "cover_resize_action", label: "封面规格处理", kind: "single" as const, required: true,
    options: [
      { id: "reupload_spec_ok", label: "重新上传一张 ≥1280×800 的原图" },
      { id: "post_vbk_manual_fix", label: "不重新上传，提交后在 VBK 调整规格" },
    ],
  }];
  assert.deepEqual(resolvedProductQuestions({ presentation: { cover: uploaded } }, questions), []);
  assert.deepEqual(
    resolvedProductQuestions({ presentation: { cover: uploaded } }, questions, { manualCoverAssetReady: true })
      .map((item) => ({ id: item.id, answer: item.answer })),
    [{ id: "cover_resize_action", answer: "reupload_spec_ok" }],
  );
});

test("a new request for an already saved manual cover is stopped before asking the user", async () => {
  const product = { presentation: { cover: uploaded } };
  let saved: AgentSnapshot | undefined;
  let modelCalls = 0;
  const core = new AgentCore({
    model: { complete: async () => {
      modelCalls += 1;
      return { toolCalls: [{ id: "ask-cover", name: "ask_user", arguments: { questions: [{
        id: "ctrip_image_info", label: "携程图库封面信息", kind: "text", required: true,
        placeholder: "格式：imageId|imageUrl",
      }] } }] };
    } },
    tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }),
    resolvedPendingQuestions: (_id, questions) => resolvedProductQuestions(product, questions),
  }, {
    getAgentSnapshot: () => saved,
    saveAgentSnapshot: (value) => { saved = structuredClone(value); },
  });
  await core.send("product", "重新检查封面");
  await core.idle("product");
  const current = await core.get("product");
  assert.equal(modelCalls, 1);
  assert.equal(current.run?.status, "paused");
  assert.equal(current.pendingInput, undefined);
  assert.ok(current.events.some((event) => event.type === "tool_result"
    && event.data?.reconciledQuestions?.includes("ctrip_image_info")));
});

test("saving a complete Ctrip cover retires the old image-ID question", async () => {
  const core = coreWithProduct({ presentation: { cover: {
    source: "ctripLibrary", poi: "金龙寺", imageId: 123, imageUrl: "https://example.com/cover.jpg",
    description: "封面", minQuality: 3,
  } } });
  const current = await core.reconcilePendingInput("product");
  assert.equal(current.pendingInput, undefined);
  assert.match(current.events.at(-1)?.content ?? "", /已选定并保存携程图库封面/);
});

test("an incomplete cover or unrelated question stays pending", async () => {
  const incomplete = coreWithProduct({ presentation: { cover: { source: "ctripLibrary", poi: "金龙寺" } } });
  assert.equal((await incomplete.get("product")).pendingInput?.id, "request");
  const saved = waitingSnapshot([{ id: "hotel_choice", label: "确认酒店", kind: "text", required: true }]);
  const core = new AgentCore({
    tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }),
    resolvedPendingQuestions: (_id, questions) => resolvedProductQuestions({ presentation: { cover: uploaded } }, questions),
  }, { getAgentSnapshot: () => saved, saveAgentSnapshot: () => { throw new Error("unrelated question changed"); } });
  assert.equal((await core.reconcilePendingInput("product")).pendingInput?.id, "request");
});

test("a mixed request drops saved fields but retains genuinely unanswered questions", async () => {
  const product = {
    presentation: { cover: uploaded },
    commercial: { pricing: { currency: "CNY", adult: 1280, child: 680, minimumTravelers: 1 } },
  };
  let saved = waitingSnapshot([
    { id: "cover_final", label: "封面图最终方案", kind: "text", required: true },
    { id: "adult_price", label: "请提供成人价", kind: "text", required: true },
    { id: "hotel_choice", label: "请确认酒店", kind: "text", required: true },
  ]);
  const core = new AgentCore({
    tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }),
    resolvedPendingQuestions: (_id, questions) => resolvedProductQuestions(product, questions),
  }, { getAgentSnapshot: () => saved, saveAgentSnapshot: (value) => { saved = structuredClone(value); } });
  const current = await core.reconcilePendingInput("product");
  assert.deepEqual(current.pendingInput?.questions.map((question) => question.id), ["hotel_choice"]);
  assert.equal(current.run?.status, "waiting_input");
  assert.equal(current.pendingInput?.defaultAnswers?.cover_final, "已在当前产品中保存");
  assert.equal(current.pendingInput?.defaultAnswers?.adult_price, "已在当前产品中保存");
});

test("saved pricing, inventory, subtitle and butler answers are reconciled independently", () => {
  const product = {
    basicInfo: { subtitle: "泸州两日游" },
    commercial: {
      pricing: { currency: "CNY", adult: 1280, child: 680, minimumTravelers: 1 },
      inventory: { startDate: "2026-09-29", endDate: "2027-09-29", dailyQuota: 30 },
    },
    operations: { bookingControls: { butler: { contactCardId: 1, providerId: 2, displayName: "管家" } } },
  };
  const questions = [
    { id: "price", label: "成人价", kind: "text" as const, required: true },
    { id: "inventory", label: "班期库存", kind: "text" as const, required: true },
    { id: "subtitle", label: "副标题", kind: "text" as const, required: true },
    { id: "butlerContact", label: "管家联系人", kind: "text" as const, required: true },
    { id: "hotel", label: "确认酒店", kind: "text" as const, required: true },
  ];
  assert.deepEqual(resolvedProductQuestions(product, questions).map((item) => item.id),
    ["price", "inventory", "subtitle", "butlerContact"]);
});

test("existing values do not answer a preference, replacement, or confirmation question", () => {
  const product = { presentation: { cover: uploaded }, commercial: {
    pricing: { currency: "CNY", adult: 1280, child: 680, minimumTravelers: 1 },
  } };
  const questions = [
    { id: "cover_choice", label: "请选择封面图", kind: "text" as const, required: true },
    { id: "cover_replace", label: "是否更换封面图", kind: "confirm" as const, required: true },
    { id: "price_confirm", label: "确认成人价", kind: "text" as const, required: true },
    { id: "price_missing", label: "请提供成人价", kind: "text" as const, required: true },
  ];
  assert.deepEqual(resolvedProductQuestions(product, questions).map((item) => item.id), ["price_missing"]);
});
