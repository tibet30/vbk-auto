import test from "node:test";
import assert from "node:assert/strict";
import { rewritePresentationCopy } from "../../src/main/minimax/presentation-copy-rewriter.js";

const presentation = { recommendation: "游览当地景点", features: "<p>当地人文行程</p>", recommendations: [
  { category: "服务保障", text: "专车衔接" }, { category: "精选酒店", text: "城区酒店" }, { category: "特色美食", text: "自由品尝江鲜" },
], cover: { imageId: 123 } };

test("专用图文模型工具声明完整三条数组并保留非文案字段", async () => {
  let request: any;
  const copy = { ...presentation, recommendations: presentation.recommendations.map((item, i) => ({ ...item, text: i === 2 ? "自由品尝本地风味" : item.text })) };
  const client = { chat: { completions: { create: async (args: any) => {
    request = args;
    return { choices: [{ message: { tool_calls: [{ type: "function", function: { name: "submit_presentation_copy", arguments: JSON.stringify(copy) } }] } }] };
  } } } };
  const response = await rewritePresentationCopy(client as never, "model", { message: "改写江鲜", product: { presentation } });
  const array = request.tools[0].function.parameters.properties.recommendations;
  assert.equal(array.type, "array"); assert.equal(array.minItems, 3); assert.equal(array.maxItems, 3);
  assert.deepEqual(array.items.required, ["category", "text"]);
  assert.deepEqual((response.patch![0]!.value as any).cover, presentation.cover);
  assert.equal((response.patch![0]!.value as any).recommendations[2].text, "自由品尝本地风味");
});

test("模型返回单条或对象形状的推荐理由时拒绝，不补造输出", async () => {
  const client = { chat: { completions: { create: async () => ({ choices: [{ message: { tool_calls: [{ type: "function", function: {
    name: "submit_presentation_copy", arguments: JSON.stringify({ ...presentation, recommendations: { item: presentation.recommendations[2] } }),
  } }] } }] }) } } };
  await assert.rejects(rewritePresentationCopy(client as never, "model", { message: "改写江鲜", product: { presentation } }));
});
