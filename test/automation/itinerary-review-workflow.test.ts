import test from "node:test";
import assert from "node:assert/strict";
import {
  canReuseVerifiedItineraryReview,
  canResumeVerifiedItineraryReviewOnly,
  runWorkflowItineraryReviewUnlock,
} from "../../src/main/automation/automation.main/runtime/itinerary-review-unlock.js";
import { itineraryContentDigest, submitItineraryReviewUnlock, verifyItineraryReviewUnlock } from "../../src/main/automation/ctrip/itinerary-review/index.js";
import {
  ITINERARY_REVIEW_REJECTED_WITHOUT_WRITE_MESSAGE,
  ITINERARY_REVIEW_VALIDATION_ONLY_RECOVERY_MESSAGE,
  readItineraryReviewDigestMismatch,
  type ItineraryReviewUnlockState,
} from "../../src/shared/itinerary-review-unlock.js";

const lockedMenus = Array.from({ length: 10 }, (_, index) => ({
  key: `menu-${index}`, title: `菜单${index}`, enabled: (index < 4 ? "T" : "F") as "T" | "F", url: `/menu-${index}`,
}));

function setup(authorized: boolean) {
  let state: ItineraryReviewUnlockState | undefined;
  let submitCalls = 0;
  let statusAtSubmit: string | undefined;
  let readCalls = 0;
  let authorizationChecks = 0;
  let revokeAtRead: number | undefined;
  let authorizedFingerprint = true;
  const requestSources: string[] = [];
  let evidence: any = {
    productId: "100", tourInfoId: "420000000000000001", contentDigest: "a".repeat(64),
    relation: { productId: 100, tourInfoId: "420000000000000001", draftTourInfoStatus: 1, auditStatus: { key: "N" } },
    base: {}, detail: {}, maxStep: -60, fullyUnlocked: false,
    menus: structuredClone(lockedMenus),
    publication: { active: "F", isonline: "F", releaseActive: "F" }, trafficChildren: 0,
  };
  const approval: any = {
    id: "approval", status: "approved", productVersion: "v1", accountKey: "account",
    intentVersion: "intent", itineraryReviewUnlockAuthorized: authorized,
    trafficRouteReviewAuthorized: true, generateTrafficChildren: true,
    scope: authorized ? ["vbk.write_phase:preflight", "vbk.review_unlock:itinerary"] : ["vbk.write_phase:preflight"],
  };
  const snapshot: any = {
    localProductId: "local", run: { id: "run", status: "running", intentVersion: "intent" },
    events: [{ id: "event", runId: "run", type: "approval", createdAt: "now", data: { approval } }],
  };
  const steps = [{ step: "check8", endpoint: "/check", saveType: 8, ack: "Success" as const, at: "now" }];
  const protocol = {
    read: async (page: any) => {
      readCalls += 1;
      await page.vbkSessionGetText?.({ endpoint: "/proof" });
      if (readCalls === revokeAtRead) authorizedFingerprint = false;
      return structuredClone(evidence);
    },
    submit: async (_page: any, _evidence: any, options: any) => {
      submitCalls += 1;
      statusAtSubmit = state?.status;
      await options.assertCurrent();
      options.onStep(steps[0]);
      evidence = { ...evidence, maxStep: 10, fullyUnlocked: false,
        menus: lockedMenus.map((menu, index) => ({ ...menu, enabled: index < 5 ? "T" : "F" })) };
    },
    verify: async (_page: any, _id: string, digest: string) => ({
      verified: true as const, productId: "100", tourInfoId: evidence.tourInfoId,
      contentDigest: evidence.contentDigest, beforeDigest: digest, afterDigest: evidence.contentDigest,
      routeId: 7, maxStep: 10, menus: evidence.menus,
      publication: { active: "F" as const, isonline: "F" as const, releaseActive: "F" as const },
      trafficChildren: 0 as const, checkedAt: "now",
      tabs: evidence.menus.map((menu: any) => ({ key: menu.key, title: menu.title, url: menu.url, verified: true as const })),
      requestSteps: [],
    }),
  };
  let preflightCalls = 0;
  let verifyPlanCalls = 0;
  const args: any = {
    localProductId: "local", productId: "100", product: { operations: {}, itinerary: [] },
    page: {
      nativeOnly: true, evaluate: async () => undefined,
      vbkSessionGetText: async () => ({ status: 200, text: "" }),
      withRequestSource: async (source: string, execute: () => Promise<unknown>) => {
        requestSources.push(source); return execute();
      },
    },
    snapshot: () => snapshot, productIdentity: () => "100", accountIdentity: () => "account",
    assertAuthorized: async () => {
      authorizationChecks += 1;
      if (!authorizedFingerprint) throw new Error("本地产品版本与授权不一致");
    },
    stateStore: { get: () => structuredClone(state), save: (value: ItineraryReviewUnlockState) => { state = structuredClone(value); } },
    protocol,
    preflight: async () => { preflightCalls += 1; },
    verifyPlan: async () => { verifyPlanCalls += 1; return {
      tourInfoId: evidence.tourInfoId, days: 1, contentDigest: evidence.contentDigest,
    }; },
  };
  return {
    args, snapshot,
    get state() { return state; },
    get submitCalls() { return submitCalls; },
    get statusAtSubmit() { return statusAtSubmit; },
    get readCalls() { return readCalls; },
    get preflightCalls() { return preflightCalls; },
    get verifyPlanCalls() { return verifyPlanCalls; },
    get authorizationChecks() { return authorizationChecks; },
    get requestSources() { return requestSources; },
    get evidence() { return evidence; },
    set evidence(value: any) { evidence = value; },
    set revokeAtRead(value: number | undefined) { revokeAtRead = value; },
  };
}

test("legacy approval cannot invoke the itinerary review protocol", async () => {
  const f = setup(false);
  f.snapshot.events.unshift({
    id: "historical", runId: "old-run", type: "approval", createdAt: "before",
    data: { approval: { ...f.snapshot.events[0].data.approval, id: "old-approval",
      itineraryReviewUnlockAuthorized: true, scope: ["vbk.review_unlock:itinerary"] } },
  });
  const result = await runWorkflowItineraryReviewUnlock(f.args);
  assert.deepEqual(result, { skipped: "not-authorized" });
  assert.equal(f.readCalls, 0);
  assert.equal(f.submitCalls, 0);
  assert.equal(f.preflightCalls, 0);
  assert.equal(f.state, undefined);
});

test("latest current-run denial cannot revive an earlier review approval", async () => {
  for (const latest of [
    { status: "approved", itineraryReviewUnlockAuthorized: false },
    { status: "invalidated", itineraryReviewUnlockAuthorized: true },
  ]) {
    const f = setup(true);
    const earlier = structuredClone(f.snapshot.events[0]);
    f.snapshot.events.push({ ...earlier, id: `latest-${latest.status}`,
      data: { approval: { ...earlier.data.approval, ...latest, id: `latest-${latest.status}` } } });
    const result = await runWorkflowItineraryReviewUnlock(f.args);
    assert.deepEqual(result, { skipped: "not-authorized" });
    assert.equal(f.readCalls, 0);
    assert.equal(f.submitCalls, 0);
    assert.equal(f.state, undefined);
  }
});

test("current explicit approval submits once and verifies the package boundary", async () => {
  const f = setup(true);
  const result = await runWorkflowItineraryReviewUnlock(f.args);
  assert.equal(result.verified, true);
  assert.equal(result.receipt.maxStep, 10);
  assert.equal(result.receipt.menus.length, 10);
  assert.deepEqual(result.receipt.menus.map(menu => menu.enabled),
    ["T", "T", "T", "T", "T", "F", "F", "F", "F", "F"]);
  assert.equal(f.preflightCalls, 0);
  assert.equal(f.verifyPlanCalls, 1);
  assert.equal(f.submitCalls, 1);
  assert.equal(f.statusAtSubmit, "dispatched");
  assert.equal(f.state?.status, "verified");
  assert.equal(f.state?.approvalId, "approval");
  assert.equal(f.state?.agentRunId, "run");
  assert.deepEqual(f.state?.requestSteps?.map(step => step.step), ["check8"]);
  assert.ok(f.authorizationChecks >= 5);
  assert.ok(f.requestSources.length >= 2);
  assert.ok(f.requestSources.every(source => /tourdays\?productid=100/.test(source)));
});

test("完整方案只读恢复只跳过重复行程保存，不跳过审核协议", () => {
  const f = setup(true);
  const state: ItineraryReviewUnlockState = {
    localProductId: "local", status: "requires_review", attemptId: "",
    approvalId: "approval", agentRunId: "run", productId: "100", accountKey: "account",
    tourInfoId: "420000000000000001", beforeDigest: "a".repeat(64), requestSteps: [],
    message: ITINERARY_REVIEW_VALIDATION_ONLY_RECOVERY_MESSAGE, updatedAt: "now",
  };
  assert.equal(canResumeVerifiedItineraryReviewOnly({ snapshot: f.snapshot, state, productId: "100" }), true);
  assert.equal(canResumeVerifiedItineraryReviewOnly({ snapshot: f.snapshot,
    state: { ...state, requestSteps: [{ step: "check8", endpoint: "/check", ack: "Success", at: "now" }] }, productId: "100" }), false);
  assert.equal(canResumeVerifiedItineraryReviewOnly({ snapshot: f.snapshot,
    state: { ...state, message: "普通待审核" }, productId: "100" }), false);
});

test("same-run verified receipt completes itinerary without another save or review", () => {
  const f = setup(true);
  const state: ItineraryReviewUnlockState = {
    localProductId: "local", status: "verified", attemptId: "attempt",
    approvalId: "approval", agentRunId: "run", productId: "100", accountKey: "account",
    tourInfoId: "420000000000000001", beforeDigest: "a".repeat(64), afterDigest: "a".repeat(64),
    routeId: 7, requestSteps: [], updatedAt: "now", receipt: {
      verified: true, productId: "100", tourInfoId: "420000000000000001",
      contentDigest: "a".repeat(64), beforeDigest: "a".repeat(64), afterDigest: "a".repeat(64),
      routeId: 7, maxStep: 10, menus: [], publication: { active: "F", isonline: "F", releaseActive: "F" },
      trafficChildren: 0, checkedAt: "now", tabs: [], requestSteps: [],
    },
  };
  assert.equal(canReuseVerifiedItineraryReview({ snapshot: f.snapshot, state, productId: "100" }), true);
  assert.equal(canReuseVerifiedItineraryReview({ snapshot: f.snapshot,
    state: { ...state, agentRunId: "other" }, productId: "100" }), false);
  assert.equal(canReuseVerifiedItineraryReview({ snapshot: f.snapshot,
    state: { ...state, approvalId: "other" }, productId: "100" }), false);
});

test("审核校验改写在回执前失败时，远端仍为未提交也不能以旧确认重试", async () => {
  const f = setup(true); const session = productionSession({ changeText: true });
  f.args.productId = session.productId;
  f.args.page = session.page;
  f.args.protocol = { submit: submitItineraryReviewUnlock };
  f.args.verifyPlan = async (_page: any, _product: any, _productId: string, tourInfoId: string) => ({
    tourInfoId, days: 1, contentDigest: itineraryContentDigest({
      tourDailyDescriptions: [{ orderDay: 1, tourDailyInfos: [{ activeType: { key: 3 }, description: "保留行程", tourDailyPois: [{ poi: { poiId: 85218 } }] }] }],
    }),
  });
  await assert.rejects(runWorkflowItineraryReviewUnlock(f.args), (error: any) =>
    error.uncertainWrite === true && readItineraryReviewDigestMismatch(error.digestMismatch)?.step === "审核校验");
  assert.equal(session.requests.filter(method => method === "checkTourDaily").length, 1);
  assert.equal(f.state?.status, "uncertain");
  assert.deepEqual(f.state?.requestSteps, []);
  assert.equal(f.state?.digestMismatch?.step, "审核校验");
  assert.equal(JSON.stringify(f.state?.digestMismatch).includes("保留行程"), false);
  await assert.rejects(runWorkflowItineraryReviewUnlock(f.args), /禁止自动重复提交/);
  assert.equal(session.requests.filter(method => method === "checkTourDaily").length, 1);
  assert.equal(f.state?.status, "uncertain");
});

test("local approval fingerprint drift during proof blocks dispatch without uncertain state", async () => {
  const f = setup(true); f.revokeAtRead = 2;
  await assert.rejects(runWorkflowItineraryReviewUnlock(f.args), /本地产品版本与授权不一致/);
  assert.equal(f.submitCalls, 0);
  assert.equal(f.state, undefined);
  assert.equal(f.authorizationChecks, 3);
});

test("尾随菜单未解锁时，已授权工作流也不能提交审核", async () => {
  const f = setup(true);
  f.evidence = { ...f.evidence, menus: [...f.evidence.menus, {
    key: "optionalAddon", title: "扩展设置", enabled: "F", url: "/optionalAddon?productId=100",
  }] };
  await assert.rejects(runWorkflowItineraryReviewUnlock(f.args), /可确认的行程审核边界/);
  assert.equal(f.submitCalls, 0);
  assert.equal(f.state, undefined);
});


function productionSession(options: { changeText?: boolean; rejectCheckWith?: string[] } = {}) {
  let unlocked = false;
  const requests: string[] = [];
  const productId = "100";
  const tourInfoId = "420000000000000001";
  const relation = () => ({ productId: Number(productId), tourInfoId, draftTourInfoId: tourInfoId,
    auditTourInfoId: tourInfoId, draftTourInfoStatus: unlocked ? 2 : 1,
    auditStatus: { key: unlocked ? "A" : "N", value: unlocked ? "审核通过" : "未提交" } });
  const menus = () => Array.from({ length: 10 }, (_, index) => ({
    key: ["saleControl", "basicInfo", "pictureAndText", "TourDays", "combomanage", "inventory", "travelOptionNew", "newResourceClause", "trafficLineEdit", "advancedSettings"][index],
    title: `菜单${index}`, enabled: unlocked || index < 4 ? "T" : "F",
    url: `/ivbk/vendor/menu-${index}?productid=${productId}`,
  }));
  const detail = () => ({ tourInfoId, tourDailyDescriptions: [{ orderDay: 1,
    tourDailyInfos: [{ activeType: { key: 3 }, description: "保留行程", tourDailyPois: [{ poi: { poiId: 85218 } }] }],
  }] });
  const page: any = {
    nativeOnly: true, evaluate: async () => undefined,
    withRequestSource: async (_source: string, execute: () => Promise<unknown>) => execute(),
    vbkSessionGetText: async ({ endpoint }: any) => {
      const url = new URL(endpoint, "https://vbooking.ctrip.com");
      return { status: 200, text: `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
        location: { pathname: url.pathname, query: { productid: productId } },
        ...(url.pathname.includes("trafficLineEdit") ? { childList: [] } : {}),
      })};</script>` };
    },
    vbkSessionFetch: async ({ endpoint, body }: any) => {
      const method = endpoint.split("/").pop(); requests.push(method);
      let payload: any = {};
      if (method === "getProductBaseInfo") payload = { baseInfo: { productId: Number(productId), routeId: unlocked ? 40004141 : 0, active: "F" },
        saleControlInfo: { inputLocale: "zh-CN", saleMode: 1, productPatternID: 2, productCategoryID: 3 }, meta: { isonline: "F", releaseActive: "F" } };
      else if (method === "getProductTourInfoList") payload = { tourInfos: [relation()] };
      else if (method === "getTourDailyDetail.json") payload = { tourInfo: detail() };
      else if (method === "getSubMenu.json") payload = { hasPermission: true, maxStep: unlocked ? 10 : -60, menus: menus() };
      else if (method === "inSwitch") payload = { switched: true };
      else if (method === "checkTourDaily") {
        const rejection = options.rejectCheckWith?.shift();
        if (rejection) return { status: 200, payload: { ResponseStatus: { Ack: "Failure", Errors: [{ Message: rejection }] } }, ctx: {} };
        const tourDaily = JSON.parse(body.tourDaily);
        if (options.changeText) tourDaily.tourDailyDescriptions[0].tourDailyInfos[0].description = "被改写";
        payload = { productTourInfo: relation(), tourDaily: JSON.stringify(tourDaily) };
      }
      else if (method === "calculateTourInfoScore") payload = { tourInfo: { aggregateScore: 100, tourInfoScores: [] } };
      else if (method === "saveTourDailyDetail.json") payload = { tourInfoId };
      else if (method === "calculateNeedAppliedVisa") payload = {};
      else if (method === "saveProductTourInfo") { unlocked = true; }
      else throw new Error(`unexpected request ${method}`);
      return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...payload }, ctx: {} };
    },
  };
  return { page, requests, productId, tourInfoId };
}

test("审核校验被平台以非法关键词驳回时保留可重试边界，不写成不确定写入", async () => {
  const f = setup(true);
  const session = productionSession({ rejectCheckWith: ["保存第1天行程描述，提示非法关键词：药浴，请修改后重新提交"] });
  f.args.productId = session.productId;
  f.args.page = session.page;
  f.args.protocol = { submit: submitItineraryReviewUnlock };
  f.args.verifyPlan = async (_page: any, _product: any, _productId: string, tourInfoId: string) => ({
    tourInfoId, days: 1, contentDigest: itineraryContentDigest({
      tourDailyDescriptions: [{ orderDay: 1, tourDailyInfos: [{ activeType: { key: 3 }, description: "保留行程", tourDailyPois: [{ poi: { poiId: 85218 } }] }] }],
    }),
  });
  await assert.rejects(runWorkflowItineraryReviewUnlock(f.args), (error: any) =>
    error.itineraryReviewValidationOnly === true && error.uncertainWrite === undefined
    && /药浴/.test(error.message));
  assert.equal(session.requests.filter(method => method === "checkTourDaily").length, 1);
  assert.equal(f.state?.status, "requires_review");
  assert.equal(f.state?.attemptId, "");
  assert.deepEqual(f.state?.requestSteps, []);
  assert.equal(f.state?.digestMismatch, undefined);
  assert.equal(f.state?.receipt, undefined);
  assert.ok(f.state?.message?.startsWith(ITINERARY_REVIEW_REJECTED_WITHOUT_WRITE_MESSAGE));
  assert.equal(f.state?.message?.includes("药浴"), true);
});

test("current authorization runs production review steps and persists the verified receipt", async () => {
  const f = setup(true); const session = productionSession();
  f.args.productId = session.productId;
  f.args.page = session.page;
  f.args.protocol = { verify: (page: any, productId: string, digest?: string) =>
    verifyItineraryReviewUnlock(page, productId, digest) };
  f.args.preflight = async () => undefined;
  f.args.verifyPlan = async (_page: any, _product: any, _productId: string, tourInfoId: string) => ({
    tourInfoId, days: 1, contentDigest: itineraryContentDigest({
      tourDailyDescriptions: [{ orderDay: 1, tourDailyInfos: [{ activeType: { key: 3 }, description: "保留行程", tourDailyPois: [{ poi: { poiId: 85218 } }] }] }],
    }),
  });
  const result = await runWorkflowItineraryReviewUnlock(f.args);
  assert.equal(result.verified, true);
  assert.equal(result.receipt.maxStep, 10);
  assert.ok(result.receipt.menus.every(menu => menu.enabled === "T"));
  assert.deepEqual(result.receipt.publication, { active: "F", isonline: "F", releaseActive: "F" });
  assert.equal(result.receipt.trafficChildren, 0);
  assert.equal(f.state?.status, "verified");
  assert.equal(f.state?.approvalId, "approval");
  assert.equal(f.state?.agentRunId, "run");
  assert.deepEqual(f.state?.requestSteps?.map(step => step.step), ["check8", "calculateScore", "check3", "saveDaily", "calculateNeedAppliedVisa", "saveProduct3"]);
  assert.deepEqual(session.requests.filter(method => /checkTourDaily|calculateTourInfoScore|saveTourDailyDetail|calculateNeedAppliedVisa|saveProductTourInfo/.test(method)),
    ["checkTourDaily", "calculateTourInfoScore", "checkTourDaily", "saveTourDailyDetail.json", "calculateNeedAppliedVisa", "saveProductTourInfo"]);
});
