import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_VBK_SESSION_CONTEXT } from "../../src/main/infrastructure/vbk-session-request.js";
import {
  finalizeParentResourceSegments,
  formalResourcesMatchDraft,
} from "../../src/main/automation/ctrip/resource-segment-finalization.js";
import { ensureVehicleResourceApi } from "../../src/main/automation/ctrip/vehicle-resource-api.js";

const productId = "79257162";
const groupId = 2206177;

function group() {
  return { resourceGroupId: groupId, resourceGroup: { resourceGroupId: groupId, vendorId: 4455 } };
}

function resourceSegments(withVehicle = true) {
  return [
    {
      segmentId: 1,
      segmentBase: {
        segmentNumber: 1, stayNights: 0, minStayNights: 0, maxStayNights: 0,
        departureCity: { cityId: 92, cityName: "日喀则" }, destinationCity: { cityId: 92, cityName: "日喀则" },
      },
      packages: [{ packageId: 79257200 }],
      segmentResourceGroups: withVehicle ? [group()] : [],
      hotel: { segmentRooms: [] },
    },
    {
      segmentId: 2,
      segmentBase: {
        segmentNumber: 2, stayNights: 2, minStayNights: 2, maxStayNights: 2,
        departureCity: { cityId: 92, cityName: "日喀则" }, destinationCity: { cityId: 92, cityName: "日喀则" },
      },
      packages: [], segmentResourceGroups: [],
      hotel: { segmentRooms: [{ masterHotelID: 96283832 }, { masterHotelID: 917851 }] },
    },
    {
      segmentId: 3,
      segmentBase: {
        segmentNumber: 3, stayNights: 0, minStayNights: 0, maxStayNights: 0,
        departureCity: { cityId: 92, cityName: "日喀则" }, destinationCity: { cityId: 92, cityName: "日喀则" },
      },
      packages: [], segmentResourceGroups: [], hotel: { segmentRooms: [] },
    },
  ];
}

function success(payload: Record<string, unknown>) {
  return {
    status: 200,
    payload: { ResponseStatus: { Ack: "Success", Errors: [] }, ...payload },
    durationMs: 1,
    ctx: EMPTY_VBK_SESSION_CONTEXT,
  };
}

function initialState() {
  return `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ userInfo: { user: { name: "vbk_test" } } })};</script>`;
}

function pageFor(options: { afterPublish?: unknown; publishError?: Error; before?: unknown }) {
  let published = false;
  let publishCalls = 0;
  let htmlReads = 0;
  const draft = resourceSegments();
  const before = options.before ?? { draftProductSegments: { segments: draft }, productSegments: { segments: [] } };
  const page = {
    nativeOnly: true as const,
    evaluate: async () => { throw new Error("native adapter expected"); },
    vbkSessionGetText: async () => {
      htmlReads += 1;
      return { status: 200, text: initialState() };
    },
    vbkSessionFetch: async (request: { endpoint: string }) => {
      if (request.endpoint.endsWith("/getSegments")) {
        return success(published ? options.afterPublish as Record<string, unknown> : before as Record<string, unknown>);
      }
      if (request.endpoint.endsWith("/publishProductModules")) {
        publishCalls += 1;
        published = true;
        if (options.publishError) throw options.publishError;
        return success({});
      }
      throw new Error(`unexpected endpoint ${request.endpoint}`);
    },
  };
  return { page, draft, publishCalls: () => publishCalls, htmlReads: () => htmlReads };
}

test("母产品资源模块发布后只以正式段确认酒店、套餐与首段用车", async () => {
  const fixture = pageFor({ afterPublish: { productSegments: { segments: resourceSegments() } } });
  const result = await finalizeParentResourceSegments(
    fixture.page, productId, { draftProductSegments: { segments: fixture.draft } },
    { vehicleGroupId: groupId, maxReadbacks: 1, sleep: async () => {} },
  );
  assert.equal(result.published, true);
  assert.equal(result.audited, true);
  assert.equal(fixture.publishCalls(), 1);
});

test("草稿正确但正式段缺酒店、套餐或用车时不能作为发布成功", () => {
  const draft = resourceSegments();
  assert.equal(formalResourcesMatchDraft(resourceSegments(false), draft, groupId), false);
  const withoutHotels = structuredClone(draft);
  withoutHotels[1]!.hotel.segmentRooms = [];
  assert.equal(formalResourcesMatchDraft(withoutHotels, draft, groupId), false);
  const withoutPackage = structuredClone(draft);
  withoutPackage[0]!.packages = [];
  assert.equal(formalResourcesMatchDraft(withoutPackage, draft, groupId), false);
  const expectedWithAnotherGroup = structuredClone(draft);
  expectedWithAnotherGroup[0]!.segmentResourceGroups.push({ resourceGroupId: 330011, resourceGroup: { resourceGroupId: 330011 } });
  assert.equal(formalResourcesMatchDraft(draft, expectedWithAnotherGroup, groupId), false);
});

test("正式资源已满足当前草稿时幂等返回且不再次发布", async () => {
  const formal = resourceSegments();
  const fixture = pageFor({ before: { draftProductSegments: { segments: resourceSegments() }, productSegments: { segments: formal } } });
  const result = await finalizeParentResourceSegments(
    fixture.page, productId, { draftProductSegments: { segments: resourceSegments() } }, { vehicleGroupId: groupId },
  );
  assert.equal(result.published, false);
  assert.equal(fixture.publishCalls(), 0);
  assert.equal(fixture.htmlReads(), 0);
});

test("母产品用车入口已具备正式绑定时不创建草稿或调用交通提交协议", async () => {
  const fixture = pageFor({ before: { productSegments: { segments: resourceSegments() } } });
  const result = await ensureVehicleResourceApi(fixture.page, {
    sales: { productForm: "privateTour" },
    operations: { vehicleResource: { resourceGroupId: groupId, resourceGroupName: "测试用车组" } },
  }, productId);
  assert.equal(result.audited, true);
  assert.equal(result.changed, false);
  assert.equal(fixture.publishCalls(), 0);
  assert.equal(fixture.htmlReads(), 0);
});

test("正式用车已绑定但酒店草稿有新改动时仍发布完整草稿", async () => {
  const oldFormal = resourceSegments();
  oldFormal[1]!.hotel.segmentRooms = [{ masterHotelID: 700001 }, { masterHotelID: 700002 }];
  const changedDraft = resourceSegments();
  const fixture = pageFor({
    before: {
      draftProductSegments: { segments: changedDraft },
      productSegments: { segments: oldFormal },
    },
    afterPublish: { productSegments: { segments: changedDraft } },
  });
  const result = await ensureVehicleResourceApi(fixture.page, {
    sales: { productForm: "privateTour" },
    operations: { vehicleResource: { resourceGroupId: groupId, resourceGroupName: "测试用车组" } },
  }, productId);
  assert.equal(result.audited, true);
  assert.equal(result.published, true);
  assert.equal(fixture.publishCalls(), 1);
});

test("用车入口以同一快照判断正式绑定与草稿存在性", async () => {
  const firstFormal = resourceSegments(false);
  const laterFormal = resourceSegments();
  const laterDraft = resourceSegments();
  laterDraft[1]!.hotel.segmentRooms = [{ masterHotelID: 700001 }, { masterHotelID: 700002 }];
  let getReads = 0;
  let published = false;
  let publishCalls = 0;
  const page = {
    nativeOnly: true as const,
    evaluate: async () => { throw new Error("native adapter expected"); },
    vbkSessionGetText: async () => ({ status: 200, text: initialState() }),
    vbkSessionFetch: async (request: { endpoint: string }) => {
      if (request.endpoint.endsWith("/getSegments")) {
        getReads += 1;
        if (getReads === 1) return success({ productSegments: { segments: firstFormal } });
        return success(published
          ? { productSegments: { segments: laterDraft } }
          : { draftProductSegments: { segments: laterDraft }, productSegments: { segments: laterFormal } });
      }
      if (request.endpoint.endsWith("/publishProductModules")) {
        publishCalls += 1;
        published = true;
        return success({});
      }
      throw new Error(`unexpected endpoint ${request.endpoint}`);
    },
  };
  const result = await ensureVehicleResourceApi(page, {
    sales: { productForm: "privateTour" },
    operations: { vehicleResource: { resourceGroupId: groupId, resourceGroupName: "测试用车组" } },
  }, productId);
  assert.equal(result.published, true);
  assert.equal(publishCalls, 1);
});

test("发布超时后仅凭完整正式回读恢复成功且不重复写入", async () => {
  const fixture = pageFor({
    publishError: new Error("VBK 资源模块发布BrowserView 执行超时（20000ms）"),
    afterPublish: { productSegments: { segments: resourceSegments() } },
  });
  const result = await finalizeParentResourceSegments(
    fixture.page, productId, { draftProductSegments: { segments: fixture.draft } },
    { vehicleGroupId: groupId, maxReadbacks: 1, sleep: async () => {} },
  );
  assert.equal(result.recovered, true);
  assert.equal(fixture.publishCalls(), 1);
});

test("发布超时且正式回读不完整时阻断并且不重复发布", async () => {
  const fixture = pageFor({
    publishError: new Error("VBK 资源模块发布浏览器请求超时（15000ms）"),
    afterPublish: { draftProductSegments: { segments: resourceSegments() }, productSegments: { segments: resourceSegments(false) } },
  });
  await assert.rejects(
    () => finalizeParentResourceSegments(
      fixture.page, productId, { draftProductSegments: { segments: fixture.draft } },
      { vehicleGroupId: groupId, maxReadbacks: 2, sleep: async () => {} },
    ),
    /结果不确定.*未重复发布/,
  );
  assert.equal(fixture.publishCalls(), 1);
});

test("发布前平台草稿发生并发变化时失败关闭且不发起写入", async () => {
  const expected = resourceSegments();
  const changed = resourceSegments();
  changed[1]!.hotel.segmentRooms = [{ masterHotelID: 700001 }, { masterHotelID: 700002 }];
  changed[0]!.segmentResourceGroups = [];
  const fixture = pageFor({
    before: { draftProductSegments: { segments: changed }, productSegments: { segments: [] } },
  });
  await assert.rejects(
    () => finalizeParentResourceSegments(
      fixture.page, productId, { draftProductSegments: { segments: expected } },
      { vehicleGroupId: groupId, maxReadbacks: 1, sleep: async () => {} },
    ),
    /发布前已发生变化.*未发布/,
  );
  assert.equal(fixture.publishCalls(), 0);
  assert.equal(fixture.htmlReads(), 0);
});

test("正式段匹配但当前草稿已变化时不得走幂等快捷返回", async () => {
  const expected = resourceSegments();
  const changed = resourceSegments();
  changed[1]!.hotel.segmentRooms = [{ masterHotelID: 700001 }, { masterHotelID: 700002 }];
  const fixture = pageFor({
    before: {
      draftProductSegments: { segments: changed },
      productSegments: { segments: expected },
    },
  });
  await assert.rejects(
    () => finalizeParentResourceSegments(
      fixture.page, productId, { draftProductSegments: { segments: expected } },
      { vehicleGroupId: groupId },
    ),
    /发布前已发生变化.*未发布/,
  );
  assert.equal(fixture.publishCalls(), 0);
  assert.equal(fixture.htmlReads(), 0);
});

test("资源发布严格拒绝 Warning Ack", async () => {
  const fixture = pageFor({ afterPublish: {} });
  fixture.page.vbkSessionFetch = async (request: { endpoint: string }) => {
    if (request.endpoint.endsWith("/getSegments")) {
      return success({ draftProductSegments: { segments: fixture.draft }, productSegments: { segments: [] } });
    }
    return {
      status: 200,
      payload: { ResponseStatus: { Ack: "Warning", Errors: [] } },
      durationMs: 1,
      ctx: EMPTY_VBK_SESSION_CONTEXT,
    };
  };
  await assert.rejects(
    () => finalizeParentResourceSegments(
      fixture.page, productId, { draftProductSegments: { segments: fixture.draft } },
      { vehicleGroupId: groupId, maxReadbacks: 1, sleep: async () => {} },
    ),
    /Ack=Warning/,
  );
});


test("正式资源异步同步超过旧等待窗口时继续回读，不重复提交", async () => {
  const fixture = pageFor({ afterPublish: { productSegments: { segments: resourceSegments() } } });
  const fetch = fixture.page.vbkSessionFetch;
  let polls = 0;
  fixture.page.vbkSessionFetch = async request => {
    const response = await fetch(request);
    if (request.endpoint.endsWith("/getSegments") && fixture.publishCalls() && ++polls < 12) {
      return success({ productSegments: { segments: resourceSegments(false) } });
    }
    return response;
  };
  const result = await finalizeParentResourceSegments(fixture.page, productId,
    { draftProductSegments: { segments: fixture.draft } }, { vehicleGroupId: groupId, sleep: async () => {} });
  assert.equal(result.audited, true);
  assert.equal(polls, 12);
  assert.equal(fixture.publishCalls(), 1);
});

test("正式资源异步同步超过两分钟时仍继续回读，不把迟到回读误判为失败", async () => {
  const fixture = pageFor({ afterPublish: { productSegments: { segments: resourceSegments() } } });
  const fetch = fixture.page.vbkSessionFetch;
  let polls = 0;
  fixture.page.vbkSessionFetch = async request => {
    const response = await fetch(request);
    if (request.endpoint.endsWith("/getSegments") && fixture.publishCalls() && ++polls <= 70) {
      return success({ productSegments: { segments: resourceSegments(false) } });
    }
    return response;
  };
  const result = await finalizeParentResourceSegments(fixture.page, productId,
    { draftProductSegments: { segments: fixture.draft } }, { vehicleGroupId: groupId, sleep: async () => {} });
  assert.equal(result.audited, true);
  assert.equal(polls, 71);
  assert.equal(fixture.publishCalls(), 1);
});
