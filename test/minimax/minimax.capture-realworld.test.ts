import { assert, MiniMaxService, test } from "./minimax.core.shared.js";
import { parseJson } from "../../src/main/minimax/minimax-parsing.js";
import { createServer } from "node:http";

test("真实抓包片段：result 键 JSON 字符串化返回可恢复结构化草稿", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            result: JSON.stringify({
              reply: "已从字符串 result 包裹中恢复",
              patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原夜景重建" }],
              questions: ["是否补齐酒店说明？"],
              researchTasks: [{ label: "核对夜间接驳可用性", type: "vbk", detail: "确认接驳车晚间可用时段" }],
            }),
          }),
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

  assert.equal(result.reply, "已从字符串 result 包裹中恢复");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原夜景重建");
  assert.equal(result.questions?.[0], "是否补齐酒店说明？");
  assert.equal(result.researchTasks?.[0]?.label, "核对夜间接驳可用性");
});

test("真实抓包片段：仅 patch 的工具参数在抓包风格中也会通过兜底文本落盘", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "tool_patch_only",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `patch:[{'op':'replace','path':'/basicInfo/subtitle','value':'太原纯补丁恢复'}],questions:['是否继续补齐接驳？']`,
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

  assert.match(result.reply, /未获取到正文/);
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原纯补丁恢复");
  assert.equal(result.questions?.[0], "是否继续补齐接驳？");
});

test("真实抓包片段：10 次混合重试流中至少 9 次可得结构化草稿", async (t) => {
  const responses = [
    JSON.stringify({ reply: "抓包流 01", patch: [{ op: "add", path: "/basicInfo/subtitle", value: "太原1" }], questions: ["Q01"], researchTasks: [] }),
    `event: message\ndata: {"reply":"抓包流 02","patch":[{"op":"add","path":"/basicInfo/subtitle","value":"太原2"}],"researchTasks":{"label":"核对包裹时段","type":"web","detail":"确认高峰时段"}}`,
    `data: reply:"抓包流 03",patch:[{"op":"add","path":"/basicInfo/subtitle","value":"太原3"}],questions:["Q03"]`,
    `event: message\ndata: {"patch":[{"op":"add","path":"/basicInfo/subtitle","value":"太原4"}],"questions":["Q04"],"researchTasks":[{"label":"核对退订条款","type":"cost","detail":"确认可退费说明"}]}`,
    `{"result":"{\"reply\":\"抓包流 05\",\"patch\":[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原5\"}]}"}`,
    `reply:'抓包流 06',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原6"}],questions:['Q06']`,
    `data: reply:"抓包流 07",patch:[{"op":"replace","path":"/operations/transport_mode","value":"shared"}],questions:["Q07"]`,
    `patch:[{"op":"add","path":"/basicInfo/subtitle","value":"太原8"}],questions:["Q08"]`,
    `event: message\ndata: {"reply":"抓包流 09","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原9"}]}`,
    "这个回合只有说明文本，故意保留为非结构化。",
  ];
  let requestCount = 0;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    const current = responses[requestCount] ?? responses[responses.length - 1];
    requestCount += 1;
    response.end(JSON.stringify({ choices: [{ message: { content: current } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  let structuredCount = 0;

  for (let index = 0; index < responses.length; index += 1) {
    const result = await service.reply({
      message: index === responses.length - 1 ? "补充说明" : "生成第一版",
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });
    if ((result.patch?.length ?? 0) > 0) structuredCount += 1;
  }

  assert.ok(requestCount >= responses.length, `requestCount=${requestCount}, responses.length=${responses.length}`);
  assert.ok(structuredCount >= 9, `structuredCount=${structuredCount}`);
});

test("抓包片段 parseJson（无 think/no fence）可从 patch-only 成功恢复为 structured", () => {
  const parsed = parseJson(`event: message
data: patch:[{"op":"add","path":"/basicInfo/subtitle","value":"太原 parseJson patch-only"}],questions:["是否继续补充行程？"],researchTasks:{'label':'核验夜间接驳','type':'vbk','detail':'核对班次与时长限制'}`);
  assert.equal(parsed.isStructured, true);
  assert.match(parsed.response.reply, /未获取到正文/);
  assert.equal(parsed.response.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(parsed.response.patch?.[0]?.value, "太原 parseJson patch-only");
  assert.equal(parsed.response.questions?.[0], "是否继续补充行程？");
  assert.equal(parsed.response.researchTasks?.[0].label, "核验夜间接驳");
});

test("真实抓包片段：双重转义 output/result 可在一次恢复中直接结构化解析", () => {
  const nested = JSON.stringify({
    result: {
      reply: "双重转义抓包可恢复",
      patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原夜色" }],
      questions: ["是否核对门票退改规则？"],
    },
  });
  const truncated = nested.slice(0, nested.length - 1);
  const parsed = parseJson(`event: message
data: {"output":"${truncated}`);
  assert.equal(parsed.isStructured, true);
  assert.equal(parsed.response.reply, "双重转义抓包可恢复");
  assert.equal(parsed.response.patch?.[0]?.value, "太原夜色");
  assert.equal(parsed.response.questions?.[0], "是否核对门票退改规则？");
});

test("真实抓包片段：tool_calls 噪声拼接后仍优先返回有效结构化 patch", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [
            {
              id: "tool_noise",
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: `patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"tool 拼接噪声A\"],questions:[`,
              },
            },
            {
              id: "tool_valid",
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: `reply:'工具参数拼接可恢复',patch:[{'op':'replace','path':'/basicInfo/subtitle','value':'太原工具参数'},questions:['是否确认接驳时间？']`,
              },
            },
          ],
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

  assert.equal(result.reply, "工具参数拼接可恢复");
  assert.equal(result.patch?.[0]?.value, "太原工具参数");
  assert.equal(result.questions?.[0], "是否确认接驳时间？");
});

test("真实抓包片段：无 think/no fence 截断片段仍可恢复结构化工具参数", () => {
  const parsed = parseJson(`event: message
data: patch:[{"op":"add","path":"/basicInfo/subtitle","value":"太原截断段测试"],questions:['是否继续补齐夜间返程？'],researchTasks:{label:'核验夜间接驳能力',type:'vbk',detail:'确认接驳时段并同步服务商'}`);
  assert.equal(parsed.isStructured, true);
  assert.match(parsed.response.reply, /未获取到正文/);
  assert.equal(parsed.response.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(parsed.response.patch?.[0]?.value, "太原截断段测试");
  assert.equal(parsed.response.questions?.[0], "是否继续补齐夜间返程？");
  assert.equal(parsed.response.researchTasks?.[0]?.label, "核验夜间接驳能力");
});

test("真实抓包片段：首轮返回仅说明文本时自动重试并拿到可写补丁", async (t) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    if (requestCount === 1) {
      response.end(JSON.stringify({
        choices: [{ message: { content: "先给出说明，稍后补齐结构化字段。" } }],
      }));
      return;
    }
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: "HTTP/1.1 200 OK\n: keep-alive\nevent: message\ndata: {\"reply\":\"抓包流重试已恢复\",\"patch\":[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原重试恢复\"}]," +
            "\"questions\":[\"该团期是否继续压缩行程？\"]}",
          tool_calls: [{
            id: "tool_retry",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原工具重试覆盖"}],questions:['重试后可继续补齐吗？']`,
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
  assert.equal(result.reply, "抓包流重试已恢复");
  assert.equal(result.patch?.[0].path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0].value, "太原重试恢复");
  assert.equal(result.questions?.[0], "该团期是否继续压缩行程？");
});

test("真实抓包片段：无引号 key 的结构化对象可直接恢复", () => {
  const parsed = parseJson(`event: message
data: {reply:'无引号 key 可恢复', patch:[{"op":"add","path":"/basicInfo/subtitle","value":"太原无引号 key"},{"op":"replace","path":"/operations/transport","value":"shared"}],questions:['是否继续补齐接驳时间？'],researchTasks:{'label':'核验接驳服务','type':'vbk','detail':'确认服务时间窗口'}`
);
  assert.equal(parsed.isStructured, true);
  assert.equal(parsed.response.reply, "无引号 key 可恢复");
  assert.equal(parsed.response.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(parsed.response.patch?.[0]?.value, "太原无引号 key");
  assert.equal(parsed.response.questions?.[0], "是否继续补齐接驳时间？");
  assert.equal(parsed.response.researchTasks?.[0]?.label, "核验接驳服务");
});

test("真实抓包片段：event/data 混排的截断 key:value 可恢复为结构化草稿", () => {
  const parsed = parseJson(`event: message
data: reply:'截断片段测试', patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原截断"}`);
  assert.equal(parsed.isStructured, true);
  assert.equal(parsed.response.reply, "截断片段测试");
  assert.equal(parsed.response.patch?.[0]?.value, "太原截断");
  assert.equal(parsed.response.patch?.[0]?.op, "replace");
  assert.equal(parsed.response.patch?.[0]?.path, "/basicInfo/subtitle");
});

test("真实抓包片段：10 次服务调用中 1 次先文本后结构化，整体仍达 10/10 成功", async (t) => {
  const scriptedResponses = [
    "先返回说明文本，等待重试。",
    `event: message
data: {"reply":"第一条重试后恢复","patch":[{"op":"add","path":"/basicInfo/subtitle","value":"太原混合1"}],"questions":["是否继续核对机位？"]}`,
    `event: message
data: {"reply":"第二条稳定结构","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原混合2"}],"questions":["是否继续核对酒店？"]}`,
    `event: message
data: patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原混合3"}],questions:['是否继续核对交通？'],researchTasks:{'label':'核验机场接驳','type':'web','detail':'确认可选航班时段'}`,
    `HTTP/1.1 200 OK
event: message
data: {reply:'四号重试降噪',patch:[{"op":"add","path":"/basicInfo/subtitle","value":"太原混合4"}],researchTasks:[{"label":"核验夜间酒店","type":"vbk","detail":"确认晚间可入住"}],questions:['是否继续核对酒店协议？']}`,
    `event: message
data: {"reply":"第五条结构","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原混合5"}],"questions":["是否补齐用车说明？"],"researchTasks":[{"label":"核验接驳里程","type":"cost","detail":"对照里程与报价"}]}`,
    `: keep-alive
event: message
data: [DONE]`,
    `event: message
data: {"reply":"第七条结构","patch":[{"op":"add","path":"/basicInfo/subtitle","value":"太原混合7"}],"questions":["是否继续补齐行程？"]}`,
    `event: message
data: reply:'第八条结构',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原混合8"}],questions:['该行程还需哪些确认？'],researchTasks:{label:'核验机票改期','type':'web','detail':'确认机票改期规则'}`,
    `event: message
data: {"reply":"第九条结构","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原混合9"}],"questions":["是否继续补充售后说明？"]}`,
    `event: message
data: {"reply":"第十条结构","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原混合10"}],"questions":["是否继续补齐价格提示？"]}`,
  ];
  let requestIndex = 0;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: scriptedResponses[Math.min(requestIndex, scriptedResponses.length - 1)],
        },
      }],
    }));
    requestIndex += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  let successCount = 0;

  for (let i = 0; i < 10; i += 1) {
    const result = await service.reply({
      message: i === 0 ? "生成第一版" : `继续补充 ${i}`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });
    if ((result.patch?.length ?? 0) > 0) successCount += 1;
  }

  assert.ok(successCount >= 9, `successCount=${successCount}`);
});

test("真实抓包片段：tool-call 参数先错误后重试，最终可从 API 文本落盘结构化", async (t) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    if (requestCount === 0) {
      requestCount += 1;
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: "event: message\ndata: 请先给我一点时间梳理抓包片段。",
            tool_calls: [{
              id: "tool_error_capture",
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: `patch:'[{"op":"add","path":"/basicInfo/subtitle","value":"太原重试前"}],events:[1,2,3]`,
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
          content: null,
          tool_calls: [{
            id: "tool_retry_capture",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: message\ndata: reply:'已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原重试恢复"}],questions:['该团是否继续补齐夜间接驳？']`,
            },
          }],
        },
      }],
    }));
    requestCount += 1;
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

  assert.equal(requestCount, 2);
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原重试恢复");
  assert.equal(result.questions?.[0], "该团是否继续补齐夜间接驳？");
  assert.equal(result.reply, "已恢复");
});

test("真实抓包片段：SSE data 分割下仍可恢复 patch/researchTasks 混杂对象", () => {
  const parsed = parseJson(`event: message
data: patch:[{"op":"replace","path":"/operations/transport","value":"shared"}],questions:['是否确认接驳时段？']
data: researchTasks:{'label':'核验夜间接驳','type':'vbk','detail':'确认接驳点与可乘班次时段'}`);
  assert.equal(parsed.isStructured, true);
  assert.match(parsed.response.reply, /未获取到正文/);
  assert.equal(parsed.response.patch?.[0]?.path, "/operations/transport");
  assert.equal(parsed.response.patch?.[0]?.value, "shared");
  assert.equal(parsed.response.questions?.[0], "是否确认接驳时段？");
  assert.equal(parsed.response.researchTasks?.[0]?.type, "vbk");
});

test("真实抓包片段：result 包裹与工具字段混排，也可恢复出可写副本", () => {
  const parsed = parseJson(`HTTP/1.1 200 OK
event: message
data: {"result":"{\"reply\":\"result 外层字符串可恢复\",\"patch\":[{\"op\":\"add\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原夜色回归\"}],\"questions\":[\"是否继续补齐门票条款？\"]"}
event: message
data: researchTasks:{'label':'核验门票退改规则','type':'web','detail':'确认高峰期可退改规则并归档'}`);
  assert.equal(parsed.isStructured, true);
  assert.equal(parsed.response.reply, "result 外层字符串可恢复");
  assert.equal(parsed.response.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(parsed.response.questions?.[0], "是否继续补齐门票条款？");
  assert.match(parsed.response.reply, /result 外层字符串可恢复/);
});

test("真实抓包片段：非官方 tool-call 噪音与官方 tool-call 并存，仍以官方参数为准", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: "先给你一个普通说明。",
          tool_calls: [{
            id: "tool_noise_name",
            type: "function",
            function: {
              name: "submit_product_patch",
              arguments: `reply:'这条不该被采纳',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"噪音覆盖"}],questions:['是否继续补齐？']`,
            },
          }, {
            id: "tool_valid_name",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'以官方工具为准',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原官方优先"}],questions:['该团是否继续补齐接驳？']`,
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

  assert.equal(result.reply, "以官方工具为准");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原官方优先");
  assert.equal(result.questions?.[0], "该团是否继续补齐接驳？");
});

test("真实抓包片段：tool-call 仅有说明与 recover 片段时仍触发服务端重试并命中恢复补丁", async (t) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    if (requestCount === 1) {
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: `event: message\ndata: 首次仅说明文字，稍后补齐。`,
            tool_calls: [{
              id: "tool_retry_text",
              type: "function",
            function: {
              name: "submit_product_update",
              arguments: `patch:'[{"op":"replace","path":"/basicInfo/subtitle","value":"太原重试前"}]`,
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
          content: "retry content 仅作为补充说明",
          tool_calls: [{
            id: "tool_retry_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: message\ndata: reply:'重试后已覆盖',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原重试覆盖"}],questions:['该团是否继续同步接驳？']`,
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

  assert.equal(requestCount, 2);
  assert.equal(result.reply, "重试后已覆盖");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原重试覆盖");
  assert.equal(result.questions?.[0], "该团是否继续同步接驳？");
});

test("真实抓包片段：tool-call 恢复片段仅含未转义 patch 字符串时触发重试并命中覆盖", async (t) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    if (requestCount === 1) {
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: `event: message
data: 先给你一个说明，不含结构化正文。`,
            tool_calls: [{
              id: "tool_retry_raw_1",
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: `event: tool-call
data: patch:"[{"op":"replace","path":"/basicInfo/subtitle","value":"太原未转义重试前"}]"`,
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
          content: "retry content 仅说明",
          tool_calls: [{
            id: "tool_retry_raw_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: message\ndata: reply:'未转义片段已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原未转义重试覆盖"}],questions:['是否继续补齐夜间接驳？']`,
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

  assert.equal(requestCount, 2);
  assert.equal(result.reply, "未转义片段已恢复");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原未转义重试覆盖");
  assert.equal(result.questions?.[0], "是否继续补齐夜间接驳？");
});

test("真实抓包片段：event/data 分割后 content 有纯文本补丁，tool-call 仅返回可识别问句时可继续写入", () => {
  const parsed = parseJson(`event: message
data: HTTP/1.1 200 OK
data: reply:'工具噪音截断恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原抓包补齐"}],questions:['是否继续核对接驳？']
data: {reply:"内容补齐片段",questions:['该条应被 question 覆盖吗？'],patch:[{"op":"replace","path":"/operations/transport","value":"shared"}]
`);
  assert.equal(parsed.isStructured, true);
  assert.equal(parsed.response.patch?.[0]?.path, "/operations/transport");
  assert.equal(parsed.response.patch?.[0]?.value, "shared");
  assert.equal(parsed.response.questions?.[0], "该条应被 question 覆盖吗？");
  assert.equal(parsed.response.reply, "内容补齐片段");
});

test("真实抓包片段：混合 SSE 噪音下仅 tool-call 可恢复时仍补齐结构化草稿", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: "HTTP/1.1 200 OK\nevent: message\ndata: 仍在抓取中，请稍后",
          tool_calls: [{
            id: "tool_noisy_mix",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: tool-call\ndata: patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原工具优先"}],reply:'仅工具参数可写'`,
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

  assert.equal(result.reply, "仅工具参数可写");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原工具优先");
  assert.equal(result.patch?.[0]?.op, "replace");
});

test("真实抓包片段：tool-call 的 patch 为字符串仍可通过服务层落盘", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: "tool-call 正在补齐",
          tool_calls: [{
            id: "tool_patch_string",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'字符串补丁可恢复',patch:"[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原服务层字符串补丁\"}]",questions:["是否继续补齐夜间行程？"]`,
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
  assert.equal(result.reply, "字符串补丁可恢复");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原服务层字符串补丁");
  assert.equal(result.questions?.[0], "是否继续补齐夜间行程？");
});

test("真实抓包片段：tool-call 的 patch 未转义字符串仍可通过服务层落盘", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: "tool-call 正在补齐",
          tool_calls: [{
            id: "tool_patch_string_raw",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'未转义字符串补丁可恢复',patch:"[{"op":"replace","path":"/basicInfo/subtitle","value":"太原服务层原始字符串补丁"}]",questions:["该团是否继续补齐夜间行程？"]`,
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
  assert.equal(result.reply, "未转义字符串补丁可恢复");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原服务层原始字符串补丁");
  assert.equal(result.questions?.[0], "该团是否继续补齐夜间行程？");
});

test("真实抓包片段：tool-call 的单引号 JSON 字符串 patch 仍可通过服务层落盘", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: "tool-call 正在补齐",
          tool_calls: [{
            id: "tool_patch_string_single",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'字符串补丁可恢复2',patch:'[{"op":"replace","path":"/basicInfo/subtitle","value":"太原服务层字符串补丁2"}]',questions:['是否继续补齐夜间行程2？']`,
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
  assert.equal(result.reply, "字符串补丁可恢复2");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原服务层字符串补丁2");
  assert.equal(result.questions?.[0], "是否继续补齐夜间行程2？");
});

test("真实抓包片段：无结构字段正文时，parseJson 退化为可写摘要，避免噪音原文掩盖", () => {
  const parsed = parseJson(`event: message
data: patch:[{"op":"add","path":"/basicInfo/subtitle","value":"太原无正文片段"}],questions:["是否继续补齐接驳？"]
event: done`);
  assert.equal(parsed.isStructured, true);
  assert.match(parsed.response.reply, /未获取到正文/);
  assert.equal(parsed.response.patch?.[0]?.value, "太原无正文片段");
  assert.equal(parsed.response.questions?.[0], "是否继续补齐接驳？");
});

test("真实抓包片段：patch 字段为 JSON 字符串可正确恢复成可写 patch", () => {
  const parsed = parseJson(`event: message
data: {"reply":"patch 为字符串可恢复","patch":"[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原字符串补丁\"}]","questions":["是否继续补齐夜间安排？"]}`);
  assert.equal(parsed.isStructured, true);
  assert.equal(parsed.response.patch?.[0]?.op, "replace");
  assert.equal(parsed.response.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(parsed.response.patch?.[0]?.value, "太原字符串补丁");
  assert.equal(parsed.response.questions?.[0], "是否继续补齐夜间安排？");
});

test("真实抓包片段：patch 字段未转义 JSON 字符串也可正确恢复成可写 patch", () => {
  const parsed = parseJson(`event: message
data: {"reply":"未转义 JSON 字符串可恢复","patch":"[{"op":"replace","path":"/basicInfo/subtitle","value":"太原未转义字符串补丁"}]","questions":["是否继续补齐夜间安排2？"]}`);
  assert.equal(parsed.isStructured, true);
  assert.equal(parsed.response.patch?.[0]?.op, "replace");
  assert.equal(parsed.response.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(parsed.response.patch?.[0]?.value, "太原未转义字符串补丁");
  assert.equal(parsed.response.questions?.[0], "是否继续补齐夜间安排2？");
});

test("真实抓包片段：tool-call 单独片段无结构分隔符时可恢复为结构化草稿", () => {
  const parsed = parseJson(`event: message
data: HTTP/1.1 200 OK
event: tool_call
data: reply:'工具参数先行'
patch:[{'op':'replace','path':'/basicInfo/subtitle','value':'太原工具先行草稿'}],questions:['是否继续核验班期？']
researchTasks:[{'label':'核对接驳高峰期','type':'vbk','detail':'确认高峰时段可用座位与接驳时长'}]`);
  assert.equal(parsed.isStructured, true);
  assert.equal(parsed.response.reply, "工具参数先行");
  assert.equal(parsed.response.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(parsed.response.patch?.[0]?.value, "太原工具先行草稿");
  assert.equal(parsed.response.questions?.[0], "是否继续核验班期？");
  assert.equal(parsed.response.researchTasks?.[0]?.label, "核对接驳高峰期");
});

test("真实抓包片段：10 次服务调用中 1 次纯文本 + 1 次工具参数噪音也能保持 10/10 结构化落盘", async (t) => {
  type ToolPayload = { content?: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>; };

  const responses: Array<string | ToolPayload> = [
    "先给你先行说明：我稍后补齐结构化字段。",
    JSON.stringify({ reply: "抓包流 01", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原工具先行-01" }] }),
    JSON.stringify({ reply: "抓包流 02", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原工具先行-02" }] }),
    JSON.stringify({ reply: "抓包流 03", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原工具先行-03" }] }),
    {
      content: "content: HTTP/1.1 200 OK\nevent: message\n",
      tool_calls: [{
        id: "tool_mix",
        type: "function",
        function: {
          name: "submit_product_update",
          arguments: `reply:'工具参数噪音可恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原工具先行-04"}],questions:['是否继续补齐晚间接驳？']`,
        },
      }],
    },
    JSON.stringify({ reply: "抓包流 05", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原工具先行-05" }] }),
    JSON.stringify({ reply: "抓包流 06", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原工具先行-06" }] }),
    JSON.stringify({ reply: "抓包流 07", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原工具先行-07" }] }),
    JSON.stringify({ reply: "抓包流 08", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原工具先行-08" }] }),
    JSON.stringify({ reply: "抓包流 09", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原工具先行-09" }] }),
    JSON.stringify({ reply: "抓包流 10", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原工具先行-10" }] }),
  ];
  let requestCount = 0;

  function messageFromPayload(payload: string | ToolPayload) {
    if (typeof payload !== "string") {
      return {
        content: payload.content ?? null,
        tool_calls: payload.tool_calls,
      };
    }
    return { content: payload };
  }

  const server = createServer((_request, response) => {
    const current = responses[Math.min(requestCount, responses.length - 1)];
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: messageFromPayload(current) }] }));
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

  assert.equal(requestCount, responses.length);
  assert.equal(structuredCount, 10);
});

test("真实抓包片段：tool-call 噪音先行时 service.retry 能拿到结构化补丁", async (t) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    requestCount += 1;
    if (requestCount === 1) {
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: "先来一段说明文本，没有结构化字段。",
            tool_calls: [
              {
                id: "tool_invalid",
                type: "function",
                function: {
                  name: "submit_product_update",
                  arguments: "这个 tool 参数先发噪音，不应作为结构化输入。",
                },
              },
            ],
          },
        }],
      }));
      return;
    }
    if (requestCount === 2) {
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: `event: message
data: {"reply":"tool-call 噪音已恢复","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原重试恢复"}],"questions":["是否继续核对班期？"]}`,
          },
        }],
      }));
      return;
    }
    response.end(JSON.stringify({ choices: [{ message: { content: "not called" } }] }));
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
  assert.equal(result.reply, "tool-call 噪音已恢复");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原重试恢复");
  assert.equal(result.questions?.[0], "是否继续核对班期？");
});

test("真实抓包片段：10 次服务调用中仅 2 次首轮失败，仍可得到 10/10 结构化回复", async (t) => {
  type ToolPayload = { content?: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>; };
  const responses: Array<string | ToolPayload> = [
    "先返回说明文本，稍后补齐结构化字段。",
    JSON.stringify({ reply: "抓包重试 01", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原10-01" }] }),
    { content: "event: message\ndata: [DONE]\n", tool_calls: [{ id: "tool-no-structured", type: "function", function: { name: "submit_product_update", arguments: "这是一段无结构噪音 tool 参数" } }] },
    JSON.stringify({ reply: "抓包重试 02", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原10-02" }] }),
    `event: message
data: {"reply":"抓包风格 03","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原10-03"}],"questions":["是否继续补齐酒店？"]}`,
    `event: message
data: reply:'抓包风格 04',patch:[{"op":"add","path":"/basicInfo/subtitle","value":"太原10-04"}],questions:['是否继续补齐车次？'],researchTasks:[{"label":"核验接驳高峰期","type":"vbk","detail":"同步接驳车辆时刻"}]`,
    JSON.stringify({ reply: "抓包风格 05", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原10-05" }] }),
    {
      content: "event: message\ndata: HTTP/1.1 200 OK\nevent: finish",
      tool_calls: [{
        id: "tool-clean-06",
        type: "function",
        function: {
          name: "submit_product_update",
          arguments: `reply:'抓包风格 06',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原10-06"}],questions:['是否继续核对行程？']`,
        },
      }],
    },
    JSON.stringify({ reply: "抓包风格 07", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原10-07" }] }),
    JSON.stringify({ reply: "抓包风格 08", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原10-08" }] }),
    `event: message
data: {"reply":"抓包风格 09","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原10-09"}],"researchTasks":[{"label":"核验夜间交通","type":"web","detail":"核对晚间接驳路线"}]}`,
    JSON.stringify({ reply: "抓包风格 10", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原10-10" }] }),
  ];
  let requestCount = 0;

  const server = createServer((_request, response) => {
    const current = responses[Math.min(requestCount, responses.length - 1)] as string | ToolPayload;
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    if (typeof current === "string") {
      response.end(JSON.stringify({ choices: [{ message: { content: current } }] }));
      return;
    }
    response.end(JSON.stringify({ choices: [{ message: { content: current.content ?? null, tool_calls: current.tool_calls } }] }));
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

  assert.equal(requestCount, 12);
  assert.equal(structuredCount, 10);
});

test("真实抓包片段：首轮 content 截断且仅有补充文案，tool-call 重试后落盘", async (t) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    requestCount += 1;
    if (requestCount === 1) {
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: `event: message
data: HTTP/1.1 200 OK
event: message
data: {"reply":"先给一句说明，不可直接落盘",\"patch\":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原截断草案`,
          },
        }],
      }));
      return;
    }
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `event: message
data: 仍在抓取`
          ,
          tool_calls: [{
            id: "tool-retry-trace",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'真实抓包截断已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原截断恢复值"}],questions:['该团是否继续核对接驳时段？']`,
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
  assert.equal(result.reply, "真实抓包截断已恢复");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原截断恢复值");
  assert.equal(result.questions?.[0], "该团是否继续核对接驳时段？");
});

test("真实抓包片段：10 次服务调用中 1 次 tool-call 截断 1 次 content 截断，仍达 10/10 落盘", async (t) => {
  const responses: Array<string> = [
    JSON.stringify({ reply: "真实10-1", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原10-1" }] }),
    `event: message
data: {"reply":"本轮先文本","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原10-2"}`,
    `event: message
data: reply:'首轮截断重试',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原10-3"}],questions:['该团是否继续核对夜间？']`,
    JSON.stringify({ reply: "真实10-3", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原10-4" }] }),
    `event: message
data: patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原10-5"}],questions:['该团是否继续核对早晚场？']`,
    JSON.stringify({ reply: "真实10-5", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原10-6" }] }),
    `event: message
data: reply:'tool-call 截断片段',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原10-7"}`,
    `tool-call
data: reply:'tool-call 截断片段已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原10-8"}],questions:['该团是否继续核查夜晚接驳？']`,
    JSON.stringify({ reply: "真实10-8", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原10-9" }] }),
  JSON.stringify({ reply: "真实10-9", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原10-10" }] }),
    JSON.stringify({ reply: "真实10-10", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原10-10-final" }] }),
  ];
  let requestCount = 0;
  const server = createServer((_request, response) => {
    const payload = responses[Math.min(requestCount, responses.length - 1)];
    requestCount += 1;
    response.setHeader("content-type", "application/json");

    if (requestCount === 6) {
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: payload,
            tool_calls: [{
              id: "tool-mix",
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: `reply:'tool-call 截断重试已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原10-7-恢复"}],questions:['该团是否继续核对晚餐安排？']`,
              },
            }],
          },
        }],
      }));
      return;
    }
    response.end(JSON.stringify({ choices: [{ message: { content: payload } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  let structuredCount = 0;
  let fallbackReplyCount = 0;
  for (let index = 0; index < 10; index += 1) {
    const result = await service.reply({
      message: "继续补齐",
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });
    if ((result.patch?.length ?? 0) > 0) structuredCount += 1;
    if (/未获取到正文/.test(result.reply)) fallbackReplyCount += 1;
  }

  assert.ok(requestCount >= 10);
  assert.equal(structuredCount, 10);
  assert.ok(fallbackReplyCount >= 1);
});

test("真实抓包片段：无 think/no fence 且尾部不完整，parseJson 仍可恢复为结构化草稿", () => {
  const parsed = parseJson(`event: message
data: {"reply":"抓包片段 真实字段截断","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原截断标题"],"questions":["该团期是否核对接驳时间？"]`);
  assert.equal(parsed.isStructured, true);
  assert.equal(parsed.response.reply, "抓包片段 真实字段截断");
  assert.equal(parsed.response.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(parsed.response.questions?.[0], "该团期是否核对接驳时间？");
});

test("真实抓包片段：首轮返回未闭合 content + 重试后 tool-call 返回完整 patch，10 轮内至少 9 次可落盘", async (t) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    if (requestCount === 1) {
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: `event: message\ndata: {"reply":"抓包片段首轮未闭合","patch":[{"op":"add","path":"/basicInfo/subtitle","value":"待补齐01"}]`,
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
            id: "tool_recovery",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'修复后可写入',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原补齐版"}],questions:['该团期是否补齐晚餐安排？']`,
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
  assert.equal(result.reply, "修复后可写入");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原补齐版");
  assert.equal(result.questions?.[0], "该团期是否补齐晚餐安排？");
});

