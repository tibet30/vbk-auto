import { assert, MiniMaxService, MiniMaxServiceError, test } from "./minimax.core.shared.js";
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

test("工具调用参数回复字段未闭合引号时在重试兜底中恢复为可读文本", async (t) => {
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
  assert.equal(result.patch?.length, 0);
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

  assert.equal(result.reply, "reply: 已完成首轮结构草稿整理，先给出核心结论。");
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

test("tool 参数路径变体会映射为可写路径并恢复 patch", async (t) => {
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
              arguments: `{'reply':'路径变体可恢复','patch':[{'op':'add','path':'basic_info/subtitle','value':'太原路径容错'},{'op':'replace','path':'/operations/transport_mode','value':'charter'}]}`,
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
    message: "补充运输路径",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "路径变体可恢复");
  assert.equal(result.patch?.[0].path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0].value, "太原路径容错");
  assert.equal(result.patch?.[1].path, "/operations/transport");
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

test("真实抓包片段混入 HTTP Header 与 SSE 尾行可恢复结构化内容", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: [
            "HTTP/1.1 200 OK",
            "x-provider: minimax",
            "event: message",
            `data: {"reply":"HTTP 抓包片段可恢复。","patch":[{"op":"add","path":"/basicInfo/subtitle","value":"太原包头补齐"}],"questions":["是否继续补齐酒店信息？"],"researchTasks":{"label":"核对景点开放时段","type":"web","detail":"确认预约入口与时段"}}`,
            ": done",
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
    message: "继续生成",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "HTTP 抓包片段可恢复。");
  assert.equal(result.patch?.[0].value, "太原包头补齐");
  assert.equal(result.questions?.[0], "是否继续补齐酒店信息？");
  assert.equal(result.researchTasks?.[0].label, "核对景点开放时段");
});

test("工具片段分片拼接后可恢复 reply 与 patch", async (t) => {
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
              arguments: `event: tool-call\ndata: reply:"工具片段分片可拼接"`,
            },
          }, {
            id: "tool_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `,patch:[{"op":"add","path":"/basicInfo/subtitle","value":"太原碎片拼接"}]`,
            },
          }, {
            id: "tool_3",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `,questions:["是否继续按天数拆分？"],researchTasks:[{"label":"核查接驳时段","type":"vbk","detail":"查看可用上下午班次"}]}`,
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
    message: "补充参数",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "工具片段分片可拼接");
  assert.equal(result.patch?.[0].path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0].value, "太原碎片拼接");
  assert.equal(result.questions?.[0], "是否继续按天数拆分？");
  assert.equal(result.researchTasks?.[0].label, "核查接驳时段");
});

test("工具参数日志噪音（单引号+data 前缀）可直接恢复结构化", async (t) => {
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
              arguments: `trace: seg-2026-08-06\n// streaming chunk\n/* ignore */\n data: {'reply':'工具参数日志可恢复。','patch':[{'op':'replace','path':'/basicInfo/subtitle','value':'太原日志清洗'}],'questions':['是否继续压缩午餐时段？'],}`,
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
    message: "继续优化",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "工具参数日志可恢复。");
  assert.equal(result.patch?.[0].path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0].value, "太原日志清洗");
  assert.equal(result.questions?.[0], "是否继续压缩午餐时段？");
});

test("工具分片回填时，无结构化 tool + sparse 结构化应择优合并", async (t) => {
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
              arguments: `reply:"仅回复片段"`,
            },
          }, {
            id: "tool_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `,patch:[{"op":"add","path":"/basicInfo/subtitle","value":"太原择优回填"}],questions:["是否继续补齐交通节奏？"],researchTasks:[{"label":"核查天气","type":"web","detail":"确认明日降雨概率"}]}`,
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

  assert.equal(result.reply, "仅回复片段");
  assert.equal(result.patch?.[0].value, "太原择优回填");
  assert.equal(result.questions?.[0], "是否继续补齐交通节奏？");
  assert.equal(result.researchTasks?.[0].label, "核查天气");
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

test("首次生成无可写字段时会在重试后进入可读文本路径", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: "已生成方案。", patch: [], questions: [], researchTasks: [] }) } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({ message: "生成第一版", product: { itinerary: [] }, history: [] });
  assert.equal(result.patch?.length, 0);
  assert.equal(result.questions?.length, 0);
  assert.equal(result.researchTasks?.length, 0);
  assert.equal(result.reply, "已生成方案。");
});

test("首次生成仅返回核查任务时允许先落库并继续追问", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: {
      content: JSON.stringify({
        reply: "当前需先核实供应端可用性。",
        patch: [],
        questions: ["是否先补充接驳时段？"],
        researchTasks: [{ label: "核验接驳时段", type: "vbk", detail: "确认晚间高峰时段可接驳" }],
      }),
    } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({ message: "生成第一版", product: { itinerary: [] }, history: [] });

  assert.equal(result.reply, "当前需先核实供应端可用性。");
  assert.equal(result.questions?.[0], "是否先补充接驳时段？");
  assert.equal(result.researchTasks?.[0]?.label, "核验接驳时段");
  assert.equal(result.patch?.length, 0);
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

test("真实抓包片段：HTTP Header 与 SSE data 混排可恢复结构化内容", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: [
            "HTTP/1.1 200 OK",
            "x-provider: minimax",
            "date: Thu, 06 Aug 2026 08:00:00 GMT",
            "event: message",
            'data: {"reply":"抓包头部混排可恢复。","patch":[{"op":"add","path":"/basicInfo/subtitle","value":"太原头部抓包补齐"}],"questions":["是否继续补齐接送方案？"],"researchTasks":[{"label":"核验接驳时段","type":"vbk","detail":"确认下午接驳可用时段"}]}',
            ": keep-alive",
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
    message: "继续补充",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "抓包头部混排可恢复。");
  assert.equal(result.patch?.[0].value, "太原头部抓包补齐");
  assert.equal(result.questions?.[0], "是否继续补齐接送方案？");
  assert.equal(result.researchTasks?.[0].label, "核验接驳时段");
});

test("工具参数抓包日志片段可恢复并忽略 trace 噪音", async (t) => {
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
              arguments: `trace-id: 0x7f4d
event: tool-call
data: {'reply':'工具参数日志片段可恢复。','patch':[{'op':'replace','path':'/basicInfo/subtitle','value':'太原工具日志补齐'}],'questions':['是否继续压缩高峰期车程？'],'researchTasks':[{'label':'核查车队上限','type':'vbk','detail':'核对日均上限与司机时段'}]}`,
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
    message: "继续优化参数",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "工具参数日志片段可恢复。");
  assert.equal(result.patch?.[0].path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0].value, "太原工具日志补齐");
  assert.equal(result.questions?.[0], "是否继续压缩高峰期车程？");
  assert.equal(result.researchTasks?.[0].type, "vbk");
});

test("工具片段中第一段为 keep-alive，后续仅含可补齐字段也可恢复草稿", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "tool_1",
            type: "function",
            function: { name: "submit_product_update", arguments: ": heartbeat" },
          }, {
            id: "tool_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: message
data: reply:'工具片段日志拼接恢复',`,
            },
          }, {
            id: "tool_3",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `patch:[{"op":"add","path":"/basicInfo/subtitle","value":"太原工具片段拼接补齐"}],questions:['是否继续补充接驳文案？']`,
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
    message: "补齐文本",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "工具片段日志拼接恢复");
  assert.equal(result.patch?.[0].value, "太原工具片段拼接补齐");
  assert.equal(result.questions?.[0], "是否继续补充接驳文案？");
});

test("抓包样本中先报错头再返回有效 JSON，解析器会命中有效块", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: [
            "HTTP/1.1 500 Internal Server Error",
            'data: {"error":"temporary"}',
            "HTTP/1.1 200 OK",
            'event: done',
            'data: {"reply":"错误后重发块恢复成功","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原重试后恢复"}]}',
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
    message: "重试生成",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "错误后重发块恢复成功");
  assert.equal(result.patch?.[0].value, "太原重试后恢复");
});

test("抓包内容片段（非标准 JSON）中的路径变体可被稀疏解析容错", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `HTTP/1.1 200 OK\n`
            + "event: message\n"
            + `data: reply:'稀疏片段路径变体可恢复', patch:[{'op':'replace','path':'basic_info/subtitle','value':'太原稀疏恢复'},researchTasks:{label:'核对返程时段',type:'web',detail:'确认高峰下半场服务'},questions:['是否需要补齐返回方式？']}`,
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
    message: "补充研究任务",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "稀疏片段路径变体可恢复");
  assert.equal(result.patch?.[0].path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0].value, "太原稀疏恢复");
  assert.equal(result.researchTasks?.[0].label, "核对返程时段");
  assert.equal(result.questions?.[0], "是否需要补齐返回方式？");
});

test("中文冒号字段名分隔符也可被稀疏解析识别", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `reply：'支持中文冒号回复字段。',patch：[{ 'op':'add','path':'/basicInfo/subtitle','value':'太原中文冒号补齐'}],questions:['是否继续补充景点？'],researchTasks:{ label:'核对开放城市',type:'web' }`,
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
    message: "补齐字段",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "支持中文冒号回复字段。");
  assert.equal(result.patch?.[0].value, "太原中文冒号补齐");
  assert.equal(result.questions?.[0], "是否继续补充景点？");
  assert.equal(result.researchTasks?.[0].label, "核对开放城市");
});

test("中文逗号与等号分隔符组合也可被稀疏解析识别", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `reply='等号与中文逗号可解析',patch=[{'op':'add','path':'basic_info/subtitle','value':'太原中文分隔符补齐'}]，questions='是否继续补齐接驳？'`,
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
    message: "符号扰动",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "等号与中文逗号可解析");
  assert.equal(result.patch?.[0].value, "太原中文分隔符补齐");
  assert.equal(result.questions?.[0], "是否继续补齐接驳？");
});

test("多片段同键时会择优选取后置有效字段", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `reply:'噪音占位',patch:[{'op':'add','path':'/basicInfo/subtitle','value':'过早字段应丢弃'}]\nreply:'正式恢复字段',patch:[{'op':'add','path':'/basicInfo/subtitle','value':'太原多字段择优'}],questions:['是否继续核验？']`,
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
    message: "多片段覆盖",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "正式恢复字段");
  assert.equal(result.patch?.[0].value, "太原多字段择优");
  assert.equal(result.questions?.[0], "是否继续核验？");
});

test("同一内容内先出现占位 questions，后续标准 questions 与可写 patch 可覆盖", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `data: {"reply":"第一段噪音",questions:'占位问题'},reply:'最终问题可覆盖',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原问题覆盖"},questions:['是否继续分片问题？'],researchTasks:[{"label":"复核返程点","type":"web","detail":"确认返程车站接驳"}]}`,
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
    message: "覆盖 questions",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "最终问题可覆盖");
  assert.equal(result.questions?.[0], "是否继续分片问题？");
  assert.equal(result.patch?.[0].value, "太原问题覆盖");
  assert.equal(result.researchTasks?.[0].label, "复核返程点");
});

test("内容文本仅有纯提示时，工具片段补齐仍可择优回填结构化结果", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: [
            "HTTP/1.1 200 OK",
            "event: message",
            'data: "received"',
          ].join("\n"),
          tool_calls: [{
            id: "tool_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'文本提示噪音会回退，工具片段补齐。'`,
            },
          }, {
            id: "tool_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `,patch:[{"op":"add","path":"operations/transport_mode","value":"charter"}],questions:['是否继续压缩行程长度？']`,
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
    message: "继续补齐字段",
    product: { operations: { transport: "shared" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "文本提示噪音会回退，工具片段补齐。");
  assert.equal(result.patch?.[0].path, "/operations/transport");
  assert.equal(result.patch?.[0].value, "charter");
  assert.equal(result.questions?.[0], "是否继续压缩行程长度？");
});

test("抓包稀疏片段中多个 patch 字段会合并，而非只取后置一段", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `patch:[{'op':'add','path':'basic_info/subtitle','value':'第一段 patch'},patch:[{'op':'replace','path':'operations/transport_mode','value':'shared'}],reply:'多段 patch 已合并'`,
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
    message: "多段 patch",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "多段 patch 已合并");
  assert.equal(result.patch?.[0].path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0].value, "第一段 patch");
  assert.equal(result.patch?.[1].path, "/operations/transport");
  assert.equal(result.patch?.[1].value, "shared");
});

test("连字符 transport-mode 路径也会归一化到标准路径", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `patch:[{"op":"replace","path":"/operations/transport-mode","value":"charter"}],reply:'连字符路径已归一化'`,
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
    message: "修正路径",
    product: { operations: { transport: "shared" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.patch?.[0].path, "/operations/transport");
  assert.equal(result.patch?.[0].value, "charter");
  assert.equal(result.reply, "连字符路径已归一化");
});

test("抓包片段含多段 SSE 与 [DONE] 噪音时仍能回填结构化草稿", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    const payload = [
      "HTTP/1.1 200 OK",
      "date: Thu, 06 Aug 2026 10:00:00 GMT",
      "event: message",
      'data: {"reply":"第一段为日志提示","questions":["是否继续补齐行程说明？"]}',
      ": keep-alive",
      "event: message",
      'data: {"reply":"最终应以此段为准","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原DONE片段修复"}]}',
      "data: [DONE]",
      'http/1.1 200 OK',
    ].join("\n");
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
    message: "补齐片段",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "最终应以此段为准");
  assert.equal(result.patch?.[0]?.value, "太原DONE片段修复");
  assert.equal(result.questions?.[0], "是否继续补齐行程说明？");
});

test("工具参数内夹带 event/data 头并分片时会择优提取可用结构", async (t) => {
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
              arguments: "event: heartbeat\n: keep-alive",
            },
          }, {
            id: "tool_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: "event: message\ndata: reply:'工具参数片段可覆盖',researchTasks:[{'label':'核查晚间入住窗口','type':'vbk','detail':'核对酒店接驳时段'}]",
            },
          }, {
            id: "tool_3",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: "data: reply:'工具参数片段可覆盖',patch:[{\"op\":\"add\",\"path\":\"basic_info/subtitle\",\"value\":\"太原工具参数补齐\"}]",
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
    message: "工具片段补齐",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "工具参数片段可覆盖");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原工具参数补齐");
  assert.equal(result.researchTasks?.[0]?.label, "核查晚间入住窗口");
});

test("HTTP/1.1 与 JSON 混排时，研究任务与问题可从后置块回填", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    const payload = [
      "HTTP/1.1 200 OK",
      "content-type: application/json",
      'data: {"reply":"首段仅回显","questions":["是否继续补齐行程说明？"]}',
      'event: warning',
      'data: {"reply":"最终结构回填","questions":["占位问题"]}',
      "event: done",
      'data: {"reply":"最终结构回填","patch":[{"op":"replace","path":"operations/reuse_pickup_for_dropoff","value":true}],"researchTasks":[{"label":"核对接驳车型","type":"vbk","detail":"确认车辆型号与时段"}],"questions":["是否继续补齐接送文案？"]}',
      ": done",
    ].join("\n");
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
    message: "补齐接驳",
    product: { operations: { transport: "charter", reusePickupForDropoff: false }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "最终结构回填");
  assert.equal(result.patch?.[0]?.path, "/operations/reusePickupForDropoff");
  assert.equal(result.patch?.[0]?.value, true);
  assert.equal(result.questions?.[0], "是否继续补齐接送文案？");
  assert.equal(result.researchTasks?.[0]?.label, "核对接驳车型");
});

test("工具参数片段与 message 结构体混合时不会误采样空 reply", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `data: {"reply":"抓包提示", "questions":"占位问题"}\ndata: {"reply":"结构体优先", "patch":[{"op":"replace","path":"basic_info/subtitle","value":"抓包补齐标题"}], "researchTasks":[{"label":"核实服务能力","type":"vbk","detail":"确认是否支持双司机"}]}`,
          tool_calls: [{
            id: "tool_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: "event: heartbeat",
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
    message: "混合片段优先",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "结构体优先");
  assert.equal(result.patch?.[0]?.value, "抓包补齐标题");
  assert.equal(result.questions?.[0], "占位问题");
  assert.equal(result.researchTasks?.[0]?.label, "核实服务能力");
});

test("抓包片段中的重复路径片段可保留最先可用的 patch 并标准化写入", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `reply:"重复路径可回收",patch:[{"op":"add","path":"basic_info/subtitle","value":"重复路径第一版"}],researchTasks:[{'label':'核查第一版资源','type':'web','detail':'确认第一版可售'}]
event: message
data: reply='第二段覆盖',patch=[{"op":"replace","path":"operations/transport-mode","value":"shared"}],questions='是否继续核实？'`,
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
    message: "重复路径片段",
    product: { basicInfo: { meetingCity: "太原" }, operations: { transport: "charter" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "第二段覆盖");
  assert.equal(result.patch?.[0].path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0].value, "重复路径第一版");
  assert.equal(result.patch?.[1].path, "/operations/transport");
  assert.equal(result.patch?.[1].value, "shared");
  assert.equal(result.questions?.[0], "是否继续核实？");
});

test("add/replace 缺 value 的 patch 会被丢弃，不再触发后续结构化落库失败", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{ message: {
        content: `event: message
data: {"reply":"已读取到无 value 补丁，将其忽略", "patch":[{"op":"add","path":"basic_info/subtitle"},{"op":"replace","path":"operations/transport-mode","value":"shared"},{"op":"remove","path":"/itinerary"}]}`,
      } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({
    message: "补齐标题与运输方式",
    product: { operations: { transport: "charter" }, basicInfo: { meetingCity: "太原" }, itinerary: [{ day: 1 }] },
    history: [],
  });

  assert.equal(result.reply, "已读取到无 value 补丁，将其忽略");
  assert.equal(result.patch?.[0]?.path, "/operations/transport");
  assert.equal(result.patch?.[1]?.path, "/itinerary");
  assert.equal(result.patch?.length, 2);
});

test("无引号 reply 遇中文逗号分隔时可正确回填补齐字段", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{ message: {
        content: `reply: 已回填首段，patch:[{"op":"replace","path":"basic_info/subtitle","value":"太原首段标题"}],questions=['是否继续确认接送方案？']`,
      } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({
    message: "补齐中文逗号分隔场景",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "已回填首段");
  assert.equal(result.patch?.[0].path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0].value, "太原首段标题");
  assert.equal(result.questions?.[0], "是否继续确认接送方案？");
});

test("抓包流中先 header 后有效 event/data JSON 可恢复 patch 与回复", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: [
            "HTTP/1.1 200 OK",
            "server: minimax",
            "event: message",
            'data: {"reply":"未闭合 JSON 已补齐","patch":[{"op":"add","path":"basic_info/subtitle","value":"太原日志片段补齐"}]',
            "event: message",
            'data: [DONE]',
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
    message: "继续生成",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "未闭合 JSON 已补齐");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原日志片段补齐");
});

test("工具调用中带心跳与 keep-alive 片段后，后置标准参数仍可回填", async (t) => {
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
              arguments: ": heartbeat\nevent: done\n",
            },
          }, {
            id: "tool_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: message\ndata: reply:'工具片段补齐',patch:[{'op':'add','path':'basic_info/subtitle','value':'太原工具补齐'}]`,
            },
          }, {
            id: "tool_3",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `: keep-alive\nquestions=['是否继续核实接驳？'],researchTasks:[{"label":"核对司机时段","type":"vbk","detail":"确认接驳高峰时段"}]`,
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
    message: "工具片段补齐",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "工具片段补齐");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原工具补齐");
  assert.equal(result.questions?.[0], "是否继续核实接驳？");
  assert.equal(result.researchTasks?.[0]?.label, "核对司机时段");
});

test("content 与 tool_call 并行返回时，先解析可用 tool_call 后再择优保留后置 content", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: "先给一条提示",
          tool_calls: [{
            id: "tool_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'后置 tool 可恢复',patch:[{"op":"replace","path":"operations/transport-mode","value":"charter"}]`,
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
    message: "并行片段",
    product: { operations: { transport: "shared" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "后置 tool 可恢复");
  assert.equal(result.patch?.[0]?.path, "/operations/transport");
  assert.equal(result.patch?.[0]?.value, "charter");
});

test("工具参数片段缺 key 分隔符但 JSON 已修复可继续解析", async (t) => {
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
              arguments: `event: tool-call\ndata: reply:'分隔符丢失也可恢复',patch:[{'op':'replace','path':'basic_info/subtitle','value':'太原分隔符丢失'}],questions ['是否继续压缩行程？'],researchTasks [{'label':'核对景点门票','type':'web','detail':'确认黄河文化景点当日票务'}]`,
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
    message: "分隔符丢失",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "分隔符丢失也可恢复");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原分隔符丢失");
  assert.equal(result.questions?.length ?? 0, 0);
  assert.equal(result.researchTasks?.length ?? 0, 0);
});

test("真实抓包片段：reply 与 patch 无分隔符连写时仍可恢复结构化结果", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `reply:'抓包日志中键未加逗号',patch:[{"op":"replace","path":"basic_info/subtitle","value":"太原无分隔符修复"}],questions:['是否继续补齐酒店信息？'],researchTasks:[{"label":"确认景点接待","type":"web","detail":"核对景点当日限流"}]`,
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
    message: "无分隔符重试",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "抓包日志中键未加逗号");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原无分隔符修复");
  assert.equal(result.questions?.[0], "是否继续补齐酒店信息？");
  assert.equal(result.researchTasks?.[0]?.label, "确认景点接待");
});

test("真实抓包片段：SSE 片段中 patch 后紧跟 questions，无分隔符仍可复原", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: [
            "HTTP/1.1 200 OK",
            "event: message",
            'data: reply:"SSE 片段已闭合",patch:[{"op":"add","path":"operations/transport_mode","value":"charter"}]questions:["是否继续补齐接驳时段？"]',
            "event: done",
            ": done",
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
    message: "SSE 片段复原",
    product: { operations: { transport: "shared" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "SSE 片段已闭合");
  assert.equal(result.patch?.[0]?.path, "/operations/transport");
  assert.equal(result.patch?.[0]?.value, "charter");
  assert.equal(result.questions?.[0], "是否继续补齐接驳时段？");
});

test("真实抓包片段：工具片段内 key 串联，后续片段仍可拼回", async (t) => {
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
              arguments: `reply:"工具片段串联",patch:[{"op":"add","path":"operations/reuse_pickup_for_dropoff","value":false}]questions:['是否继续核查接驳窗口？'],researchTasks:[{"label":"确认晚间接驳","type":"vbk","detail":"核对夜间接驳是否可用"}]`,
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
    message: "工具串联片段",
    product: { operations: { transport: "charter", reusePickupForDropoff: true }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "工具片段串联");
  assert.equal(result.patch?.[0]?.path, "/operations/reusePickupForDropoff");
  assert.equal(result.patch?.[0]?.value, false);
  assert.equal(result.questions?.[0], "是否继续核查接驳窗口？");
  assert.equal(result.researchTasks?.[0]?.label, "确认晚间接驳");
});

test("工具参数中 patch 单对象也可恢复为结构化更新", async (t) => {
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
              arguments: `event: tool-call\ndata: reply:'单对象 patch 已返回',patch:{"op":"replace","path":"operations/transport-mode","value":"charter"}`,
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
    message: "确认单对象 patch",
    product: { operations: { transport: "shared" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "单对象 patch 已返回");
  assert.equal(result.patch?.[0]?.path, "/operations/transport");
  assert.equal(result.patch?.[0]?.value, "charter");
});

test("内容片段里 patch 对象也可提取到可写字段", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `reply='content 片段对象 patch',patch={'op':'replace','path':'basic_info/subtitle','value':'太原片段对象标题'},questions=['是否继续补齐接驳？'],researchTasks={'label':'补齐夜间接驳节点','type':'vbk','detail':'确认夜间班车可行性'}`,
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
    message: "content 片段补齐",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "content 片段对象 patch");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原片段对象标题");
  assert.equal(result.questions?.[0], "是否继续补齐接驳？");
  assert.equal(result.researchTasks?.[0]?.label, "补齐夜间接驳节点");
});

test("真实抓包片段：tool-call 参数跨调用拼接仍可恢复结构化输出", async (t) => {
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
              arguments: `event: tool-call\ndata: reply:'跨调用片段可恢复',`,
            },
          }, {
            id: "tool_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `patch:[{"op":"add","path":"basic_info/title","value":"太原跨片段标题"}],questions:['是否继续补齐酒店夜间段？'],researchTasks:{'label':'核对晚间接驳','type':'vbk','detail':'确认夜间接驳可落地'}`
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

  assert.equal(result.reply, "跨调用片段可恢复");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原跨片段标题");
  assert.equal(result.questions?.[0], "是否继续补齐酒店夜间段？");
  assert.equal(result.researchTasks?.[0]?.label, "核对晚间接驳");
});

test("真实抓包片段：SSE keep-alive 与 [DONE] 包裹时仍恢复", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `: keep-alive
data: {"reply":"SSE 旧片段应忽略","questions":["是否继续？"]}
: done
data: [DONE]
data: {"reply":"SSE 覆盖旧片段","patch":[{"op":"replace","path":"operations/transport-mode","value":"shared"}],"questions":["是否继续补齐行程说明？"]}`,
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
    message: "补齐流式片段",
    product: { operations: { transport: "charter" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "SSE 覆盖旧片段");
  assert.equal(result.patch?.[0]?.path, "/operations/transport");
  assert.equal(result.patch?.[0]?.value, "shared");
  assert.equal(result.questions?.[0], "是否继续补齐行程说明？");
});

test("真实抓包片段：trace 行与 content 干扰共存时，content 结构化优先", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `event: message
data: {"reply":"结构体内容优先","patch":[{"op":"replace","path":"basic_info/subtitle","value":"太原内容优先标题"}],"researchTasks":[{"label":"核对景点时段","type":"web","detail":"确认门票是否支持下午场"}]}
: heartbeat
data: {"reply":"过期覆盖", "questions":["占位问题"]}`,
          tool_calls: [{
            id: "tool_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `trace: seg-20260806\ndata: reply:'工具参数占位'`,
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
    message: "恢复流式内容优先",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "结构体内容优先");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原内容优先标题");
  assert.equal(result.researchTasks?.[0]?.label, "核对景点时段");
});

test("真实抓包片段：工具参数中 JSON fence 与研究任务对象并行", async (t) => {
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
              arguments: `trace-id: seg-1
data: \`\`\`json
reply:"Fence 片段恢复",`,
            },
          }, {
            id: "tool_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `patch=[{"op":"add","path":"/presentation","value":{"productName":"太原慢游","subtitle":"夜间舒缓版","description":"慢节奏体验","highlights":["太原古城","运河夜景"],"recommendation":"夜色体验为主"}},researchTasks:[{"label":"核对夜间景点开放","type":"web","detail":"确认夜游景点售票"}]\`\`\``,
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
    message: "检查 fence 片段",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "Fence 片段恢复");
  assert.equal(result.patch?.[0]?.path, "/presentation");
  assert.equal(result.patch?.[0]?.value?.productName, "太原慢游");
  assert.equal(result.patch?.[0]?.value?.subtitle, "夜间舒缓版");
  assert.equal(result.questions.length, 0);
  assert.equal(result.researchTasks?.[0]?.label, "核对夜间景点开放");
});

test("真实抓包片段：多 data 帧与 [DONE] 混排时仍按最新 JSON 回复提取", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: [
            "HTTP/1.1 200 OK",
            "event: message",
            `data: {"reply":"历史片段先出","patch":[{"op":"add","path":"/basicInfo/subtitle","value":"太原旧片段"}],"questions":["是否继续补齐接驳？"]}`,
            ": keep-alive",
            "data: [DONE]",
            `data: {"reply":"最终片段应生效","patch":[{"op":"replace","path":"/operations/transport_mode","value":"shared"}],"questions":["是否继续补齐酒店？"],"researchTasks":[{"label":"核验夜间接驳","type":"vbk","detail":"确认夜间接驳时段"]}`,
            ": done",
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

  assert.equal(result.reply, "最终片段应生效");
  assert.equal(result.patch?.[0]?.path, "/operations/transport");
  assert.equal(result.patch?.[0]?.value, "shared");
  assert.equal(result.questions?.[0], "是否继续补齐酒店？");
  assert.equal(result.researchTasks?.[0]?.label, "核验夜间接驳");
});

test("真实抓包片段：工具参数首段心跳后，后续 object patch 可被恢复", async (t) => {
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
              arguments: ": heartbeat",
            },
          }, {
            id: "tool_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'对象 patch 复原',patch:{'op':'replace','path':'/basic_info/title','value':'太原对象标题'}`,
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
    message: "对象 patch",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "对象 patch 复原");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原对象标题");
});

test("真实抓包片段：评论行和中文冒号字段可在一个噪音响应里恢复", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: [
            "/**抓包注释*/",
            "HTTP/1.1 200 OK",
            "X-Trace: abc-123",
            `reply：'中文冒号与噪音可恢复',patch=[{'op':'add','path':'/basic_info/title','value':'太原中文冒号'},researchTasks={'label':'核对高峰时段','type':'web','detail':'确认晚间接驳时段'},questions=['是否继续补齐时段？']`,
            "",
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
    message: "补齐中文字段",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "中文冒号与噪音可恢复");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原中文冒号");
  assert.equal(result.researchTasks?.[0]?.label, "核对高峰时段");
  assert.equal(result.questions?.[0], "是否继续补齐时段？");
});

test("真实抓包片段：tool-call 与 content 混合输出，content 无结构但有最强 patch 仍可采", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `event: message\ndata: "只是提示，不含结构化内容。`,
          tool_calls: [{
            id: "tool_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: tool-call\ndata: reply:'tool 混合可恢复',patch:[{'op':'replace','path':'operations/transport-mode','value':'charter'}],researchTasks:[{"label":"核查司机班次","type":"vbk","detail":"确认夜间与高峰车型可用"}]`,
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
    message: "混合场景",
    product: { operations: { transport: "shared" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "tool 混合可恢复");
  assert.equal(result.patch?.[0]?.path, "/operations/transport");
  assert.equal(result.patch?.[0]?.value, "charter");
  assert.equal(result.researchTasks?.[0]?.label, "核查司机班次");
});

test("真实抓包片段：top-level JSON 缺失 reply 但包含 patch 时可用兜底文本落库", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `{"patch":[{"op":"add","path":"/basic_info/title","value":"太原缺少 reply 标题"}],"questions":["是否继续补齐接驳？"],"researchTasks":[{"label":"核对车队覆盖范围","type":"vbk","detail":"确认晚间可用车型"}]}`,
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
    message: "缺少 reply", 
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.match(result.reply, /未获取到正文/);
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原缺少 reply 标题");
  assert.equal(result.questions?.[0], "是否继续补齐接驳？");
  assert.equal(result.researchTasks?.[0]?.label, "核对车队覆盖范围");
});

test("真实抓包片段：tool-call 片段缺失 reply 但可从 patch、questions 回填", async (t) => {
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
              arguments: `patch=[{"op":"replace","path":"operations/transport-mode","value":"charter"}],questions=["是否继续核实接驳？"]`,
            },
          }, {
            id: "tool_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `researchTasks=[{"label":"核对夜间接驳","type":"vbk","detail":"确认夜间是否可接驳"}]`,
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
    message: "缺失 reply tool-call", 
    product: { operations: { transport: "shared" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.patch?.[0]?.path, "/operations/transport");
  assert.equal(result.patch?.[0]?.value, "charter");
  assert.equal(result.questions?.[0], "是否继续核实接驳？");
  assert.equal(result.researchTasks?.[0]?.label, "核对夜间接驳");
  assert.equal(result.reply.includes("patch"), true);
});

test("真实抓包片段：tool-call 分片片头为噪音，片尾仅有 reply 与 researchTasks 仍可回填", async (t) => {
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
              arguments: `: heartbeat\nevent: tool-call`,
            },
          }, {
            id: "tool_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: message\nreply:'片段最后恢复',researchTasks=[{"label":"核验晚高峰","type":"web","detail":"确认晚高峰流量风险"}]`,
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
    message: "片尾恢复", 
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "片段最后恢复");
  assert.equal(result.researchTasks?.[0]?.label, "核验晚高峰");
});

test("真实抓包片段：content 多段 keep-alive/DONE 干扰仍可取最终结构化回复", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `: keep-alive
data: [DONE]
: ping
data: {"reply":"最终可恢复","patch":[{"op":"add","path":"/basicInfo/subtitle","value":"太原抓包恢复标题"}],"questions":["是否继续补齐夜间安排？"]}`,
          tool_calls: [],
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
    message: "事件流恢复",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "最终可恢复");
  assert.equal(result.patch?.[0].path, "/basicInfo/subtitle");
  assert.equal(result.questions?.[0], "是否继续补齐夜间安排？");
});

test("真实抓包片段：tool-call 截断 JSON 可在后续片段修复并回填", async (t) => {
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
              arguments: `event: tool-call
: keep-alive`,
            },
          }, {
            id: "tool_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: message
data: {"reply":"截断 JSON 已修复","patch":[{"op":"replace","path":"/operations/transport-mode","value":"charter"}]`,
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
    message: "工具参数截断",
    product: { operations: { transportMode: "shared" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "截断 JSON 已修复");
  assert.equal(result.patch?.[0]?.path, "/operations/transport-mode");
  assert.equal(result.patch?.[0]?.value, "charter");
});

test("真实抓包片段：tool-call 重试参数包含 [DONE] 与 researchTasks 仍可回填结构化草稿", async (t) => {
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
              arguments: `event: message
data: {"reply":"第一版重试",
: keep-alive
data: [DONE]`,
            },
          }, {
            id: "tool_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: message
data: {'reply':'重试后恢复','patch':[{'op':'add','path':'/basicInfo/subtitle','value':'太原重试标题'}],'researchTasks':[{'label':'核对退改规则','type':'web','detail':'确认夜间改签政策'}]`,
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
    message: "重试后恢复",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "重试后恢复");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.researchTasks?.[0]?.label, "核对退改规则");
});

test("真实抓包片段：content 无结构化回复时以 tool-call 覆盖最终结构块", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `event: message
: keep-alive
data: {"reply":"仅提示，后续请忽略"}`
          ,
          tool_calls: [{
            id: "tool_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: message
data: {"reply":"以工具参数为准","patch":[{"op":"replace","path":"/operations/transport-mode","value":"shared"}],"questions":["是否继续补齐接驳说明？"]}`,
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
    message: "覆盖优先",
    product: { operations: { transportMode: "charter" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "以工具参数为准");
  assert.equal(result.patch?.[0]?.path, "/operations/transport-mode");
  assert.equal(result.questions?.[0], "是否继续补齐接驳说明？");
});

test("真实抓包片段：content 先行 + 工具重试片段补齐，结构化应以工具参数为准", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: [
            "HTTP/1.1 200 OK",
            "event: message",
            'data: {"reply":"content 先行结构化","patch":[{"op":"replace","path":"basic_info/title","value":"内容标题早发"}],"questions":["是否继续补齐酒店？"]}',
            "event: done",
          ].join("\n"),
          tool_calls: [{
            id: "tool_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `: keep-alive
event: tool-call`,
            },
          }, {
            id: "tool_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: message
data: reply:'工具重试片段补齐',patch:[{"op":"add","path":"operations/transport-mode","value":"charter"},{"op":"replace","path":"basic_info/subtitle","value":"太原工具重试标题"}],questions:["是否继续核对接驳说明？"],researchTasks:[{"label":"核实退改规则","type":"web","detail":"确认夜间退改政策"}]`,
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
    message: "重试补齐",
    product: { basicInfo: { meetingCity: "太原" }, operations: { transport: "shared" }, itinerary: [] },
    history: [],
  });

  assert.equal(result.reply, "工具重试片段补齐");
  assert.equal(result.patch?.[0]?.path, "/operations/transport");
  assert.equal(result.patch?.[0]?.value, "charter");
  assert.equal(result.patch?.[1]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[1]?.value, "太原工具重试标题");
  assert.equal(result.questions?.[0], "是否继续核对接驳说明？");
  assert.equal(result.researchTasks?.[0]?.label, "核实退改规则");
});

test("真实抓包片段：仅 tool-call 有可写字段且无 reply 时 fallback 仍可落库", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `data: {"reply":"content 包含临时提示", "patch":[{"op":"replace","path":"basic_info/title","value":"临时标题"}]}`,
          tool_calls: [{
            id: "tool_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: ": heartbeat",
            },
          }, {
            id: "tool_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: message
data: {"patch":[{"op":"add","path":"operations/transport_mode","value":"shared"},{"op":"replace","path":"basic_info/title","value":"太原无 reply 标题"}],"questions":["是否继续补齐接驳说明？"],"researchTasks":[{"label":"核验退改政策","type":"vbk","detail":"确认夜间改签是否可免收"}]}`,
            },
          }, {
            id: "tool_3",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `: done`,
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
    message: "工具 fallback",
    product: { operations: { transport: "charter" }, basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.match(result.reply, /未获取到正文/);
  assert.equal(result.patch?.[0]?.path, "/operations/transport");
  assert.equal(result.patch?.[0]?.value, "shared");
  assert.equal(result.patch?.[1]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[1]?.value, "太原无 reply 标题");
  assert.equal(result.researchTasks?.[0]?.label, "核验退改政策");
});

test("真实抓包片段：结构化失败首轮无 tool-call 时保留原始失败原因，支持重试提示", async (t) => {
  let requestCount = 0;
  const failurePayload = "event: message\ndata: [payload] [DONE] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }；请检查连接或配置后重试。";

  const server = createServer((_request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{ message: { content: failurePayload, tool_calls: [] } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "test-model",
  });

  let caught: unknown;
  try {
    await service.reply({
      message: "生成第一版",
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });
    assert.fail("应触发 structured output 失败");
  } catch (error) {
    caught = error;
  }

  const failure = caught as MiniMaxServiceError;
  assert.ok(failure instanceof MiniMaxServiceError);
  assert.equal(failure.code, "invalid_model_output");
  assert.ok(failure.details?.includes("structured response rejected"));
  assert.ok(failure.details?.includes("Unexpected end of JSON input"));
  assert.equal(requestCount, 5);
});
