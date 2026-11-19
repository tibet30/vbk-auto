import assert from "node:assert/strict";
import test from "node:test";
import { createTibetReadSkill } from "../../src/main/agent-runtime/index.js";
import { buildTibetReadPort } from "../../src/main/agent-workspace/tibet-adapter.js";
import {
  TibetServiceAuthError,
  TibetServiceScopeError,
  type TibetServiceClient,
} from "../../src/main/infrastructure/tibet-service-client.js";
import { context, OWNER, port } from "./tibet-readonly-fixtures.js";

test("三人同游 Skill 只注册只读动作", () => {
  const skill = createTibetReadSkill(port());
  assert.equal(skill.id, "tibet");
  assert.deepEqual(skill.actions.map((action) => action.name), [
    "tibet.status",
    "tibet.services",
    "tibet.adminServices",
    "tibet.service",
    "tibet.vbkBindings",
    "tibet.orders",
    "tibet.order",
    "tibet.productReference",
  ]);
  assert.ok(skill.actions.every((action) => action.kind === "read" && action.risk === "low"));
});

test("未配置令牌时如实说明，并指出公共目录仍可用", async () => {
  const skill = createTibetReadSkill(port({
    status: async () => ({ configured: false, message: "未配置服务令牌（环境变量 TIBET_SERVICE_TOKEN）。" }),
  }));
  const result = await skill.actions[0].execute({}, context);
  assert.match(result.content, /服务令牌未配置/u);
  assert.match(result.content, /公共服务目录仍可查询/u);
  assert.match(result.summary, /未配置/u);
});

test("已配置令牌时如实报出权限、有效期与绑定身份", async () => {
  const skill = createTibetReadSkill(port({
    status: async () => ({
      configured: true,
      name: "ansike",
      statusLabel: "生效中",
      permissions: ["只读", "创建", "编辑"],
      expiresAt: "2027-05-16 21:10:30",
      remainingDays: 180,
      bound: null,
      identities: [],
      message: "",
    }),
  }));
  const result = await skill.actions[0].execute({}, context);
  assert.match(result.content, /令牌「ansike」：生效中/u);
  assert.match(result.content, /权限：只读、创建、编辑/u);
  assert.match(result.content, /剩余 180 天/u);
  assert.match(result.content, /未绑定——只能访问公共接口/u);
  assert.match(result.result, /identities=0/u);
});

test("服务目录列表如实报出总数、起价与截断信息", async () => {
  const seen: unknown[] = [];
  const items = Array.from({ length: 18 }, (_, index) => ({
    publicId: String(172708729898149700 + index),
    title: `服务 ${index + 1}`,
    cityCode: "sydney",
    countryCode: "au",
    serviceType: "sightseeing",
    durationLabel: "约10小时",
    priceFrom: 760 + index,
    availableLabel: "固定发团日可询",
    hot: index === 0,
  }));
  const skill = createTibetReadSkill(port({
    listServices: async (query) => {
      seen.push(query);
      return { items, total: 41, page: 2, pageSize: 18 };
    },
  }));

  const result = await skill.actions[1].execute({ search: "蓝山", page: 2, pageSize: 18, hot: true }, context);
  assert.deepEqual(seen, [{ search: "蓝山", hot: true, page: 2, pageSize: 18 }]);
  assert.match(result.content, /服务目录共 41 条，第 2 页（每页 18 条）/u);
  assert.match(result.content, /服务 1（public_id 172708729898149700）：au\/sydney，sightseeing，约10小时，¥760/u);
  assert.match(result.content, /热门/u);
  assert.match(result.content, /本页另有 3 条未展示/u);
  assert.match(result.summary, /本页 18 条，共 41 条/u);
});

test("目录查询参数非法时在解析目标阶段就拒绝，不发起请求", async () => {
  let called = false;
  const skill = createTibetReadSkill(port({
    listServices: async () => { called = true; return emptyPage; },
  }));
  await assert.rejects(() => skill.actions[1].target({ pageSize: 500 }, context), /pageSize 不能超过 50/u);
  await assert.rejects(() => skill.actions[1].target({ page: -1 }, context), /page 必须是正整数/u);
  await assert.rejects(() => skill.actions[1].target({ priceMin: -5 }, context), /priceMin 必须是非负数字/u);
  assert.equal(called, false);
});

test("目录为空时明确说明，不给出空壳结论", async () => {
  const skill = createTibetReadSkill(port());
  const result = await skill.actions[1].execute({ search: "不存在的地方" }, context);
  assert.match(result.content, /没有匹配的服务（共 0 条）/u);
});

test("服务详情列出亮点、包含项与取消规则", async () => {
  const skill = createTibetReadSkill(port({
    getService: async (publicId) => ({
      publicId,
      title: "悉尼蓝山小团观光日游",
      countryCode: "au",
      cityCode: "sydney",
      serviceType: "sightseeing",
      durationLabel: "约10小时",
      priceFrom: 760,
      highlights: ["蓝山经典观景点"],
      includes: ["当地用车"],
      excludes: ["餐饮"],
      meeting: "按确认方案在市区集合点上车。",
      notices: ["请携带防晒和轻便外套。"],
      cancelPolicy: "固定团期确认后取消按供应商规则处理。",
    }),
  }));
  const result = await skill.actions[3].execute({ publicId: "172708729898149707" }, context);
  assert.match(result.content, /悉尼蓝山小团观光日游（public_id 172708729898149707）/u);
  assert.match(result.content, /包含：当地用车/u);
  assert.match(result.content, /不包含：餐饮/u);
  assert.match(result.content, /须知：请携带防晒和轻便外套。/u);
  assert.match(result.content, /取消规则：固定团期确认后取消按供应商规则处理。/u);
});

test("读取失败必须抛出，由执行器记 failed 收据", async () => {
  const skill = createTibetReadSkill(port({
    listServices: async () => { throw new TibetServiceScopeError("该服务令牌未绑定扩展用户身份"); },
  }));
  await assert.rejects(() => skill.actions[1].execute({}, context), /未绑定扩展用户身份/u);
});

test("端口：令牌无效属于状态结论，网络与协议故障必须抛出", async () => {
  const authFailure: TibetServiceClient = {
    configured: () => true,
    selfCheck: async () => { throw new TibetServiceAuthError("服务令牌已过期"); },
    listServices: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }),
    getService: async () => { throw new Error("unused"); },
  };
  const status = await buildTibetReadPort(authFailure).status();
  assert.equal(status.configured, true);
  assert.match(status.message, /服务令牌已过期/u);

  const scopeFailure: TibetServiceClient = { ...authFailure, selfCheck: async () => { throw new TibetServiceScopeError("缺少权限"); } };
  await assert.rejects(() => buildTibetReadPort(scopeFailure).status(), TibetServiceScopeError);
});

test("端口：未配置令牌时不发请求，公共目录照常可用", async () => {
  let requested = false;
  const unconfigured: TibetServiceClient = {
    configured: () => false,
    selfCheck: async () => { requested = true; throw new Error("不应调用"); },
    listServices: async () => ({
      items: [{
        publicId: "172708729898149707",
        title: "悉尼蓝山小团观光日游",
        subtitle: null,
        countryCode: "au",
        cityCode: "sydney",
        serviceType: "sightseeing",
        durationLabel: "约10小时",
        priceFrom: 760,
        availableLabel: null,
        tags: [],
        hot: false,
      }],
      total: 1,
      page: 1,
      pageSize: 20,
    }),
    getService: async () => { throw new Error("unused"); },
  };
  const built = buildTibetReadPort(unconfigured);
  const status = await built.status();
  assert.equal(status.configured, false);
  assert.equal(requested, false, "未配置令牌时连自检请求都不发");

  const page = await built.listServices();
  assert.deepEqual(page.items[0], {
    publicId: "172708729898149707",
    title: "悉尼蓝山小团观光日游",
    countryCode: "au",
    cityCode: "sydney",
    serviceType: "sightseeing",
    durationLabel: "约10小时",
    priceFrom: 760,
    tags: [],
    hot: false,
  });
});
