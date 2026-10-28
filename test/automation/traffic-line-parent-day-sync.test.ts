import test from "node:test";
import assert from "node:assert/strict";
import { ensureTrafficLineApi } from "../../src/main/automation/ctrip/traffic-line/main.js";

/** 母产品 1、子产品 2；子产品已有一次「交通卡片缺失」的资源拒绝记录，可走恢复捷径。 */
function harness(options: { parentDays: number; childDays: number; parentHasTourInfo?: boolean }) {
  const calls: string[] = [];
  const checkpoints: any[] = [];
  const page = {
    vbkSessionGetText: async () => ({ status: 200,
      text: '<script>window.__INITIAL_STATE__ = {"childList":[{"subProductId":"2","lineDescription":"火车往返","isActiveInPackage":"F"}]};</script>',
    }),
    evaluate: async (_fn: unknown, request: any) => {
      calls.push(request.endpoint);
      const isParent = String(request.body?.productId) === "1";
      const payload = request.endpoint.endsWith("getdescriptionInfo")
        ? { info: { productDesc: { productDesc: "same" }, pmRcmdItems: [] } }
        : request.endpoint.endsWith("getProductTourInfoList")
          ? { tourInfos: isParent && options.parentHasTourInfo === false ? []
            : [{ productId: Number(request.body.productId), tourInfoId: isParent ? 910 : 920, main: true, sort: 0,
              days: isParent ? options.parentDays : options.childDays }] }
        : request.endpoint.endsWith("getTourDailyDetail.json")
          ? { tourInfo: { tourDailyDescriptions: Array.from({ length: String(request.body.tourInfoId) === "910" ? options.parentDays : options.childDays }, () => ({})) } }
        : assert.fail(`unexpected request ${request.endpoint}`);
      return { status: 200, durationMs: 1, ctx: {}, payload: { ResponseStatus: { Ack: "Success" }, ...payload } };
    },
  };
  const run = () => ensureTrafficLineApi(page as never, "1", { enabled: true, variants: ["trainRoundTrip"] }, {
    itinerary: [{}], endpointPlan: { arrivalCity: "成都", departureCity: "成都", resolvedAt: "2026-10-08",
      train: { arrival: { code: "CN001CNW", name: "成都南", resourceKey: "28" }, departure: { code: "CN001CNW", name: "成都南", resourceKey: "28" } } },
    childProgress: [{ variant: "trainRoundTrip", lineDescription: "火车往返", childProductId: "2", verified: false,
      completedStages: ["presentationCopied"], validationSubmittedAt: "2026-10-08", failedStage: "resourcesSaved",
      failureReason: "子产品资源提交未通过：资源配置中含有火车票资源，需要行程描述中先添加火车信息卡片。" }],
    onChildProgress: progress => checkpoints.push(progress),
  });
  return { calls, checkpoints, run };
}

test("母子天数比较失败时子产品按跳过规则记录失败，不按旧天数收口", async () => {
  const h = harness({ parentDays: 2, childDays: 2, parentHasTourInfo: false });
  const result = await h.run();
  assert.deepEqual(result.children, []);
  assert.match(result.skipped?.[0]?.reason ?? "", /未能比较母子行程天数，不按旧天数收口/);
  assert.equal(h.calls.some(url => /getSegments|save|submit|activate/i.test(url)), false, "比较失败后不能继续写入或回读收口");
  const last = h.checkpoints.at(-1);
  assert.equal(last.skipped, true);
  assert.equal(last.skipReason, "child_failed");
  assert.match(last.failureReason, /未能比较母子行程天数/);
  assert.equal(last.completedStages.includes("resourcesSaved"), false);
});

test("母子天数不一致时恢复分支不走捷径（不先回读旧资源段），改走完整写链", async () => {
  const h = harness({ parentDays: 3, childDays: 2 });
  const result = await h.run();
  // 完整写链需要销售班期做资源核验；本夹具没有班期，因此在写链入口处停下，证明未走恢复捷径。
  assert.match(result.skipped?.[0]?.reason ?? "", /没有可用于交通资源核验的销售班期/);
  assert.equal(h.calls.some(url => url.endsWith("getSegments")), false);
  const afterSync = h.calls.slice(h.calls.lastIndexOf("https://vbooking.ctrip.com/restapi/soa2/13643/getTourDailyDetail.json") + 1);
  // 捷径的第一步是只读 getSegments 回读正式资源；完整写链先查询上次资源提交状态。
  assert.notEqual(afterSync[0]?.split("/").pop(), "getSegments", `首个后续请求：${afterSync[0]}`);
  assert.equal(h.checkpoints.some(item => item.completedStages.includes("resourcesSaved")), false);
});

test("母子天数一致时恢复分支照常走捷径", async () => {
  const h = harness({ parentDays: 2, childDays: 2 });
  await h.run();
  const index = h.calls.findIndex(url => url.endsWith("getSegments"));
  assert.ok(index > 0, "天数一致时先只读回读正式资源段");
});
