import assert from "node:assert/strict";
import test from "node:test";
import {
  readItineraryReviewEvidence,
  submitItineraryReviewUnlock,
  verifyItineraryReviewUnlockEventually,
  verifyItineraryReviewUnlock,
} from "../../src/main/automation/ctrip/itinerary-review/index.ts";
import { itineraryContentDifferencePaths } from "../../src/main/automation/ctrip/itinerary-review/evidence.ts";
import { PRODUCT_MENU_KEYS } from "../../src/main/automation/ctrip/product-menu-readback.ts";
import {
  ITINERARY_REVIEW_DIGEST_MISMATCH_PATH_LIMIT,
  ITINERARY_REVIEW_DIGEST_MISMATCH_PATH_MAX_LENGTH,
  itineraryReviewDigestMismatchFromError,
} from "../../src/shared/itinerary-review-unlock.ts";

const id = "79713744";
const detail = (tourInfoId = "420189338085900414", productId?: number) => ({ ...(productId === undefined ? {} : { productId }), tourInfoId, tourDailyDescriptions: [{
  orderDay: 1, tourDailyInfos: [{ activeType: { key: 3 }, description: "保留景点",
    takeoffTime: {}, takeoffEndTime: { name: "" }, tourDailyPois: [{ poi: { poiId: 85218 } }],
    tourDailyPackageGatherList: [{ trainStations: [{ stationName: "广安站", locationCode: "CN001VJW" }] }] },
  { activeType: { key: 1 }, description: "平台酒店", tourDailyHotels: [{
    hotel: { hotelId: 0, hotelName: "自选酒店", hotelNameEn: null, grade: { key: -4, name: "四钻" } },
  }] }],
}] });

function fixture(options: { allUnlocked?: boolean; formalOnly?: boolean; lockedStatus2?: boolean; badAck?: boolean; dropPoi?: boolean; changeText?: boolean; generatedDailyId?: boolean; unknownDailyId?: boolean; platformNormalization?: boolean; aiMetadata?: boolean; nonemptyPlatformField?: boolean; postReviewField?: boolean; foreignCheck?: boolean; foreignAssociation?: boolean; foreignSecondAssociation?: boolean; foreignDetail?: boolean; emptyScore?: boolean; visaMessage?: boolean; published?: boolean; child?: boolean; badPage?: boolean; login?: boolean; noRoute?: boolean; badMaxStep?: boolean; pendingReadbacks?: number; unsubmittedAfterUnlock?: boolean } = {}) {
  let unlocked = options.allUnlocked === true;
  let routeId = unlocked && !options.noRoute ? 900 : 0;
  let pendingReadbacks = options.pendingReadbacks ?? 0;
  const requests: Array<{ method: string; body: any }> = [];
  let checks = 0;
  const relation = () => ({ productId: Number(id), tourInfoId: "420190190563967062",
    ...(options.formalOnly ? { previewTourInfoId: "420189338085900414" } : { draftTourInfoId: "420189338085900414" }),
    auditTourInfoId: "420190190563967062", draftTourInfoStatus: options.formalOnly ? (unlocked || options.lockedStatus2 ? 2 : 1) : unlocked ? 2 : 1, main: true, sort: 0,
    auditStatus: { key: options.unsubmittedAfterUnlock ? "N" : options.formalOnly || routeId ? "A" : "N",
      value: options.unsubmittedAfterUnlock ? "未提交" : options.formalOnly || routeId ? "审核通过" : "未提交" } });
  const menus = () => PRODUCT_MENU_KEYS.map((key, index) => ({ key, title: key,
    enabled: options.allUnlocked || index < (unlocked ? 5 : 4) ? "T" : "F",
    url: `/ivbk/vendor/${key}?productid=${id}` }));
  const page: any = { nativeOnly: true,
    vbkSessionGetText: async ({ endpoint }: any) => {
      const url = new URL(endpoint);
      const isTraffic = url.pathname.includes("trafficLineEdit");
      const pageId = options.badPage && !isTraffic ? "1" : id;
      const login = options.login && !isTraffic;
      const state = { ...(login ? { action: "login" } : {}), location: { pathname: login ? "/login" : url.pathname, query: { productid: pageId } }, ...(isTraffic ? { childList: options.child ? [{ productId: "2", lineDescription: "飞机往返" }] : [] } : {}) };
      return { status: 200, text: `<script>window.__INITIAL_STATE__ = ${JSON.stringify(state)};</script>` };
    },
    vbkSessionFetch: async ({ endpoint, body }: any) => {
      const method = endpoint.split("/").pop(); requests.push({ method, body });
      if (options.badAck && method === "checkTourDaily") return { status: 200, payload: { ResponseStatus: { Ack: "Unknown" } }, context: {} };
      let payload: any = {};
      if (method === "getProductBaseInfo") {
        const visibleRouteId = pendingReadbacks > 0 ? 0 : routeId;
        pendingReadbacks = Math.max(0, pendingReadbacks - 1);
        payload = { baseInfo: { productId: Number(id), routeId: visibleRouteId, active: options.published ? "T" : "F" },
        saleControlInfo: { inputLocale: "zh-CN", saleMode: 1, productPatternID: 2, productCategoryID: 3 }, meta: { releaseActive: "F", isonline: "F" } };
      }
      else if (method === "getProductTourInfoList") payload = { tourInfos: [relation()] };
      else if (method === "getTourDailyDetail.json") {
        const current = detail(body.tourInfoId, options.foreignDetail ? 1 : undefined);
        if (unlocked && options.aiMetadata) {
          Object.assign(current.tourDailyDescriptions[0], { isAiRcmdTitle: true, isEditAfterAi: true });
          Object.assign(current.tourDailyDescriptions[0].tourDailyInfos[0].tourDailyPois[0],
            { aiAdjustPoiDetailInfo: { suggestedPoiName: "平台建议", reason: "AI推荐标记" } });
        }
        if (unlocked && options.postReviewField) current.tourDailyDescriptions[0].reviewGeneratedValue = "platform";
        payload = { tourInfo: current };
      }
      else if (method === "getSubMenu.json") payload = { hasPermission: true, maxStep: unlocked && options.badMaxStep ? 9 : unlocked ? 10 : -60, menus: menus() };
      else if (method === "inSwitch") payload = { switched: true };
      else if (method === "checkTourDaily") {
        checks += 1;
        const next = JSON.parse(body.tourDaily);
        if (options.dropPoi) next.tourDailyDescriptions[0].tourDailyInfos[0].tourDailyPois = [];
        if (options.changeText) next.tourDailyDescriptions[0].tourDailyInfos[0].description = "被改写";
        if (options.generatedDailyId) next.tourDailyDescriptions[0].tourDailyInfos[0].tourDailyInfoId = "platform-generated";
        if (options.unknownDailyId) next.tourDailyDescriptions[0].tourDailyInfos[0].tourDailyUnknownId = "new";
        if (options.platformNormalization) {
          const day = next.tourDailyDescriptions[0]; const info = day.tourDailyInfos[0];
          day.parentId = "platform-parent"; day.refId = "platform-reference";
          Object.assign(info, { directionType: null, fixedProductsOnSale: [], parentId: "platform-parent",
            pkgDepartureDate: null, refId: "platform-reference", sightRecommend: {},
            takeoffTime: { ...info.takeoffTime, key: null }, takeoffEndTime: { ...info.takeoffEndTime, key: null },
            tourDailyCar: {}, tourDailyDinner: {}, tourDailyDismiss: {}, tourDailyGather: {}, transportation: {} });
          const gather = info.tourDailyPackageGatherList[0]; const station = gather.trainStations[0];
          Object.assign(gather, { location: {}, poi: {}, rangeTemplateIds: [] });
          Object.assign(station, { arriveDate: null, arriveTime: "", departureDate: null,
            departureTime: "", stationNo: null, telCode: "" });
          info.useSegmentConfig = false;
          const dailyPoi = info.tourDailyPois[0];
          Object.assign(dailyPoi, { costInclude: { key: "", name: null }, groupType: { key: null, name: null } });
          Object.assign(dailyPoi.poi, { childPoiIds: null, cost: null, costUnit: { key: null, name: null },
            currency: { currencyCode: null }, district: { parents: [{ parents: [], publishStatus: null }] } });
          Object.assign(dailyPoi, { suggestPoiList: [], themeSelectCount: null });
          info.tourDailyDinner = { foodType: { key: null, name: null } };
          const hotelSlot = day.tourDailyInfos[1].tourDailyHotels[0];
          Object.assign(hotelSlot, { basicRooms: [], cruiseCompany: null, hotelType: null, ships: [] });
          Object.assign(hotelSlot.hotel, { biTag: null, district: {}, ggLatitude: null, ggLongitude: null });
        }
        if (options.aiMetadata) {
          Object.assign(next.tourDailyDescriptions[0], { isAiRcmdTitle: true, isEditAfterAi: true });
          Object.assign(next.tourDailyDescriptions[0].tourDailyInfos[0].tourDailyPois[0],
            { aiAdjustPoiDetailInfo: { suggestedPoiName: "平台建议", reason: "AI推荐标记" } });
        }
        if (options.nonemptyPlatformField) next.tourDailyDescriptions[0].tourDailyInfos[0].tourDailyDinner = { dinnerType: { key: "L" } };
        if (options.foreignCheck) next.productId = 1;
        payload = { productTourInfo: options.foreignAssociation || options.foreignSecondAssociation && checks === 2
          ? { ...relation(), productId: 1 } : relation(), tourDaily: JSON.stringify(next) };
      } else if (method === "calculateTourInfoScore") payload = { tourInfo: options.emptyScore ? {} : { aggregateScore: 100, tourInfoScores: [] } };
      else if (method === "saveTourDailyDetail.json") payload = { tourInfoId: body.tourInfo.tourInfoId };
      else if (method === "calculateNeedAppliedVisa") payload = options.visaMessage ? { addMessage: "需新增签证" } : {};
      else if (method === "saveProductTourInfo") { unlocked = true; routeId = 900; payload = {}; }
      else throw new Error(`unexpected ${method}`);
      return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...payload }, context: {} };
    },
  };
  return { page, requests };
}

test("审核解锁走完整六步、忽略平台引用与空壳标准化并回读十个官方菜单", async () => {
  const f = fixture({ generatedDailyId: true, platformNormalization: true }); const before = await readItineraryReviewEvidence(f.page, id); const steps: string[] = []; let current = 0;
  await submitItineraryReviewUnlock(f.page, before, { assertCurrent: () => { current += 1; }, onStep: step => steps.push(step.step) });
  const result = await verifyItineraryReviewUnlock(f.page, id, before.contentDigest);
  assert.deepEqual(steps, ["check8", "calculateScore", "check3", "saveDaily", "calculateNeedAppliedVisa", "saveProduct3"]);
  assert.equal(current, 6); assert.equal(result.verified, true); assert.equal(result.tabs.length, 5); assert.equal(result.publication.active, "F");
  assert.deepEqual(result.menus.map(menu => menu.enabled), ["T", "T", "T", "T", "T", "F", "F", "F", "F", "F"]);
  assert.deepEqual(f.requests.filter(request => /checkTourDaily|calculateTourInfoScore|saveTourDailyDetail|calculateNeedAppliedVisa|saveProductTourInfo/.test(request.method)).map(request => request.method),
    ["checkTourDaily", "calculateTourInfoScore", "checkTourDaily", "saveTourDailyDetail.json", "calculateNeedAppliedVisa", "saveProductTourInfo"]);
});

test("审核提交后只对远端最终一致性状态做有界只读等待", async () => {
  const delayed = fixture({ allUnlocked: true, pendingReadbacks: 2 });
  let delayedWaits = 0;
  const receipt = await verifyItineraryReviewUnlockEventually(delayed.page, id, undefined, undefined, {
    attempts: 3,
    intervalMs: 0,
    wait: async () => { delayedWaits += 1; },
  });
  assert.equal(receipt.routeId, 900);
  assert.equal(delayedWaits, 2);
  assert.equal(delayed.requests.filter(request => request.method === "getProductBaseInfo").length, 3);

  const f = fixture({ noRoute: true, allUnlocked: true });
  let waits = 0;
  await assert.rejects(() => verifyItineraryReviewUnlockEventually(f.page, id, undefined, undefined, {
    attempts: 3,
    intervalMs: 0,
    wait: async () => { waits += 1; },
  }), /审核尚未通过/);
  assert.equal(waits, 2);
  assert.equal(f.requests.filter(request => request.method === "getProductBaseInfo").length, 3);
  assert.equal(f.requests.some(request => /save|check|calculate/i.test(request.method)), false);

  const identity = fixture({ allUnlocked: true, badPage: true });
  await assert.rejects(() => verifyItineraryReviewUnlockEventually(identity.page, id, undefined, undefined, {
    attempts: 3,
    intervalMs: 0,
    wait: async () => { throw new Error("不应等待"); },
  }), /身份不一致/);
});

test("套餐管理已解锁且仍为未提交草稿时，审核回读成功而不是误报不确定写入", async () => {
  const f = fixture({ allUnlocked: true, unsubmittedAfterUnlock: true });
  const result = await verifyItineraryReviewUnlock(f.page, id);
  assert.equal(result.verified, true);
  assert.equal(result.routeId, 900);
  assert.deepEqual(result.publication, { active: "F", isonline: "F", releaseActive: "F" });
});

test("审核后摘要变化必须由完整方案回读接管，无方案证明仍拒绝", async () => {
  const f = fixture({ postReviewField: true });
  const before = await readItineraryReviewEvidence(f.page, id);
  await submitItineraryReviewUnlock(f.page, before);
  await assert.rejects(() => verifyItineraryReviewUnlock(f.page, id, before.contentDigest), /内容与提交前不一致/);

  const result = await verifyItineraryReviewUnlock(f.page, id, before.contentDigest, { itinerary: [] }, {
    verifyPlan: async (_page, _product, _productId, tourInfoId) => {
      const current = await readItineraryReviewEvidence(f.page, id);
      return { tourInfoId, days: 1, contentDigest: current.contentDigest };
    },
  });
  assert.notEqual(result.beforeDigest, result.afterDigest);
  assert.equal(result.contentDigest, result.afterDigest);
});

test("业务内容差异只记录脱敏路径，并阻止所有后续审核请求", async () => {
  for (const [options, expectedPath] of [
    [{ changeText: true }, "$.tourDailyDescriptions[0].tourDailyInfos[0].description"],
    [{ unknownDailyId: true }, "$.tourDailyDescriptions[0].tourDailyInfos[0].tourDailyUnknownId"],
    [{ dropPoi: true }, "$.tourDailyDescriptions[0].tourDailyInfos[0].tourDailyPois[0]"],
    [{ nonemptyPlatformField: true }, "$.tourDailyDescriptions[0].tourDailyInfos[0].tourDailyDinner"],
  ]) {
    const f = fixture(options); const before = await readItineraryReviewEvidence(f.page, id);
    await assert.rejects(() => submitItineraryReviewUnlock(f.page, before), error => {
      const mismatch = itineraryReviewDigestMismatchFromError(error);
      assert.match(error instanceof Error ? error.message : "", /改写/);
      assert.equal(mismatch?.step, "审核校验");
      assert.equal(mismatch?.beforeDigest, before.contentDigest);
      assert.match(mismatch?.afterDigest ?? "", /^[a-f0-9]{64}$/);
      assert.ok(mismatch?.paths.includes(expectedPath));
      assert.ok((mismatch?.paths.length ?? Infinity) <= ITINERARY_REVIEW_DIGEST_MISMATCH_PATH_LIMIT);
      assert.equal(JSON.stringify(mismatch).includes("保留景点"), false);
      assert.equal(JSON.stringify(mismatch).includes("被改写"), false);
      return true;
    });
    assert.deepEqual(f.requests.filter(request => /checkTourDaily|calculateTourInfoScore|saveTourDailyDetail|calculateNeedAppliedVisa|saveProductTourInfo/.test(request.method)).map(request => request.method), ["checkTourDaily"]);
  }
});

test("摘要诊断路径逐项和总数均有上限", () => {
  const before = { tourDailyDescriptions: Array.from({ length: 13 }, (_, index) => ({ orderDay: index + 1 })) };
  const after = structuredClone(before);
  for (const description of after.tourDailyDescriptions) description.orderDay += 100;
  (after.tourDailyDescriptions[0] as Record<string, unknown>)["x".repeat(300)] = "正文不得保存";
  const paths = itineraryContentDifferencePaths(before, after);
  assert.equal(paths.length, ITINERARY_REVIEW_DIGEST_MISMATCH_PATH_LIMIT);
  assert.ok(paths.every(path => path.length <= ITINERARY_REVIEW_DIGEST_MISMATCH_PATH_MAX_LENGTH));
  assert.ok(paths.includes("$.tourDailyDescriptions[0][*]"));
  assert.equal(JSON.stringify(paths).includes("正文不得保存"), false);
});

test("已解锁产品只读返回，未知 Ack 和校验改写均不能继续", async () => {
  const all = fixture({ allUnlocked: true }); const unlocked = await readItineraryReviewEvidence(all.page, id);
  await submitItineraryReviewUnlock(all.page, unlocked); assert.equal(all.requests.some(request => request.method === "saveProductTourInfo"), false);
  const ack = fixture({ badAck: true }); const ackBefore = await readItineraryReviewEvidence(ack.page, id);
  await assert.rejects(() => submitItineraryReviewUnlock(ack.page, ackBefore), /Ack=Unknown/);
  const poi = fixture({ dropPoi: true }); const poiBefore = await readItineraryReviewEvidence(poi.page, id);
  await assert.rejects(() => submitItineraryReviewUnlock(poi.page, poiBefore), /改写/);
  assert.equal(poi.requests.some(request => request.method === "saveProductTourInfo"), false);
  const visa = fixture({ visaMessage: true }); const visaBefore = await readItineraryReviewEvidence(visa.page, id);
  await assert.rejects(() => submitItineraryReviewUnlock(visa.page, visaBefore), /签证适用范围/);
  assert.equal(visa.requests.some(request => request.method === "saveProductTourInfo"), false);
});

test("页面身份不一致会拒绝审核完成", async () => {
  const f = fixture({ badPage: true }); const before = await readItineraryReviewEvidence(f.page, id);
  await submitItineraryReviewUnlock(f.page, before);
  await assert.rejects(() => verifyItineraryReviewUnlock(f.page, id, before.contentDigest), /身份不一致/);
});

test("审核前发布或已有子产品零写入，协议和完成回读也拒绝异常身份", async () => {
  for (const options of [{ published: true }, { child: true }]) {
    const f = fixture(options); await assert.rejects(() => readItineraryReviewEvidence(f.page, id), /未发布状态|交通子产品/);
    assert.equal(f.requests.some(request => /checkTourDaily|saveProduct/.test(request.method)), false);
  }
  const foreign = fixture({ foreignCheck: true }); const before = await readItineraryReviewEvidence(foreign.page, id);
  await assert.rejects(() => submitItineraryReviewUnlock(foreign.page, before), /产品身份/);
  const text = fixture({ changeText: true }); const textBefore = await readItineraryReviewEvidence(text.page, id);
  await assert.rejects(() => submitItineraryReviewUnlock(text.page, textBefore), /改写/);
  const unknown = fixture({ unknownDailyId: true }); const unknownBefore = await readItineraryReviewEvidence(unknown.page, id);
  await assert.rejects(() => submitItineraryReviewUnlock(unknown.page, unknownBefore), /改写/);
  const association = fixture({ foreignAssociation: true }); const associationBefore = await readItineraryReviewEvidence(association.page, id);
  await assert.rejects(() => submitItineraryReviewUnlock(association.page, associationBefore), /关联产品身份/);
  assert.equal(association.requests.some(request => /calculateTourInfoScore|saveTourDailyDetail|saveProductTourInfo/.test(request.method)), false);
  const secondAssociation = fixture({ foreignSecondAssociation: true }); const secondBefore = await readItineraryReviewEvidence(secondAssociation.page, id);
  await assert.rejects(() => submitItineraryReviewUnlock(secondAssociation.page, secondBefore), /关联产品身份/);
  assert.equal(secondAssociation.requests.some(request => /saveTourDailyDetail|saveProductTourInfo/.test(request.method)), false);
  const score = fixture({ emptyScore: true }); const scoreBefore = await readItineraryReviewEvidence(score.page, id);
  await assert.rejects(() => submitItineraryReviewUnlock(score.page, scoreBefore), /评分响应缺少/);
  const detail = fixture({ foreignDetail: true }); await assert.rejects(() => readItineraryReviewEvidence(detail.page, id), /详情产品身份/);
  for (const options of [{ allUnlocked: true, noRoute: true }, { allUnlocked: true, login: true }]) {
    const f = fixture(options); const before = await readItineraryReviewEvidence(f.page, id);
    await assert.rejects(() => verifyItineraryReviewUnlock(f.page, id, before.contentDigest), /审核尚未通过|菜单未全部|登录页/);
  }
  const badStep = fixture({ allUnlocked: true, badMaxStep: true });
  await assert.rejects(() => readItineraryReviewEvidence(badStep.page, id), /流程未到完成步骤/);
});

test("无独立草稿的真实 formal==audit 审核边界按状态选择版本", async () => {
  const locked = fixture({ formalOnly: true }); const evidence = await readItineraryReviewEvidence(locked.page, id);
  assert.equal(evidence.tourInfoId, "420190190563967062"); assert.equal(evidence.fullyUnlocked, false);
  const unlocked = fixture({ formalOnly: true, allUnlocked: true }); const readOnly = await readItineraryReviewEvidence(unlocked.page, id);
  assert.equal(readOnly.tourInfoId, "420190190563967062"); assert.equal(readOnly.fullyUnlocked, true);
  const invalid = fixture({ formalOnly: true, lockedStatus2: true });
  await assert.rejects(() => readItineraryReviewEvidence(invalid.page, id), /可提交的当前草稿版本/);
  assert.equal(invalid.requests.some(request => /checkTourDaily|saveProduct/.test(request.method)), false);
});

// The real protocol must consume the check responses and finish full readback.
test("check8/check3 与最终回读带 AI 标记时完整审核协议仍验证实际行程", async () => {
  const f = fixture({ aiMetadata: true });
  const before = await readItineraryReviewEvidence(f.page, id);
  const steps: string[] = [];
  await submitItineraryReviewUnlock(f.page, before, { onStep: step => steps.push(step.step) });
  const result = await verifyItineraryReviewUnlock(f.page, id, before.contentDigest);
  assert.equal(result.verified, true);
  assert.deepEqual(steps, ["check8", "calculateScore", "check3", "saveDaily", "calculateNeedAppliedVisa", "saveProduct3"]);
  const saved = f.requests.find(request => request.method === "saveTourDailyDetail.json")!.body.tourInfo;
  assert.equal(saved.tourDailyDescriptions[0].tourDailyInfos[0].tourDailyPois[0].poi.poiId, 85218);
  assert.deepEqual(result.publication, { active: "F", isonline: "F", releaseActive: "F" });
});
