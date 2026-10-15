import test from "node:test";
import assert from "node:assert/strict";
import { rewriteItineraryCopy } from "../../src/main/minimax/itinerary-copy-rewriter.js";

const targets = [
  { path: "/itinerary/0/activities/0/detail", value: "体验太白山唐镇南山温泉，含室外汤池与药浴。" },
];

function clientReturning(argumentsValue: unknown) {
  let request: any;
  return {
    get request() { return request; },
    client: { chat: { completions: { create: async (args: any) => {
      request = args;
      return { choices: [{ message: { tool_calls: [{ type: "function", function: {
        name: "submit_itinerary_copy",
        arguments: typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue),
      } }] } }] };
    } } } },
  };
}

test("行程改写工具把路径锁进 schema，并只返回命中路径的 replace", async () => {
  const fake = clientReturning({ patches: [{ path: targets[0]!.path, value: "体验太白山唐镇南山温泉室外汤池。" }] });
  const response = await rewriteItineraryCopy(fake.client as never, "model", {
    message: "VBK 行程校验以非法关键词驳回：药浴。",
    product: { itinerary: [] },
    targets,
  });
  const schema = fake.request.tools[0].function.parameters;
  assert.deepEqual(schema.properties.patches.items.properties.path.enum, [targets[0]!.path]);
  assert.deepEqual(schema.properties.patches.items.required, ["path", "value"]);
  assert.deepEqual(response.patch, [
    { op: "replace", path: targets[0]!.path, value: "体验太白山唐镇南山温泉室外汤池。" },
  ]);
  assert.match(fake.request.messages[1].content, /药浴/);
  assert.match(fake.request.messages[1].content, /activities\/0\/detail/);
});

test("模型返回空 patch 或非结构化结果时拒绝，不补造输出", async () => {
  const empty = clientReturning({ patches: [] });
  await assert.rejects(rewriteItineraryCopy(empty.client as never, "model", {
    message: "改写", product: {}, targets,
  }));
  const broken = clientReturning("not-json");
  await assert.rejects(rewriteItineraryCopy(broken.client as never, "model", {
    message: "改写", product: {}, targets,
  }));
  await assert.rejects(rewriteItineraryCopy(clientReturning({ patches: [] }).client as never, "model", {
    message: "改写", product: {}, targets: [],
  }), /没有需要改写的行程文案路径/);
});
