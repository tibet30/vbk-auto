import assert from "node:assert/strict";
import test from "node:test";
import { syncCtripHotelResources } from "../../src/main/automation/ctrip/hotel-resource-page.js";

function fixture(options: { staleDraft?: boolean; corruptRestore?: boolean; uncertainSave?: boolean } = {}) {
  const city = { cityId: 447, cityName: "汕头" };
  let segments: any[] = [0, 2, 1, 1, 0].map((nights, index) => ({
    productId: 79239782, segmentId: 100 + index,
    segmentBase: { segmentNumber: index + 1, destinationCity: city, stayNights: nights,
      minStayNights: nights, maxStayNights: nights },
    packages: index === 0 ? [{ packageId: 1, segmentId: 100 }] : [],
    hotel: { segmentRooms: index === 1 ? [{ masterHotelID: 694781, squenceNumber: 1 }] : [] },
  }));
  let draft = true;
  let stale = false;
  const calls: string[] = [];
  const savedSlots: number[] = [];
  const page = { evaluate: async (_fn: unknown, request: any) => {
    const endpoint = new URL(request.endpoint).pathname.split("/").at(-1)!;
    calls.push(endpoint);
    if (endpoint === "getSegments") return { status: 200, payload: {
      ResponseStatus: { Ack: "Success" },
      [draft || stale ? "draftProductSegments" : "productSegments"]: { segments: structuredClone(segments) },
    } };
    if (endpoint === "saveSegment") {
      if (!draft) {
        stale = false;
        return { status: 200, payload: { ResponseStatus: { Ack: "Failure",
          Errors: [{ ErrorCode: "20016116", Message: "产品还没有创建草稿。" }] } } };
      }
      const slot = segments.findIndex(segment => segment.segmentId === request.body.segment.segmentId);
      assert.ok(slot >= 0);
      segments[slot] = structuredClone(request.body.segment);
      if (options.uncertainSave) return { status: 200, payload: { ResponseStatus: { Ack: "Failure",
        Errors: [{ ErrorCode: "20016116", Message: "产品还没有创建草稿。" }] } } };
      savedSlots.push(slot);
      draft = false;
      stale = options.staleDraft === true;
    } else if (endpoint === "createProductDraft") {
      draft = true; stale = false;
      // 平台重建草稿会改变自身 ID 以及套餐对全程段的引用。
      segments = segments.map((segment, index) => ({ ...segment,
        productId: 90000000, segmentId: segment.segmentId + 10,
        packages: index === 0 ? [{ packageId: 1, segmentId: segment.segmentId + 10 }] : [],
      }));
      if (options.corruptRestore) segments[1].hotel.segmentRooms = [];
    } else assert.equal(endpoint, "saveProductMaintainType");
    return { status: 200, payload: { ResponseStatus: { Ack: "Success" } } };
  } };
  return {
    calls, savedSlots, read: () => segments,
    run: () => syncCtripHotelResources({ page, productId: "79239782", dailyCandidates: [
      { day: 1, segmentId: "101", candidates: [{ hotelId: 694781, hotelName: "已保存酒店" }] },
      { day: 3, segmentId: "102", candidates: [{ hotelId: 123815030, hotelName: "第3晚酒店" }] },
      { day: 4, segmentId: "103", candidates: [{ hotelId: 110033216, hotelName: "第4晚酒店" }] },
    ] }),
  };
}

for (const staleDraft of [false, true]) {
  test(`前两晚已保存，后续保存使草稿${staleDraft ? "外壳过期" : "消失"}时保留进度继续剩余晚次`, async () => {
    const f = fixture({ staleDraft });
    const result = await f.run();
    assert.equal(result.verified, true);
    assert.deepEqual(f.savedSlots, [2, 3]);
    assert.deepEqual(f.read().slice(1, 4).map(s => s.hotel.segmentRooms[0].masterHotelID),
      [694781, 123815030, 110033216]);
    assert.equal(f.calls.filter(call => call === "createProductDraft").length, 1);
    assert.equal(f.calls.filter(call => call === "saveSegment").length, staleDraft ? 3 : 2);
    assert.ok(!f.calls.includes("submitSegments"));
    assert.deepEqual(result.days.map(day => day.segmentId), ["111", "112", "113"]);
  });
}

test("恢复草稿丢失前面已保存的酒店时立即停止，不继续下一晚", async () => {
  const f = fixture({ corruptRestore: true });
  await assert.rejects(f.run(), /草稿恢复后内容发生变化/);
  assert.deepEqual(f.savedSlots, [2]);
  assert.equal(f.calls.filter(call => call === "saveSegment").length, 1);
});

test("保存返回草稿错误但本次实际内容已变化时，不恢复或重试", async () => {
  const f = fixture({ uncertainSave: true });
  await assert.rejects(f.run(), /本次保存前后资源内容发生变化/);
  assert.equal(f.calls.filter(call => call === "saveSegment").length, 1);
  assert.ok(!f.calls.includes("createProductDraft"));
});
