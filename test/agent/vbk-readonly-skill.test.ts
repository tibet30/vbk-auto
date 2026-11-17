import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import {
  createAgentRuntime,
  createVbkReadSkill,
  type AgentSkillContext,
  type VbkReadPort,
  type VbkStatusSnapshot,
} from "../../src/main/agent-runtime/index.js";
import { buildVbkReadPort } from "../../src/main/agent-workspace/ports.js";
import type { AgentModel, AgentModelInput, AgentModelResult } from "../../src/main/agent/types.js";

const OWNER = 1001;
const context: AgentSkillContext = { ownerUserId: OWNER, threadId: "t-1", runId: "r-1" };

const emptyContacts = async (options: { providerId?: number } = {}) => ({ providerId: options.providerId ?? 1, cards: [] });
const emptyPois = async () => ({ httpStatus: 200, businessStatus: 0, poiListCount: 0, best: null, candidates: [] });

test("VBK Skill 只注册只读动作", () => {
  const skill = createVbkReadSkill({ status: async () => ({ loggedIn: false, message: "" }), contacts: emptyContacts, searchPoi: emptyPois });
  assert.deepEqual(skill.actions.map((action) => action.name), ["vbk.status", "vbk.contacts", "vbk.poi"]);
  assert.ok(skill.actions.every((action) => action.kind === "read" && action.risk === "low"));
});

test("已登录时如实报出账号，不额外推断权限", async () => {
  const calls: Array<{ refresh: boolean }> = [];
  const port: VbkReadPort = {
    contacts: emptyContacts,
    searchPoi: emptyPois,
    status: async (options) => {
      calls.push({ refresh: options?.refresh === true });
      return {
        loggedIn: true,
        message: "已连接旅游供应商平台",
        accountName: "小璐",
        loginAccount: "vbk_671205",
        accounts: ["vbk_671205", "vbk_700001"],
      };
    },
  };
  const skill = createVbkReadSkill(port);
  const result = await skill.actions[0].execute({}, context);
  assert.match(result.content, /VBK 已登录：小璐（vbk_671205）/u);
  assert.match(result.content, /本机已知账号：vbk_671205、vbk_700001/u);
  assert.match(result.summary, /已登录/u);
  assert.deepEqual(calls, [{ refresh: false }], "默认读缓存，不主动刷新页面");

  await skill.actions[0].execute({ refresh: true }, context);
  assert.deepEqual(calls[1], { refresh: true }, "refresh 参数必须透传到端口");
});

test("未登录时明确说明，不编造账号", async () => {
  const skill = createVbkReadSkill({
    status: async () => ({ loggedIn: false, message: "请先登录 VBK 后台。" }),
    contacts: emptyContacts,
    searchPoi: emptyPois,
  });
  const result = await skill.actions[0].execute({}, context);
  assert.match(result.content, /VBK 未登录：请先登录 VBK 后台/u);
  assert.doesNotMatch(result.content, /vbk_\d/u);
  assert.match(result.summary, /未登录/u);
});

test("读取失败必须抛出，让执行器记失败收据而不是「成功但正文说失败」", async () => {
  const skill = createVbkReadSkill({
    status: async () => { throw new Error("VBK 页面加载失败，请重试。"); },
    contacts: emptyContacts,
    searchPoi: emptyPois,
  });
  await assert.rejects(() => skill.actions[0].execute({}, context), /VBK 页面加载失败/u);
});

test("没有浏览器时端口如实返回未登录，而不是假装成功", async () => {
  const port = buildVbkReadPort({ db: new VbkDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "vbk-vbk-port-"))) });
  const snapshot: VbkStatusSnapshot = await port.status();
  assert.equal(snapshot.loggedIn, false);
  assert.match(snapshot.message, /VBK 浏览器不可用/u);
});

test("端口把 refresh 透传给浏览器适配器", async () => {
  const seen: boolean[] = [];
  const port = buildVbkReadPort({
    db: new VbkDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "vbk-vbk-port2-"))),
    browser: {
      listKnownLoginAccounts: () => ({ current: null, saved: [] }),
      status: async (refresh) => {
        seen.push(refresh === true);
        return { loggedIn: true, message: "ok", accountName: "小璐" };
      },
    },
  });
  await port.status({ refresh: true });
  await port.status();
  assert.deepEqual(seen, [true, false]);
});

class ScriptedModel implements AgentModel {
  constructor(private readonly responses: AgentModelResult[]) {}

  async complete(_input: AgentModelInput): Promise<AgentModelResult> {
    const next = this.responses.shift();
    if (!next) throw new Error("模型脚本已用尽");
    return next;
  }
}

test("查询 VBK 状态在对话中直接执行并留下收据，不进审批", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-vbk-runtime-"));
  const db = new VbkDatabase(path.join(dir, "data"));
  const thread = db.createAgentThread(OWNER, { title: "查 VBK" });
  const runtime = createAgentRuntime(db, {
    vbk: {
      status: async () => ({ loggedIn: true, message: "ok", accountName: "小璐", loginAccount: "vbk_671205" }),
      contacts: emptyContacts,
      searchPoi: emptyPois,
    },
  });
  const model = new ScriptedModel([
    { toolCalls: [{ id: "call-1", name: "vbk.status", arguments: {} }] },
    { content: "当前 VBK 登录的是小璐（vbk_671205）。" },
  ]);
  const run = await runtime.runs.start({
    ownerUserId: OWNER,
    threadId: thread.id,
    history: [{ role: "user", content: "现在 VBK 登录的是哪个账号" }],
    intent: "现在 VBK 登录的是哪个账号",
    provider: async () => ({ model, systemPrompt: "系统说明" }),
  });
  assert.equal(run.status, "completed", "只读查询不应停在审批点");
  const receipts = db.listAgentActionReceipts(OWNER, thread.id);
  assert.deepEqual(receipts.map((receipt) => receipt.action), ["vbk.status"]);
  assert.equal(receipts[0].accountKey, "vbk-read");
});

test("联系人卡片只读查询：列出名称与联系人卡 id", async () => {
  const seen: Array<{ providerId?: number; keyword?: string }> = [];
  const skill = createVbkReadSkill({
    status: async () => ({ loggedIn: true, message: "ok" }),
    searchPoi: emptyPois,
    contacts: async (options) => {
      seen.push(options);
      return {
        providerId: options.providerId ?? 3388899,
        cards: [
          { contactCardId: 66, displayName: "王管家", providerId: 3388899 },
          { contactCardId: 67, displayName: "李管家", providerId: 3388899 },
        ],
      };
    },
  });
  const result = await skill.actions[1].execute({ providerId: 3388899, keyword: "管家" }, context);
  assert.match(result.content, /供应商 3388899 的联系人卡片（2 个）/u);
  assert.match(result.content, /王管家（联系人卡 66）/u);
  assert.match(result.content, /李管家（联系人卡 67）/u);
  assert.match(result.summary, /2 个/u);
  assert.deepEqual(seen, [{ providerId: 3388899, keyword: "管家" }]);
});

test("没有匹配的联系人时明确说明，不返回空壳结论", async () => {
  const skill = createVbkReadSkill({ status: async () => ({ loggedIn: true, message: "" }), contacts: emptyContacts, searchPoi: emptyPois });
  const result = await skill.actions[1].execute({ providerId: 9 }, context);
  assert.match(result.content, /供应商 9 下没有匹配的联系人卡片/u);
});

test("非法 providerId 在解析目标阶段就被拒绝，不发起后台请求", async () => {
  let called = false;
  const skill = createVbkReadSkill({
    status: async () => ({ loggedIn: true, message: "" }),
    contacts: async () => { called = true; return { providerId: 1, cards: [] }; },
    searchPoi: emptyPois,
  });
  await assert.rejects(() => skill.actions[1].target({ providerId: -1 }, context), /providerId 必须是正整数/u);
  await assert.rejects(() => skill.actions[1].target({ providerId: 0 }, context), /providerId 必须是正整数/u);
  assert.equal(called, false);
});

test("后台读取失败同样抛出，由执行器记 failed 收据", async () => {
  const skill = createVbkReadSkill({
    status: async () => ({ loggedIn: true, message: "" }),
    contacts: async () => { throw new Error("VBK 联系人列表查询失败：timeout"); },
    searchPoi: emptyPois,
  });
  await assert.rejects(() => skill.actions[1].execute({}, context), /VBK 联系人列表查询失败/u);
});

test("端口：providerId 省略时按当前活跃账号解析，解析不到就明确报错", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-contacts-port-"));
  const db = new VbkDatabase(path.join(dir, "data"));
  const seen: number[] = [];
  const browser = {
    listKnownLoginAccounts: () => ({ current: null, saved: [] }),
    status: async () => ({ loggedIn: true, message: "ok" }),
    listProviderContactCards: async (providerId: number) => {
      seen.push(providerId);
      return [{ contactCardId: 1, displayName: "王管家", providerId }];
    },
  };

  const port = buildVbkReadPort({ db, browser });
  await assert.rejects(() => port.contacts({}), /无法确定当前供应商 id/u, "没有活跃账号时必须报错而不是猜");

  db.setProviderIdFor("vbk_671205", 3388899);
  db.setSetting("vbkActiveAccountKey", "vbk_671205");
  const resolved = await port.contacts({});
  assert.deepEqual(resolved, { providerId: 3388899, cards: [{ contactCardId: 1, displayName: "王管家", providerId: 3388899 }] });
  assert.deepEqual(seen, [3388899]);
});

test("端口：浏览器缺少联系人能力时明确报错", async () => {
  const port = buildVbkReadPort({
    db: new VbkDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "vbk-contacts-port2-"))),
    browser: { listKnownLoginAccounts: () => ({ current: null, saved: [] }) },
  });
  await assert.rejects(() => port.contacts({ providerId: 1 }), /VBK 浏览器不可用/u);
});

test("缓存缺失时用当前会话现场探测 providerId，并写回缓存", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-contacts-detect-"));
  const db = new VbkDatabase(path.join(dir, "data"));
  db.setSetting("vbkActiveAccountKey", "vbk_671205");
  const remembered: Array<[string, number]> = [];
  const seen: number[] = [];
  const port = buildVbkReadPort({
    db,
    detectProviderId: async () => 3388899,
    rememberProviderId: (accountKey, providerId) => {
      remembered.push([accountKey, providerId]);
      db.setProviderIdFor(accountKey, providerId);
    },
    browser: {
      listKnownLoginAccounts: () => ({ current: null, saved: [] }),
      listProviderContactCards: async (providerId: number) => {
        seen.push(providerId);
        return [{ contactCardId: 66, displayName: "王管家", providerId }];
      },
    },
  });
  const result = await port.contacts({});
  assert.equal(result.providerId, 3388899);
  assert.deepEqual(remembered, [["vbk_671205", 3388899]], "探测到就写回缓存，下次不必再探测");
  assert.deepEqual(seen, [3388899]);

  // 有了缓存后不再触发探测
  let detects = 0;
  const second = buildVbkReadPort({
    db,
    detectProviderId: async () => { detects += 1; return 1; },
    browser: {
      listKnownLoginAccounts: () => ({ current: null, saved: [] }),
      listProviderContactCards: async (providerId: number) => [{ contactCardId: 1, displayName: "x", providerId }],
    },
  });
  assert.equal((await second.contacts({})).providerId, 3388899);
  assert.equal(detects, 0, "缓存命中时不应再探测");
});

test("探测也拿不到 providerId 时明确报错", async () => {
  const db = new VbkDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "vbk-contacts-detect2-")));
  db.setSetting("vbkActiveAccountKey", "vbk_671205");
  const port = buildVbkReadPort({
    db,
    detectProviderId: async () => null,
    browser: {
      listKnownLoginAccounts: () => ({ current: null, saved: [] }),
      listProviderContactCards: async () => [],
    },
  });
  await assert.rejects(() => port.contacts({}), /缓存缺失且当前会话探测不到/u);
});

test("POI 只读查询：列出候选的名称、id、所在地与可选性", async () => {
  const skill = createVbkReadSkill({
    status: async () => ({ loggedIn: true, message: "" }),
    contacts: emptyContacts,
    searchPoi: async () => ({
      httpStatus: 200,
      businessStatus: 0,
      poiListCount: 2,
      best: { poiName: "扎什伦布寺", poiId: 12345 },
      candidates: [
        { index: 0, poiName: "扎什伦布寺", poiId: 12345, province: "西藏", city: "日喀则", district: "桑珠孜区", selectable: true, textFields: [] },
        { index: 1, poiName: "珠峰大本营", poiId: 67890, province: "西藏", city: "日喀则", district: null, selectable: false, textFields: [] },
      ],
    }),
  });
  const result = await skill.actions[2].execute({ keyword: "日喀则" }, context);
  assert.match(result.content, /POI 候选（共 2 个，展示 2 个）/u);
  assert.match(result.content, /扎什伦布寺（id 12345，西藏·日喀则·桑珠孜区，可选）/u);
  assert.match(result.content, /珠峰大本营（id 67890，西藏·日喀则，不可选）/u);
  assert.match(result.summary, /2 个候选/u);
});

test("POI 没有候选时如实说明，不编造景点", async () => {
  const skill = createVbkReadSkill({ status: async () => ({ loggedIn: true, message: "" }), contacts: emptyContacts, searchPoi: emptyPois });
  const result = await skill.actions[2].execute({ keyword: "不存在的地名" }, context);
  assert.match(result.content, /没有返回「不存在的地名」的 POI 候选/u);
  assert.doesNotMatch(result.content, /id \d+/u);
});

test("空关键词在解析目标阶段就拒绝，不发起平台请求", async () => {
  let called = false;
  const skill = createVbkReadSkill({
    status: async () => ({ loggedIn: true, message: "" }),
    contacts: emptyContacts,
    searchPoi: async () => { called = true; return { httpStatus: 200, businessStatus: 0, poiListCount: 0, best: null, candidates: [] }; },
  });
  await assert.rejects(() => skill.actions[2].target({ keyword: "  " }, context), /缺少必填参数 keyword/u);
  assert.equal(called, false);
});

test("端口没有 POI 能力时明确报错", async () => {
  const port = buildVbkReadPort({
    db: new VbkDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "vbk-poi-port-"))),
    browser: { listKnownLoginAccounts: () => ({ current: null, saved: [] }) },
  });
  await assert.rejects(() => port.searchPoi("日喀则"), /POI 查询能力不可用/u);
});
