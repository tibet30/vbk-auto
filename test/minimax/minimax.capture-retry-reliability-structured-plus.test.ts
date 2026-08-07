import { assert, MiniMaxService, test } from "./minimax.core.shared.js";
import { createServer } from "node:http";

const buildCanonicalTurnPayload = (turn: number) => ({
  content: null,
  tool_calls: [{
    id: `tool_turn_${turn}_ok`,
    type: "function" as const,
    function: {
      name: "submit_product_update",
      arguments: `reply:'回合 ${turn} 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 ${turn} 恢复值"}],questions:['该团是否继续核对接驳？']`,
    },
  }],
});

test("真实抓包片段：10 次主流程 1 回合 content 结构化失败，tool-call 官方参数有可写 patch，10/10 落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  const structuredFailureBodies: string[] = [];
  let requestCount = 0;
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

      const payload = turn === 4 && attempt === 1
        ? {
          content: "[MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }",
          tool_calls: [
            {
              id: "tool_turn_4_bad",
              type: "function" as const,
              function: {
                name: "submit_product_update",
                arguments: `reply:'回合 4 工具参数说明',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 4 恢复值"}],questions:['该团是否继续核对接驳？']`,
              },
            },
            {
              id: "tool_turn_4_noisy_typo",
              type: "function" as const,
              function: {
                name: "submit_product_update_typo",
                arguments: "reply:'该工具名不应命中',patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"坏路径\"}]",
              },
            },
          ],
        }
        : buildCanonicalTurnPayload(turn);

      if (turn === 4 && attempt === 1) {
        structuredFailureBodies.push(body);
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
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
      assert.match(result.reply, /恢复值/);
    }
  }

  assert.equal(requestCount, 10);
  assert.equal(successCount, 10);
  assert.equal(attemptByTurn.get(4), 1);
  assert.equal(structuredFailureBodies.length, 1);
});

test("真实抓包片段：10 次主流程 1 回合连续结构化失败后 3 次后恢复，10/10 落盘且仅该轮多次重试", async (t) => {
  const attemptByTurn = new Map<number, number>();
  let requestCount = 0;
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

      let payload:
        | { content: string | null; tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
        | { content: null; tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };

      if (turn === 7 && attempt <= 3) {
        if (attempt <= 2) {
          payload = {
            content: `event: message\ndata: [MiniMax] structured response rejected { length: 134, hasThinkingBlock: ${attempt === 2 ? "true" : "false"}, hasJsonFence: ${attempt === 2 ? "true" : "false"}, reason: 'Unexpected end of JSON input' }`,
            tool_calls: [
              {
                id: `tool_turn_7_retry_${attempt}`,
                type: "function",
                function: {
                  name: "submit_product_update",
                  arguments: attempt === 1
                    ? "reply:'回合 7 重试前，暂缺可写字段',questions:['该团是否继续核对接驳？']"
                    : `reply:'回合 7 仍失败',questions:['该团是否继续核对接驳？'],notes:"${attempt === 2 ? "[MiniMax] structured response rejected { length: 134, hasThinkingBlock: true, hasJsonFence: true, reason: 'Unexpected token } in JSON at position 77' }" : "待补齐"}`,
                },
              },
              {
                id: `tool_turn_7_typo_${attempt}`,
                type: "function",
                function: {
                  name: "submit_product_update_typo",
                  arguments: "reply:'该工具名不应命中',patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"待失败样本\"}]",
                },
              },
            ],
          };
        } else {
          payload = buildCanonicalTurnPayload(turn);
        }
      } else {
        payload = buildCanonicalTurnPayload(turn);
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
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
      assert.match(result.reply, /已恢复/);
    }
  }

  assert.equal(successCount, 10);
  assert.equal(requestCount, 11);
  assert.equal(attemptByTurn.get(7), 3);
});

test("真实抓包片段：10 次主流程 1 回合首轮仅报 structured response rejected，2 次重试后恢复，10/10 落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  const retryBodies: string[] = [];
  let requestCount = 0;
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

      let payload: {
        content: string | null;
        tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
      };

      if (turn === 6 && attempt <= 2) {
        if (attempt >= 2) {
          retryBodies.push(body);
        }
        payload = {
          content: "[MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }",
          tool_calls: [
            {
              id: `tool_turn_6_bad_${attempt}`,
              type: "function",
              function: {
                name: "submit_product_update_typo",
                arguments: "reply:'该工具名不应命中',patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原回合 6\"}]",
              },
            },
            {
              id: `tool_turn_6_bad_${attempt}_no_patch`,
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: attempt === 1
                  ? "reply:'回合 6 未携带可写字段',questions:['该团是否继续核对接驳？']"
                  : `reply:'回合 6 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 6 恢复值"}],questions:['该团是否继续核对接驳？']`,
              },
            },
          ],
        };
      } else {
        payload = {
          content: "event: message\ndata: 回合已可恢复",
          tool_calls: buildCanonicalTurnPayload(turn).tool_calls,
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
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
      assert.match(result.reply, /恢复值/);
    }
  }

  assert.equal(successCount, 10);
  assert.equal(requestCount, 11);
  assert.equal(attemptByTurn.get(6), 2);
  assert.equal(retryBodies.length, 1);
  const lastRetry = JSON.parse(retryBodies[0] ?? "{}") as { messages?: Array<{ role: string; content: string }>; };
  const lastUser = lastRetry.messages?.at(-1);
  assert.equal(lastUser?.role, "user");
  assert.equal(lastUser?.content?.includes("上一次返回未通过结构化校验") ?? false, true);
});

test("真实抓包片段：10 次主流程 1 回合 5 次 structured response rejected 仍 9/10 落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  let requestCount = 0;
  let successCount = 0;
  let failCount = 0;

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

      let payload = buildCanonicalTurnPayload(turn);
      if (turn === 5 && attempt <= 5) {
        payload = {
          content: `event: message\ndata: [payload] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected token } in JSON at position 77' }`,
          tool_calls: [{
            id: `tool_turn_5_bad_${attempt}`,
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'回合 5 仍无可写字段',questions:['该团是否继续核对接驳？']`,
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
      if ((result.patch?.length ?? 0) > 0) {
        successCount += 1;
      }
    } catch (error) {
      failCount += 1;
      assert.match((error as Error)?.message ?? "", /结构|未返回可写入的产品方案|结构化|Unable/);
    }
  }

  assert.equal(failCount, 1);
  assert.equal(successCount, 9);
  assert.equal(requestCount, 14);
  assert.equal(attemptByTurn.get(5), 5);
});

test("真实抓包片段：10 次主流程首轮仅包含 [2] structured response rejected，官方 tool-call 仍 10/10 落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  let requestCount = 0;
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

      let payload:
        | { content: string | null; tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
        | { content: string | null; tool_calls: undefined };

      if (turn === 4 && attempt === 1) {
        payload = {
          content: "[2] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }",
          tool_calls: [
            {
              id: "tool_turn_4_bad_1",
              type: "function",
              function: {
                name: "submit_product_update_typo",
                arguments: "reply:'该工具名不应命中',patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"坏答案\"}],questions:['该团是否继续核对接驳？']",
              },
            },
            {
              id: "tool_turn_4_ok_1",
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: `reply:'回合 4 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 4 恢复值"}],questions:['该团是否继续核对接驳？']`,
              },
            },
          ],
        };
      } else {
        payload = buildCanonicalTurnPayload(turn);
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
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
      if (turn === 4) {
        assert.equal(result.patch?.[0]?.value, "太原回合 4 恢复值");
      }
    }
  }

  assert.equal(requestCount, 10);
  assert.equal(successCount, 10);
  assert.equal(attemptByTurn.get(4), 1);
});

test("真实抓包片段：10 次主流程 1 回合 tool-call 参数含 structured failure 日志文本，仍 10/10 落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  const targetTurnBodies: string[] = [];
  let requestCount = 0;
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

      let payload:
        | { content: string | null; tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
        | { content: string | null; tool_calls: undefined };

      if (turn === 6 && attempt === 1) {
        targetTurnBodies.push(body);
        payload = {
          content: "event: message\ndata: 回合 6 先说明文本",
          tool_calls: [{
            id: "tool_turn_6_with_failure_signal_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'回合 6 工具参数含异常日志',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 6 恢复值"}],notes:"[MiniMax] structured response rejected { length: 134, hasThinkingBlock: true, hasJsonFence: true, reason: 'Unexpected end of JSON input' }",questions:['该团是否继续核对接驳？']`,
            },
          }],
        };
      } else {
        payload = buildCanonicalTurnPayload(turn);
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
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
      if (turn === 6) {
        assert.equal(result.patch?.[0]?.value, "太原回合 6 恢复值");
      }
    }
  }

  assert.equal(requestCount, 10);
  assert.equal(successCount, 10);
  assert.equal(attemptByTurn.get(6), 1);
  assert.equal(targetTurnBodies.length, 1);
  const parsedTurnBody = JSON.parse(targetTurnBodies[0] ?? "{}") as { messages?: Array<{ role: string; content: string }> };
  const userTurn = parsedTurnBody.messages?.filter((item) => item.role === "user").at(-1)?.content ?? "";
  assert.equal(userTurn.includes("回合 6 继续补齐"), true);
});

test("真实抓包片段：10 次主流程 1 回合首轮出现 [2] 与内容干扰，官方 tool-call 仍 10/10 落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  let requestCount = 0;
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

      const payload = turn === 8 && attempt === 1
        ? {
          content: "event: message\ndata: [2] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }",
          tool_calls: [
            {
              id: "tool_turn_8_bad_1",
              type: "function",
              function: {
                name: "submit_product_update_typo",
                arguments: "reply:'该工具名不应命中',patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"坏答案\"}],questions:['该团是否继续核对接驳？']",
              },
            },
            {
              id: "tool_turn_8_ok_1",
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: `reply:'回合 8 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 8 恢复值"}],notes:"[2] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }",questions:['该团是否继续核对接驳？']`,
              },
            },
          ],
        }
        : buildCanonicalTurnPayload(turn);

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
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
      if (turn === 8) {
        assert.equal(result.patch?.[0]?.value, "太原回合 8 恢复值");
      }
    }
  }

  assert.equal(requestCount, 10);
  assert.equal(successCount, 10);
  assert.equal(attemptByTurn.get(8), 1);
});

test("真实抓包片段：10 次主流程 1 回合 4 次首轮 structured failure，1 回合 5 次后仍 1 次落空（≥9/10）", async (t) => {
  const attemptByTurn = new Map<number, number>();
  let requestCount = 0;
  let successCount = 0;
  let failCount = 0;

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

      let payload = buildCanonicalTurnPayload(turn);
      if (turn === 4 && attempt <= 5) {
        payload = {
          content: `event: message\ndata: [payload] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected token } in JSON at position 77' }`,
          tool_calls: attempt <= 4 ? [
            {
              id: `tool_turn_4_bad_${attempt}`,
              type: "function",
              function: {
                name: "submit_product_update_typo",
                arguments: "reply:'turn4 typo patch',patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"坏答案\"}]",
              },
            },
            {
              id: `tool_turn_4_retry_${attempt}`,
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: "reply:'回合 4 重试文本',questions:['该团是否继续核对接驳？']",
              },
            },
          ] : buildCanonicalTurnPayload(turn).tool_calls,
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
      if ((result.patch?.length ?? 0) > 0) {
        successCount += 1;
      }
    } catch (error) {
      failCount += 1;
      assert.equal(turn === 4, true);
      assert.match((error as Error)?.message ?? "", /结构化|未返回可写入的产品方案|JSON/);
    }
  }

  assert.equal(requestCount, 14);
  assert.equal(successCount, 9);
  assert.equal(failCount, 1);
  assert.equal(attemptByTurn.get(4), 5);
});

test("真实抓包片段：10 次主流程 1 回合 content 同时含 [2]/[DONE]/[payload] 噪音，官方 tool-call 仍 10/10 落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  let requestCount = 0;
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

      const payload = turn === 2 && attempt === 1
        ? {
          content: "event: message\ndata: [DONE]\nevent: message\ndata: [payload] [2] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected token } in JSON at position 77' }",
          tool_calls: [
            {
              id: "tool_turn_2_bad_1",
              type: "function",
              function: {
                name: "submit_product_update_typo",
                arguments: "reply:'该工具名不应命中',patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"噪音回合 2\"}],questions:['该团是否继续核对接驳？']",
              },
            },
            {
              id: "tool_turn_2_ok_1",
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: `reply:'回合 2 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 2 恢复值"}],notes:"HTTP/1.1 200 OK:keep-alive 该日志无结构意义",questions:['该团是否继续核对接驳？']`,
              },
            },
          ],
        }
        : buildCanonicalTurnPayload(turn);

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
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
      if (turn === 2) {
        assert.equal(result.patch?.[0]?.value, "太原回合 2 恢复值");
      }
    }
  }

  assert.equal(requestCount, 10);
  assert.equal(successCount, 10);
  assert.equal(attemptByTurn.get(2), 1);
});

test("真实抓包片段：10 次主流程 1 回合 structured response rejected 连续 3 次后恢复，10/10 落盘且重试内容带结构化补齐提示", async (t) => {
  const attemptByTurn = new Map<number, number>();
  const secondAttemptBodies: string[] = [];
  let requestCount = 0;
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

      if (turn === 7 && attempt === 2) secondAttemptBodies.push(body);

      let payload:
        | { content: string | null; tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
        | { content: string | null; tool_calls: undefined };

      if (turn === 7 && attempt <= 3) {
        payload = attempt < 3
          ? {
            content: `[payload] structured response rejected { length: 134, hasThinkingBlock: ${attempt === 2 ? "true" : "false"}, hasJsonFence: ${attempt === 2 ? "true" : "false"}, reason: 'Unexpected end of JSON input' }`,
            tool_calls: [
              {
                id: `tool_turn_7_bad_${attempt}`,
                type: "function",
                function: {
                  name: "submit_product_update_typo",
                  arguments: "reply:'该工具名不应命中',patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"回合 7 错误值\"}]",
                },
              },
              {
                id: `tool_turn_7_retry_${attempt}`,
                type: "function",
                function: {
                  name: "submit_product_update",
                  arguments: attempt === 1
                    ? "reply:'回合 7 仍无可写字段',questions:['该团是否继续核对接驳？']"
                    : attempt === 2
                      ? "reply:'回合 7 重试 2',questions:['该团是否继续核对接驳？'],notes:'[MiniMax] structured response rejected { length: 134, hasThinkingBlock: true, hasJsonFence: true, reason: \"Unexpected token } in JSON at position 77\" }'"
                      : `reply:'回合 7 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 7 恢复值"}],questions:['该团是否继续核对接驳？']`,
                },
              },
            ],
          }
          : buildCanonicalTurnPayload(turn);
      } else {
        payload = buildCanonicalTurnPayload(turn);
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
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
      if (turn === 7) {
        assert.equal(result.patch?.[0]?.value, "太原回合 7 恢复值");
      }
    }
  }

  assert.equal(requestCount, 12);
  assert.equal(successCount, 10);
  assert.equal(attemptByTurn.get(7), 3);
  assert.equal(secondAttemptBodies.length, 1);
  const secondAttempt = JSON.parse(secondAttemptBodies[0] ?? "{}") as { messages?: Array<{ role: string; content: string }>; };
  const retryUserMessage = [...(secondAttempt.messages ?? [])].reverse().find((item) => item.role === "user")?.content ?? "";
  assert.equal(retryUserMessage.includes("上一次返回未通过结构化校验"), true);
});

test("真实抓包片段：10 次主流程 1 回合连续 5 次结构化失败，最终 9/10 落盘（含完整 AI 结构化字段）", async (t) => {
  const attemptByTurn = new Map<number, number>();
  const retryRequestBodies: string[] = [];
  let requestCount = 0;
  let successCount = 0;
  let failCount = 0;

  const buildSuccessPayload = (turn: number) => ({
    content: `event: message\ndata: 回合 ${turn} 可恢复`,
    tool_calls: [{
      id: `tool_turn_${turn}_ok`,
      type: "function" as const,
      function: {
        name: "submit_product_update",
        arguments: `reply:'回合 ${turn} 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 ${turn} 恢复值"},{"op":"replace","path":"/operations/transport","value":"包车"}],questions:['该团是否确认接驳时段？'],researchTasks:[{"label":"确认接驳时间","type":"vbk","detail":"核对夜间接驳时间与供应商可用性"}]`,
      },
    }],
  });

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
      requestCount += 1;

      if (turn === 5 && attempt <= 5) {
        if (attempt >= 2) retryRequestBodies.push(body);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: `[2] [DONE] [payload] structured response rejected { length: 134, hasThinkingBlock: ${attempt === 3 ? "true" : "false"}, hasJsonFence: ${attempt === 3 ? "true" : "false"}, reason: 'Unexpected token } in JSON at position 77' }`,
              tool_calls: [
                {
                  id: `tool_turn_5_typo_${attempt}`,
                  type: "function",
                  function: {
                    name: "submit_product_update_typo",
                    arguments: `reply:'回合 5 失败提示',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 5 错名"}],questions:['是否继续补齐？'],researchTasks:[{"label":"错误工具名排查","type":"web","detail":"工具名应为 submit_product_update"}]`,
                  },
                },
                {
                  id: `tool_turn_5_bad_${attempt}`,
                  type: "function",
                  function: {
                    name: "submit_product_update",
                    arguments: `reply:'回合 5 仍未可写补齐',questions:['该团是否继续核对接驳？'],researchTasks:[{"label":"接驳核查失败","type":"vbk","detail":"回合5重试 ${attempt} 仍未返回可写 patch"}]`,
                  },
                },
              ],
            },
          }],
        }));
        return;
      }

      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: buildSuccessPayload(turn) }] }));
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
      if ((result.patch?.length ?? 0) > 0) {
        successCount += 1;
      }
    } catch (error) {
      failCount += 1;
      assert.match((error as Error)?.message ?? "", /结构|未返回可写入的产品方案/);
    }
  }

  assert.equal(requestCount, 14);
  assert.equal(successCount, 9);
  assert.equal(failCount, 1);
  assert.equal(attemptByTurn.get(5), 5);
  assert.equal(retryRequestBodies.length, 4);
  for (const retryBody of retryRequestBodies) {
    const parsed = JSON.parse(retryBody) as { messages?: Array<{ role: string; content: string }>; };
    const lastUser = parsed.messages?.at(-1)?.content ?? "";
    assert.ok(/上一次返回未通过结构化校验/.test(lastUser));
    assert.ok(/回合 5/.test(lastUser));
  }
});

test("真实抓包片段：10 次主流程 1 回合首轮含 [2] structured response rejected，2 次重试后恢复，10/10 落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  const retryRequestBodies: string[] = [];
  let requestCount = 0;
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
      requestCount += 1;

      if (turn === 7 && attempt <= 3) {
        if (attempt >= 2) retryRequestBodies.push(body);
        const payload = {
          content: attempt === 1
            ? "[2] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }"
            : attempt === 2
              ? `event: message\ndata: [MiniMax] structured response rejected { length: 134, hasThinkingBlock: ${attempt === 2 ? "true" : "false"}, hasJsonFence: ${attempt === 2 ? "true" : "false"}, reason: 'Unexpected token } in JSON at position 77' }`
              : `event: message\ndata: 回合 ${turn} 恢复可落盘`,
          tool_calls: [
            {
              id: `tool_turn_${turn}_bad_${attempt}`,
              type: "function" as const,
              function: {
                name: "submit_product_update_typo",
                arguments: "reply:'回合 7 工具名命中异常',patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原回合 7 错名\"}],questions:['是否继续核对接驳？']",
              },
            },
            {
              id: `tool_turn_${turn}_retry_${attempt}`,
              type: "function" as const,
              function: {
                name: "submit_product_update",
                arguments: attempt < 3
                  ? "reply:'回合 7 重试片段待补齐',questions:['该团是否继续核对接驳？'],researchTasks:[{\"label\":\"结构化失败重试\",\"type\":\"vbk\",\"detail\":\"含 [2] 错误后需继续补齐\"}]"
                  : `reply:'回合 7 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 7 恢复值"}],questions:['该团是否继续核对接驳？'],researchTasks:[{\"label\":\"结构化重试核验\",\"type\":\"web\",\"detail\":\"确认已补齐可写 patch\"}]`,
              },
            },
          ],
        };
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: payload }] }));
        return;
      }

      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: `event: message\ndata: 回合 ${turn} 已恢复`,
            tool_calls: [{
              id: `tool_turn_${turn}_ok`,
              type: "function" as const,
              function: {
                name: "submit_product_update",
                arguments: `reply:'回合 ${turn} 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 ${turn} 恢复值"},{"op":"replace","path":"/operations/transport","value":"包车"}],questions:['该团是否继续核对接驳？'],researchTasks:[{\"label\":\"行前核对\",\"type\":\"web\",\"detail\":\"确认接驳与夜间安排\"}]`,
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

  for (let turn = 0; turn < 10; turn += 1) {
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });
    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
      if (turn === 7) {
        assert.equal(result.patch?.[0]?.value, "太原回合 7 恢复值");
      }
    }
  }

  assert.equal(requestCount, 12);
  assert.equal(successCount, 10);
  assert.equal(attemptByTurn.get(7), 3);
  assert.equal(retryRequestBodies.length, 2);
  for (const retryBody of retryRequestBodies) {
    const parsed = JSON.parse(retryBody) as { messages?: Array<{ role: string; content: string }>; };
    const lastUser = parsed.messages?.at(-1)?.content ?? "";
    assert.equal(lastUser.includes("上一次返回未通过结构化校验"), true);
    assert.equal(lastUser.includes("回合 7 继续补齐"), true);
  }
});

test("真实抓包片段：10 次主流程 1 回合首轮仅含 [2] structured response rejected（无官方 tool-call），1 次重试后 10/10 落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  const retryBodies: string[] = [];
  let requestCount = 0;
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

      const payload: { content: string | null; tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> } =
        turn === 9 && attempt === 1
          ? {
            content: "[2] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }",
            tool_calls: [{
              id: "tool_turn_9_bad_1",
              type: "function",
              function: {
                name: "submit_product_update_typo",
                arguments: `reply:'该工具名不应命中',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"坏答案"}]`,
              },
            }],
          }
          : {
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

      requestCount += 1;
      if (turn === 9 && attempt === 1) {
        retryBodies.push(body);
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
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
      if (turn === 9) {
        assert.equal(result.patch?.[0]?.value, "太原回合 9 恢复值");
      }
    }
  }

  assert.equal(requestCount, 11);
  assert.equal(successCount, 10);
  assert.equal(attemptByTurn.get(9), 2);
  assert.equal(retryBodies.length, 1);
  const lastRetryBody = JSON.parse(retryBodies[0] ?? "{}") as { messages?: Array<{ role: string; content: string }>; };
  const lastUser = lastRetryBody.messages?.at(-1)?.content ?? "";
  assert.ok(/回合 9 继续补齐/.test(lastUser));
  assert.ok(/上一次返回未通过结构化校验/.test(lastUser));
});

test("真实抓包片段：10 次主流程 1 回合首轮混入 [2] [payload] [DONE]，typo 工具名后 1 次重试恢复，10/10 落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  const retryRequestBodies: string[] = [];
  let requestCount = 0;
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
      requestCount += 1;
      if (turn === 2 && attempt === 1) {
        retryRequestBodies.push(body);
      }

      if (turn === 2 && attempt === 1) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: "event: message\ndata: [2] [DONE] [payload] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }",
              tool_calls: [
                {
                  id: "tool_turn_2_typo_bad",
                  type: "function",
                  function: {
                    name: "submit_product_update_typo",
                    arguments: "reply:'该工具名不应命中',patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"坏路径\"}]",
                  },
                },
              ],
            },
          }],
        }));
        return;
      }

      const payload = turn === 2 && attempt === 2
        ? {
          content: "event: message\ndata: [payload] 回合 2 已恢复",
          tool_calls: [{
            id: `tool_turn_2_ok_retry_${attempt}`,
            type: "function" as const,
            function: {
              name: "submit_product_update",
              arguments: `reply:'回合 2 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 2 恢复值"}],questions:['该团是否继续核对接驳？']`,
            },
          }],
        }
        : buildCanonicalTurnPayload(turn);

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
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });
    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
      if (turn === 2) {
        assert.equal(result.patch?.[0]?.value, "太原回合 2 恢复值");
      }
    }
  }

  assert.equal(requestCount, 11);
  assert.equal(successCount, 10);
  assert.equal(attemptByTurn.get(2), 2);
  assert.equal(retryRequestBodies.length, 1);
  const retryBodyParsed = JSON.parse(retryRequestBodies[0] ?? "{}") as { messages?: Array<{ role: string; content: string }>; };
  const retryUser = retryBodyParsed.messages?.at(-1)?.content ?? "";
  assert.ok(/回合 2/.test(retryUser));
  assert.ok(!/submit_product_update_typo/.test(retryUser));
});

test("真实抓包片段：10 次主流程 1 回合首轮仅含 [2] structured response rejected（无 tool-call），1 次重试后 10/10 落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  const turnRetryBodies: string[] = [];
  let requestCount = 0;
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

      if (turn === 6 && attempt >= 1) {
        turnRetryBodies.push(body);
      }

      const payload = turn === 6 && attempt === 1
        ? {
          content: "[2] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }",
          tool_calls: [] as Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>,
        }
        : buildCanonicalTurnPayload(turn);

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
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
      if (turn === 6) {
        assert.equal(result.patch?.[0]?.value, "太原回合 6 恢复值");
      }
    }
  }

  assert.equal(requestCount, 11);
  assert.equal(successCount, 10);
  assert.equal(attemptByTurn.get(6), 2);
  assert.equal(turnRetryBodies.length, 2);
  const firstBody = JSON.parse(turnRetryBodies[0] ?? "{}") as { messages?: Array<{ role: string; content: string }>; };
  const firstUser = firstBody.messages?.at(-1)?.content ?? "";
  assert.ok(/回合 6 继续补齐/.test(firstUser));
  assert.ok(!/上一次返回未通过结构化校验/.test(firstUser));
  const retryBody = JSON.parse(turnRetryBodies[1] ?? "{}") as { messages?: Array<{ role: string; content: string }>; };
  const retryUser = retryBody.messages?.at(-1)?.content ?? "";
  assert.ok(/回合 6 继续补齐/.test(retryUser));
  assert.ok(/上一次返回未通过结构化校验/.test(retryUser));
});

test("真实抓包片段：10 次主流程 1 回合首轮仅有 [2] [payload] [DONE] structured response rejected（无 tool-call）并重复 5 次后 9/10 落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  const failureRequestBodies: string[] = [];
  let requestCount = 0;
  let successCount = 0;
  let failCount = 0;

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      let turn = 0;
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> };
        const userMessage = [...(parsed.messages ?? [])]
          .reverse()
          .find((item) => item.role === "user")?.content ?? "";
        turn = Number(/回合\s*(\d+)/.exec(userMessage)?.[1] ?? 0);
      } catch {
        turn = 0;
      }

      const attempt = (attemptByTurn.get(turn) ?? 0) + 1;
      attemptByTurn.set(turn, attempt);

      if (turn === 4) {
        failureRequestBodies.push(body);
      }

      const payload = turn === 4 && attempt <= 5
        ? {
          content: "event: message\ndata: [2] [payload] [DONE] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }",
          tool_calls: [] as Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>,
        }
        : buildCanonicalTurnPayload(turn);

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

      if ((result.patch?.length ?? 0) > 0) {
        successCount += 1;
      }
    } catch (error) {
      failCount += 1;
      assert.equal((error as Error)?.message, "MiniMax 返回的数据格式无法用于产品方案，请重试。");
    }
  }

  assert.equal(requestCount, 14);
  assert.equal(successCount, 9);
  assert.equal(failCount, 1);
  assert.equal(attemptByTurn.get(4), 5);
  assert.equal(failureRequestBodies.length, 5);
  const secondAttemptBody = JSON.parse(failureRequestBodies[1] ?? "{}") as { messages?: Array<{ role: string; content: string }>; };
  const secondAttemptUser = secondAttemptBody.messages?.at(-1)?.content ?? "";
  assert.ok(/回合 4/.test(secondAttemptUser));
  assert.ok(/上一次返回未通过结构化校验/.test(secondAttemptUser));
});

test("真实抓包片段：10 次主流程 1 回合首轮 structured failure 无 tool-call，4 次重试后恢复，10/10 落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  const retryUserBodies: string[] = [];
  let requestCount = 0;
  let successCount = 0;
  let failCount = 0;

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      let turn = 0;
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> };
        const userMessage = [...(parsed.messages ?? [])]
          .reverse()
          .find((item) => item.role === "user")?.content ?? "";
        turn = Number(/回合\s*(\d+)/.exec(userMessage)?.[1] ?? 0);
      } catch {
        turn = 0;
      }

      const attempt = (attemptByTurn.get(turn) ?? 0) + 1;
      attemptByTurn.set(turn, attempt);

      if (turn === 4 && attempt > 1) {
        retryUserBodies.push(body);
      }

      const payload = turn === 4 && attempt <= 4
        ? {
          content: "[payload] [2] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected token } in JSON at position 77' }",
          tool_calls: [] as Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>,
        }
        : turn === 4
          ? {
            content: "event: message\ndata: 回合 4 已恢复",
            tool_calls: [{
              id: "tool_turn_4_ok_5",
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: `reply:'回合 4 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 4 恢复值"}],questions:['该团是否继续核对接驳？']`,
              },
            }],
          }
          : buildCanonicalTurnPayload(turn);

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

      if ((result.patch?.length ?? 0) > 0) {
        successCount += 1;
        if (turn === 4) {
          assert.equal(result.patch?.[0]?.value, "太原回合 4 恢复值");
        }
      }
    } catch (error) {
      failCount += 1;
      assert.equal(failCount, 0, `期望第 ${turn} 回合可恢复，实际抛错：${(error as Error)?.message ?? "unknown"}`);
    }
  }

  assert.equal(requestCount, 13);
  assert.equal(successCount, 10);
  assert.equal(failCount, 0);
  assert.equal(attemptByTurn.get(4), 5);
  assert.equal(retryUserBodies.length, 4);
  for (const retryBody of retryUserBodies) {
    const parsed = JSON.parse(retryBody) as { messages?: Array<{ role: string; content: string }>; };
    const retryUser = parsed.messages?.at(-1)?.content ?? "";
    assert.ok(/回合 4/.test(retryUser));
    assert.ok(/上一次返回未通过结构化校验/.test(retryUser));
  }
});
