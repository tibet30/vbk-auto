// 行程关联写回的版本身份契约：
//   平台已经存在未提交的正式/审核身份（tourInfoId === auditTourInfoId、无独立草稿）时，
//   check(2) 可能再生成一个新的草稿版本。此时关联写回只能把新版本登记为独立草稿，
//   绝不能把 tourInfoId / auditTourInfoId / auditTourInfoStatus 改到新版本上——真实环境
//   会以「VBK 行程关联保存失败（Ack=Failure）：请求参数错误」驳回（2026-10-14/15）。
//
//   只有真正空关联首建和仅 preview 的首建还没有任何身份，新版本才可以成为当前身份，
//   这两条路径由 itinerary-empty-draft / orchestration-part-2 覆盖。

import test from "node:test";
import assert from "node:assert/strict";

import { ensureItineraryApi } from "../../src/main/automation/ctrip/itinerary-api.js";
import {
  baseProductNoHotel,
  callLog,
  clearRouteHandlers,
  installFetchStub,
  installHandlersForFieldMismatch,
  makeFakePage,
  resetCallLog,
  routeHandlers,
  uninstallFetchStub,
} from "./itinerary-api.test-helpers.js";

test.before(installFetchStub);
test.afterEach(() => { clearRouteHandlers(); resetCallLog(); });
test.after(uninstallFetchStub);

test("已有未提交正式/审核身份时，新草稿只登记为独立草稿且不改审核指针", async () => {
  installHandlersForFieldMismatch({
    hotelName: () => "",
    otherDescription: () => "自由活动",
    serviceStart: "08:00",
    serviceEnd: "20:00",
    title: (i) => i === 0 ? "第1天" : "第2天",
  });
  const currentTourInfoId = "418082233558728766";
  const checkedTourInfoId = "418082233558728999";
  let listCalls = 0;
  routeHandlers["/restapi/soa2/15638/getProductTourInfoList"] = () => {
    listCalls += 1;
    return {
      ResponseStatus: { Ack: "Success", Errors: [] },
      tourInfos: [{
        tourInfoId: currentTourInfoId,
        auditTourInfoId: currentTourInfoId,
        auditTourInfoStatus: 2,
        ...(listCalls > 1 ? { draftTourInfoId: checkedTourInfoId, draftTourInfoStatus: 1 } : {}),
        auditStatus: { key: "N", value: "未提交" },
        productId: 77035928,
        main: true,
        sort: 0,
        templateId: 3,
      }],
    };
  };
  routeHandlers["/restapi/soa2/15638/checkTourDaily"] = (body: any) => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    tourDaily: JSON.stringify({ ...JSON.parse(body.tourDaily), tourInfoId: checkedTourInfoId }),
  });
  routeHandlers["/restapi/soa2/20049/saveTourDailyDetail.json"] = () => ({
    ResponseStatus: { Ack: "Success", Errors: [] },
    tourInfoId: checkedTourInfoId,
  });

  const result = await ensureItineraryApi(makeFakePage() as any, baseProductNoHotel as any, "77035928");

  assert.equal(listCalls, 2);
  assert.equal(result.tourInfoId, checkedTourInfoId);
  const check = callLog.find((call) => call.endpoint === "/restapi/soa2/15638/checkTourDaily");
  assert.equal((check?.body as any).productTourInfo.tourInfoId, currentTourInfoId, "校验阶段仍以既有身份为源");
  const association = callLog.find((call) => call.endpoint === "/restapi/soa2/15638/saveProductTourInfo");
  const tourInfo = (association?.body as any).tourInfo;
  assert.equal((association?.body as any).saveType, 2);
  assert.equal(tourInfo.tourInfoId, currentTourInfoId, "正式身份不得被新草稿顶替");
  assert.equal(tourInfo.auditTourInfoId, currentTourInfoId, "审核指针不得被改到新草稿");
  assert.equal(tourInfo.auditTourInfoStatus, 2, "审核状态必须原样保留，不得硬编码为 1");
  assert.deepEqual(tourInfo.auditStatus, { key: "N", value: "未提交" });
  assert.equal(tourInfo.draftTourInfoId, checkedTourInfoId, "新版本只能登记为独立草稿");
  assert.equal(tourInfo.draftTourInfoStatus, 1);
  assert.equal(JSON.parse((association?.body as any).tourDaily).tourInfoId, checkedTourInfoId);
});
