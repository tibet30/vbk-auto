import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceSavedProductWizardStage,
  advanceSavedProductWizardWithoutReview,
} from "../../src/main/automation/ctrip/product-wizard.ts";
import { verifyProductMenusUnlocked } from "../../src/main/automation/ctrip/product-menu-readback.ts";
import { unlockedMenus } from "./product-menu-fixture.ts";

function fixture(initialStep: number, options: {
  stuck?: boolean;
  review?: boolean;
  incomplete?: boolean;
  remoteStep?: number;
  afterBaseStep?: number;
  afterDescriptionStep?: number;
  afterBaseMaxStep?: number;
  afterDescriptionMaxStep?: number;
  baseProductId?: unknown;
  descriptionProductId?: unknown;
  descriptionInfoProductIds?: unknown[];
  descriptionNestedProductId?: unknown;
  missingDescriptionIdentity?: boolean;
  sessionInvalidOnceFor?: string;
  mutateMenus?: (menus: any[]) => void;
} = {}) {
  let step = initialStep;
  let reportedMaxStep = initialStep;
  let sessionInvalidAttempts = 0;
  let descriptionReads = 0;
  const calls: string[] = [];
  const writes: any[] = [];
  const base = { productId: options.baseProductId ?? 79712643, mainName: "保留原标题" };
  const description = {
    ...(options.missingDescriptionIdentity ? {} : { productId: 79712643 }),
    productDesc: {
      ...(options.missingDescriptionIdentity ? {} : { id: options.descriptionProductId ?? 79712643 }),
      ...(options.descriptionNestedProductId === undefined ? {} : { productId: options.descriptionNestedProductId }),
      productDesc: "保留原图文",
    },
    pmRcmdItems: [{ rcmdDesc: "原推荐", pmRcmdCategoryId: 9 }],
  };
  const page: any = {
    waitForTimeout: async () => {},
    goto: async () => { throw new Error("不应导航或提交审核"); },
    evaluate: async (_fn: unknown, request: any) => {
      const endpoint = request.endpoint.split("/").pop();
      calls.push(endpoint);
      let payload: any;
      if (endpoint === "getSubMenu.json") {
        const enabledCount = step === -80 ? 2 : step === -70 ? 3 : step === -60 ? 4 : 10;
        payload = unlockedMenus(); payload.maxStep = reportedMaxStep;
        payload.menus = payload.menus.map((m: any, index: number) => ({ ...m, enabled: index < enabledCount ? "T" : "F" }));
        options.mutateMenus?.(payload.menus);
      } else if (endpoint === "getProductBaseInfo") {
        payload = { baseInfo: base, nameAreas: [], bookingControls: { minPersonQuantity: 1, maxPersonQuantity: 10 }, meta: { saveStep: options.remoteStep ?? step } };
      } else if (endpoint === "getdescriptionInfo") {
        const sequence = options.descriptionInfoProductIds;
        const sequenceValue = sequence?.[Math.min(descriptionReads, sequence.length - 1)];
        descriptionReads += 1;
        payload = { info: options.incomplete ? {} : {
          ...description,
          ...(sequence ? { productId: sequenceValue } : {}),
        } };
      }
      else if (endpoint === "inSwitch") payload = { switched: options.review ?? true };
      else {
        if (options.sessionInvalidOnceFor === endpoint && sessionInvalidAttempts++ === 0) {
          return { status: 200, payload: { ResponseStatus: { Ack: "Warning", Errors: [{ Message: "当前用户未登录" }] } }, durationMs: 1, ctx: {} };
        }
        writes.push({ endpoint, body: request.body }); payload = {};
        if (!options.stuck && endpoint === "saveProductBaseInfo") {
          step = options.afterBaseStep ?? -70;
          reportedMaxStep = options.afterBaseMaxStep ?? step;
        }
        if (!options.stuck && endpoint === "savedescriptioninfo") {
          step = options.afterDescriptionStep ?? 0;
          reportedMaxStep = options.afterDescriptionMaxStep ?? step;
        }
      }
      return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...payload }, durationMs: 1, ctx: {} };
    },
  };
  return { page, calls, writes, base, description };
}

test("单阶段基本信息下一步只解锁图文，且不导航、不点击或审核", async () => {
  const f = fixture(-80);
  const result = await advanceSavedProductWizardStage(f.page, "79712643", "basicInfo");
  assert.equal(result.advanced, true);
  assert.equal(result.targetStep, "pictureAndText");
  assert.deepEqual(f.writes.map(write => write.endpoint), ["saveProductBaseInfo"]);
  assert.deepEqual(f.calls, ["getSubMenu.json", "getProductBaseInfo", "saveProductBaseInfo", "getSubMenu.json"]);
  assert.equal(f.writes[0].body.meta.saveType, 2);
  assert.equal(f.writes[0].body.bookingControl.isPublicEmergencyContact, "T");
  assert.deepEqual(f.writes[0].body.baseInfo, f.base);
});

test("尾随扩展菜单不影响基本信息的单步向导边界", async () => {
  const f = fixture(-80, { mutateMenus: menus => {
    menus.push({ key: "optionalAddon", title: "optionalAddon", enabled: "T", url: "/ivbk/vendor/optionalAddon?productId=79712643" });
  } });
  const result = await advanceSavedProductWizardStage(f.page, "79712643", "basicInfo");
  assert.equal(result.advanced, true);
  assert.deepEqual(f.writes.map(write => write.endpoint), ["saveProductBaseInfo"]);
});

test("单阶段图文下一步只解锁行程，保留远端图文并使用 saveType=4", async () => {
  const f = fixture(-70, { afterDescriptionStep: -60 });
  const result = await advanceSavedProductWizardStage(f.page, "79712643", "pictureAndText");
  assert.equal(result.advanced, true);
  assert.equal(result.targetStep, "TourDays");
  assert.deepEqual(f.writes.map(write => write.endpoint), ["createProductDraft", "savedescriptioninfo"]);
  assert.equal(f.writes[1].body.dto.saveType, 4);
  assert.deepEqual(f.writes[1].body.dto.pmRcmdItems, f.description.pmRcmdItems);
});

test("单阶段目标已越过时幂等返回，不读取或重写远端保存模型", async () => {
  const f = fixture(-70);
  const result = await advanceSavedProductWizardStage(f.page, "79712643", "basicInfo");
  assert.equal(result.advanced, false);
  assert.equal(result.targetStep, "pictureAndText");
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.calls, ["getSubMenu.json"]);
});

test("单阶段拒绝指定步骤尚未完成、菜单乱序和远端步骤不一致", async () => {
  const locked = fixture(-80);
  await assert.rejects(() => advanceSavedProductWizardStage(locked.page, "79712643", "pictureAndText"), /当前步骤未完成/);
  assert.equal(locked.writes.length, 0);

  const outOfOrder = fixture(-80, { mutateMenus: menus => { menus[3].enabled = "T"; } });
  await assert.rejects(() => advanceSavedProductWizardStage(outOfOrder.page, "79712643", "basicInfo"), /菜单顺序异常/);
  assert.equal(outOfOrder.writes.length, 0);

  const wrongRemoteStep = fixture(-80, { remoteStep: -70 });
  await assert.rejects(() => advanceSavedProductWizardStage(wrongRemoteStep.page, "79712643", "basicInfo"), /保存模型或步骤不完整/);
  assert.equal(wrongRemoteStep.writes.length, 0);
});

test("单阶段拒绝跨产品回读模型，未发送任何官方下一步写入", async () => {
  const foreignBase = fixture(-80, { baseProductId: 123 });
  await assert.rejects(
    () => advanceSavedProductWizardStage(foreignBase.page, "79712643", "basicInfo"),
    /产品身份不一致/,
  );
  assert.equal(foreignBase.writes.length, 0);

  const foreignDescription = fixture(-70, { descriptionProductId: 123 });
  await assert.rejects(
    () => advanceSavedProductWizardStage(foreignDescription.page, "79712643", "pictureAndText"),
    /指向另一产品.*productDesc\.id=123.*未发送图文下一步/,
  );
  assert.equal(foreignDescription.writes.length, 0);

  const noDescriptionIdentity = fixture(-70, { missingDescriptionIdentity: true });
  await assert.rejects(
    () => advanceSavedProductWizardStage(noDescriptionIdentity.page, "79712643", "pictureAndText"),
    /缺少可核验的产品标识.*未发送图文下一步/,
  );
  assert.equal(noDescriptionIdentity.writes.length, 0);
});

test("图文回读容忍空值占位，并在瞬时跨产品标识恢复后安全推进", async () => {
  const placeholder = fixture(-70, { descriptionNestedProductId: 0, afterDescriptionStep: -60 });
  await advanceSavedProductWizardStage(placeholder.page, "79712643", "pictureAndText");
  assert.deepEqual(placeholder.writes.map(write => write.endpoint), ["createProductDraft", "savedescriptioninfo"]);

  const transient = fixture(-70, {
    descriptionInfoProductIds: [123, 79712643],
    afterDescriptionStep: -60,
  });
  await advanceSavedProductWizardStage(transient.page, "79712643", "pictureAndText");
  assert.equal(transient.calls.filter(call => call === "getdescriptionInfo").length, 2);
  assert.deepEqual(transient.writes.map(write => write.endpoint), ["createProductDraft", "savedescriptioninfo"]);
});

test("每笔官方下一步写入前都重新核验当前状态", async () => {
  const basic = fixture(-80);
  await assert.rejects(
    () => advanceSavedProductWizardStage(basic.page, "79712643", "basicInfo", {
      assertCurrent: () => { throw new Error("基本信息授权已失效"); },
    }),
    /授权已失效/,
  );
  assert.equal(basic.writes.length, 0);

  const presentation = fixture(-70, { afterDescriptionStep: -60 });
  let checks = 0;
  await assert.rejects(
    () => advanceSavedProductWizardStage(presentation.page, "79712643", "pictureAndText", {
      assertCurrent: () => {
        checks += 1;
        if (checks === 2) throw new Error("图文授权已失效");
      },
    }),
    /授权已失效/,
  );
  assert.deepEqual(presentation.writes.map(write => write.endpoint), ["createProductDraft"]);
});

test("会话重试前重新核验，授权失效时不发送第二笔下一步请求", async () => {
  const f = fixture(-80, { sessionInvalidOnceFor: "saveProductBaseInfo" });
  let checks = 0;
  await assert.rejects(
    () => advanceSavedProductWizardStage(f.page, "79712643", "basicInfo", {
      assertCurrent: () => {
        checks += 1;
        if (checks === 2) throw new Error("重试前授权已失效");
      },
    }),
    /授权已失效/,
  );
  assert.equal(checks, 2);
  assert.deepEqual(f.calls.filter(call => call === "saveProductBaseInfo"), ["saveProductBaseInfo"]);
  assert.equal(f.writes.length, 0);
});

test("单阶段拒绝卡住或一次越过多个菜单边界，不追加第二次写入", async () => {
  const stuck = fixture(-80, { stuck: true });
  await assert.rejects(() => advanceSavedProductWizardStage(stuck.page, "79712643", "basicInfo"), /推进后菜单未解锁/);
  assert.deepEqual(stuck.writes.map(write => write.endpoint), ["saveProductBaseInfo"]);

  const skipped = fixture(-80, { afterBaseStep: -60 });
  await assert.rejects(() => advanceSavedProductWizardStage(skipped.page, "79712643", "basicInfo"), /推进越过指定菜单边界/);
  assert.deepEqual(skipped.writes.map(write => write.endpoint), ["saveProductBaseInfo"]);

  const malformedMaxStep = fixture(-80, { afterBaseMaxStep: 0 });
  await assert.rejects(
    () => advanceSavedProductWizardStage(malformedMaxStep.page, "79712643", "basicInfo"),
    /官方步骤状态不一致/,
  );
  assert.deepEqual(malformedMaxStep.writes.map(write => write.endpoint), ["saveProductBaseInfo"]);
});

test("官方保存语义只逐步解锁基本和图文，遇到行程即交给独立服务端审核协议", async () => {
  const f = fixture(-80, { afterDescriptionStep: -60 });
  await assert.rejects(
    () => advanceSavedProductWizardWithoutReview(f.page, "79712643"),
    /要求提交审核/,
  );
  assert.deepEqual(f.writes.map(w => w.endpoint), ["saveProductBaseInfo", "createProductDraft", "savedescriptioninfo"]);
  assert.equal(f.writes[0].body.meta.saveType, 2);
  assert.deepEqual(f.writes[0].body.baseInfo, f.base);
  assert.equal(f.writes[2].body.dto.saveType, 4);
  assert.deepEqual(f.writes[2].body.dto.pmRcmdItems, f.description.pmRcmdItems);
  assert.equal(f.writes[1].body.productId, 79712643);
  await assert.rejects(
    () => advanceSavedProductWizardWithoutReview(f.page, "79712643"),
    /要求提交审核/,
  );
  assert.equal(f.writes.length, 3);
});

test("接口成功但菜单不推进不能通过或重复写入", async () => {
  const f = fixture(-80, { stuck: true });
  await assert.rejects(() => advanceSavedProductWizardWithoutReview(f.page, "79712643"), /推进后菜单未解锁/);
  assert.equal(f.writes.length, 1);
});

test("官方行程需要审核时停止，不替换为提交审核并下一步", async () => {
  const f = fixture(-60, { review: true });
  await assert.rejects(() => advanceSavedProductWizardWithoutReview(f.page, "79712643"), /要求提交审核/);
  assert.equal(f.writes.length, 0);
});

test("不因开关回读为 false 而模拟点击行程页面下一步", async () => {
  const f = fixture(-60, { review: false });
  await assert.rejects(
    () => advanceSavedProductWizardWithoutReview(f.page, "79712643"),
    /不会模拟点击页面下一步/,
  );
  assert.equal(f.writes.length, 0);
  assert.equal(f.calls.includes("inSwitch"), false);
});

test("缺图文保存模型时停止且不创建草稿", async () => {
  const f = fixture(-70, { incomplete: true });
  await assert.rejects(() => advanceSavedProductWizardWithoutReview(f.page, "79712643"), /图文保存模型不完整/);
  assert.equal(f.writes.length, 0);
});

test("完成验收拒绝锁定菜单，maxStep 不能单独作为成功证据", async () => {
  await assert.rejects(() => verifyProductMenusUnlocked(fixture(-60).page, "79712643"), /菜单尚未解锁/);
});

test("完成验收拒绝缺失、重复、无权限、无效步骤或状态收据", async () => {
  for (const mutate of [
    (v: any) => { v.menus.pop(); },
    (v: any) => { v.menus.push(v.menus[0]); },
    (v: any) => { v.hasPermission = false; },
    (v: any) => { delete v.maxStep; },
    (v: any) => { v.menus[3].enabled = undefined; },
    (v: any) => { v.menus.reverse(); },
    (v: any) => { v.menus[0].url = "https://example.invalid/?productId=79712643"; },
  ]) {
    const payload = unlockedMenus(); mutate(payload);
    const page: any = { evaluate: async () => ({ status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...payload }, durationMs: 1, ctx: {} }) };
    await assert.rejects(() => verifyProductMenusUnlocked(page, "79712643"), /菜单回读/);
  }
});
