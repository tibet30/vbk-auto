import { assert, MiniMaxService, test } from "./minimax.core.shared.js";
import { createServer } from "node:http";
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

test("模型返回轻微截断 JSON 时可自动补齐并解析", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{ message: { content: `{"reply":"已生成太原2天1晚私家团第一版。","patch":[{"op":"add","path":"/basicInfo/subtitle","value":"晋阳古都文化体验·专车私享"` } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({
    message: "生成第一版",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "已生成太原2天1晚私家团第一版。");
  assert.deepEqual(result.patch?.[0], { op: "add", path: "/basicInfo/subtitle", value: "晋阳古都文化体验·专车私享" });
});

test("模型返回尾随逗号 JSON 时可自动修复并解析", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    const payload = `{"reply":"ok","patch":[{"op":"add","path":"/basicInfo/subtitle","value":"尾随逗号修复"},],}`;
    response.end(JSON.stringify({
      choices: [{ message: { content: payload } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({
    message: "生成第一版",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "ok");
  assert.deepEqual(result.patch?.[0], { op: "add", path: "/basicInfo/subtitle", value: "尾随逗号修复" });
});

test("模型返回字符串截断时可恢复", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    const payload = `{"reply":"已截断","patch":[{"op":"add","path":"/basicInfo/subtitle","value":"未完成的字符串`;
    response.end(JSON.stringify({
      choices: [{ message: { content: payload } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({
    message: "生成第一版",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "已截断");
  assert.equal(result.patch?.[0].value, "未完成的字符串");
});

test("工具调用参数回复字段未闭合引号时也能恢复", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    const payload = `{"reply":"截断回复字段内容`;
    response.end(JSON.stringify({
      choices: [{ message: { content: null, tool_calls: [{
        id: "tool_unfinished",
        type: "function",
        function: {
          name: "submit_product_update",
          arguments: payload,
        },
      }] } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({
    message: "生成第一版",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "截断回复字段内容");
  assert.deepEqual(result.patch, []);
});

test("回复字段使用单引号也能恢复", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    const payload = `{'reply':'单引号回复字段可解析','patch':[{"op":"add","path":"/basicInfo/subtitle","value":"单引号兼容"}`;
    response.end(JSON.stringify({
      choices: [{ message: { content: payload } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({
    message: "生成第一版",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "单引号回复字段可解析");
  assert.deepEqual(result.patch?.[0], { op: "add", path: "/basicInfo/subtitle", value: "单引号兼容" });
});

test("完整单引号对象会先修复后成功解析", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    const payload = `{'reply':'单引号对象可修复','patch':[{'op':'add','path':'/basicInfo/subtitle','value':'标题'}]}`;
    response.end(JSON.stringify({
      choices: [{ message: { content: payload } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({
    message: "生成第一版",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "单引号对象可修复");
  assert.deepEqual(result.patch?.[0], { op: "add", path: "/basicInfo/subtitle", value: "标题" });
});

test("非 JSON 的纯文本回复会回退为 reply", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{ message: { content: "已完成首轮整理，先给出建议。请稍后会补充 patch。" } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({
    message: "更新说明",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [{ day: 1 }, { day: 2 }] },
    history: [],
  });

  assert.equal(result.reply, "已完成首轮整理，先给出建议。请稍后会补充 patch。");
  assert.deepEqual(result.patch, []);
});

test("无 JSON 分隔符的 bare reply 会回退为文本", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{ message: { content: "reply: 已完成首轮结构草稿整理，先给出核心结论。" } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({
    message: "更新说明",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [{ day: 1 }, { day: 2 }] },
    history: [],
  });

  assert.equal(result.reply, "已完成首轮结构草稿整理，先给出核心结论。");
  assert.deepEqual(result.patch, []);
});

test("模型返回转义字符截断时可恢复", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    const payload = '{"reply":"转义断点","patch":[{"op":"add","path":"/basicInfo/subtitle","value":"未完成转义\\\\';
    response.end(JSON.stringify({
      choices: [{ message: { content: payload } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({
    message: "生成第一版",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "转义断点");
  assert.equal(result.patch?.[0].value, "未完成转义");
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

test("工具调用参数不可解析时会回退解析消息内容", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            reply: "回退到正文解析。",
            patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "内容回退·专车私享" }],
            questions: [],
            researchTasks: [],
          }),
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `{"reply":"截断参数", "patch":[`,
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
    message: "生成第一版",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "回退到正文解析。");
  assert.deepEqual(result.patch?.[0], { op: "replace", path: "/basicInfo/subtitle", value: "内容回退·专车私享" });
});

test("工具调用片段可解析时即使正文存在也会优先回填结构化结果", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: "已收到分步提示，先给出简要说明。",
          tool_calls: [{
            id: "tool_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'工具片段优先恢复。', patch:[{'op':'replace','path':'/basicInfo/subtitle','value':'太原慢线备选'}]`,
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
    message: "补充首版",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "工具片段优先恢复。");
  assert.deepEqual(result.patch?.[0], {
    op: "replace",
    path: "/basicInfo/subtitle",
    value: "太原慢线备选",
  });
});

test("全部工具调用参数不可解析且无正文时会降级返回原始文本", async (t) => {
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
              arguments: `reply字段缺失，仅有片段`,
            },
          }, {
            id: "call_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `继续返回片段`,
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
    message: "生成第一版",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "reply字段缺失，仅有片段\n继续返回片段");
  assert.deepEqual(result.patch, []);
});

test("结构化解析彻底失败时会提取裸 reply 字段继续处理", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{ message: { content: `"reply":"内容可回退"` } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({
    message: "生成第一版",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [{ day: 1 }, { day: 2 }] },
    history: [],
  });

  assert.equal(result.reply, "内容可回退");
  assert.deepEqual(result.patch, []);
  assert.deepEqual(result.questions, []);
});

test("多条工具调用中优先使用可解析的一条", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: "should not be used",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `{"reply":"截断参数", "patch":[`,
            },
          }, {
            id: "call_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: JSON.stringify({
                reply: "多条工具调用可恢复。",
                patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "工具回退序列" }],
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
    message: "生成第一版",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "多条工具调用可恢复。");
  assert.deepEqual(result.patch?.[0], { op: "replace", path: "/basicInfo/subtitle", value: "工具回退序列" });
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

test("非标准片段文本可恢复可回写字段与问题列表", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `reply:"已返回片段化结构。",patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"晋阳古韵·半日游"}],researchTasks:{"label":"核查门店开业时间","type":"web","detail":"确认门店营业时段"},questions:"本次方案是否继续补充高端玩法？"`,
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
    message: "生成第一版",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "已返回片段化结构。");
  assert.deepEqual(result.patch?.[0], {
    op: "replace",
    path: "/basicInfo/subtitle",
    value: "晋阳古韵·半日游",
  });
  assert.equal(result.questions?.[0], "本次方案是否继续补充高端玩法？");
  assert.equal(result.researchTasks?.[0].label, "核查门店开业时间");
  assert.equal(result.researchTasks?.[0].type, "web");
});

test("抓包片段风格响应可跳过 think 与噪音恢复结构化", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `<think>先校验可写字段边界</think>\n\n{"reply":"抓包片段测试通过，已构建完整草稿。","patch":[{"op":"replace","path":"/presentation","value":{"productName":"太原慢享2天","subtitle":"慢一点更有感觉","description":"以文化体验为主","highlights":["太原古城","晋祠"],"recommendation":"慢节奏体验。"}}],"questions":["是否继续补齐酒店信息？"],"researchTasks":[{"label":"确认景点当日排队时长","type":"web","detail":"查看当日预约是否开启"}]}` + "\n\nEND_OF_TURN",
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
    message: "补充首版",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "抓包片段测试通过，已构建完整草稿。");
  assert.equal(result.patch?.[0].path, "/presentation");
  assert.equal(result.questions?.[0], "是否继续补齐酒店信息？");
  assert.equal(result.researchTasks?.[0].label, "确认景点当日排队时长");
});

test("抓包参数片段（单引号）可恢复为结构化结果", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `reply:'抓包参数片段已恢复。',patch:[{'op':'replace','path':'/operations/transport','value':'charter'}],questions:['运输方案是否改为共享？'],researchTasks:{label:'确认高峰时段派车能力',type:'vbk',detail:'核对供应端可接待车辆'}`,
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
    message: "补充运输信息",
    product: { operations: { transport: "shared" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "抓包参数片段已恢复。");
  assert.equal(result.patch?.[0].value, "charter");
  assert.equal(result.questions?.[0], "运输方案是否改为共享？");
  assert.equal(result.researchTasks?.[0].type, "vbk");
});

test("工具调用片段可恢复基础结构", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "tool_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:"工具调用片段",patch:[{"op":"add","path":"/basicInfo/subtitle","value":"太原慢线"},],` ,
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
    message: "补充基础字段",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "工具调用片段");
  assert.equal(result.patch?.[0].path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0].value, "太原慢线");
});

test("抓包 data 前缀响应可跳过噪音还原结构化内容", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `data: {"reply":"抓包流式片段可恢复。","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原慢线包包"}],"questions":["是否继续补齐酒店信息？"],"researchTasks":{"label":"确认门票通道","type":"web","detail":"核对大巴专线当天可用性"}}\n: keep-alive`,
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
    message: "补充字段",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "抓包流式片段可恢复。");
  assert.equal(result.patch?.[0].value, "太原慢线包包");
  assert.equal(result.questions?.[0], "是否继续补齐酒店信息？");
  assert.equal(result.researchTasks?.[0].label, "确认门票通道");
});

test("工具调用参数片段带噪音单引号可完整恢复", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "tool_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `/*trace*/ reply:'工具参数片段带注释可恢复',patch:[{'op':'replace','path':'/basicInfo/subtitle','value':'太原慢线可恢复'}],questions:'请确认是否继续压缩景点密度？',researchTasks:{'label':'核查供应是否可接驳','type':'vbk','detail':'与 VBK 对接确认可安排接送时段'}`,
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
    message: "继续补齐",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "工具参数片段带注释可恢复");
  assert.equal(result.patch?.[0].value, "太原慢线可恢复");
  assert.equal(result.questions?.[0], "请确认是否继续压缩景点密度？");
  assert.equal(result.researchTasks?.[0].type, "vbk");
});

test("工具调用参数尾逗号片段在正文噪音下仍优先解析", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `<think>token 已落库，开始返回工具片段。</think>\n先给你一条提示`,
          tool_calls: [{
            id: "tool_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'工具调用尾逗号片段仍可恢复', patch:[{"op":"add","path":"/basicInfo/subtitle","value":"太原慢线尾逗号"},], questions:["是否需要补充高端玩法？"], researchTasks:[{"label":"确认用车加价规则","type":"web","detail":"核对工作日与周末差异",}],`,
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
    message: "继续调整",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "工具调用尾逗号片段仍可恢复");
  assert.equal(result.patch?.[0].path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0].value, "太原慢线尾逗号");
  assert.equal(result.questions?.[0], "是否需要补充高端玩法？");
});

test("多条工具调用中后续有效片段可覆盖前置无效片段", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: "先给你一个说明。",
          tool_calls: [{
            id: "tool_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'前置片段暂不可写', patch:[`,
            },
          }, {
            id: "tool_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'后置工具片段可覆盖', patch:[{"op":"add","path":"/basicInfo/subtitle","value":"太原续发备选"}],questions:['是否继续补充天数？']`,
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
    message: "补充基础字段",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "后置工具片段可覆盖");
  assert.equal(result.patch?.[0].value, "太原续发备选");
  assert.equal(result.questions?.[0], "是否继续补充天数？");
});

test("event/data 流式日志中会选择完整 JSON 片段恢复", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: [
            "event: message",
            'data: {"reply":"第一段截断","patch":[',
            "data: {\"reply\":\"事件流完整恢复。\",\"patch\":[{\"op\":\"add\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原事件流\"}]}",
          ].join("\n"),
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
    message: "继续补齐",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "事件流完整恢复。");
  assert.equal(result.patch?.[0].value, "太原事件流");
});

test("Unexpected end of JSON input 可恢复：后截断工具片段仍回填结构化草稿", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "tool_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'长度截断可恢复', patch:[{"op":"add","path":"/basicInfo/subtitle","value":"太原截断恢复"`,
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
    message: "继续补齐",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "长度截断可恢复");
  assert.equal(result.patch?.[0].value, "太原截断恢复");
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
  assert.equal(parsedBody.max_completion_tokens, 8192);
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
    activities: [{ time: "上午", title: "晋祠博物馆", detail: "参观古建筑", type: "other" }],
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
