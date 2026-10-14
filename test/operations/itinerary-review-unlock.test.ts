import test from "node:test";
import assert from "node:assert/strict";
import { lockedMenus, postReviewMenus, setup, unlockedMenus } from "./itinerary-review-unlock.fixture.js";

test("fresh confirmation is consumed once and verified state is durable", async () => {
  const f = setup();
  const service = f.service();
  const plan = await service.prepare("local");
  assert.ok(plan.token);
  assert.equal(f.preflightCalls, 1);
  assert.equal(f.verifyPlanCalls, 1);
  const result = await service.execute(plan.token!);
  assert.equal(result.verified, true);
  assert.equal(f.submitCalls, 1);
  assert.equal(f.preflightCalls, 2);
  assert.equal(f.verifyPlanCalls, 2);
  assert.equal(f.persisted?.status, "verified");
  assert.equal(f.persisted?.beforeDigest, "a".repeat(64));
  await assert.rejects(service.execute(plan.token!), /过期或已使用/);
  assert.equal(f.submitCalls, 1);
});

test("expired, local, account and remote changes reject before a write", async () => {
  for (const mutate of [
    (f: ReturnType<typeof setup>) => f.advance(300_001),
    (f: ReturnType<typeof setup>) => { f.product = { ...f.product, productJsonVersion: 4 }; },
    (f: ReturnType<typeof setup>) => { f.account = "vbk-b"; },
    (f: ReturnType<typeof setup>) => { f.evidence = { ...f.evidence, contentDigest: "changed" }; },
    (f: ReturnType<typeof setup>) => { f.evidence = { ...f.evidence, tourInfoId: "420000000000000002" }; },
  ]) {
    const f = setup(); const service = f.service(); const plan = await service.prepare("local"); mutate(f);
    await assert.rejects(service.execute(plan.token!));
    assert.equal(f.writes, 0);
  }
});

test("relation pointer or status drift with identical itinerary content rejects before write", async () => {
  for (const relation of [
    { productId: 100, tourInfoId: "420000000000000001", draftTourInfoId: "420000000000000099",
      auditTourInfoId: "420000000000000001", draftTourInfoStatus: 1, auditStatus: { key: "A", value: "审核通过" } },
    { productId: 100, tourInfoId: "420000000000000001", draftTourInfoId: "420000000000000002",
      auditTourInfoId: "420000000000000001", draftTourInfoStatus: 2, auditStatus: { key: "A", value: "审核通过" } },
  ]) {
    const f = setup(); const service = f.service(); const plan = await service.prepare("local");
    f.evidence = { ...f.evidence, relation };
    await assert.rejects(service.execute(plan.token!), /关联身份已变化/);
    assert.equal(f.writes, 0);
  }
});

test("dispatch barrier storage failure prevents every remote write", async () => {
  const f = setup(); const service = f.service(); const plan = await service.prepare("local");
  f.failNextSave = true;
  await assert.rejects(service.execute(plan.token!), /disk full/);
  assert.equal(f.writes, 0);
  assert.equal(f.persisted, undefined);
});

test("audit log failure before protocol dispatch remains a proven zero-write failure", async () => {
  const f = setup(); const service = f.service(); const plan = await service.prepare("local");
  f.failRecord = true;
  await assert.rejects(service.execute(plan.token!), /log failed/);
  assert.equal(f.writes, 0);
  assert.equal(f.persisted?.status, "failed");
});

test("check8 改写在回执前失败后，只能通过完整解锁回读收敛", async () => {
  const f = setup(); f.submitMode = "digest-mismatch";
  f.evidence = { ...f.evidence, relation: { ...f.evidence.relation, auditStatus: { key: "N", value: "未提交" } } };
  const first = f.service(); const plan = await first.prepare("local");
  await assert.rejects(first.execute(plan.token!), (error: any) => error.uncertainWrite === true);
  assert.equal(f.persisted?.status, "uncertain");
  assert.deepEqual(f.persisted?.requestSteps, []);
  assert.ok(f.persisted?.digestMismatch);
  assert.equal(f.submitCalls, 1);

  const restarted = f.service();
  await assert.rejects(restarted.prepare("local"), /只能只读核查/);
  assert.equal(f.submitCalls, 1, "restart must never replay a possibly dispatched write");
  assert.equal(f.persisted?.status, "uncertain");

  const locked = await restarted.refresh("local");
  assert.equal(locked.status, "uncertain");
  assert.equal(f.submitCalls, 1, "audit=N is not proof that check8 never reached VBK");

  f.evidence = { ...f.evidence, maxStep: 10, fullyUnlocked: true, menus: structuredClone(unlockedMenus) };
  const reconciled = await restarted.refresh("local");
  assert.equal(reconciled.status, "verified");
  assert.equal(f.submitCalls, 1);
});

test("平台空壳标准化误判经完整方案回读后可继续，但不会跳过新的校验", async () => {
  const f = setup(); f.submitMode = "digest-mismatch";
  f.digestMismatchPaths = [
    "$.tourDailyDescriptions[0].parentId",
    "$.tourDailyDescriptions[0].tourDailyInfos[0].takeoffTime.key",
    "$.tourDailyDescriptions[0].tourDailyInfos[0].tourDailyDinner",
  ];
  const first = f.service(); const plan = await first.prepare("local");
  await assert.rejects(first.execute(plan.token!), (error: any) => error.uncertainWrite === true);
  const recovered = await f.service().refresh("local");
  assert.equal(recovered.status, "requires_review");
  assert.equal(recovered.attemptId, "");
  assert.equal(recovered.digestMismatch, undefined);
  assert.match(recovered.message ?? "", /只读确认/);
  assert.equal(f.submitCalls, 1);

  f.submitMode = "success";
  const restarted = f.service(); const retry = await restarted.prepare("local");
  assert.ok(retry.token);
  const result = await restarted.execute(retry.token!);
  assert.equal(result.verified, true);
  assert.equal(f.submitCalls, 2, "recovery must run the corrected validation protocol again");
});

test("标准化误判恢复时完整方案回读失败仍保持 uncertain", async () => {
  const f = setup(); f.submitMode = "digest-mismatch";
  f.digestMismatchPaths = ["$.tourDailyDescriptions[0].tourDailyInfos[0].tourDailyCar"];
  const service = f.service(); const plan = await service.prepare("local");
  await assert.rejects(service.execute(plan.token!));
  f.verifyPlanError = new Error("已人工删除的 POI 被远端恢复");
  await assert.rejects(f.service().refresh("local"), /删除的 POI/);
  assert.equal(f.persisted?.status, "uncertain");
  assert.equal(f.submitCalls, 1);
});

test("two fresh tokens cannot replay after the first attempt becomes uncertain", async () => {
  const f = setup(); f.submitMode = "uncertain";
  const service = f.service();
  const first = await service.prepare("local");
  const second = await service.prepare("local");
  await assert.rejects(service.execute(first.token!));
  assert.equal(f.submitCalls, 1);
  await assert.rejects(service.execute(second.token!), /已有行程审核写入结果尚未确认/);
  assert.equal(f.submitCalls, 1);
});

test("active account change during the protocol is rejected by every-step assertion", async () => {
  const f = setup(); f.submitMode = "account-change";
  const service = f.service(); const plan = await service.prepare("local");
  await assert.rejects(service.execute(plan.token!), (error: any) =>
    error.uncertainWrite === true && /账号已变化/.test(error.message));
  assert.equal(f.submitCalls, 1);
  assert.equal(f.persisted?.status, "uncertain");
});

test("already unlocked product verifies read-only and returns no token", async () => {
  const f = setup();
  f.evidence = { ...f.evidence, maxStep: 10, fullyUnlocked: true, menus: structuredClone(unlockedMenus) };
  const plan = await f.service().prepare("local");
  assert.equal(plan.readonlyVerified, true);
  assert.equal(plan.token, undefined);
  assert.equal(plan.receipt?.verified, true);
  assert.equal(f.writes, 0);
  assert.equal(f.persisted?.status, "verified");
});

test("套餐管理已连续解锁即可只读确认审核完成", async () => {
  const f = setup();
  f.evidence = { ...f.evidence, maxStep: 10, fullyUnlocked: false, menus: structuredClone(postReviewMenus) };
  const plan = await f.service().prepare("local");
  assert.equal(plan.readonlyVerified, true);
  assert.equal(f.writes, 0);
  assert.equal(f.persisted?.status, "verified");
});

test("tail extension F blocks confirmation with zero writes", async () => {
  const f = setup();
  f.evidence = {
    ...f.evidence,
    maxStep: 10,
    fullyUnlocked: false,
    menus: [...structuredClone(unlockedMenus), { key: "extension", title: "扩展菜单", enabled: "F" }],
  };
  await assert.rejects(f.service().prepare("local"), /不是可确认的行程审核边界/);
  assert.equal(f.writes, 0);
  assert.equal(f.submitCalls, 0);
  assert.equal(f.persisted, undefined);
});

test("locked refresh without a prior dispatch reports requires_review without persistence", async () => {
  const f = setup();
  const state = await f.service().refresh("local");
  assert.equal(state.status, "requires_review");
  assert.equal(f.persisted, undefined);
  assert.equal(f.writes, 0);
});

test("基本信息或图文菜单未推进时，不能误发起行程审核", async () => {
  for (const [maxStep, unlockedCount] of [[-80, 2], [-70, 3]] as const) {
    const f = setup();
    f.evidence = {
      ...f.evidence,
      maxStep,
      menus: lockedMenus.map((menu, index) => ({ ...menu, enabled: index < unlockedCount ? "T" : "F" })),
    };
    await assert.rejects(f.service().prepare("local"), /不是可确认的行程审核边界/);
    assert.equal(f.writes, 0);
  }
});

test("prepare and refresh reject a local or account change during remote readback", async () => {
  const prepare = setup();
  prepare.afterRead = () => { prepare.product = { ...prepare.product, productJsonVersion: 4 }; };
  await assert.rejects(prepare.service().prepare("local"), /产品方案、账号或远程身份已变化/);

  const refresh = setup();
  refresh.afterRead = () => { refresh.account = "vbk-b"; };
  await assert.rejects(refresh.service().refresh("local"), /账号已变化/);
  assert.equal(refresh.writes, 0);
});

test("confirmation plan uses menu titles rather than technical keys", async () => {
  const plan = await setup().service().prepare("local");
  assert.deepEqual(plan.lockedMenus, ["菜单4", "菜单5", "菜单6", "菜单7", "菜单8", "菜单9"]);
});

test("readonly refresh preserves the completed workflow approval binding", async () => {
  const f = setup(); const service = f.service(); const plan = await service.prepare("local");
  await service.execute(plan.token!);
  const saved = f.persisted!;
  saved.approvalId = "approved-current-run";
  saved.agentRunId = "current-run";
  f.evidence = { ...f.evidence, contentDigest: "b".repeat(64) };
  const refreshed = await service.refresh("local");
  assert.equal(refreshed.status, "verified");
  assert.equal(refreshed.approvalId, "approved-current-run");
  assert.equal(refreshed.beforeDigest, "a".repeat(64));
  assert.equal(refreshed.afterDigest, "b".repeat(64));
  assert.equal(refreshed.agentRunId, "current-run");
  assert.equal(f.writes, 1, "readonly refresh must never repeat the review");
});

test("current preflight failures block prepare and execute before dispatch", async () => {
  const prepare = setup(); prepare.preflightError = new Error("价格库存回读不一致");
  await assert.rejects(prepare.service().prepare("local"), /价格库存回读不一致/);
  assert.equal(prepare.preflightCalls, 1);
  assert.equal(prepare.verifyPlanCalls, 0);
  assert.equal(prepare.submitCalls, 0);
  assert.equal(prepare.persisted, undefined);

  const execute = setup(); const service = execute.service(); const plan = await service.prepare("local");
  execute.preflightError = new Error("住宿规则回读不一致");
  await assert.rejects(service.execute(plan.token!), /住宿规则回读不一致/);
  assert.equal(execute.preflightCalls, 2);
  assert.equal(execute.verifyPlanCalls, 1);
  assert.equal(execute.submitCalls, 0);
  assert.equal(execute.persisted, undefined);
});

test("route or deleted POI mismatch blocks prepare and execute before dispatch", async () => {
  const prepare = setup(); prepare.verifyPlanError = new Error("路线顺序与本地确认方案不一致");
  await assert.rejects(prepare.service().prepare("local"), /路线顺序/);
  assert.equal(prepare.verifyPlanCalls, 1);
  assert.equal(prepare.writes, 0);
  assert.equal(prepare.persisted, undefined);

  const execute = setup(); const service = execute.service(); const plan = await service.prepare("local");
  execute.verifyPlanError = new Error("已人工删除的 POI 被远端恢复");
  await assert.rejects(service.execute(plan.token!), /删除的 POI/);
  assert.equal(execute.verifyPlanCalls, 2);
  assert.equal(execute.submitCalls, 0);
  assert.equal(execute.persisted, undefined);
});

test("fresh proof reread rejects remote drift before token or dispatch", async () => {
  const prepare = setup();
  prepare.afterVerifyPlan = () => {
    prepare.afterVerifyPlan = undefined;
    prepare.evidence = { ...prepare.evidence, contentDigest: "drift-after-proof" };
  };
  await assert.rejects(prepare.service().prepare("local"), /核验期间发生变化/);
  assert.equal(prepare.writes, 0);
  assert.equal(prepare.persisted, undefined);

  const execute = setup(); const service = execute.service(); const plan = await service.prepare("local");
  execute.afterVerifyPlan = () => {
    execute.afterVerifyPlan = undefined;
    const menus = structuredClone(execute.evidence.menus); menus[4].enabled = "T";
    execute.evidence = { ...execute.evidence, menus };
  };
  await assert.rejects(service.execute(plan.token!), /核验期间发生变化/);
  assert.equal(execute.verifyPlanCalls, 2);
  assert.equal(execute.submitCalls, 0);
  assert.equal(execute.persisted, undefined);
});
