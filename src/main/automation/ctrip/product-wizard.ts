import type { Page } from "playwright";
import { getProductBaseInfoApi } from "./basic-info/read-base.js";
import { postTrafficLineSoa, type TrafficLinePage } from "./traffic-line/client.js";
import { productMenuCore, readProductMenus, verifyProductMenusUnlocked, type ProductMenu } from "./product-menu-readback.js";

export type SavedProductWizardStage = "basicInfo" | "pictureAndText";

export interface SavedProductWizardStageOptions {
  /** Revalidate the current phase authorization immediately before each write. */
  assertCurrent?: () => Promise<void> | void;
}

type SavedStagePage = TrafficLinePage & Pick<Page, "waitForTimeout">;

const SAVED_STAGE_BOUNDARIES: Record<SavedProductWizardStage, {
  currentIndex: number;
  targetIndex: number;
  expectedSaveStep: number;
  targetMaxStep: number;
}> = {
  basicInfo: { currentIndex: 1, targetIndex: 2, expectedSaveStep: -80, targetMaxStep: -70 },
  pictureAndText: { currentIndex: 2, targetIndex: 3, expectedSaveStep: -70, targetMaxStep: -60 },
};

function assertContiguousMenuOrder(menus: ProductMenu[]) {
  let locked = false;
  for (const menu of menus) {
    if (menu.enabled === "F") locked = true;
    else if (locked) throw new Error(`VBK 向导菜单顺序异常：${menu.title || menu.key} 在已锁定菜单之后被解锁`);
  }
}

function stageState(menus: ProductMenu[], completedStep: SavedProductWizardStage) {
  const coreMenus = productMenuCore(menus);
  assertContiguousMenuOrder(coreMenus);
  const boundary = SAVED_STAGE_BOUNDARIES[completedStep];
  const current = coreMenus[boundary.currentIndex];
  const target = coreMenus[boundary.targetIndex];
  if (!current || !target || current.enabled !== "T") {
    throw new Error(`VBK 向导当前步骤未完成或已锁定：${completedStep}`);
  }
  return { boundary, target, passed: target.enabled === "T" };
}

function sameProductId(value: unknown, productId: string): boolean {
  const expected = Number(productId);
  const actual = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isSafeInteger(expected) && expected > 0 && actual === expected;
}

function positiveProductId(value: unknown): number | null {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function assertBaseInfoIdentity(baseInfo: unknown, productId: string): asserts baseInfo is Record<string, unknown> {
  if (!baseInfo || typeof baseInfo !== "object" || !sameProductId((baseInfo as Record<string, unknown>).productId, productId)) {
    throw new Error("VBK 基本信息向导回读产品身份不一致，停止推进");
  }
}

function assertDescriptionIdentity(info: unknown, productId: string): asserts info is Record<string, unknown> {
  if (!info || typeof info !== "object") throw new Error("VBK 图文保存模型不完整，停止推进");
  const description = (info as Record<string, unknown>).productDesc;
  const fields = [
    ["info.productId", (info as Record<string, unknown>).productId],
    ["productDesc.productId", description && typeof description === "object"
      ? (description as Record<string, unknown>).productId : undefined],
    ["productDesc.id", description && typeof description === "object"
      ? (description as Record<string, unknown>).id : undefined],
  ] as const;
  const identities = fields.flatMap(([field, value]) => {
    const id = positiveProductId(value);
    return id === null ? [] : [{ field, id }];
  });
  if (!identities.length) {
    throw new Error(`VBK 图文回读缺少可核验的产品标识（当前产品 ${productId}），已安全暂停；未发送图文下一步。`);
  }
  const conflicts = identities.filter(({ id }) => !sameProductId(id, productId));
  if (conflicts.length) {
    const evidence = conflicts.map(({ field, id }) => `${field}=${id}`).join("、");
    throw new Error(`VBK 图文回读指向另一产品（当前产品 ${productId}；${evidence}），已安全暂停；未发送图文下一步。`);
  }
}

async function readVerifiedDescription(page: SavedStagePage, productId: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const description = await postTrafficLineSoa(page, "15638", "getdescriptionInfo",
      { productId: Number(productId) }, "VBK 已保存图文回读");
    const info = description.info as Record<string, unknown> | undefined;
    try {
      if (!info?.productDesc || !Array.isArray(info.pmRcmdItems)) {
        throw new Error("VBK 图文保存模型不完整，已安全暂停；未发送图文下一步。");
      }
      assertDescriptionIdentity(info, productId);
      return info;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await page.waitForTimeout(attempt * 250);
    }
  }
  throw lastError;
}

async function saveCompletedStage(
  page: SavedStagePage,
  productId: string,
  completedStep: SavedProductWizardStage,
  options: SavedProductWizardStageOptions,
) {
  const remote = await getProductBaseInfoApi(page, productId);
  const expectedSaveStep = SAVED_STAGE_BOUNDARIES[completedStep].expectedSaveStep;
  if (remote.meta?.saveStep !== expectedSaveStep) {
    throw new Error(`VBK ${completedStep} 向导保存模型或步骤不完整，停止推进`);
  }
  if (completedStep === "basicInfo") {
    const booking = remote.bookingControls ?? remote.bookingControl;
    if (!remote.baseInfo || !booking || !Array.isArray(remote.nameAreas)) {
      throw new Error("VBK 基本信息向导保存模型或步骤不完整，停止推进");
    }
    assertBaseInfoIdentity(remote.baseInfo, productId);
    await postTrafficLineSoa(page, "15638", "saveProductBaseInfo", {
      baseInfo: remote.baseInfo,
      bookingControl: { ...booking, personQuantity: {
        minPersonQuantity: booking.minPersonQuantity, maxPersonQuantity: booking.maxPersonQuantity,
      } },
      nameAreaRules: remote.nameAreas,
      meta: { ...remote.meta, saveType: 2, resizeTourDailyInfo: "F", clauseTabEnabled: "F" },
      advancedSettings: remote.advancedSettings, scenicSpots: remote.scenicSpots ?? [],
      resourceFields: remote.resourceFields ?? {},
    }, "VBK 已保存基本信息下一步", { beforeAttempt: options.assertCurrent });
    return;
  }
  const info = await readVerifiedDescription(page, productId);
  assertBaseInfoIdentity(remote.baseInfo, productId);
  await postTrafficLineSoa(page, "20698", "createProductDraft",
    { productId: Number(productId), module: "desc" }, "VBK 现有产品图文草稿准备", { beforeAttempt: options.assertCurrent });
  await postTrafficLineSoa(page, "15638", "savedescriptioninfo",
    { dto: { ...info, productId: Number(productId), saveType: 4 } }, "VBK 已保存图文下一步", { beforeAttempt: options.assertCurrent });
}

function assertSingleBoundaryAdvance(
  before: Awaited<ReturnType<typeof readProductMenus>>,
  after: Awaited<ReturnType<typeof readProductMenus>>,
  completedStep: SavedProductWizardStage,
) {
  const { boundary, target, passed } = stageState(after.menus, completedStep);
  if (!passed) {
    throw new Error(`VBK 向导推进后菜单未解锁：${target.title || target.key}`);
  }
  const beforeCore = productMenuCore(before.menus);
  const afterCore = productMenuCore(after.menus);
  const changed = afterCore.flatMap((menu, index) => menu.enabled === beforeCore[index]?.enabled ? [] : [index]);
  if (changed.length !== 1 || changed[0] !== boundary.targetIndex) {
    throw new Error(`VBK 向导推进越过指定菜单边界：${target.title || target.key}`);
  }
  if (after.maxStep !== boundary.targetMaxStep) {
    throw new Error(`VBK 向导推进后官方步骤状态不一致：${target.title || target.key}`);
  }
}

/**
 * Advances exactly one already-saved menu boundary through its official save API.
 * It deliberately cannot navigate, click a page button, enter itinerary, or submit review.
 */
export async function advanceSavedProductWizardStage(
  page: SavedStagePage,
  productId: string,
  completedStep: SavedProductWizardStage,
  options: SavedProductWizardStageOptions = {},
) {
  const before = await readProductMenus(page, productId);
  const initial = stageState(before.menus, completedStep);
  if (initial.passed) {
    return { ...before, completedStep, targetStep: initial.target.key, advanced: false as const };
  }
  await saveCompletedStage(page, productId, completedStep, options);
  for (let poll = 0; poll <= 10; poll += 1) {
    const after = await readProductMenus(page, productId);
    const current = stageState(after.menus, completedStep);
    if (current.passed) {
      assertSingleBoundaryAdvance(before, after, completedStep);
      return { ...after, completedStep, targetStep: current.target.key, advanced: true as const };
    }
    if (poll < 10) await page.waitForTimeout(500);
  }
  throw new Error(`VBK 向导推进后菜单未解锁：${initial.target.title || initial.target.key}`);
}

/** Only official next-step saves; never substitutes review/submission for next. */
export async function advanceSavedProductWizardWithoutReview(
  page: SavedStagePage,
  productId: string,
  options: SavedProductWizardStageOptions = {},
) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const before = await readProductMenus(page, productId);
    const coreMenus = productMenuCore(before.menus);
    if (coreMenus.every(menu => menu.enabled === "T")) return verifyProductMenusUnlocked(page, productId);
    const firstLocked = coreMenus.findIndex(menu => menu.enabled === "F");
    const current = coreMenus[firstLocked - 1];
    if (!current || current.enabled !== "T") throw new Error("VBK 向导菜单顺序异常，停止推进");
    if (current.key === "basicInfo") {
      await advanceSavedProductWizardStage(page, productId, "basicInfo", options);
    } else if (current.key === "pictureAndText") {
      await advanceSavedProductWizardStage(page, productId, "pictureAndText", options);
    } else {
      throw new Error(`VBK 向导在「${current.title}」要求提交审核服务端协议；本恢复器不会模拟点击页面下一步`);
    }
  }
  throw new Error("VBK 向导超过推进上限，停止且不提交审核");
}
