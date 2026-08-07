import { assert, MiniMaxService, test } from "./minimax.core.shared.js";
import { parseJson } from "../../src/main/minimax/minimax-parsing.js";
import { createServer } from "node:http";

test("真实抓包片段：tool-call 噪音里交错内容时仍按 tool-call 覆盖为结构化草稿", async (t) => {
  const rawPayload = `event: message\n
data: 系统状态: 运行中，请忽略以下片段\n
tool_call: reply:'无效提示文本但可忽略'`;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: rawPayload,
          tool_calls: [{
            id: "tool_call_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: tool-call\nreply:'已确认工具参数优先',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原夜游"}],questions:['是否继续核对首晚？']`,
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

  assert.equal(result.reply, "已确认工具参数优先");
  assert.equal(result.patch?.[0].op, "replace");
  assert.equal(result.patch?.[0].value, "太原夜游");
  assert.equal(result.questions?.[0], "是否继续核对首晚？");
});

test("真实抓包片段：tool-call 与 content 混合，content 无结构时仍取可修复 tool-call", async (t) => {
  const parsed = parseJson(`HTTP/1.1 200 OK\ndata: keep-alive\n\n{"reply":"结构化内容先到达","patch":[{"op":"add","path":"/basicInfo/subtitle","value":"清晨天坛"}],"researchTasks":[{"label":"核对酒店","type":"web","detail":"确认晚间可订"}]}`);
  assert.equal(parsed.isStructured, true);
  assert.equal(parsed.response.reply, "结构化内容先到达");
  assert.equal(parsed.response.patch?.[0].value, "清晨天坛");
  assert.equal(parsed.response.researchTasks?.[0].label, "核对酒店");
});

test("真实抓包片段：patch 引号字符串存在前导空白时可解析为结构化草稿", () => {
  const parsed = parseJson(`event: message
data: reply:'前导空白字符串可恢复',patch:" [ {'op':'add','path':'/basicInfo/subtitle','value':'太原前导空白补齐'} ,{'op':'replace','path':'/basicInfo/title','value':'太原夜色'} ]",questions:['是否继续补齐接驳时段？'],researchTasks:{'label':'核验夜间接驳','type':'vbk','detail':'确认夜间接驳是否有班次'}`);
  assert.equal(parsed.isStructured, true);
  assert.equal(parsed.response.reply, "前导空白字符串可恢复");
  assert.equal(parsed.response.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(parsed.response.patch?.[0]?.value, "太原前导空白补齐");
  assert.equal(parsed.response.patch?.[1]?.path, "/basicInfo/subtitle");
  assert.equal(parsed.response.questions?.[0], "是否继续补齐接驳时段？");
  assert.equal(parsed.response.researchTasks?.[0]?.type, "vbk");
});

test("真实抓包片段：tool-call 的 patch 字符串带前导空白仍按官方工具参数落盘", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: "tool-call 在恢复中补齐 patch",
          tool_calls: [{
            id: "tool_patch_string_ws",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: tool-call
data: reply:'tool-call 前导空白可恢复',patch:" [ {'op':'replace','path':'/basicInfo/subtitle','value':'太原工具白空补齐'} ]",questions:['该团期是否继续补齐夜间安排？']`,
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

  assert.equal(result.reply, "tool-call 前导空白可恢复");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原工具白空补齐");
  assert.equal(result.questions?.[0], "该团期是否继续补齐夜间安排？");
});

test("真实抓包片段：10 次调用中前导空白工具参数仍能保持 10/10 落盘", async (t) => {
  const responses: string[] = [
    `event: message
data: {"reply":"抓包 span-01","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原空白-01"}]}`,
    `event: message
data: {"reply":"抓包 span-02","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原空白-02"}]}`,
    `event: message
data: reply:'抓包 span-03',patch:" [ {'op':'replace','path':'/basicInfo/subtitle','value':'太原空白-03'} ]",questions:['是否继续补齐接驳？']`,
    `event: message
data: {"reply":"抓包 span-04","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原空白-04"}],"questions":["是否继续补齐接驳？"]}`,
    `event: message
data: {"reply":"抓包 span-05","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原空白-05"}]}`,
    `event: message
data: {"reply":"抓包 span-06","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原空白-06"}]}`,
    `event: message
data: {"reply":"抓包 span-07","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原空白-07"}]}`,
    `event: message
data: {"reply":"抓包 span-08","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原空白-08"}]}`,
    `event: message
data: {"reply":"抓包 span-09","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原空白-09"}]}`,
    `event: message
data: {"reply":"抓包 span-10","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原空白-10"}]}`,
  ];
  let requestCount = 0;
  const server = createServer((_request, response) => {
    const current = responses[Math.min(requestCount, responses.length - 1)];
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: current } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  let structuredCount = 0;
  for (let index = 0; index < 10; index += 1) {
    const result = await service.reply({
      message: "生成第一版",
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });
    if ((result.patch?.length ?? 0) > 0) structuredCount += 1;
  }

  assert.equal(requestCount, 10);
  assert.equal(structuredCount, 10);
});

test("真实抓包片段：首次生成仅返回核查任务与追问时仍保留为可继续流程", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "tool_check",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:"请先核查资源可用性。",questions:["该团期是否需要同步更新酒店？"],researchTasks:[{"label":"核验价格库存","type":"cost","detail":"对比最新核验价与历史价差"}]`,
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

  assert.equal(result.patch?.length, 0);
  assert.equal(result.questions?.[0], "该团期是否需要同步更新酒店？");
  assert.equal(result.researchTasks?.[0].label, "核验价格库存");
});

test("真实抓包片段：首次生成返回结构化失效时自动重试并拿到可写补丁", async (t) => {
  let requestCount = 0;
  let secondRequestBody = "";
  const server = createServer((request, response) => {
    requestCount += 1;
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      if (requestCount === 2) secondRequestBody = body;
      if (requestCount === 1) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          choices: [{
            message: { content: "系统抓到第一段：先给你说明信息，稍后补齐结构化字段。" },
          }],
        }));
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              reply: "已触发重试并补齐首版。",
              patch: [{ op: "add", path: "/basicInfo/subtitle", value: "太原一日速览（补齐）" }],
              questions: [],
              researchTasks: [],
            }),
          },
        }],
      }));
    });
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

  assert.equal(result.patch?.[0].op, "add");
  assert.equal(result.patch?.[0].value, "太原一日速览（补齐）");
  assert.equal(requestCount, 2);
  const parsedSecondBody = JSON.parse(secondRequestBody) as { messages?: Array<{ content: string }> };
  const retryPrompt = parsedSecondBody.messages?.[parsedSecondBody.messages.length - 1]?.content ?? "";
  assert.match(retryPrompt, /上一次返回未通过结构化校验/);
});

test("真实抓包片段：tool-call 首次参数截断触发重试后可恢复", async (t) => {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      if (requestCount === 1) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "tool_retry_1",
                type: "function",
                function: {
                  name: "submit_product_update",
                  arguments: `reply:'抓包片段截断`,
                },
              }],
            },
          }],
        }));
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "tool_retry_2",
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: `data: {"reply":"工具片段重试成功","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原夜线重试"}]}`,
              },
            }],
          },
        }],
      }));
    });
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

  assert.equal(result.reply, "工具片段重试成功");
  assert.equal(result.patch?.[0].path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0].value, "太原夜线重试");
  assert.equal(requestCount, 2);
});

test("真实抓包片段：首轮 tool-call 名称异常，重试后按约束恢复结构化草稿", async (t) => {
  let requestCount = 0;
  let secondRequestBody = "";
  const server = createServer((request, response) => {
    requestCount += 1;
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      if (requestCount === 2) secondRequestBody = body;
      if (requestCount === 1) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: "无效工具名示例，先返回一些说明文字。",
              tool_calls: [{
                id: "tool_invalid",
                type: "function",
                function: {
                  name: "submit_product_patch",
                  arguments: `reply:"错误工具名参数不应被读取"`,
                },
              }],
            },
          }],
        }));
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "tool_retry_rename",
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: `event: tool-call\ndata: reply:"工具名已修正",patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原夜市夜线"}],researchTasks:[{"label":"核实接驳车班次","type":"vbk","detail":"确认司机与接驳时段"}]`,
              },
            }],
          },
        }],
      }));
    });
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

  assert.equal(result.reply, "工具名已修正");
  assert.equal(result.patch?.[0].op, "replace");
  assert.equal(result.patch?.[0].value, "太原夜市夜线");
  assert.equal(result.researchTasks?.[0].type, "vbk");
  assert.equal(requestCount, 2);
  const parsedSecondBody = JSON.parse(secondRequestBody) as { messages?: Array<{ content: string }>; };
  const retryPrompt = parsedSecondBody.messages?.[parsedSecondBody.messages.length - 1]?.content ?? "";
  assert.match(retryPrompt, /上一次返回未通过结构化校验/);
});

test("真实抓包片段：首轮 SSE 与 keep-alive 混排截断，重试后 tool-call 恢复补丁", async (t) => {
  let requestCount = 0;
  let secondRequestBody = "";
  const server = createServer((request, response) => {
    requestCount += 1;
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      if (requestCount === 2) secondRequestBody = body;
      if (requestCount === 1) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: `HTTP/1.1 200 OK\n:data\n\ndata: {"reply":"当前仅为说明，尚未返回结构化内容",\"patch\":`,
            },
          }],
        }));
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "tool_retry_keepalive",
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: `event: tool-call\n: keep-alive\ndata: reply:'已从 keep-alive 片段恢复',patch:[{'op':'replace','path':'/basicInfo/subtitle','value':'太原夜游'}, {'op':'replace','path':'/basicInfo/subtitle','value':'太原夜游二版'}],researchTasks:[{'label':'核对接送时段','type':'cost','detail':'确认接送服务时段价差'}]`,
              },
            }],
          },
        }],
      }));
    });
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

  assert.equal(result.reply, "已从 keep-alive 片段恢复");
  assert.equal(result.patch?.length, 2);
  assert.equal(result.patch?.[0].path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0].value, "太原夜游");
  assert.equal(result.questions?.length, 0);
  assert.equal(result.researchTasks?.[0].type, "cost");
  assert.equal(requestCount, 2);
  const parsedSecondBody = JSON.parse(secondRequestBody) as { messages?: Array<{ content: string }>; };
  const retryPrompt = parsedSecondBody.messages?.[parsedSecondBody.messages.length - 1]?.content ?? "";
  assert.match(retryPrompt, /上一次返回未通过结构化校验/);
});

test("真实抓包片段：首轮 patch 字段类型错，重试后补齐可用补丁", async (t) => {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    request.on("data", () => {});
    request.on("end", () => {
      if (requestCount === 1) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                reply: "字段类型错误导致应重试",
                patch: null,
                questions: ["是否继续补齐问法？"],
              }),
            },
          }],
        }));
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              reply: "已按结构化输出修复",
              patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原夜色修复" }],
              questions: ["是否继续补充第三天行程？"],
            }),
          },
        }],
      }));
    });
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

  assert.equal(result.reply, "已按结构化输出修复");
  assert.equal(result.patch?.[0].value, "太原夜色修复");
  assert.equal(result.questions?.[0], "是否继续补充第三天行程？");
  assert.equal(requestCount, 2);
});

test("真实抓包片段：tool-call 名称错误但参数可直接解析", async (t) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "tool_wrong_name_direct",
            type: "function",
            function: {
              name: "submit_patch_direct",
              arguments: `reply:"工具名不一致但参数可解析",patch:[{"op":"add","path":"/basicInfo/subtitle","value":"直接解析"}],questions:[],researchTasks:[]`,
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

  assert.equal(requestCount, 1);
  assert.equal(result.reply, "工具名不一致但参数可解析");
  assert.equal(result.patch?.[0].value, "直接解析");
});

test("真实抓包片段：二次重试仍不结构化时采纳最后一段可读文本", async (t) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    if (requestCount <= 2) {
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: "这是一段说明文本，未提供结构化字段。",
          },
        }],
      }));
      return;
    }
    response.end(JSON.stringify({
      choices: [{
        message: { content: "仍然是说明文字，继续补充可读文本。" },
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

  assert.equal(requestCount, 3);
  assert.equal(result.patch?.length, 0);
  assert.equal(result.questions?.length, 0);
  assert.equal(result.researchTasks?.length, 0);
  assert.equal(result.reply, "仍然是说明文字，继续补充可读文本。");
});

test("真实抓包片段：前两轮仅有 SSE 标记与纯文本噪音，第三轮才补齐结构化草稿", async (t) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    if (requestCount === 1) {
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: `: keep-alive
event: message
data: [DONE]\n: done`,
          },
        }],
      }));
      return;
    }
    if (requestCount === 2) {
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: `HTTP/1.1 200 OK\nevent: message\ndata: 重试过程仅文本`,
          },
        }],
      }));
      return;
    }
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `event: message\ndata: {"reply":"SSE 噪音清理后恢复","patch":[{"op":"add","path":"/basicInfo/subtitle","value":"太原重试恢复"}],"questions":["是否继续补齐接驳文案？"]}`,
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

  assert.equal(requestCount, 3);
  assert.equal(result.reply, "SSE 噪音清理后恢复");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原重试恢复");
  assert.equal(result.questions?.[0], "是否继续补齐接驳文案？");
});

test("真实抓包片段：首轮 tool-call 仅带不可写路径会重试，重试后返回可写路径", async (t) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    if (requestCount === 1) {
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "tool_invalid",
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: `event: tool-call\npatch:[{"op":"add","path":"/supplier/productId","value":"tmp-abc"}]`,
              },
            }],
          },
        }],
      }));
      return;
    }
    if (requestCount === 2) {
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: `: heartbeat\nevent: done`,
          },
        }],
      }));
      return;
    }
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `event: message\ndata: {"reply":"补齐路径已修正","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原路径修正"}],"questions":["是否继续补齐返程安排？"]}`,
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

  assert.equal(requestCount, 3);
  assert.equal(result.reply, "补齐路径已修正");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原路径修正");
  assert.equal(result.questions?.[0], "是否继续补齐返程安排？");
});

test("真实抓包片段：tool-call 与 content 混发时，会优先保留可写 tool-call 作为最终结构", async (t) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    if (requestCount === 1) {
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: `event: message\ndata: {"reply":"仅说明，不含结构化", "patch":[]}`,
            tool_calls: [{
              id: "tool_1",
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: `trace-id: seg-20260806\ndata: reply:'tool-call 与 content 争抢',patch:[{"op":"add","path":"/supplier/productId","value":"tmp-xyz"}]`,
              },
            }],
          },
        }],
      }));
      return;
    }
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `HTTP/1.1 200 OK\n: done`,
          tool_calls: [{
            id: "tool_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: tool-call\nreply:'最终 tool-call 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原混发恢复"}],questions:['是否继续核对接驳？']`,
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
    product: { basicInfo: { meetingCity: "太原" }, operations: { transport: "charter" }, itinerary: [] },
    history: [],
  });

  assert.equal(requestCount, 2);
  assert.equal(result.reply, "最终 tool-call 已恢复");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原混发恢复");
  assert.equal(result.questions?.[0], "是否继续核对接驳？");
});

test("真实抓包片段：parseJson 解析无 JSON fence 与无 <think> 的 SSE 混排片段", async (t) => {
  const parsed = parseJson(
    [
      "HTTP/1.1 200 OK",
      "event: message",
      `data: reply:'parseJson 抓包片段样式',patch:[{'op':'add','path':'/basicInfo/subtitle','value':'太原 parseJson 标题'}],questions:['是否继续补充行程？'],researchTasks:{'label':'核对夜间接驳','type':'web','detail':'确认夜间接驳是否有车'}`,
      "event: done",
      "data: [DONE]",
    ].join("\n"),
  );

  assert.equal(parsed.isStructured, true);
  assert.equal(parsed.response.reply, "parseJson 抓包片段样式");
  assert.equal(parsed.response.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(parsed.response.patch?.[0]?.value, "太原 parseJson 标题");
  assert.equal(parsed.response.questions?.[0], "是否继续补充行程？");
  assert.equal(parsed.response.researchTasks?.[0]?.label, "核对夜间接驳");
});

test("真实抓包片段：result 外层字符串中的 patch 字符串可继续解析为可写补丁", () => {
  const nestedPayload = JSON.stringify({
    reply: "result 内嵌字符串可恢复",
    patch: "[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原外层字符串补齐\"}]",
    questions: ["该团是否继续核对交通？"],
  });
  const parsed = parseJson(`event: message
data: {"result":"${nestedPayload}"}`);

  assert.equal(parsed.isStructured, true);
  assert.equal(parsed.response.reply, "result 内嵌字符串可恢复");
  assert.equal(parsed.response.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(parsed.response.patch?.[0]?.value, "太原外层字符串补齐");
  assert.equal(parsed.response.questions?.[0], "该团是否继续核对交通？");
});

test("真实抓包片段：patch 为数字类型先行导致重试，再由 tool-call 恢复可写补丁", async (t) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    if (requestCount === 1) {
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              reply: "patch 字段类型错应重试",
              patch: 1,
              questions: ["该团是否继续核对价格？"],
            }),
          },
        }],
      }));
      return;
    }
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "tool_retry_patch_number",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'数字类型已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原数字类型补齐"}],questions:['是否继续核对交通？']`,
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

  assert.equal(requestCount, 2);
  assert.equal(result.reply, "数字类型已恢复");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原数字类型补齐");
  assert.equal(result.questions?.[0], "是否继续核对交通？");
});

test("真实抓包片段：10 次服务调用中 1 次 patch 类型错仍达 10/10 落盘", async (t) => {
  const responses = [
    JSON.stringify({ reply: "稳定回填 01", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原1" }] }),
    JSON.stringify({ reply: "patch 为字符串类型需重试", patch: 1 }),
    JSON.stringify({ reply: "重试已恢复 01", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原1-恢复" }] }),
    JSON.stringify({ reply: "稳定回填 02", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原2" }] }),
    JSON.stringify({ reply: "稳定回填 03", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原3" }] }),
    JSON.stringify({ reply: "稳定回填 04", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原4" }] }),
    JSON.stringify({ reply: "稳定回填 05", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原5" }] }),
    JSON.stringify({ reply: "稳定回填 06", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原6" }] }),
    JSON.stringify({ reply: "稳定回填 07", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原7" }] }),
    JSON.stringify({ reply: "稳定回填 08", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原8" }] }),
    JSON.stringify({ reply: "稳定回填 09", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原9" }] }),
    JSON.stringify({ reply: "稳定回填 10", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原10" }] }),
  ];
  let requestCount = 0;
  const server = createServer((_request, response) => {
    const payload = responses[Math.min(requestCount, responses.length - 1)];
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: payload } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  let structuredCount = 0;
  for (let index = 0; index < 10; index += 1) {
    const result = await service.reply({
      message: "继续补齐",
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });
    if ((result.patch?.length ?? 0) > 0) structuredCount += 1;
  }

  assert.equal(structuredCount, 10);
  assert.equal(requestCount, 11);
});

test("真实抓包片段：首轮 content 截断导致重试，tool-call 补齐后恢复可落盘", async (t) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    if (requestCount === 1) {
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: `event: message
data: {"reply":"先回传一段截断内容","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原截断片段"`,
          },
        }],
      }));
      return;
    }
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "tool_retry_truncate",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: tool-call\nreply:'截断后重试恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原截断恢复"}],questions:['该团是否继续补齐夜间接驳？']`,
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

  assert.equal(requestCount, 2);
  assert.equal(result.reply, "截断后重试恢复");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原截断恢复");
  assert.equal(result.questions?.[0], "该团是否继续补齐夜间接驳？");
});

test("真实抓包片段：10 次调用中 1 次截断后仍≥9 次成功落盘", async (t) => {
  const responses = [
    JSON.stringify({ reply: "稳态回填 01", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原1-稳定" }] }),
    `event: message
data: {"reply":"本条先截断","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原截断候选"}`,
    JSON.stringify({ reply: "重试恢复 01", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原1-恢复" }] }),
    JSON.stringify({ reply: "稳态回填 02", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原2-稳态" }] }),
    JSON.stringify({ reply: "稳态回填 03", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原3-稳态" }] }),
    JSON.stringify({ reply: "稳态回填 04", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原4-稳态" }] }),
    JSON.stringify({ reply: "稳态回填 05", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原5-稳态" }] }),
    JSON.stringify({ reply: "稳态回填 06", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原6-稳态" }] }),
    JSON.stringify({ reply: "稳态回填 07", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原7-稳态" }] }),
    JSON.stringify({ reply: "稳态回填 08", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原8-稳态" }] }),
    JSON.stringify({ reply: "稳态回填 09", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原9-稳态" }] }),
    JSON.stringify({ reply: "稳态回填 10", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原10-稳态" }] }),
  ];
  let requestCount = 0;
  const server = createServer((_request, response) => {
    const payload = responses[Math.min(requestCount, responses.length - 1)];
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: payload } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  let successCount = 0;
  for (let index = 0; index < 10; index += 1) {
    const result = await service.reply({
      message: "继续补齐",
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });
    if ((result.patch?.length ?? 0) > 0) successCount += 1;
  }

  assert.equal(successCount, 10);
  assert.equal(requestCount, 11);
});

test("真实抓包片段：无 think/no fence 的首轮 incomplete JSON 触发重试后可恢复补丁", async (t) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    if (requestCount === 1) {
      response.end(JSON.stringify({
        choices: [{ message: { content: `event: message\ndata: {"reply":"抓包片段截断，未闭合"` } }],
      }));
      return;
    }
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "tool_retry_01",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'服务端重试已恢复',patch:[{'op':'replace','path':'/basicInfo/subtitle','value':'太原恢复01'}],questions:['该团期是否继续补齐夜间安排？']`,
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

  assert.equal(requestCount, 2);
  assert.equal(result.reply, "服务端重试已恢复");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原恢复01");
  assert.equal(result.questions?.[0], "该团期是否继续补齐夜间安排？");
});

test("真实抓包片段：10 次流量中保底 1 次不完整触发重试，仍达 9/10 可落盘", async (t) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    const responses = [
      "event: message\ndata: {\"reply\":\"抓包片段第一轮不完整\"",
      JSON.stringify({
        reply: "重试后已恢复",
        patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原补齐01" }],
        questions: ["继续补齐接驳吗？"],
      }),
      JSON.stringify({
        reply: "抓包片段 02",
        patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原片段02" }],
        questions: ["是否继续补齐接驳吗？"],
      }),
      JSON.stringify({
        reply: "抓包片段 03",
        patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原片段03" }],
      }),
      JSON.stringify({
        reply: "抓包片段 04",
        patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原片段04" }],
      }),
      JSON.stringify({
        reply: "抓包片段 05",
        patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原片段05" }],
      }),
      JSON.stringify({
        reply: "抓包片段 06",
        patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原片段06" }],
      }),
      JSON.stringify({
        reply: "抓包片段 07",
        patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原片段07" }],
      }),
      JSON.stringify({
        reply: "抓包片段 08",
        patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原片段08" }],
      }),
      JSON.stringify({
        reply: "抓包片段 09",
        patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原片段09" }],
      }),
      JSON.stringify({
        reply: "抓包片段 10",
        patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原片段10" }],
      }),
      JSON.stringify({
        reply: "抓包片段 11",
        patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原片段11" }],
      }),
    ];
    const current = responses[Math.min(requestCount - 1, responses.length - 1)] ?? responses[responses.length - 1];
    response.end(JSON.stringify({ choices: [{ message: { content: current } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  let structuredCount = 0;
  for (let index = 0; index < 10; index += 1) {
    const result = await service.reply({
      message: "生成第一版",
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });
    if ((result.patch?.length ?? 0) > 0) structuredCount += 1;
  }

  assert.ok(requestCount >= 11, `requestCount=${requestCount}`);
  assert.equal(structuredCount, 10);
});
