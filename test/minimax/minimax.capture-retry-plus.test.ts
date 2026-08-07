import { assert, MiniMaxService, MiniMaxServiceError, test } from "./minimax.core.shared.js";
import { createServer } from "node:http";

test("真实抓包片段：10 次混合首轮失败仍 10/10 可落盘（tool 名错名+截断+不可写路径）", async (t) => {
  let requestCount = 0;
  const attemptByTurn = new Map<number, number>();

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      let turn = 0;
      let userMessage = "";
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }>; };
        userMessage = [...(parsed.messages ?? [])]
          .reverse()
          .find((item) => item.role === "user")?.content ?? "";
        const matched = /回合\s*(\d+)/.exec(userMessage);
        if (matched) turn = Number(matched[1]);
      } catch {
        turn = 0;
      }

      const currentAttempt = (attemptByTurn.get(turn) ?? 0) + 1;
      attemptByTurn.set(turn, currentAttempt);

      let payload: {
        content: string | null;
        tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
      };

      if (turn === 0 && currentAttempt === 1) {
        payload = {
          content: "event: message\ndata: 回合 0 首次仅说明文本。",
          tool_calls: [{
            id: "tool_turn0_a1",
            type: "function",
            function: {
              name: "submit_product_update_typo",
              arguments: "reply:'回合 0 工具名错位',patch:[{'op':'replace','path':'/basicInfo/subtitle','value':'太原回合0'}]",
            },
          }],
        };
      } else if (turn === 0 && currentAttempt === 2) {
        payload = {
          content: "event: message\ndata: 回合 0 首次截断尝试。",
          tool_calls: [{
            id: "tool_turn0_a2",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: "reply:'回合 0 仍未闭合',patch:[{'op':'replace','path':'/basicInfo/subtitle','value':'太原回合0-二次'",
            },
          }],
        };
      } else if (turn === 3 && currentAttempt === 1) {
        payload = {
          content: "event: message\ndata: 回合 3 首次给不可写路径。",
          tool_calls: [{
            id: "tool_turn3_a1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'回合 3 回调了不可写字段',patch:[{"op":"replace","path":"/supplier/productId","value":"tmp-3"}],questions:['先确认供应商编码？']`,
            },
          }],
        };
      } else if (turn === 5 && currentAttempt === 1) {
        payload = {
          content: `event: message\ndata: {"reply":"回合 5 无法闭合`,
        };
      } else {
        const validAttempt = currentAttempt > 1 ? `${currentAttempt}` : "";
        payload = {
          content: null,
          tool_calls: [{
            id: `tool_ok_${turn}_${validAttempt || 1}`,
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `event: message\ndata: reply:'回合 ${turn} 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 ${turn} 已恢复"}],questions:['该团是否继续补齐夜间接驳？']`,
            },
          }],
        };
      }

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

test("真实抓包片段：服务端首轮不结构化时应在同一次请求内补齐重试提示", async (t) => {
  let requestCount = 0;
  let secondRequestBody = "";
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      requestCount += 1;
      if (requestCount === 2) secondRequestBody = body;
      if (requestCount === 1) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: "先回复说明文本，先不落盘。",
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
              id: "tool_retry_with_prompt",
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: `reply:'补齐后可落盘',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原重试提示恢复"}],questions:['该团是否继续补齐班期？']`,
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

  const service = new MiniMaxService({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "test-model",
  });

  const result = await service.reply({
    message: "补齐夜间安排",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(requestCount, 2);
  assert.equal(result.reply, "补齐后可落盘");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原重试提示恢复");

  const parsedBody = JSON.parse(secondRequestBody) as { messages?: Array<{ role: string; content: string }> };
  const retryPrompt = parsedBody.messages?.[parsedBody.messages.length - 1]?.content ?? "";
  assert.match(retryPrompt, /上一次返回未通过结构化校验/);
});

test("真实抓包片段：10 次混合失败中每次重试都应附带结构化补齐提示，仍 10/10 落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  const retryRequestBodies: string[] = [];
  let requestCount = 0;

  const parseTurnFromUserMessage = (message: string): number => {
    const matchedTurn = /回合\s*(\d+)/.exec(message);
    if (matchedTurn) return Number(matchedTurn[1]);

    const matchedInput = /用户本轮输入：([^\n\r]+)/.exec(message);
    if (!matchedInput?.[1]) return 0;
    return Number(/回合\s*(\d+)/.exec(matchedInput[1])?.[1] ?? 0);
  };
  const buildTurnPayload = (turn: number, attempt: number) => {
    if (turn === 0 && attempt === 1) {
      return { content: "event: message\ndata: 抓包片段 0 首轮未落盘文本，期待重试。", tool_calls: undefined };
    }
    if (turn === 0 && attempt === 2) {
      return {
        content: null,
        tool_calls: [{
          id: "tool_turn0_wrong_name",
          type: "function",
          function: {
            name: "submit_product_update_typo",
            arguments: "reply:'首轮工具名错位导致无可写字段'",
          },
        }],
      };
    }
    if (turn === 5 && attempt === 1) {
      return {
        content: "event: message\ndata: 先回传不落盘文本。",
        tool_calls: [{
          id: "tool_turn5_invalid_path",
          type: "function",
          function: {
            name: "submit_product_update",
            arguments: `reply:'回合5 先给不可写路径',patch:[{"op":"replace","path":"/supplier/productId","value":"tmp-5"}],questions:['该团是否继续核对供应商编码？']`,
          },
        }],
      };
    }
    return {
      content: null,
      tool_calls: [{
        id: `tool_turn_${turn}_ok_${attempt}`,
        type: "function",
        function: {
          name: "submit_product_update",
          arguments: `reply:'抓包恢复 ${turn}',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 ${turn}"}],questions:['该团是否继续核对接驳？']`,
        },
      }],
    };
  };

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as {
        messages?: Array<{ role: string; content: string }>;
      };
      const message = parsed.messages?.filter((item) => item.role === "user").at(-1)?.content ?? "";
      const turn = parseTurnFromUserMessage(message);
      const attempt = (attemptByTurn.get(turn) ?? 0) + 1;
      attemptByTurn.set(turn, attempt);
      if (message.includes("上一次返回未通过结构化校验")) {
        retryRequestBodies.push(body);
      }

      const payload = buildTurnPayload(turn, attempt);
      if (turn === 5 && attempt >= 2) {
        payload.tool_calls = [{
          id: "tool_turn5_ok_2",
          type: "function",
          function: {
            name: "submit_product_update",
            arguments: `reply:'抓包恢复 5',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 5 恢复值"}],questions:['该团是否继续核对酒店？']`,
          },
        }];
      }
      if (turn === 0 && attempt >= 3) {
        payload.tool_calls = [{
          id: "tool_turn0_ok_3",
          type: "function",
          function: {
            name: "submit_product_update",
            arguments: `reply:'抓包恢复 0',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 0 恢复值"}],questions:['该团是否继续核对车接驳？']`,
          },
        }];
      }

      response.setHeader("content-type", "application/json");
      requestCount += 1;
      response.end(JSON.stringify({ choices: [{ message: payload }] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });

  let structuredCount = 0;
  for (let turn = 0; turn < 10; turn += 1) {
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });
    if ((result.patch?.length ?? 0) > 0) structuredCount += 1;
  }

  assert.equal(requestCount, 13);
  assert.equal(structuredCount, 10);
  assert.ok(retryRequestBodies.length >= 2);
  for (const body of retryRequestBodies) {
    const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> };
    const latestMessage = parsed.messages?.filter((item) => item.role === "user").at(-1)?.content ?? "";
    assert.match(latestMessage, /上一次返回未通过结构化校验/);
  }
});

test("真实抓包片段：10 次流量中 1 次全失败，仍应至少 9/10 可落盘", async (t) => {
  const requestByTurn = new Map<number, number>();
  let requestCount = 0;
  let failCount = 0;
  let successCount = 0;

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as {
        messages?: Array<{ role: string; content: string }>;
      };
      const message = parsed.messages?.filter((item) => item.role === "user").at(-1)?.content ?? "";
      const turn = Number(/回合\s*(\d+)/.exec(message)?.[1] ?? 0);
      const attempt = (requestByTurn.get(turn) ?? 0) + 1;
      requestByTurn.set(turn, attempt);
      requestCount += 1;

      let payload: { content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };
      if (turn === 4 && attempt <= 5) {
        payload = {
          content: "event: message\ndata: 故障回合 4 暂无可落盘结构化内容",
        };
      } else {
        payload = {
          content: null,
          tool_calls: [{
            id: `tool_turn_${turn}_ok_${attempt}`,
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'抓包恢复 ${turn}',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 ${turn} 恢复值"}],questions:['该团是否继续核对行程？']`,
            },
          }],
        };
      }
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

  for (let turn = 0; turn < 10; turn += 1) {
    try {
      const result = await service.reply({
        message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
        product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
        history: [],
      });
      if ((result.patch?.length ?? 0) > 0) successCount += 1;
    } catch (error) {
      failCount += 1;
      assert.ok(error instanceof MiniMaxServiceError);
      assert.equal((error as MiniMaxServiceError).code, "invalid_model_output");
    }
  }

  assert.equal(successCount, 9);
  assert.equal(failCount, 1);
  assert.equal(requestCount, 14);
});
