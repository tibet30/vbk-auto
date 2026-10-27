import assert from "node:assert/strict";
import test from "node:test";
import {
  isGeneratedPoiFailureDetail,
  poiResearchFailureDetail,
  type PoiResearchFailureArgs,
} from "../../src/shared/poi-research-outcome.js";

const base: PoiResearchFailureArgs = {
  reviewingComplete: false,
  queryFailed: false,
  invalidLocation: false,
  invalidIdentity: false,
  suspended: false,
  travelNode: false,
};

test("没有同名候选时说明身份不符，不再让运营去改当天城市", () => {
  const detail = poiResearchFailureDetail({ ...base, reason: "identity_mismatch" });
  assert.match(detail, /未找到与该景点一致/);
  assert.doesNotMatch(detail, /地域/);
});

test("同名候选地域不符时才提示当天路线范围", () => {
  const detail = poiResearchFailureDetail({ ...base, reason: "location_mismatch" });
  assert.match(detail, /已找到同名候选 POI/);
  assert.match(detail, /当天原路线/);
  assert.doesNotMatch(detail, /产品主城市/);
});

test("复核已绑定 POI 时保留绑定，并按当前查询原因给出重试说明", () => {
  const retained = { ...base, reviewingComplete: true };
  assert.match(poiResearchFailureDetail({ ...retained, reason: "identity_mismatch" }), /本轮 POI 核验未完成.*其他景点或上下级景点/);
  assert.match(poiResearchFailureDetail({ ...retained, reason: "location_mismatch" }), /本轮 POI 核验未完成.*地域信息不足/);
  assert.match(poiResearchFailureDetail({ ...retained, queryFailed: true }), /查询失败或超时/);
  assert.match(poiResearchFailureDetail({ ...retained, reason: "ambiguous" }), /多个候选/);
});

test("系统失败说明可被识别，运营手写备注不被误判", () => {
  for (const detail of [
    "已找到候选 POI，但其地域与产品主城市不一致；请确认当天行程地点范围或手动绑定 POI",
    "已找到候选 POI，但其地域与当天原路线不一致；请确认当天行程地点范围或手动绑定 POI",
    "未找到与该景点一致、且不是其他景点或上下级景点的 VBK POI；请确认景点名称（可尝试简称），或手动绑定/删除该景点",
    "本轮 POI 核验未完成：当前查询只召回其他景点或上下级景点，已保留先前绑定；请重新查询并确认当前 POI",
    "未找到对应的 VBK POI，已保留原景点和原行程位置；请确认景点名称或手动录入 POI",
  ]) assert.equal(isGeneratedPoiFailureDetail(detail), true, detail);
  assert.equal(isGeneratedPoiFailureDetail("运营备注：从南门进入，保留人工复核记录"), false);
  assert.equal(isGeneratedPoiFailureDetail(""), false);
  assert.equal(isGeneratedPoiFailureDetail(undefined), false);
});
