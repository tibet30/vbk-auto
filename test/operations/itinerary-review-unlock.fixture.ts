import assert from "node:assert/strict";
import { ItineraryReviewUnlock } from "../../src/main/operations/itinerary-review-unlock.js";
import { PRODUCT_MENU_KEYS } from "../../src/main/automation/ctrip/product-menu-readback.js";
import type { ItineraryReviewEvidence } from "../../src/main/operations/itinerary-review-unlock-support.js";
import type {
  ItineraryReviewStepReceipt,
  ItineraryReviewUnlockReceipt,
  ItineraryReviewUnlockState,
} from "../../src/shared/itinerary-review-unlock.js";

export const lockedMenus = PRODUCT_MENU_KEYS.map((key, index) => ({
  key,
  title: `菜单${index}`,
  enabled: (index < 4 ? "T" : "F") as "T" | "F",
}));
export const unlockedMenus = lockedMenus.map(menu => ({ ...menu, enabled: "T" as const }));
export const postReviewMenus = lockedMenus.map((menu, index) => ({
  ...menu, enabled: (index < 5 ? "T" : "F") as "T" | "F",
}));

function receipt(digest = "a".repeat(64)): ItineraryReviewUnlockReceipt {
  return {
    verified: true,
    productId: "100",
    tourInfoId: "420000000000000001",
    contentDigest: digest,
    beforeDigest: "a".repeat(64),
    afterDigest: digest,
    routeId: 40004141,
    maxStep: 10,
    menus: postReviewMenus.map(menu => ({ ...menu, url: `https://vbooking.ctrip.com/${menu.key}?productId=100` })),
    publication: { active: "F", isonline: "F", releaseActive: "F" },
    trafficChildren: 0,
    checkedAt: "2026-10-14T00:00:00.000Z",
    tabs: postReviewMenus.filter(menu => menu.enabled === "T")
      .map(menu => ({ key: menu.key, title: menu.title, url: `/${menu.key}`, verified: true })),
    requestSteps: [],
  };
}

export function setup() {
  let now = Date.parse("2026-10-14T00:00:00.000Z");
  let account = "vbk-a";
  let product: any = {
    id: "local", name: "测试产品", productId: "100", vbkAccount: "vbk-a",
    productJsonVersion: 3, product: { itinerary: [{ day: 1, title: "原行程" }] }, status: "draft_saved",
  };
  let evidence: ItineraryReviewEvidence = {
    productId: "100", tourInfoId: "420000000000000001", contentDigest: "a".repeat(64),
    relation: { productId: 100, tourInfoId: "420000000000000001", draftTourInfoId: "420000000000000002",
      auditTourInfoId: "420000000000000001", draftTourInfoStatus: 1, auditStatus: { key: "A", value: "审核通过" } },
    maxStep: -60, fullyUnlocked: false, menus: structuredClone(lockedMenus),
  };
  let persisted: ItineraryReviewUnlockState | undefined;
  let submitMode: "success" | "uncertain" | "digest-mismatch" | "account-change" = "success";
  let submitCalls = 0;
  let writes = 0;
  let preflightCalls = 0;
  let verifyPlanCalls = 0;
  let afterRead: (() => void) | undefined;
  let afterVerifyPlan: (() => void) | undefined;
  let preflightError: Error | undefined;
  let verifyPlanError: Error | undefined;
  let digestMismatchPaths = ["$.tourDailyDescriptions[0]"];
  let failNextSave = false;
  let failRecord = false;
  const steps: ItineraryReviewStepReceipt[] = [{
    step: "check8", endpoint: "/checkTourDaily", saveType: 8, ack: "Success", at: "now",
  }];
  const protocol = {
    read: async () => { const result = structuredClone(evidence); afterRead?.(); return result; },
    submit: async (_page: any, _before: any, options: any) => {
      submitCalls += 1;
      writes += 1;
      options.assertCurrent?.();
      if (submitMode === "digest-mismatch") throw Object.assign(new Error("审核校验改写了已保存行程内容"), { digestMismatch: {
        step: "审核校验", beforeDigest: "a".repeat(64), afterDigest: "b".repeat(64), paths: digestMismatchPaths,
      } });
      options.onStep?.(steps[0]);
      if (submitMode === "account-change") {
        account = "vbk-b";
        options.assertCurrent?.();
      }
      if (submitMode === "uncertain") throw new Error("timeout after write");
      evidence = { ...evidence, maxStep: 10, fullyUnlocked: false, menus: structuredClone(postReviewMenus) };
    },
    verify: async (_page: any, _id: string, expected?: string) => {
      assert.equal(evidence.maxStep, 10);
      const value = receipt(evidence.contentDigest);
      value.beforeDigest = expected ?? evidence.contentDigest;
      value.requestSteps = structuredClone(steps);
      return value;
    },
  };
  const deps: any = {
    getProduct: () => structuredClone(product), accountKey: () => account,
    assertIdle: () => {}, withLocks: async (_id: string, work: () => Promise<any>) => work(),
    getPage: async () => ({}), now: () => now, protocol,
    preflight: async () => {
      preflightCalls += 1;
      if (preflightError) throw preflightError;
      return {};
    },
    verifyPlan: async () => {
      verifyPlanCalls += 1;
      if (verifyPlanError) throw verifyPlanError;
      const result = { tourInfoId: evidence.tourInfoId, days: 1, contentDigest: evidence.contentDigest };
      afterVerifyPlan?.();
      return result;
    },
    stateStore: {
      get: () => structuredClone(persisted),
      save: (state: ItineraryReviewUnlockState) => {
        if (failNextSave) { failNextSave = false; throw new Error("disk full"); }
        persisted = structuredClone(state);
      },
    },
    record: () => { if (failRecord) throw new Error("log failed"); },
  };
  return {
    service: () => new ItineraryReviewUnlock(deps),
    get persisted() { return persisted; },
    get submitCalls() { return submitCalls; },
    get writes() { return writes; },
    get preflightCalls() { return preflightCalls; },
    get verifyPlanCalls() { return verifyPlanCalls; },
    set account(value: string) { account = value; },
    set evidence(value: any) { evidence = value; },
    get evidence() { return evidence; },
    set product(value: any) { product = value; },
    get product() { return product; },
    set submitMode(value: "success" | "uncertain" | "digest-mismatch" | "account-change") { submitMode = value; },
    set failNextSave(value: boolean) { failNextSave = value; },
    set failRecord(value: boolean) { failRecord = value; },
    set afterRead(value: (() => void) | undefined) { afterRead = value; },
    set afterVerifyPlan(value: (() => void) | undefined) { afterVerifyPlan = value; },
    set preflightError(value: Error | undefined) { preflightError = value; },
    set verifyPlanError(value: Error | undefined) { verifyPlanError = value; },
    set digestMismatchPaths(value: string[]) { digestMismatchPaths = value; },
    advance(ms: number) { now += ms; },
  };
}
