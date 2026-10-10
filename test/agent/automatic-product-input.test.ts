import test from "node:test";
import assert from "node:assert/strict";
import { AgentSnapshotManager } from "../../src/main/agent/core-snapshot.js";
import { AgentToolRunner } from "../../src/main/agent/core-tools.js";
import { refreshPendingInput } from "../../src/main/agent/core-pending-input.js";
import { PRODUCT_PREPARATION_INSTRUCTION } from "../../src/main/agent/preparation-run.js";
import { hotelAnswerInstruction } from "../../src/main/agent/hotel-answer-instruction.js";
import type { AgentQuestion, AgentSnapshot } from "../../src/shared/contracts.js";
import type { AgentCoreDependencies } from "../../src/main/agent/types.js";

function fixture(content: string) {
  let saved: AgentSnapshot = { localProductId: "product", run: { id: "run", status: "running", intentVersion: "v", createdAt: "now", updatedAt: "now" }, events: [
    { id: "user", runId: "run", type: "user", content: PRODUCT_PREPARATION_INSTRUCTION, createdAt: "now" },
  ] };
  let modelCalls = 0;
  const deps: AgentCoreDependencies = { tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }),
    model: { complete: async () => { modelCalls++; return { content }; } }, contextFor: async () => "潮汕5天4晚，保留原景点和顺序" };
  let sequence = 0;
  const snapshots = new AgentSnapshotManager({ getAgentSnapshot: () => saved, saveAgentSnapshot: value => { saved = structuredClone(value); } }, () => new Date(), () => `event-${sequence++}`);
  const runner = new AgentToolRunner(deps, snapshots, () => new Date(), () => `call-${sequence++}`);
  const ask = async (questions: AgentQuestion[]) => runner.execute("product", { id: "ask", name: "ask_user", arguments: { questions } }, snapshots.token(saved));
  return { deps, snapshots, ask, get: () => saved, modelCalls: () => modelCalls, set: (value: AgentSnapshot) => { saved = value; } };
}

test("普通文本资料由 AI 回答，不能进入等待输入或暂停", async () => {
  const f = fixture('{"style":"海岛与古城体验"}');
  assert.equal(await f.ask([{ id: "style", label: "产品风格怎么写？", kind: "text", required: true }]), "continue");
  assert.equal(f.modelCalls(), 1);
  assert.equal(f.get().run?.status, "running");
  assert.equal(f.get().pendingInput, undefined);
  assert.equal(f.get().events.some(e => e.type === "input_request"), false);
  assert.deepEqual(f.get().events.find(e => e.type === "tool_result")?.data?.answers, { style: "海岛与古城体验" });
});

test("酒店恢复 AI 选择真实选项并持久化逐日选择供后续工具读取", async () => {
  const f = fixture('{"hotel1":"lower_hotel"}');
  await f.ask([{ id: "hotel1", label: "第1天住宿未取得符合要求的酒店候选", kind: "single", required: true, options: [
    { id: "keep", label: "保留当地5钻酒店" }, { id: "lower_hotel", label: "接受当地4钻酒店，保留原定住宿地点" },
  ] }]);
  assert.equal(f.get().pendingInput, undefined);
  assert.equal(f.get().run?.status, "running");
  assert.match(hotelAnswerInstruction(f.get().events), /接受当地4钻酒店/);
});

test("AI 输出无效选项时交回模型修复，不把普通问题推给运营", async () => {
  const f = fixture('{"choice":"invented"}');
  await f.ask([{ id: "choice", label: "游览节奏", kind: "single", required: true, options: [{ id: "slow", label: "轻松游览" }] }]);
  assert.equal(f.get().pendingInput, undefined);
  assert.equal(f.get().run?.status, "running");
  assert.equal(f.get().events.find(e => e.type === "tool_result")?.data?.executionRejected, true);
});

test("定价缺失强制转自动商业补全，不生成运营输入卡", async () => {
  const f = fixture("{}");
  await f.ask([{ id: "price", label: "请提供成人价儿童价起订人数", kind: "text", required: true }]);
  assert.equal(f.modelCalls(), 0);
  assert.equal(f.get().pendingInput, undefined);
  assert.match(f.get().events.find(e => e.type === "tool_result")?.content ?? "", /generate_product_module/);
});

test("已持久化的普通等待输入自动恢复到模型，不需运营回答", () => {
  const f = fixture('{"style":"轻松"}');
  const value = f.get(); value.run!.status = "waiting_input";
  value.pendingInput = { id: "old", createdAt: "now", questions: [{ id: "style", label: "产品风格", kind: "text", required: true }] };
  const result = refreshPendingInput({ id: "product", snapshot: value, deps: f.deps, snapshots: f.snapshots });
  assert.equal(result.shouldSchedule, true);
  assert.equal(value.pendingInput, undefined);
  assert.equal(value.run?.status, "running");
});

test("登录凭证不能由 AI 生成，仍保留真实访问条件", async () => {
  const f = fixture("{}");
  await f.ask([{ id: "login", label: "登录验证码", kind: "text", required: true }]);
  assert.equal(f.modelCalls(), 0);
  assert.equal(f.get().pendingInput?.questions[0]?.id, "login");
});

test("普通产品问答不依赖准备模式提示词，程序仍禁止运营输入", async () => {
  const f = fixture('{"style":"轻松游览"}');
  f.get().events[0]!.content = "修复产品资料";
  f.deps.preparationProduct = () => ({ product: {} } as import("../../src/shared/contracts.js").ProductDetail);
  await f.ask([{ id: "style", label: "游览风格", kind: "text", required: true }]);
  assert.equal(f.modelCalls(), 1);
  assert.equal(f.get().pendingInput, undefined);
  assert.equal(f.get().run?.status, "running");
});

test("资料问题即使被旧核对逻辑建议暂停，也不能等待运营", async () => {
  const f = fixture("{}");
  f.deps.resolvedPendingQuestions = () => [{ id: "cover", message: "封面需要换一张", answer: "重新查询图库", pause: true }];
  assert.equal(await f.ask([{ id: "cover", label: "封面图片选择", kind: "text", required: true }]), "continue");
  assert.equal(f.get().pendingInput, undefined);
  assert.equal(f.get().run?.status, "running");
});

test("AI 服务不可用时返回实际服务错误，不能退回运营资料输入", async () => {
  const f = fixture("{}");
  f.deps.model = undefined;
  await f.ask([{ id: "style", label: "产品风格", kind: "text", required: true }]);
  assert.equal(f.get().pendingInput, undefined);
  assert.equal(f.get().run?.status, "running");
  assert.match(f.get().events.find(e => e.type === "tool_result")?.content ?? "", /AI 服务未就绪/);
});

test("酒店查询错误提到验证码时，住宿策略仍由 AI 处理", async () => {
  const f = fixture('{"hotel1":"重新检索同城住宿"}');
  await f.ask([{ id: "hotel1", label: "第1天住宿核验未完成：列表可能触发验证码，请补充住宿地点", kind: "text", required: true }]);
  assert.equal(f.modelCalls(), 1);
  assert.equal(f.get().pendingInput, undefined);
});

test("混合住宿和登录请求只显示真实访问条件，并保存 AI 住宿选择", async () => {
  const f = fixture('{"hotel1":"lower_hotel"}');
  await f.ask([
    { id: "hotel1", label: "第1天住宿未取得符合要求的酒店候选", kind: "single", required: true,
      options: [{ id: "lower_hotel", label: "接受当地4钻酒店" }] },
    { id: "login", label: "登录验证码", kind: "text", required: true },
  ]);
  assert.deepEqual(f.get().pendingInput?.questions.map(question => question.id), ["login"]);
  assert.match(hotelAnswerInstruction(f.get().events), /接受当地4钻酒店/);
});
