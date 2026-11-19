import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { createAgentRuntime, createTibetReadSkill } from "../../src/main/agent-runtime/index.js";
import { buildTibetReadPort } from "../../src/main/agent-workspace/tibet-adapter.js";
import {
  TibetServiceAuthError,
  TibetServiceScopeError,
  type TibetServiceClient,
} from "../../src/main/infrastructure/tibet-service-client.js";
import type { AgentModel, AgentModelInput, AgentModelResult } from "../../src/main/agent/types.js";
import { context, OWNER, port } from "./tibet-readonly-fixtures.js";
class ScriptedModel implements AgentModel {
  constructor(private readonly responses: AgentModelResult[]) {}

  async complete(_input: AgentModelInput): Promise<AgentModelResult> {
    const next = this.responses.shift();
    if (!next) throw new Error("模型脚本已用尽");
    return next;
  }
}

test("查询服务令牌状态在对话中直接执行并留下收据，不进审批", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-tibet-runtime-"));
  const db = new VbkDatabase(path.join(dir, "data"));
  const thread = db.createAgentThread(OWNER, { title: "查服务令牌" });
  const runtime = createAgentRuntime(db, {
    tibet: port({
      status: async () => ({
        configured: true,
        name: "ansike",
        statusLabel: "生效中",
        permissions: ["只读", "创建", "编辑"],
        expiresAt: "2027-05-16 21:10:30",
        remainingDays: 180,
        bound: null,
        message: "",
      }),
    }),
  });

  assert.ok(runtime.registry.list().some((skill) => skill.id === "tibet"), "端口存在时注册三人同游 Skill");
  const model = new ScriptedModel([
    { toolCalls: [{ id: "call-1", name: "tibet.status", arguments: {} }] },
    { content: "服务令牌 ansike 生效中，未绑定身份。" },
  ]);
  const run = await runtime.runs.start({
    ownerUserId: OWNER,
    threadId: thread.id,
    history: [{ role: "user", content: "三人同游的服务令牌还有效吗" }],
    intent: "三人同游的服务令牌还有效吗",
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  });

  assert.equal(run.status, "completed", "只读查询不应停在审批点");
  const receipts = db.listAgentActionReceipts(OWNER, thread.id);
  assert.deepEqual(receipts.map((receipt) => receipt.action), ["tibet.status"]);
  assert.equal(receipts[0].accountKey, "tibet-read");
});

test("后台服务目录：标出下架项，并如实给出本页统计", async () => {
  const seen: unknown[] = [];
  const skill = createTibetReadSkill(port({
    listAdminServices: async (query) => {
      seen.push(query);
      return {
        items: [
          { publicId: "172708729898149707", title: "在售服务", priceFrom: 760, enabled: true, hot: false },
          { publicId: "909223317350627981", title: "已下架服务", priceFrom: 680, enabled: false, hot: false },
        ],
        total: 2,
        page: 1,
        pageSize: 20,
      };
    },
  }));

  const result = await skill.actions[2].execute({ includeDisabled: true, sort: "price_asc" }, context);
  assert.deepEqual(seen, [{ includeDisabled: true, sort: "price_asc" }]);
  assert.match(result.content, /后台服务目录（含管理字段）共 2 条/u);
  assert.match(result.content, /已下架服务.*已下架/u);
  assert.match(result.summary, /下架 1 条/u);
  await assert.rejects(() => skill.actions[2].target({ sort: "unknown" }, context), /sort 只能是/u);
});

test("VBK 绑定：列出当前使用账号与管家联系人，缺身份时抛错不伪装空", async () => {
  const skill = createTibetReadSkill(port({
    listVbkBindings: async () => ({
      activeVbkAccountKey: "vbk_671205",
      items: [{
        vbkAccountKey: "vbk_671205",
        vbkAccountName: "小璐",
        servicePhone: "4000000000",
        providerId: 1279416,
        butler: { contactCardId: 66, displayName: "王管家", providerId: 1279416 },
        lastUsedAt: null,
      }],
    }),
  }));
  const result = await skill.actions[4].execute({}, context);
  assert.match(result.content, /VBK 绑定 1 个（当前使用 vbk_671205）/u);
  assert.match(result.content, /管家 王管家（联系人卡 66）/u);
  assert.match(result.content, /← 当前使用/u);

  const denied = createTibetReadSkill(port({
    listVbkBindings: async () => { throw new TibetServiceScopeError("该服务令牌未绑定扩展用户身份"); },
  }));
  await assert.rejects(() => denied.actions[4].execute({}, context), /未绑定扩展用户身份/u);
});

test("客户订单：按状态筛选并展示金额/日期，非法状态在解析阶段拒绝", async () => {
  const seen: unknown[] = [];
  const skill = createTibetReadSkill(port({
    listOrders: async (query) => {
      seen.push(query);
      return [{
        publicId: "223016566171929308",
        orderNo: "223016566171929308",
        serviceId: "505639037750125942",
        serviceTitle: "悉尼蓝山小团观光日游",
        travelDate: "2026-12-01",
        peopleCount: 2,
        totalPrice: 1520,
        status: "paid",
        createdAt: null,
      }];
    },
  }));

  const result = await skill.actions[5].execute({ status: "paid" }, context);
  assert.deepEqual(seen, [{ status: "paid" }]);
  assert.match(result.content, /状态为「待出行」的订单共 1 条/u);
  assert.match(result.content, /¥1520，出行 2026-12-01，2 人/u);
  await assert.rejects(() => skill.actions[5].target({ status: "unknown" }, context), /status 只能是/u);
});

test("单笔订单详情：缺订单号拒绝；详情如实列出支付截止与联系人", async () => {
  const skill = createTibetReadSkill(port({
    getOrder: async (orderNo) => ({
      publicId: orderNo,
      orderNo,
      serviceId: "505639037750125942",
      serviceTitle: "悉尼蓝山小团观光日游",
      destination: "悉尼",
      travelDate: "2026-12-01",
      peopleCount: 2,
      contactName: "安思科",
      contactPhone: "18835112829",
      totalPrice: 1520,
      payableUntil: "2026-11-20T23:59:59+08:00",
      status: "pending_payment",
      createdAt: "2026-11-17T10:00:00+08:00",
    }),
  }));
  const result = await skill.actions[6].execute({ orderNo: "223016566171929308" }, context);
  assert.match(result.content, /订单 223016566171929308：悉尼蓝山小团观光日游（待支付）/u);
  assert.match(result.content, /联系人：安思科（18835112829）/u);
  assert.match(result.content, /支付截止：2026-11-20T23:59:59\+08:00/u);
  await assert.rejects(() => skill.actions[6].target({ orderNo: "" }, context), /缺少必填参数 orderNo/u);
});


test("订单标题缺失时回退到服务 id，不假装服务名", async () => {
  const skill = createTibetReadSkill(port({
    listOrders: async () => [{
      publicId: "223016566171929308",
      orderNo: "223016566171929308",
      serviceId: "505639037750125942",
      serviceTitle: null,
      totalPrice: 511,
      status: "pending_payment",
    }],
  }));
  const result = await skill.actions[5].execute({}, context);
  assert.match(result.content, /服务 505639037750125942（平台未返回标题）/u);
});


test("平台参考：列出相近服务与差价，并明确「仅供参考」", async () => {
  const skill = createTibetReadSkill(port({
    productReference: async (productId) => ({
      configured: true,
      title: "成都青城山都江堰私家团两日游",
      cities: ["成都"],
      matches: [{
        publicId: "172708729898149707",
        title: "成都青城山都江堰两日私家团",
        priceFrom: 1200,
        priceGap: 200,
        durationLabel: "2天1晚",
        similarity: 0.82,
        reasons: ["同城", "标题相似 82%"],
      }],
      message: `按城市 成都 命中 1 条（productId ${productId}）`,
    }),
  }));

  const result = await skill.actions[7].execute({ productId: "prod-1" }, context);
  assert.match(result.content, /平台在售参考：成都青城山都江堰私家团两日游（比对城市：成都）/u);
  assert.match(result.content, /¥1200（与产品成人价差 \+200）/u);
  assert.match(result.content, /同城，标题相似 82%/u);
  assert.match(result.summary, /1 条相近服务/u);
  await assert.rejects(() => skill.actions[7].target({ productId: "" }, context), /缺少必填参数 productId/u);
});

test("平台参考：无命中时如实说明，不伪造匹配", async () => {
  const skill = createTibetReadSkill(port({
    productReference: async () => ({
      configured: true, title: "无同类产品", cities: ["成都"], matches: [],
      message: "没有找到与该产品相近的平台在售服务。",
    }),
  }));
  const result = await skill.actions[7].execute({ productId: "prod-2" }, context);
  assert.match(result.content, /没有找到/u);
  assert.match(result.summary, /0 条相近服务/u);
});
