import { assert, MiniMaxService, test } from "./minimax.core.shared.js";
import { createServer } from "node:http";

test("真实抓包片段：首轮仅说明文本，重试后由 tool-call 截断恢复", async (t) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    const responses = [
      {
        content: "先返回说明文本，需按工具链恢复。",
        tool_calls: [
          {
            id: "tool_retry_noise",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'这是一段无效的重试文本，先不落盘'`,
            },
          },
        ],
      },
      {
        content: null,
        tool_calls: [
          {
            id: "tool_retry_fixed",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'已通过真实重试恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原重试恢复"}],questions:['该团期是否继续补齐夜间安排？']`,
            },
          },
        ],
      },
    ];
    const payload = responses[requestCount - 1] ?? responses[responses.length - 1];
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: payload }] }));
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

  const result = await service.reply({
    message: "继续补充夜间安排",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(requestCount, 2);
  assert.equal(result.reply, "已通过真实重试恢复");
  assert.equal(result.patch?.[0]?.value, "太原重试恢复");
  assert.equal(result.questions?.[0], "该团期是否继续补齐夜间安排？");
});

test("真实抓包片段：10 次主流程下 2 次首轮失败，仍保持 10/10 可写入落盘", async (t) => {
  let requestCount = 0;
  const responses = [
    "先返回说明文本，抓包片段 01 首轮未闭合。",
    JSON.stringify({
      reply: "抓包片段 01 恢复",
      patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原已补齐01" }],
      questions: ["是否继续核对接驳？"],
    }),
    JSON.stringify({ reply: "抓包片段 02", patch: [{ op: "add", path: "/basicInfo/subtitle", value: "太原抓包02" }] }),
    JSON.stringify({ reply: "抓包片段 03", patch: [{ op: "add", path: "/basicInfo/subtitle", value: "太原抓包03" }] }),
    "content: event line\nreply:'这是一条 tool-call 触发前噪音',patch:'[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原待补齐04\"",
    JSON.stringify({
      reply: "抓包片段 04 恢复",
      patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原已补齐04" }],
      questions: ["是否继续核对酒店？"],
    }),
    JSON.stringify({ reply: "抓包片段 05", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原抓包05" }] }),
    JSON.stringify({ reply: "抓包片段 06", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原抓包06" }] }),
    JSON.stringify({ reply: "抓包片段 07", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原抓包07" }] }),
    JSON.stringify({ reply: "抓包片段 08", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原抓包08" }] }),
    JSON.stringify({ reply: "抓包片段 09", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原抓包09" }] }),
    JSON.stringify({ reply: "抓包片段 10", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原抓包10" }] }),
    JSON.stringify({ reply: "抓包片段 11", patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原抓包11" }] }),
  ];

  const server = createServer((_request, response) => {
    requestCount += 1;
    const current = responses[Math.min(requestCount - 1, responses.length - 1)] ?? responses[responses.length - 1];
    const payload = requestCount === 5
      ? {
        content: "系统抓包中的无结构噪音，不应直接写入。",
        tool_calls: [{
          id: "tool_retry_candidate",
          type: "function",
          function: {
            name: "submit_product_update",
            arguments: "reply:'仅有说明文本，暂不落盘'",
          },
        }],
      }
      : { content: current };

    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: payload }] }));
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

  let structuredCount = 0;
  for (let index = 0; index < 10; index += 1) {
    const result = await service.reply({
      message: index === 0 ? "生成第一版" : `继续补齐 ${index}`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });
    if ((result.patch?.length ?? 0) > 0) structuredCount += 1;
  }

  assert.ok(requestCount >= 12, `requestCount=${requestCount}`);
  assert.equal(structuredCount, 10);
});

test("真实抓包片段：tool-call 截断与 content 截断交替出现，连续 5 次仍有 5/5 落盘", async (t) => {
  const scripted: Array<{ content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }> = [
    {
      content: "交替场景：首轮 content 仅说明文本，尚未结构化。",
    },
    {
      content: null,
      tool_calls: [{
        id: "tool_fallback",
        type: "function",
        function: {
          name: "submit_product_update",
          arguments: `event: message\ndata: reply:'交替场景已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原交替-1"}],questions:['是否继续核对行程？']`,
        },
      }],
    },
    {
      content: "交替场景：content 片段断开但未形成结构化字段。",
    },
    {
      content: JSON.stringify({
        reply: "交替场景-内容恢复",
        patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "太原交替-2" }],
      }),
    },
    {
      content: "tool-call 先来噪音，content 片段未闭合",
      tool_calls: [
        {
          id: "tool_dirty",
          type: "function",
          function: {
            name: "submit_product_update",
            arguments: "reply:'tool-call 截断片段，仅说明文本'",
          },
        },
      ],
    },
    {
      content: null,
      tool_calls: [{
        id: "tool_recover",
        type: "function",
        function: {
          name: "submit_product_update",
          arguments: `reply:'交替场景-tool-call 恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原交替-3"}],questions:['该团期是否继续核对交通？']`,
        },
      }],
    },
    {
      content: JSON.stringify({
        reply: "交替场景-4",
        patch: [{ op: "add", path: "/basicInfo/subtitle", value: "太原交替-4" }],
      }),
    },
    {
      content: JSON.stringify({
        reply: "交替场景-5",
        patch: [{ op: "add", path: "/basicInfo/subtitle", value: "太原交替-5" }],
      }),
    },
  ];

  let requestCount = 0;
  const server = createServer((_request, response) => {
    const payload = scripted[requestCount] ?? scripted[scripted.length - 1];
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: payload }] }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  let success = 0;
  for (let index = 0; index < 5; index += 1) {
    const result = await service.reply({
      message: index === 0 ? "继续补齐" : `继续补齐-${index}`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });
    if ((result.patch?.length ?? 0) > 0) success += 1;
  }

  assert.equal(success, 5);
  assert.ok(requestCount >= scripted.length, `requestCount=${requestCount}`);
});

test("真实抓包片段：tool-call 首轮截断 + content 噪音后仍可重试命中可写结构化", async (t) => {
  let requestCount = 0;
  const responses = [
    {
      content: "先恢复 tool-call，当前只留说明文本。",
      tool_calls: [
        {
          id: "tool_retry_noise_capture",
          type: "function",
          function: {
            name: "submit_product_update",
            arguments: "reply:'重试前说明但未闭合",
          },
        },
      ],
    },
    {
      content: "event: message\ndata: {\"reply\":\"重试恢复\",\"patch\":[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原工具重试恢复\"}],\"questions\":[\"是否继续核对夜间安排？\"]}",
    },
  ];
  const server = createServer((_request, response) => {
    const payload = responses[Math.min(requestCount, responses.length - 1)];
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: payload }] }));
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

  const result = await service.reply({
    message: "继续补齐",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(requestCount, 2);
  assert.equal(result.reply, "重试恢复");
  assert.equal(result.patch?.[0]?.value, "太原工具重试恢复");
  assert.equal(result.questions?.[0], "是否继续核对夜间安排？");
});

test("真实抓包片段：10 次主流程中 3 次先文本失败，仍 10/10 落盘", async (t) => {
  const failTurns = new Set([2, 5, 8]);
  const retriedTurns = new Set<number>();
  let requestCount = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      let turn = -1;
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: string }>; };
        const userMessage = [...(parsed.messages ?? [])]
          .reverse()
          .find((item) => item.role === "user")?.content;
        const matched = /回合\s*(\d+)/.exec(userMessage ?? "");
        if (matched) turn = Number(matched[1]);
      } catch {
        turn = -1;
      }

      let message: { content: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };
      if (turn >= 0 && failTurns.has(turn) && !retriedTurns.has(turn)) {
        retriedTurns.add(turn);
        message = {
          content: `回合 ${turn} 第一次先说明不落盘。`,
          tool_calls: [{
            id: `tool_retry_${turn}`,
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: "reply:'先发说明，仅做重试触发',patch:'[{'",
            },
          }],
        };
      } else {
        message = {
          content: JSON.stringify({
            reply: `回合 ${turn} 已恢复`,
            patch: [{
              op: "replace",
              path: "/basicInfo/subtitle",
              value: `太原回合 ${turn} 落盘`,
            }],
            questions: ["该团是否继续核对酒店？"],
          }),
        };
      }

      requestCount += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message }] }));
    });
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

  let structuredCount = 0;
  for (let turn = 0; turn < 10; turn += 1) {
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });
    if ((result.patch?.length ?? 0) > 0) {
      structuredCount += 1;
    }
  }

  assert.equal(retriedTurns.size, 3);
  assert.equal(requestCount, 13);
  assert.equal(structuredCount, 10);
});

test("真实抓包片段：10 次主流程中 1 回合连续首轮失败仍保持 9/10 落盘", async (t) => {
  const failTurn = 4;
  let requestCount = 0;
  const attemptByTurn = new Map<number, number>();

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      let turn = -1;
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: string }>; };
        const userMessage = [...(parsed.messages ?? [])]
          .reverse()
          .find((item) => item.role === "user")?.content;
        const matched = /回合\s*(\d+)/.exec(userMessage ?? "");
        if (matched) turn = Number(matched[1]);
      } catch {
        turn = -1;
      }

      const currentAttempt = (attemptByTurn.get(turn) ?? 0) + 1;
      attemptByTurn.set(turn, currentAttempt);

      let message: { content: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>; };
      if (turn === failTurn && currentAttempt === 1) {
        message = {
          content: `: keep-alive\nevent: message\ndata: 回合 ${turn} 首轮返回说明与断行噪音。`,
          tool_calls: [{
            id: "tool_fail_text_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: tool-call\ndata: reply:'回合 ${turn} 首轮未闭合`,
            },
          }],
        };
      } else if (turn === failTurn && currentAttempt === 2) {
        message = {
          content: `HTTP/1.1 200 OK\ndata: {"reply":"回合 ${turn} 内容继续截断","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合${turn}-恢复"}`,
        };
      } else if (turn === failTurn && currentAttempt === 3) {
        message = {
          content: `event: message\ndata: 回合 ${turn} 再次重试也给出异常 tool-call 名。`,
          tool_calls: [{
            id: "tool_fail_text_3",
            type: "function",
            function: {
              name: "submit_product_update_typo",
              arguments: `event: tool-call\nreply:'回合 ${turn} 仍无法落盘'`,
            },
          }],
        };
      } else if (turn === failTurn) {
        message = {
          content: `event: message\n: done`,
        };
      } else {
        message = {
          content: null,
          tool_calls: [{
            id: `tool_ok_${turn}`,
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: tool-call\ndata: reply:'回合 ${turn} 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 ${turn}"}],questions:['是否继续补齐接驳安排？']`,
            },
          }],
        };
      }

      requestCount += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message }] }));
    });
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

  let structuredCount = 0;
  for (let turn = 0; turn < 10; turn += 1) {
    const result = await service.reply({
      message: turn === 0 ? `回合 ${turn} 生成第一版` : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });
    if ((result.patch?.length ?? 0) > 0) {
      structuredCount += 1;
    }
  }

  assert.equal(requestCount, 13);
  assert.equal(structuredCount, 9);
});

test("真实抓包片段：10 次主流程中 3 回合混合首轮失败，仍 10/10 落盘（SSE + 错工具名 + 首轮不写路径）", async (t) => {
  const attemptByTurn = new Map<number, number>();
  let requestCount = 0;

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      let turn = -1;
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: string }>; };
        const userMessage = [...(parsed.messages ?? [])]
          .reverse()
          .find((item) => item.role === "user")?.content;
        const matched = /回合\s*(\d+)/.exec(userMessage ?? "");
        if (matched) turn = Number(matched[1]);
      } catch {
        turn = -1;
      }

      const currentAttempt = (attemptByTurn.get(turn) ?? 0) + 1;
      attemptByTurn.set(turn, currentAttempt);

      let message: { content: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>; };

      if (turn === 2 && currentAttempt === 1) {
        message = {
          content: `event: message\ndata: 该回合先返回 SSE 噪音，不含结构化内容`,
          tool_calls: [{
            id: "tool_mix_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: "reply:'回合 2 tool-call 首轮噪音'",
            },
          }],
        };
      } else if (turn === 6 && currentAttempt === 1) {
        message = {
          content: `event: message\ndata: 回合 6 工具名错误，参数未闭合`,
          tool_calls: [{
            id: "tool_mix_6",
            type: "function",
            function: {
              name: "submit_product_update_x",
              arguments: `event: tool-call\nreply:'回合 6 工具名不匹配`,
            },
          }],
        };
      } else if (turn === 8 && currentAttempt === 1) {
        message = {
          content: `event: message\ndata: 回合 8 先发不可写路径`,
          tool_calls: [{
            id: "tool_mix_8",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: tool-call\nreply:'回合 8 先有问题',patch:[{"op":"replace","path":"/supplier/productId","value":"tmp-8"}],questions:['请先核对供应商 id 是否可读']`,
            },
          }],
        };
      } else {
        const resolvedAttempt = (turn === 2 || turn === 6 || turn === 8) && currentAttempt > 1 ? 2 : 1;
        message = {
          content: null,
          tool_calls: [{
            id: `tool_mix_ok_${turn}_${resolvedAttempt}`,
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: tool-call\nreply:'回合 ${turn} 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 ${turn} 恢复"}],questions:['该团期是否继续补齐行程？']`,
            },
          }],
        };
      }

      requestCount += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message }] }));
    });
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

  let structuredCount = 0;
  for (let turn = 0; turn < 10; turn += 1) {
    const result = await service.reply({
      message: turn === 0 ? `回合 ${turn} 生成第一版` : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });
    if ((result.patch?.length ?? 0) > 0) {
      structuredCount += 1;
    }
  }

  assert.equal(requestCount, 13);
  assert.equal(structuredCount, 10);
});

test("真实抓包片段：首轮重试失败 2 次仍保持 10/10 落盘（首条结构化失败）", async (t) => {
  const attemptByTurn = new Map<number, number>();
  let requestCount = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      let turn = 0;
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: string }>; };
        const userMessage = [...(parsed.messages ?? [])]
          .reverse()
          .find((item) => item.role === "user")?.content;
        const matched = /回合\s*(\d+)/.exec(userMessage ?? "");
        if (matched) turn = Number(matched[1]);
      } catch {
        turn = 0;
      }

      const currentAttempt = (attemptByTurn.get(turn) ?? 0) + 1;
      attemptByTurn.set(turn, currentAttempt);

      let message: { content: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };
      if (turn === 0 && currentAttempt === 1) {
        message = {
          content: "event: message\ndata: 先发工具签名噪音，不含可落盘内容。",
          tool_calls: [{
            id: "tool_retry_0_1",
            type: "function",
            function: {
              name: "submit_product_update_typo",
              arguments: "reply:'重试首轮签名错名'，patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原回合0\"}]",
            },
          }],
        };
      } else if (turn === 0 && currentAttempt === 2) {
        message = {
          content: "先给一段说明文本，等待主流程重试。",
          tool_calls: [{
            id: "tool_retry_0_2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: "reply:'重试第二次仍仅有说明文本'。",
            },
          }],
        };
      } else {
        message = {
          content: JSON.stringify({
            reply: `回合 ${turn} 已恢复`,
            patch: [{
              op: "replace",
              path: "/basicInfo/subtitle",
              value: `太原回合 ${turn} 落盘`,
            }],
            questions: ["该团是否继续补齐行程？"],
          }),
        };
      }

      requestCount += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message }] }));
    });
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

  let structuredCount = 0;
  for (let turn = 0; turn < 10; turn += 1) {
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });
    if ((result.patch?.length ?? 0) > 0) {
      structuredCount += 1;
    }
  }

  assert.equal(requestCount, 12);
  assert.equal(structuredCount, 10);
});

test("真实抓包片段：更新型需求首轮说明文本+工具签名噪音后在下一次重试恢复可写 patch", async (t) => {
  let requestCount = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      let userMessage = "";
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: string }>; };
        const messages = [...(parsed.messages ?? [])].reverse();
        userMessage = messages.find((item) => item.role === "user")?.content ?? "";
      } catch {
        userMessage = "";
      }
      const turnMatch = /回合\s*(\d+)/.exec(userMessage);
      const turn = turnMatch ? Number(turnMatch[1]) : 0;
      const attempt = /上一次返回未通过结构化校验/.test(userMessage) ? 2 : 1;

      const payload = attempt === 1
        ? {
          content: `event: message
data: 回合 ${turn} 先说明不落盘`,
          tool_calls: [{
            id: "tool_update_noise",
            type: "function",
            function: {
              name: "submit_product_update_typo",
              arguments: `reply:'更新回合 ${turn} 先给说明'`,
            },
          }],
        }
        : {
          content: null,
          tool_calls: [{
            id: "tool_update_recover",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'回合 ${turn} 更新已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合${turn} 已恢复"}],questions:['该团是否继续补齐夜间安排？']`,
            },
          }],
        };

      requestCount += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: payload }] }));
    });
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

  const result = await service.reply({
    message: "回合 0 更新夜间安排描述",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(requestCount, 2);
  assert.equal(result.reply, "回合 0 更新已恢复");
  assert.equal(result.patch?.[0].value, "太原回合0 已恢复");
  assert.equal(result.questions?.[0], "该团是否继续补齐夜间安排？");
});
