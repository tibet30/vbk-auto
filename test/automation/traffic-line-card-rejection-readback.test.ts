import test from "node:test";
import assert from "node:assert/strict";
import { ensureTrafficLineApi } from "../../src/main/automation/ctrip/traffic-line/main.js";

test("card rejection recovery cannot activate or record saved resources when formal readback is empty", async () => {
  const calls: string[] = [];
  const checkpoints: any[] = [];
  const page = {
    vbkSessionGetText: async () => ({ status: 200,
      text: '<script>window.__INITIAL_STATE__ = {"childList":[{"subProductId":"2","lineDescription":"火车往返","isActiveInPackage":"F"}]};</script>',
    }),
    evaluate: async (_fn: unknown, request: any) => {
      calls.push(request.endpoint);
      const payload = request.endpoint.endsWith("getdescriptionInfo")
        ? { info: { productDesc: { productDesc: "same" }, pmRcmdItems: [] } }
        : request.endpoint.endsWith("getSegments") ? { productSegments: { segments: [] } }
        : assert.fail(`unexpected request ${request.endpoint}`);
      return { status: 200, durationMs: 1, ctx: {}, payload: { ResponseStatus: { Ack: "Success" }, ...payload } };
    },
  };
  const result = await ensureTrafficLineApi(page as never, "1", { enabled: true, variants: ["trainRoundTrip"] }, {
    itinerary: [{}], endpointPlan: { arrivalCity: "成都", departureCity: "成都", resolvedAt: "2026-10-08",
      train: { arrival: { code: "CN001CNW", name: "成都南", resourceKey: "28" }, departure: { code: "CN001CNW", name: "成都南", resourceKey: "28" } } },
    childProgress: [{ variant: "trainRoundTrip", lineDescription: "火车往返", childProductId: "2", verified: false,
      completedStages: ["presentationCopied"], validationSubmittedAt: "2026-10-08", failedStage: "resourcesSaved",
      failureReason: "子产品资源提交未通过：资源配置中含有火车票资源，需要行程描述中先添加火车信息卡片。" }],
    onChildProgress: progress => checkpoints.push(progress),
  });
  assert.deepEqual(result.children, []);
  assert.match(result.skipped?.[0]?.reason ?? "", /未返回可作为正式回读的资源段/);
  assert.equal(calls.some(url => /save|submit|activate/i.test(url)), false);
  assert.equal(checkpoints.some(item => item.completedStages.includes("resourcesSaved")), false);
  assert.equal(checkpoints.at(-1).skipped, false);
});
