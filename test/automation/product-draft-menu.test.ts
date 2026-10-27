import assert from "node:assert/strict";
import test from "node:test";
import {
  isItineraryReviewCompletedMenus,
  PRODUCT_MENU_KEYS,
  productWizardRecoveryPhase,
  readProductMenus,
  verifyProductDraftMenus,
  verifyProductMenusUnlocked,
} from "../../src/main/automation/ctrip/product-menu-readback.ts";
import { unlockedMenus, unlockedMenusWithExtensions } from "./product-menu-fixture.ts";

const productId = "79712643";
const success = (payload: Record<string, unknown>) => ({
  status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...payload }, durationMs: 1, ctx: {},
});

function pageFor(
  mutate: (menus: ReturnType<typeof unlockedMenus>) => void = () => {},
  switched: unknown = true,
  requests: string[] = [],
) {
  return { evaluate: async (_fn: unknown, request: any) => {
    const endpoint = String(request.endpoint);
    requests.push(endpoint);
    if (endpoint.endsWith("/getSubMenu.json")) {
      const menus = unlockedMenus(productId); menus.maxStep = -60;
      menus.menus.forEach((menu, index) => { menu.enabled = index < 4 ? "T" : "F"; });
      mutate(menus);
      return success(menus);
    }
    if (endpoint.endsWith("/inSwitch")) return success({ switched });
    throw new Error(`unexpected endpoint ${endpoint}`);
  } };
}

function menuEvidence(maxStep: number, unlockedCount: number) {
  const evidence = unlockedMenus(productId);
  evidence.maxStep = maxStep;
  evidence.menus.forEach((menu, index) => { menu.enabled = index < unlockedCount ? "T" : "F"; });
  return evidence;
}

function context(overrides: Partial<{ tourInfo: Record<string, unknown>; verifiedTourInfoId: string }> = {}) {
  return {
    base: {},
    tourInfo: { tourInfoId: "1001", auditStatus: { key: "A", value: "审核通过" }, ...overrides.tourInfo },
    verifiedTourInfoId: overrides.verifiedTourInfoId ?? "1001",
  };
}

test("草稿菜单边界接受审核通过、缺省 isCruise 的官方行程", async () => {
  const result = await verifyProductDraftMenus(pageFor(), productId, context());
  assert.equal(result.fullyUnlocked, false);
  assert.equal(result.advancementRequiresReview, true);
  assert.equal(result.savedItineraryTourInfoId, "1001");
  assert.deepEqual(result.auditStatus, { key: "A", value: "审核通过" });
});

test("草稿菜单边界拒绝 basic 到图文的 -80，即使已保存行程关联", async () => {
  const requests: string[] = [];
  await assert.rejects(() => verifyProductDraftMenus(pageFor(menus => {
    menus.maxStep = -80;
    menus.menus.forEach((menu, index) => { menu.enabled = index < 2 ? "T" : "F"; });
  }, true, requests), productId, context()), /VBK 菜单尚未解锁/);
  assert.equal(requests.some(endpoint => endpoint.endsWith("/inSwitch")), false);
});

test("产品向导恢复阶段只接受连续的官方菜单形态", () => {
  assert.equal(productWizardRecoveryPhase(menuEvidence(-80, 2)), "basic");
  assert.equal(productWizardRecoveryPhase(menuEvidence(-70, 3)), "presentation");
  assert.equal(productWizardRecoveryPhase(menuEvidence(-60, 4)), "itinerary");
  assert.equal(productWizardRecoveryPhase(unlockedMenus(productId)), undefined);

  const nonContiguous = menuEvidence(-60, 4);
  nonContiguous.menus[2].enabled = "F";
  nonContiguous.menus[4].enabled = "T";
  assert.equal(productWizardRecoveryPhase(nonContiguous), undefined);

  const wrongOrder = menuEvidence(-80, 2);
  wrongOrder.menus[0].key = "pictureAndText";
  assert.equal(productWizardRecoveryPhase(wrongOrder), undefined);
});

test("行程审核成功只需连续解锁到套餐管理，后续菜单由各模块逐步推进", async () => {
  const postReview = menuEvidence(10, 5);
  assert.equal(isItineraryReviewCompletedMenus(postReview), true);
  assert.equal(isItineraryReviewCompletedMenus(menuEvidence(10, 4)), false);
  assert.equal(isItineraryReviewCompletedMenus(menuEvidence(10, 7)), true);
  const broken = menuEvidence(10, 5);
  broken.menus[6].enabled = "T";
  assert.equal(isItineraryReviewCompletedMenus(broken), false);

  const result = await verifyProductDraftMenus(pageFor(menus => {
    menus.maxStep = 10;
    menus.menus.forEach((menu, index) => { menu.enabled = index < 5 ? "T" : "F"; });
  }), productId, context({ tourInfo: { draftTourInfoStatus: 2 } }));
  assert.equal(result.reviewCompleted, true);
  assert.equal(result.fullyUnlocked, false);
  assert.equal(result.advancementRequiresReview, false);
  assert.deepEqual(result.lockedMenus, PRODUCT_MENU_KEYS.slice(5));
});

test("菜单回读接受核心十项后附带的扩展菜单，恢复仍只按核心边界判断", async () => {
  const extended = unlockedMenusWithExtensions(productId);
  const page: any = { evaluate: async () => success(extended) };
  const result = await verifyProductMenusUnlocked(page, productId);
  assert.equal(result.fullyUnlocked, true);

  extended.maxStep = -80;
  extended.menus.forEach((menu, index) => {
    menu.enabled = index < 2 || index >= 10 ? "T" : "F";
  });
  assert.equal(productWizardRecoveryPhase(extended), "basic");
});

test("尾随扩展菜单未解锁时不能作为完整菜单通过", async () => {
  const extended = unlockedMenusWithExtensions(productId);
  extended.menus[10].enabled = "F";
  const page: any = { evaluate: async () => success(extended) };
  await assert.rejects(() => verifyProductMenusUnlocked(page, productId), /菜单尚未解锁/);
});

test("全部菜单已解锁但 maxStep 未完成时不能作为完成证据", async () => {
  const extended = unlockedMenusWithExtensions(productId);
  extended.maxStep = -80;
  const page: any = { evaluate: async () => success(extended) };
  await assert.rejects(() => verifyProductMenusUnlocked(page, productId), /maxStep=-80/);
});

test("尾随的当前产品菜单未解锁时不能进入行程审核", async () => {
  const requests: string[] = [];
  await assert.rejects(() => verifyProductDraftMenus(pageFor(menus => {
    menus.menus.push({ key: "optionalAddon", title: "扩展设置", enabled: "F",
      url: `/ivbk/vendor/optionalAddon?productId=${productId}` });
  }, true, requests), productId, context()), /extensionUnlocked/);
  assert.equal(requests.some(endpoint => endpoint.endsWith("/inSwitch")), false);
});

test("未绑定产品的尾随菜单不阻断核心回读，但不能作为完成依据", async () => {
  const extended = unlockedMenusWithExtensions(productId);
  extended.menus[10].url = "/ivbk/vendor/help";
  const page: any = { evaluate: async () => success(extended) };
  const result = await readProductMenus(page, productId);
  assert.equal(result.unscopedExtensionMenus.length, 1);
  assert.equal(result.fullyUnlocked, false);
  await assert.rejects(() => verifyProductMenusUnlocked(page, productId), /菜单尚未解锁/);
});

test("菜单回读即使有扩展菜单也拒绝核心菜单键或顺序变化", async () => {
  for (const mutate of [
    (menus: ReturnType<typeof unlockedMenusWithExtensions>["menus"]) => { menus[0].key = "basicInfo"; },
    (menus: ReturnType<typeof unlockedMenusWithExtensions>["menus"]) => {
      [menus[0], menus[1]] = [menus[1], menus[0]];
    },
  ]) {
    const extended = unlockedMenusWithExtensions(productId);
    mutate(extended.menus);
    const page: any = { evaluate: async () => success(extended) };
    await assert.rejects(() => verifyProductMenusUnlocked(page, productId), /菜单回读/);
  }
});

test("菜单只读接口首轮返回瞬时缺项时有界重读并保留严格顺序校验", async () => {
  let reads = 0;
  const page: any = { evaluate: async () => {
    reads += 1;
    const result = unlockedMenus(productId);
    if (reads === 1) result.menus.splice(4, 1);
    return success(result);
  } };
  const recovered = await readProductMenus(page, productId);
  assert.equal(recovered.fullyUnlocked, true);
  assert.equal(reads, 2);

  reads = 0;
  const invalid: any = { evaluate: async () => {
    reads += 1;
    const result = unlockedMenus(productId); result.menus[4].key = "wrong";
    return success(result);
  } };
  await assert.rejects(() => readProductMenus(invalid, productId), /combomanage.*keys=/);
  assert.equal(reads, 3);
});

test("草稿菜单边界拒绝不完整或不匹配的审核证据", async () => {
  const cases: Array<[string, any, any?, unknown?]> = [
    ["未知审核状态", context({ tourInfo: { tourInfoId: "1001", auditStatus: { key: "P", value: "处理中" } } })],
    ["关联 ID 不匹配", context({ verifiedTourInfoId: "2002" })],
    ["非审核步骤", context(), menus => { menus.maxStep = -70; }],
    ["额外菜单锁定", context(), menus => { menus.menus[2].enabled = "F"; }],
    ["错误产品 URL", context(), menus => { menus.menus[0].url = "/menu?productId=79712644"; }],
  ];
  for (const [name, evidence, mutate, switched] of cases) {
    await assert.rejects(() => verifyProductDraftMenus(pageFor(mutate, switched), productId, evidence), /VBK 菜单/, name);
  }
});

test("草稿菜单边界只接受明确开启的官方审核推进开关", async () => {
  for (const switched of [false, null, "true"]) {
    await assert.rejects(() => verifyProductDraftMenus(pageFor(undefined, switched), productId, context()), /VBK 菜单尚未解锁/);
  }
});

test("自由行的推荐玩法菜单归一为 TourDays，不破坏向导边界", async () => {
  const menus = unlockedMenus(productId);
  menus.maxStep = -80;
  menus.menus.forEach((menu, index) => { menu.enabled = index < 2 ? "T" : "F"; });
  const index = menus.menus.findIndex(menu => menu.key === "TourDays");
  menus.menus[index] = { ...menus.menus[index]!, key: "dailyRecommendTour", title: "推荐玩法",
    url: `/ivbk/vendor/tourdays?productid=${productId}&from=vbk` };
  const page = { evaluate: async (_fn: unknown, _request: unknown) => success(menus) };
  const read = await readProductMenus(page as any, productId);
  assert.equal(read.menus[index]!.key, "TourDays");
  assert.equal(productWizardRecoveryPhase(read), "basic");
});

test("自由行图文保存同时解锁推荐玩法与套餐管理，边界仍必须包含推荐玩法", async () => {
  const { assertSingleBoundaryAdvance } = await import("../../src/main/automation/ctrip/product-wizard.js");
  const menus = (unlocked: number[], steps: number) => {
    const rows = PRODUCT_MENU_KEYS.map((key, index) => ({ key, title: key,
      enabled: (unlocked.includes(index) ? "T" : "F") as "T" | "F",
      url: `/ivbk/vendor/${key}?productId=${productId}` }));
    return { maxStep: steps, menus: rows } as any;
  };
  const before = menus([0, 1, 2], -70);
  const after = menus([0, 1, 2, 3, 4], 10);
  assert.doesNotThrow(() => assertSingleBoundaryAdvance(before, after, "pictureAndText", { allowAdditionalUnlock: true }));
  assert.throws(() => assertSingleBoundaryAdvance(before, after, "pictureAndText"),
    /越过指定菜单边界/);
  const skipped = menus([0, 1, 2, 4], 10);
  assert.throws(() => assertSingleBoundaryAdvance(before, skipped, "pictureAndText", { allowAdditionalUnlock: true }),
    /菜单顺序异常|越过指定菜单边界/);
});

test("自由行行程审核不要求 routeId，私家团仍要求线路身份", async () => {
  const { reviewReadbackSatisfied } = await import("../../src/main/automation/ctrip/itinerary-review/unlock.js");
  assert.equal(reviewReadbackSatisfied("freeTravel", 0, "N"), true);
  assert.equal(reviewReadbackSatisfied("privateTour", 0, "N"), false);
  assert.equal(reviewReadbackSatisfied("privateTour", 558, "A"), true);
  assert.equal(reviewReadbackSatisfied("freeTravel", 558, "X"), false);
});
