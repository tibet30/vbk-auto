import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import {
  assertProductActionsReadOnly,
  createAgentRuntime,
  createProductReadSkill,
  resolveProduct,
  type AgentSkillContext,
  type ProductReadPort,
  type ProductReadRecord,
} from "../../src/main/agent-runtime/index.js";
import type { ProductReadiness } from "../../src/shared/contracts.js";
import type { AgentModel, AgentModelInput, AgentModelResult } from "../../src/main/agent/types.js";

const OWNER = 1001;

function fakePort(
  records: ProductReadRecord[],
  readiness: Record<string, ProductReadiness | undefined> = {},
): ProductReadPort {
  return {
    list: () => records,
    get: (id) => records.find((record) => record.id === id),
    readiness: (id) => readiness[id],
  };
}

const records: ProductReadRecord[] = [
  { id: "49ecb537-1111-4aaa-8bbb-000000000001", name: "日喀则2天1晚私家团", status: "review", productId: "3388899", planVersion: 3 },
  { id: "c7d39d86-2222-4aaa-8bbb-000000000002", name: "西安6天5晚私家团", status: "draft_saved", basicInfoSaved: true },
];

const context: AgentSkillContext = { ownerUserId: OWNER, threadId: "t-1", runId: "r-1" };

test("产品 Skill 只注册只读动作，结构上无法替代任何产品门禁", () => {
  const skill = createProductReadSkill(fakePort(records));
  assert.deepEqual(skill.actions.map((action) => action.name), ["product.list", "product.status"]);
  assert.ok(skill.actions.every((action) => action.kind === "read"), "不得出现写或删除动作");
  assert.ok(skill.actions.every((action) => action.risk === "low"));
});

test("按全量 id 或唯一前缀读取产品状态与门禁结论", async () => {
  const skill = createProductReadSkill(fakePort(records, {
    "49ecb537-1111-4aaa-8bbb-000000000001": {
      ready: false,
      completion: 62,
      issues: [{ label: "住宿", detail: "缺少逐晚住宿城市" }],
    },
  }));
  const status = skill.actions[1];
  const byFullId = await status.execute({ productId: "49ecb537-1111-4aaa-8bbb-000000000001" }, context);
  assert.match(byFullId.content, /日喀则2天1晚私家团/u);
  assert.match(byFullId.content, /程序检查结论：未通过（完成度 62%）/u);
  assert.match(byFullId.content, /- 住宿：缺少逐晚住宿城市/u);
  assert.match(byFullId.summary, /未就绪/u);

  const byPrefix = await status.execute({ productId: "c7d39d86" }, context);
  assert.match(byPrefix.content, /草稿已保存/u);
  assert.match(byPrefix.content, /VBK 产品 id：未回填/u);
});

test("前缀过短、命中多个或查不到都失败，不猜产品", async () => {
  const port = fakePort([
    { id: "aaaa1111-0000-0000-0000-000000000000", name: "A", status: "draft_saved" },
    { id: "aaaa2222-0000-0000-0000-000000000000", name: "B", status: "draft_saved" },
  ]);
  assert.throws(() => resolveProduct(port, "aaa"), /至少需要 4 位/u);
  assert.throws(() => resolveProduct(port, "aaaa"), /前缀命中 2 个产品/u);
  assert.throws(() => resolveProduct(port, "zzzz"), /未找到匹配的产品/u);
  assert.equal(resolveProduct(port, "aaaa1").name, "A");
});

test("就绪结论读不到时如实说无法读取，不默认通过", async () => {
  const skill = createProductReadSkill(fakePort(records));
  const result = await skill.actions[1].execute({ productId: "49ecb537" }, context);
  assert.match(result.content, /程序检查结论：无法读取/u);
  assert.doesNotMatch(result.content, /已通过/u);
});

class ScriptedModel implements AgentModel {
  readonly inputs: AgentModelInput[] = [];
  constructor(private readonly responses: AgentModelResult[]) {}

  async complete(input: AgentModelInput): Promise<AgentModelResult> {
    this.inputs.push(input);
    const next = this.responses.shift();
    if (!next) throw new Error("模型脚本已用尽");
    return next;
  }
}

test("只读产品查询在对话中直接执行，不进审批并留下审计收据", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-product-read-skill-"));
  const db = new VbkDatabase(path.join(dir, "data"));
  const thread = db.createAgentThread(OWNER, { title: "查产品" });
  const runtime = createAgentRuntime(db, {
    products: fakePort(records, {
      "49ecb537-1111-4aaa-8bbb-000000000001": { ready: true, completion: 100, issues: [] },
    }),
  });
  const model = new ScriptedModel([
    { toolCalls: [{ id: "call-1", name: "product.status", arguments: { productId: "49ecb537" } }] },
    { content: "该产品程序检查已通过，接下来需要运营确认。" },
  ]);

  const run = await runtime.runs.start({
    ownerUserId: OWNER,
    threadId: thread.id,
    history: [{ role: "user", content: "日喀则那个产品现在能进录入了吗" }],
    intent: "日喀则那个产品现在能进录入了吗",
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  });

  assert.equal(run.status, "completed", "只读查询不应停在审批点");
  const receipts = db.listAgentActionReceipts(OWNER, thread.id);
  assert.deepEqual(receipts.map((receipt) => receipt.action), ["product.status"]);
  assert.equal(receipts[0].status, "succeeded");
  assert.ok(db.getAgentThreadDetail(OWNER, thread.id).messages
    .some((message) => message.role === "assistant" && message.content.includes("运营确认")));
  assert.equal(runtime.runs.snapshot({ ownerUserId: OWNER, threadId: thread.id }).approval, undefined);
});

test("决策 A 的代码守卫：产品域一旦出现写动作立即拒绝", () => {
  assert.doesNotThrow(() => assertProductActionsReadOnly([
    { name: "product.list", kind: "read" },
    { name: "product.status", kind: "read" },
  ] as never));
  assert.throws(
    () => assertProductActionsReadOnly([
      { name: "product.list", kind: "read" },
      { name: "product.confirm", kind: "write" },
    ] as never),
    /产品域只允许只读 Skill（决策 A）：product\.confirm/u,
  );
  assert.throws(
    () => assertProductActionsReadOnly([{ name: "product.delete", kind: "delete" }] as never),
    /决策 A/u,
  );
});
