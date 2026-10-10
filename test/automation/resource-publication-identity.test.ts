import test from "node:test";
import assert from "node:assert/strict";
import { formalResourcesMatchDraft } from "../../src/main/automation/ctrip/resource-segment-finalization.js";

const fixture = () => [{ segmentId: 100, segmentBase: { segmentNumber: 1, stayNights: 1,
  departureCity: { cityId: 10, cityName: "西安" }, destinationCity: { cityId: 1920, cityName: "洋县" } },
  packages: [{ segmentId: 100, masterResourceId: 79344746, servantResourceId: 79344747, childOccupationBedResourceId: 79344748 }],
  hotel: { segmentRooms: [{ masterHotelID: 131313778, squenceNumber: 2 }, { masterHotelID: 7007077, squenceNumber: 1 }] },
  segmentResourceGroups: [{ resourceGroupId: 2207115 }] }];

test("正式发布重建段编号和倒排酒店数组，不影响套餐资源与候选优先级核验", () => {
  const expected = fixture();
  const formal = structuredClone(expected);
  formal[0].segmentId = 688459095;
  formal[0].packages[0].segmentId = 688459095;
  formal[0].hotel.segmentRooms.reverse();
  assert.equal(formalResourcesMatchDraft(formal, expected, 2207115), true);
});

test("同一酒店集合的实际候选优先级改变必须被拒绝", () => {
  const expected = fixture();
  const formal = structuredClone(expected);
  formal[0].hotel.segmentRooms[0].squenceNumber = 1;
  formal[0].hotel.segmentRooms[1].squenceNumber = 2;
  assert.equal(formalResourcesMatchDraft(formal, expected, 2207115), false);
});

test("套餐成人儿童资源角色互换、资源丢失或额外酒店都失败关闭", () => {
  for (const change of [
    (formal: ReturnType<typeof fixture>) => { [formal[0].packages[0].masterResourceId, formal[0].packages[0].servantResourceId] = [formal[0].packages[0].servantResourceId, formal[0].packages[0].masterResourceId]; },
    (formal: ReturnType<typeof fixture>) => { formal[0].packages = []; },
    (formal: ReturnType<typeof fixture>) => { formal[0].hotel.segmentRooms.push({ masterHotelID: 999, squenceNumber: 0 }); },
  ]) {
    const expected = fixture(); const formal = structuredClone(expected); change(formal);
    assert.equal(formalResourcesMatchDraft(formal, expected, 2207115), false);
  }
});

test("平台漏回候选优先级或重复优先级不能伪装成顺序正确", () => {
  const expected = fixture();
  const missing = structuredClone(expected) as any;
  delete missing[0].hotel.segmentRooms[0].squenceNumber;
  assert.equal(formalResourcesMatchDraft(missing, expected, 2207115), false);
  const duplicated = structuredClone(expected);
  duplicated[0].hotel.segmentRooms[1].squenceNumber = 2;
  assert.equal(formalResourcesMatchDraft(duplicated, expected, 2207115), false);
});
