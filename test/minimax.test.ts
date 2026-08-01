import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { MiniMaxService } from "../src/main/minimax.js";

test("通用产品方案模型响应会被解析为安全的草稿更新", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{ message: { content: `<think>先确认产品约束，再生成安全草稿。</think>\n\n以下是结果：\n\n\`\`\`json\n${JSON.stringify({
        reply: "已生成太原2天1晚私家团第一版。",
        patch: [{ op: "add", path: "/basicInfo/subtitle", value: "晋阳古都文化体验·专车私享" }],
        researchTasks: [{ label: "核查用车资源组", type: "vbk", detail: "在 VBK 资源库确认有效资源组 ID" }],
      })}\n\`\`\`` } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });

  const result = await service.reply({ message: "生成第一版", product: { basicInfo: { meetingCity: "太原" }, itinerary: [] }, history: [] });

  assert.equal(result.reply, "已生成太原2天1晚私家团第一版。");
  assert.deepEqual(result.patch?.[0], { op: "add", path: "/basicInfo/subtitle", value: "晋阳古都文化体验·专车私享" });
  assert.equal(result.researchTasks?.[0].label, "核查用车资源组");
});

test("模型响应被常见外层字段包裹时仍可解析", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        result: {
          reply: "已生成太原2天1晚私家团第一版。",
          patch: [{ op: "add", path: "/itinerary", value: [{ day: 1, title: "太原接站—晋祠", spots: ["晋祠"], description: "专车接站后游览晋祠。", hotel: "太原市区酒店", meals: "敬请自理" }] }],
          researchTasks: [{ label: "核查门票预约", type: "web", detail: "确认晋祠开放时间与预约要求" }],
        },
      }) } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({ message: "生成第一版", product: { basicInfo: { meetingCity: "太原" }, itinerary: [] }, history: [] });

  assert.equal(result.reply, "已生成太原2天1晚私家团第一版。");
  assert.equal(result.patch?.[0].path, "/itinerary");
  assert.equal(result.researchTasks?.[0].label, "核查门票预约");
});

test("模型通过工具调用返回时会直接解析为产品更新", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: JSON.stringify({
                reply: "已按上一轮要求缩短行程节奏。",
                patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "轻松慢游·专车私享" }],
                questions: [],
                researchTasks: [],
              }),
            },
          }],
        },
      }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({
    message: "第二天不要太赶",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [{ day: 1 }, { day: 2 }] },
    history: [{ role: "user", content: "生成第一版" }, { role: "assistant", content: "已生成第一版。" }],
  });

  assert.equal(result.reply, "已按上一轮要求缩短行程节奏。");
  assert.deepEqual(result.patch?.[0], { op: "replace", path: "/basicInfo/subtitle", value: "轻松慢游·专车私享" });
});

test("模型返回不可写 patch 路径时会被本地结构校验丢弃", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        reply: "已设置价格。",
        patch: [{ op: "add", path: "/commercial/pricing", value: { publicPrice: 1999 } }],
        questions: [],
        researchTasks: [],
      }) } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({ message: "补价格", product: { basicInfo: { meetingCity: "太原" }, itinerary: [] }, history: [] });

  assert.equal(result.reply, "已设置价格。");
  assert.deepEqual(result.patch, []);
});

test("连接测试会发出轻量 MiniMax 请求", async (t) => {
  let requestBody = "";
  const server = createServer((request, response) => {
    request.on("data", (chunk) => { requestBody += String(chunk); });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  await new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" }).testConnection();
  const parsedBody = JSON.parse(requestBody) as Record<string, unknown>;
  assert.equal(parsedBody.max_completion_tokens, 1);
  assert.deepEqual(parsedBody.thinking, { type: "disabled" });
  assert.equal(parsedBody.extra_body, undefined);
});

test("方案生成请求会给完整 JSON 草稿预留足够输出额度", async (t) => {
  let requestBody = "";
  const server = createServer((request, response) => {
    request.on("data", (chunk) => { requestBody += String(chunk); });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: "ok", patch: [{ op: "add", path: "/itinerary", value: [{ day: 1, title: "太原一日", spots: [], description: "", hotel: "", meals: "" }] }], questions: [], researchTasks: [] }) } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  await new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" }).reply({ message: "生成第一版", product: { basicInfo: { meetingCity: "太原" }, itinerary: [] }, history: [] });

  const parsedBody = JSON.parse(requestBody) as Record<string, unknown>;
  assert.equal(parsedBody.max_completion_tokens, 2048);
  assert.ok(Array.isArray(parsedBody.tools));
  assert.equal((parsedBody.tool_choice as { function?: { name?: string } }).function?.name, "submit_product_update");
  assert.deepEqual(parsedBody.thinking, { type: "disabled" });
  assert.equal(parsedBody.reasoning_split, true);
  assert.equal(parsedBody.service_tier, "standard");
  assert.equal(parsedBody.extra_body, undefined);
  const tool = (parsedBody.tools as Array<{ function: { parameters: { properties: { patch: { items: { properties: { path: { enum: string[] } } } } } } } }>)[0];
  assert.ok(tool.function.parameters.properties.patch.items.properties.path.enum.includes("/itinerary"));
  assert.equal(tool.function.parameters.properties.patch.items.properties.path.enum.includes("/basicInfo/productTitle"), false);
});

test("首次生成没有返回可写字段时不会被误判为成功", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: "已生成方案。", patch: [], questions: [], researchTasks: [] }) } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  await assert.rejects(
    service.reply({ message: "生成第一版", product: { itinerary: [] }, history: [] }),
    (error: unknown) => error instanceof Error && error.message === "MiniMax 未返回可写入的产品方案，请重试。",
  );
});

test("空草稿首次生成时不会被历史中的假成功回复误导", async (t) => {
  let requestBody = "";
  const server = createServer((request, response) => {
    request.on("data", (chunk) => { requestBody += String(chunk); });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        reply: "已重新生成第一版。",
        patch: [{ op: "add", path: "/itinerary", value: [{ day: 1, title: "太原一日", spots: [], description: "", hotel: "", meals: "" }] }],
        questions: [],
        researchTasks: [],
      }) } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  await service.reply({
    message: "生成第一版",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [{ role: "assistant", content: "已经生成完整方案。" }],
  });

  const messages = (JSON.parse(requestBody) as { messages: Array<{ content: string }> }).messages;
  assert.equal(messages.some((message) => message.content === "已经生成完整方案。"), false);
});

test("MiniMax 常见展示和行程字段会转换为产品草稿协议", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      reply: "已生成方案。",
      patch: [
        { op: "add", path: "/presentation", value: { productName: "太原私家团", subtitle: "晋阳古韵", highlights: ["专车服务", "纯玩无购物"], description: "两天探访三晋文化。" } },
        { op: "add", path: "/itinerary", value: [{ day: 1, title: "晋祠探古", summary: "游览晋祠", activities: [{ time: "上午", name: "晋祠博物馆", detail: "参观古建筑" }], meals: { breakfast: "自理", lunch: "自理", dinner: "自理" }, stay: "太原市区酒店" }] },
      ],
      questions: [],
      researchTasks: [],
    }) } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({ message: "生成第一版", product: { itinerary: [] }, history: [] });

  assert.deepEqual(result.patch?.[0].value, {
    recommendationCategory: "优选行程",
    recommendation: "两天探访三晋文化。",
    features: "专车服务\n纯玩无购物",
  });
  assert.deepEqual(result.patch?.[1].value, [{
    day: 1,
    title: "晋祠探古",
    spots: ["晋祠博物馆"],
    description: "游览晋祠。上午 晋祠博物馆 参观古建筑",
    hotel: "太原市区酒店",
    meals: "早餐自理；午餐自理；晚餐自理",
    mealDescriptions: ["早餐自理", "午餐自理", "晚餐自理"],
    hotelDescription: "太原市区酒店",
  }]);
});

test("结构字段中的待核查占位值不会写入产品草稿", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      reply: "运营字段待核查。",
      patch: [
        { op: "replace", path: "/operations/transport", value: "待核查" },
        { op: "replace", path: "/operations/reusePickupForDropoff", value: null },
        { op: "replace", path: "/commercial/packageName", value: "" },
      ],
      questions: [],
      researchTasks: [{ label: "核查车辆资源", type: "vbk" }],
    }) } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({ message: "补充运营字段", product: { itinerary: [{ day: 1 }] }, history: [] });

  assert.deepEqual(result.patch, []);
  assert.equal(result.researchTasks?.[0].label, "核查车辆资源");
});
