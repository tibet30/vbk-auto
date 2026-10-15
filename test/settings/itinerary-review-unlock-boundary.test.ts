import assert from "node:assert/strict";
import test from "node:test";
import type { ItineraryReviewMenu, ItineraryReviewUnlockState } from "../../src/shared/itinerary-review-unlock";
import { PRODUCT_MENU_KEYS } from "../../src/main/automation/ctrip/product-menu-readback";
import {
  ITINERARY_REVIEW_IDLE_NOTE,
  ITINERARY_REVIEW_UNLOCKED_MENU_COUNT,
  describeItineraryReviewBoundary,
} from "../../src/renderer/app/views/workspace/vbk/itinerary-review-unlock-boundary";

const menu = (title: string, enabled: "T" | "F"): ItineraryReviewMenu =>
  ({ key: title, title, url: "https://vbooking.ctrip.com/ivbk/vendor/menu", enabled });

/** 平台产品向导的固定 10 项菜单，与 PRODUCT_MENU_KEYS 一一对应。 */
const MENU_TITLES_BY_KEY: Record<(typeof PRODUCT_MENU_KEYS)[number], string> = {
  saleControl: "销售控制",
  basicInfo: "产品信息",
  pictureAndText: "产品图文",
  TourDays: "行程描述",
  combomanage: "套餐管理",
  inventory: "价格库存班期",
  travelOptionNew: "资源配置",
  newResourceClause: "条款维护",
  trafficLineEdit: "线路及交通规划",
  advancedSettings: "高级设置",
};
const MENU_TITLES = PRODUCT_MENU_KEYS.map(key => MENU_TITLES_BY_KEY[key]);
const CORE_TITLES = MENU_TITLES.slice(0, ITINERARY_REVIEW_UNLOCKED_MENU_COUNT);
const LATER_TITLES = MENU_TITLES.slice(ITINERARY_REVIEW_UNLOCKED_MENU_COUNT);

function base(overrides: Partial<ItineraryReviewUnlockState>): ItineraryReviewUnlockState {
  return {
    localProductId: "local", status: "requires_review", attemptId: "", productId: "1", accountKey: "a",
    tourInfoId: "t", beforeDigest: "d", updatedAt: "2026-01-01T00:00:00.000Z", ...overrides,
  };
}

function withReceipt(menus: ItineraryReviewMenu[]): ItineraryReviewUnlockState {
  return base({
    status: "verified",
    receipt: {
      verified: true, productId: "1", tourInfoId: "t",
      contentDigest: "d".repeat(64), beforeDigest: "d".repeat(64), afterDigest: "d".repeat(64),
      routeId: 1, maxStep: 10, menus,
      publication: { active: "F" as const, isonline: "F" as const, releaseActive: "F" as const },
      trafficChildren: 0 as const, checkedAt: "2026-01-01T00:00:00.000Z",
      tabs: menus.filter(item => item.enabled === "T")
        .map(item => ({ key: item.key, title: item.title, url: item.url, verified: true as const })),
      requestSteps: [],
    },
  });
}

test("无核查结果时只输出静态授权说明，不要求核查入口", () => {
  for (const input of [null, undefined]) {
    assert.deepEqual(describeItineraryReviewBoundary(input), {
      tone: "idle", note: ITINERARY_REVIEW_IDLE_NOTE, needsAttention: false,
    });
  }
});

test("行程审核已完成时说明覆盖范围，且不占用核查入口", () => {
  // 边界规则必须与主进程 menu-readback 的「前 5 项可用」一致。
  assert.equal(ITINERARY_REVIEW_UNLOCKED_MENU_COUNT, 5);
  const boundary = describeItineraryReviewBoundary(withReceipt([...CORE_TITLES, ...LATER_TITLES].map(title => menu(title, "T"))));
  assert.equal(boundary.tone, "verified");
  assert.equal(boundary.needsAttention, false);
  assert.match(boundary.note, new RegExp(`已解锁 ${MENU_TITLES.length}/${MENU_TITLES.length} 个页签`));
  assert.match(boundary.note, /销售控制 → 套餐管理/);
  assert.doesNotMatch(boundary.note, /待解锁/);
});

test("行程审核后仍有锁定页签时列出待解锁项，不把它们算进已解锁", () => {
  const boundary = describeItineraryReviewBoundary(withReceipt([
    ...CORE_TITLES.map(title => menu(title, "T")), ...LATER_TITLES.map(title => menu(title, "F")),
  ]));
  assert.equal(boundary.needsAttention, false);
  assert.match(boundary.note, new RegExp(`已解锁 ${CORE_TITLES.length}/${MENU_TITLES.length} 个页签`));
  assert.match(boundary.note, new RegExp(`待解锁 ${LATER_TITLES.join("、")}`));
});

test("缺少回读收据时不编造页签数量，只说明解锁范围已覆盖", () => {
  const boundary = describeItineraryReviewBoundary(base({ status: "verified" }));
  assert.match(boundary.note, /销售控制 → 套餐管理 及前置页签均已解锁/);
  assert.doesNotMatch(boundary.note, /\d+\/9/);
});

test("停在审核边界时说明将解锁的页签数，且不需要核查入口", () => {
  const boundary = describeItineraryReviewBoundary(base({ status: "requires_review" }));
  assert.equal(boundary.tone, "idle");
  assert.equal(boundary.needsAttention, false);
  assert.match(boundary.note, new RegExp(`${ITINERARY_REVIEW_UNLOCKED_MENU_COUNT} 个页签`));
});

test("提交中与结果不确定属于待核验态，需要只读核查入口", () => {
  const dispatched = describeItineraryReviewBoundary(base({ status: "dispatched" }));
  assert.equal(dispatched.tone, "attention");
  assert.equal(dispatched.needsAttention, true);
  const uncertain = describeItineraryReviewBoundary(base({ status: "uncertain", message: "上次结果未确认，只能只读核查" }));
  assert.equal(uncertain.tone, "attention");
  assert.equal(uncertain.needsAttention, true);
  assert.equal(uncertain.note, "上次结果未确认，只能只读核查");
});

test("审核失败与摘要不一致都按错误态给出核查入口", () => {
  const failed = describeItineraryReviewBoundary(base({ status: "failed", message: "自动审核尚未完成" }));
  assert.equal(failed.tone, "error");
  assert.equal(failed.needsAttention, true);
  assert.equal(failed.note, "自动审核尚未完成");

  const mismatched: ItineraryReviewUnlockState = {
    ...withReceipt(CORE_TITLES.map(title => menu(title, "T"))),
    message: "审核校验响应未被确认",
    digestMismatch: { step: "审核校验", beforeDigest: "a".repeat(64), afterDigest: "b".repeat(64), paths: ["$.tourInfoId"] },
  };
  const boundary = describeItineraryReviewBoundary(mismatched);
  assert.equal(boundary.tone, "error");
  assert.equal(boundary.needsAttention, true);
  assert.equal(boundary.note, "审核校验响应未被确认");
});
