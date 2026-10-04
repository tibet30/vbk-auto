import assert from "node:assert/strict";
import test from "node:test";
import { executeApiWithPhasePageSync } from "../../src/main/automation/automation.main/automation.main.retry-navigation.js";
import { ensureHotelResourceApi } from "../../src/main/automation/ctrip/hotel-resource-api.js";
import { productSectionUrl } from "../../src/main/automation/constants.js";

function context(phase = "hotelResource") {
  const events: string[] = [];
  const logs: Array<{ message: string; level?: string }> = [];
  return {
    events, logs,
    args: {
      phase, productId: "79239782",
      page: {
        goto: async () => { throw new Error("不应直接导航"); },
        reload: async () => { events.push("reload"); },
        url: () => "https://vbooking.ctrip.com/product/input/productListMerge?from=vbk",
      },
      isPageVisible: () => true,
      ensureBrowserHasBounds: () => { events.push("bounds"); },
      navigate: async () => {
        events.push("navigate");
        throw new Error("VBK 显式导航未抵达目标");
      },
      log: (message: string, level?: "info" | "warning" | "error") => { logs.push({ message, level }); },
    },
  };
}

test("停留在列表且酒店页跳转失败时，酒店仍通过 API 保存并回读", async () => {
  const { args, events, logs } = context();
  const destinationCity = { cityId: 447, cityName: "汕头" };
  let lodging: any = {
    segmentId: "lodging", productId: 79239782,
    segmentBase: { segmentNumber: 2, destinationCity, departureCity: destinationCity,
      stayNights: 1, minStayNights: 1, maxStayNights: 1, deleteable: true },
    hotel: { segmentRooms: [] },
  };
  const fullTrip = { ...lodging, segmentId: "full-trip", segmentBase: {
    ...lodging.segmentBase, segmentNumber: 1, stayNights: 0, minStayNights: 0, maxStayNights: 0, deleteable: false,
  } };
  const terminal = { ...lodging, segmentId: "terminal", segmentBase: {
    ...lodging.segmentBase, segmentNumber: 3, stayNights: 0, minStayNights: 0, maxStayNights: 0,
  } };
  const page = {
    ...args.page,
    evaluate: async (_fn: unknown, request: any) => {
      const endpoint = new URL(request.endpoint).pathname;
      events.push(endpoint.split("/").at(-1)!);
      if (endpoint.endsWith("saveSegment")) lodging = structuredClone(request.body.segment);
      else assert.equal(request.body.productId, 79239782);
      assert.ok(endpoint.endsWith("saveSegment") || endpoint.endsWith("getSegments"));
      return { status: 200, payload: endpoint.endsWith("getSegments")
        ? { ResponseStatus: { Ack: "Success" }, draftProductSegments: { segments: [fullTrip, lodging, terminal] } }
        : { ResponseStatus: { Ack: "Success" } } };
    },
  };
  const result = await executeApiWithPhasePageSync({
    ...args, page,
    executeApi: () => ensureHotelResourceApi(page, {
      sales: { productForm: "privateTour" },
      operations: { hotelTier: "当地5钻酒店/-38", hotelResource: { source: "ctrip" } },
      itinerary: [{ day: 1, hotel: "汕头龙光喜来登酒店", hotelCandidates: [
        { hotelId: 694781, hotelName: "汕头龙光喜来登酒店", cityName: "汕头", anchorCityId: 447 },
      ] }],
    }, "79239782"),
  });
  assert.equal(result.verified, true);
  assert.deepEqual(lodging.hotel.segmentRooms.map((room: any) => room.masterHotelID), [694781]);
  assert.equal(events.filter(event => event === "saveSegment").length, 1);
  assert.ok(events.lastIndexOf("getSegments") > events.indexOf("saveSegment"));
  assert.ok(events.indexOf("navigate") > events.lastIndexOf("getSegments"));
  assert.ok(logs.some(log => log.level === "warning" && log.message.includes("不影响阶段成功")));
});

test("真实 API 错误继续上抛，失败后不执行展示导航", async () => {
  const { args, events } = context();
  const error = new Error("VBK 指定酒店资源保存失败：HTTP 401");
  await assert.rejects(executeApiWithPhasePageSync({
    ...args, executeApi: async () => { events.push("api"); throw error; },
  }), received => received === error);
  assert.deepEqual(events, ["api"]);
});

test("API 回读成功后才同步可见页面，目标页已打开时刷新而不重新导航", async () => {
  const { args, events } = context("hotelResource");
  await executeApiWithPhasePageSync({
    ...args,
    page: { ...args.page, url: () => productSectionUrl("79239782", "hotelResource") },
    executeApi: async () => { events.push("api-readback"); },
  });
  assert.deepEqual(events, ["api-readback", "bounds", "reload"]);
});

test("手动封面上传必须先进入目标页，导航失败时不上传", async () => {
  const { args, events } = context("presentation");
  await assert.rejects(executeApiWithPhasePageSync({
    ...args, requiresPhasePage: true,
    executeApi: async () => { events.push("upload"); },
  }), /显式导航未抵达目标/);
  assert.deepEqual(events, ["bounds", "navigate"]);
});

test("缺少明确产品 ID 时拒绝 API 写入", async () => {
  const { args, events } = context();
  await assert.rejects(executeApiWithPhasePageSync({
    ...args, productId: null,
    executeApi: async () => { events.push("api"); },
  }), /缺少产品 ID/);
  assert.deepEqual(events, []);
});

test("手动封面上传在隐藏页面时也先进入目标页", async () => {
  const { args, events } = context("presentation");
  await executeApiWithPhasePageSync({
    ...args, isPageVisible: () => false, requiresPhasePage: true,
    navigate: async () => { events.push("navigate"); },
    page: { ...args.page, url: undefined },
    executeApi: async () => { events.push("upload"); },
  });
  assert.deepEqual(events, ["bounds", "navigate", "upload"]);
});
