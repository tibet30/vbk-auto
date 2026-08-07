import { assert, MiniMaxService, MiniMaxServiceError, test } from "./minimax.core.shared.js";
import { createServer } from "node:http";

test("真实抓包片段：10 次中 1 回合首轮工具名错位但带可写参数仍需重试，10/10 落盘", async (t) => {
  const retryRequestBodies: string[] = [];
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
        const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }>; };
        const userMessage = [...(parsed.messages ?? [])]
          .reverse()
          .find((item) => item.role === "user")?.content ?? "";
        turn = Number(/回合\s*(\d+)/.exec(userMessage)?.[1] ?? 0);
      } catch {
        turn = 0;
      }
      const attempt = (attemptByTurn.get(turn) ?? 0) + 1;
      attemptByTurn.set(turn, attempt);

      if (body.includes("上一次返回未通过结构化校验")) {
        retryRequestBodies.push(body);
      }

      let payload: { content: string | null; tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>; };
      if (turn === 0 && attempt === 1) {
        payload = {
          content: null,
          tool_calls: [{
            id: "tool_typo_only",
            type: "function",
            function: {
              name: "submit_product_update_typo",
              arguments: `reply:'回合0 错工具名但含可写 patch',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 0 错工具名"}],questions:['该团是否继续核对行程？']`,
            },
          }],
        };
      } else {
        payload = {
          content: null,
          tool_calls: [{
            id: `tool_turn_${turn}_ok_${attempt}`,
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'回合 ${turn} 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 ${turn} 恢复值"}],questions:['该团是否继续核对接驳？']`,
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
    if ((result.patch?.length ?? 0) > 0) structuredCount += 1;
  }

  assert.equal(requestCount, 11);
  assert.equal(structuredCount, 10);
  assert.equal(retryRequestBodies.length, 1);
});

test("真实抓包片段：10 次主流程 2 回合首轮工具名错位，仍 10/10 可落盘", async (t) => {
  const retryRequestTurns = new Set<number>();
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
        const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }>; };
        const userMessage = [...(parsed.messages ?? [])]
          .reverse()
          .find((item) => item.role === "user")?.content ?? "";
        turn = Number(/回合\s*(\d+)/.exec(userMessage)?.[1] ?? 0);
      } catch {
        turn = 0;
      }
      const attempt = (attemptByTurn.get(turn) ?? 0) + 1;
      attemptByTurn.set(turn, attempt);
      if (attempt === 1 && (turn === 3 || turn === 7)) {
        retryRequestTurns.add(turn);
      }

      const typoPayload = turn === 3 || turn === 7
        ? {
          content: attempt === 1 ? "该回合先给说明文本" : null,
          tool_calls: [{
            id: `tool_wrong_${turn}_${attempt}`,
            type: "function" as const,
            function: {
              name: "submit_product_update_x",
              arguments: `reply:'回合${turn} 错工具名',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 ${turn} 错名"}],questions:['该团是否继续核对酒店？']`,
            },
          }],
        }
        : {
          content: null,
          tool_calls: [{
            id: `tool_turn_${turn}_ok_${attempt}`,
            type: "function" as const,
            function: {
              name: "submit_product_update",
              arguments: `reply:'回合 ${turn} 正式恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 ${turn} 恢复值"}],questions:['该团是否继续核对夜间安排？']`,
            },
          }],
        };

      requestCount += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: typoPayload }] }));
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
    if ((result.patch?.length ?? 0) > 0) structuredCount += 1;
  }

  assert.equal(requestCount, 12);
  assert.equal(structuredCount, 10);
  assert.equal(retryRequestTurns.size, 2);
  assert.ok(retryRequestTurns.has(3));
  assert.ok(retryRequestTurns.has(7));
});

test("真实抓包片段：10 次主流程中 1 回合 5 次全为错工具名，仍应 9/10 可落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  let requestCount = 0;
  let failCount = 0;
  let successCount = 0;

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      let turn = 0;
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }>; };
        const userMessage = [...(parsed.messages ?? [])]
          .reverse()
          .find((item) => item.role === "user")?.content ?? "";
        turn = Number(/回合\s*(\d+)/.exec(userMessage)?.[1] ?? 0);
      } catch {
        turn = 0;
      }
      const attempt = (attemptByTurn.get(turn) ?? 0) + 1;
      attemptByTurn.set(turn, attempt);

      let payload: { content: string; tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>; };
      if (turn === 4 && attempt <= 5) {
        payload = {
          content: "该回合全程错工具名，无官方工具返回",
          tool_calls: [{
            id: `tool_turn_4_wrong_${attempt}`,
            type: "function",
            function: {
              name: "submit_product_update_typo",
              arguments: `reply:'回合 4 重复错工具名',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 4 失败片段"}],questions:['该团是否继续核对供应商编码？']`,
            },
          }],
        };
      } else {
        payload = {
          content: null,
          tool_calls: [{
            id: `tool_turn_${turn}_ok_${attempt}`,
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'回合 ${turn} 恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 ${turn} 恢复值"}],questions:['该团是否继续核对车辆？']`,
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

  assert.equal(requestCount, 14);
  assert.equal(successCount, 9);
  assert.equal(failCount, 1);
});
