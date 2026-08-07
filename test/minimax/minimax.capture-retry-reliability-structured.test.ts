import { assert, MiniMaxService, MiniMaxServiceError, test } from "./minimax.core.shared.js";
import { createServer } from "node:http";

test("真实抓包片段：10 次主流程中 1 回合结构化失败日志连发 5 次，仍 9/10 可落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  const structuredRetryBodies: string[] = [];
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

      let payload: {
        content: string | null;
        tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
      };

      if (turn === 8 && attempt <= 5) {
        if (attempt >= 2) structuredRetryBodies.push(body);
        payload = {
          content: "structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }",
          tool_calls: [{
            id: `tool_turn_8_bad_${attempt}`,
            type: "function",
            function: {
              name: "submit_product_update_typo",
              arguments: `reply:'回合 8 结构化片段失败',questions:['该团是否继续核对接驳？']`,
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
      assert.ok(error instanceof MiniMaxServiceError);
      assert.equal((error as MiniMaxServiceError).code, "invalid_model_output");
    }
  }

  assert.equal(requestCount, 14);
  assert.equal(successCount, 9);
  assert.equal(failCount, 1);
  assert.equal(structuredRetryBodies.length, 4);
  for (const item of structuredRetryBodies) {
    const parsed = JSON.parse(item) as { messages?: Array<{ role: string; content: string }>; };
    const lastUser = parsed.messages?.at(-1);
    assert.equal(lastUser?.role, "user");
    assert.match(lastUser?.content ?? "", /回合 8 继续补齐/);
  }
});

test("真实抓包片段：10 次主流程首轮仅为 structured response rejected，二次重试后恢复，10/10 落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  let requestCount = 0;
  let structuredRetryBodies: string[] = [];
  let structuredSuccessCount = 0;

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

      if (turn === 4 && attempt === 1) {
        payload = {
          content: "[MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }",
          tool_calls: [{
            id: "tool_turn4_bad_1",
            type: "function",
            function: {
              name: "submit_product_update_typo",
              arguments: "reply:'回合 4 先回避，后补齐',patch:[{\'op\':\'replace\',\'path\':\'/basicInfo/subtitle\',\'value\':\'太原回合4\'}],questions:['先核对景点？']",
            },
          }],
        };
        structuredRetryBodies.push(body);
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

  for (let turn = 0; turn < 10; turn += 1) {
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      structuredSuccessCount += 1;
      assert.match(result.reply, /已恢复/);
    }
  }

  assert.equal(structuredRetryBodies.length, 1);
  assert.equal(requestCount, 11);
  assert.equal(structuredSuccessCount, 10);

  const firstRetry = JSON.parse(structuredRetryBodies[0] ?? "{}") as { messages?: Array<{ role: string; content: string }>; };
  const lastRetryUser = firstRetry.messages?.at(-1);
  assert.equal(lastRetryUser?.role, "user");
  assert.equal(lastRetryUser?.content?.includes("回合 4 继续补齐") ?? false, true);
});

test("真实抓包片段：10 次主流程 1 回合连续 2 次 structured response rejected（含 <think>/JSON fence）后恢复，10/10 落盘", async (t) => {
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

      if (turn === 5 && attempt <= 2) {
        if (attempt >= 2) retryBodies.push(body);
        payload = {
          content: "<think>\n正在定位：返回未完整闭合\n</think>\n```json\n{ length: 134, hasThinkingBlock: true, hasJsonFence: true, reason: 'Unexpected end of JSON input' }\n```",
          tool_calls: [{
            id: `tool_turn_5_bad_${attempt}`,
            type: "function",
            function: {
              name: "submit_product_update_typo",
              arguments: "reply:'回合 5 先报错待补齐',patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"待修复值\"}],questions:['是否继续核对接驳？']",
            },
          }],
        };
      } else {
        payload = {
          content: `event: message\ndata: 回合 ${turn} 已恢复`,
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

  for (let turn = 0; turn < 10; turn += 1) {
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
    }
  }

  assert.equal(requestCount, 12);
  assert.equal(successCount, 10);
  assert.equal(retryBodies.length, 1);

  const parsedRetry = JSON.parse(retryBodies[0] ?? "{}") as { messages?: Array<{ role: string; content: string }>; };
  const lastRetryUser = parsedRetry.messages?.at(-1);
  assert.equal(lastRetryUser?.role, "user");
  assert.equal(lastRetryUser?.content?.includes("上一次返回未通过结构化校验"), true);
});

test("真实抓包片段：10 次主流程 2 回合交错出现 structured response rejected，2 次重试后均恢复，10/10 落盘", async (t) => {
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

      const isRetryTurn = (turn === 2 || turn === 7) && attempt <= 2;
      if (isRetryTurn) {
        if (attempt >= 2) retryBodies.push(body);
        const structuredFailure = turn === 2
          ? "structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }"
          : "event: message\ndata: HTTP/1.1 200 OK\n: keep-alive\nevent: message\ndata: [payload] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected token } in JSON at position 77' }";
        payload = {
          content: structuredFailure,
          tool_calls: [{
            id: `tool_turn_${turn}_bad_${attempt}`,
            type: "function",
            function: {
              name: "submit_product_update_typo",
              arguments: `reply:'回合 ${turn} 重试后补齐',patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"会失败 ${turn}\"}],questions:['是否继续核对接驳？']`,
            },
          }],
        };
      } else {
        payload = {
          content: "event: message\ndata: 回合已恢复",
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

  for (let turn = 0; turn < 10; turn += 1) {
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
    }
  }

  assert.equal(requestCount, 14);
  assert.equal(successCount, 10);
  assert.equal(retryBodies.length, 2);
  for (const item of retryBodies) {
    const parsed = JSON.parse(item) as { messages?: Array<{ role: string; content: string }>; };
    const lastUser = parsed.messages?.at(-1);
    assert.equal(lastUser?.role, "user");
    assert.match(lastUser?.content ?? "", /回合 [27] 继续补齐/);
    assert.equal(lastUser?.content?.includes("上一次返回未通过结构化校验"), true);
  }
});

test("真实抓包片段：10 次主流程 1 回合 structured response rejected 后重试，10/10 落盘且补丁回写值为同值", async (t) => {
  const attemptByTurn = new Map<number, number>();
  const sameValueRetryBodies: string[] = [];
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

      if (turn === 6 && attempt === 1) {
        payload = {
          content: "<think>\nJSON fence 内仍未闭合\n</think>\n```json\n{ length: 134, hasThinkingBlock: true, hasJsonFence: true, reason: 'Unexpected end of JSON input' }\n```",
          tool_calls: [{
            id: `tool_turn_6_bad_${attempt}`,
            type: "function",
            function: {
              name: "submit_product_update_typo",
              arguments: "reply:'回合 6 重试后补齐',patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"固定标题\"}],questions:['是否继续核对接驳？']",
            },
          }],
        };
      } else {
        if (turn === 6 && attempt === 2) sameValueRetryBodies.push(body);
        payload = {
          content: "event: message\ndata: 回合已恢复",
          tool_calls: [{
            id: `tool_turn_${turn}_ok_${attempt}`,
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'回合 ${turn} 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"固定标题"}],questions:['该团是否继续核对接驳？']`,
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
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原", subtitle: "固定标题" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
      assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
      assert.equal(result.patch?.[0]?.value, "固定标题");
    }
  }

  assert.equal(requestCount, 11);
  assert.equal(successCount, 10);
  assert.equal(sameValueRetryBodies.length, 1);
  const parsedRetry = JSON.parse(sameValueRetryBodies[0] ?? "{}") as { messages?: Array<{ role: string; content: string }>; };
  const retryUser = parsedRetry.messages?.at(-1);
  assert.equal(retryUser?.role, "user");
  assert.equal(retryUser?.content?.includes("上一次返回未通过结构化校验"), true);
});

test("真实抓包片段：10 次主流程 1 回合 3 段式结构化失败后恢复，10/10 落盘", async (t) => {
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

      if (turn === 3 && attempt <= 3) {
        if (attempt >= 2) retryBodies.push(body);
        const structuredFailure = attempt === 1
          ? "[MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected token } in JSON at position 77' }"
          : attempt === 2
            ? "event: message\ndata: HTTP/1.1 200 OK\n: keep-alive\nevent: message\ndata: [payload] structured response rejected { length: 134, hasThinkingBlock: true, hasJsonFence: true, reason: 'Unexpected end of JSON input' }"
            : "event: message\ndata: reason=JSON.parse(\"未闭合)\n{\"";
        payload = {
          content: structuredFailure,
          tool_calls: [{
            id: `tool_turn_3_bad_${attempt}`,
            type: "function",
            function: {
              name: "submit_product_update_typo",
              arguments: "reply:'回合 3 无法落盘',patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原回合3\"}],questions:['是否继续核对接驳？']",
            },
          }],
        };
      } else {
        payload = {
          content: "event: message\ndata: 回合已恢复",
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

  for (let turn = 0; turn < 10; turn += 1) {
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原", subtitle: "太原回合3" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
    }
  }

  assert.equal(requestCount, 13);
  assert.equal(successCount, 10);
  assert.equal(retryBodies.length, 2);
  const firstRetry = JSON.parse(retryBodies[0] ?? "{}") as { messages?: Array<{ role: string; content: string }>; };
  const lastRetry = JSON.parse(retryBodies[1] ?? "{}") as { messages?: Array<{ role: string; content: string }>; };
  const firstRetryUser = firstRetry.messages?.at(-1);
  const secondRetryUser = lastRetry.messages?.at(-1);
  assert.equal(firstRetryUser?.role, "user");
  assert.equal(secondRetryUser?.role, "user");
  assert.equal(firstRetryUser?.content?.includes("上一次返回未通过结构化校验") ?? false, true);
});

test("真实抓包片段：10 次主流程 1 回合内容报 structured response rejected + typo tool-call，首轮重试后恢复，10/10 落盘", async (t) => {
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

      if (turn === 6 && attempt === 1) {
        payload = {
          content: "[MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }",
          tool_calls: [{
            id: "tool_turn_6_bad_1",
            type: "function",
            function: {
              name: "submit_product_update_typo",
              arguments: "reply:'回合 6 tool-call 标识错位',patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原回合 6 错位\"}],questions:['是否继续核对接驳？']",
            },
          }],
        };
      } else {
        if (turn === 6 && attempt === 2) {
          retryBodies.push(body);
        }
        payload = {
          content: "event: message\ndata: 回合已恢复",
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

  for (let turn = 0; turn < 10; turn += 1) {
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
    }
  }

  assert.equal(requestCount, 11);
  assert.equal(successCount, 10);
  assert.equal(retryBodies.length, 1);
  const parsedRetry = JSON.parse(retryBodies[0] ?? "{}") as { messages?: Array<{ role: string; content: string }>; };
  const lastRetryUser = parsedRetry.messages?.at(-1);
  assert.equal(lastRetryUser?.role, "user");
  assert.equal(lastRetryUser?.content?.includes("上一次返回未通过结构化校验"), true);
});

test("真实抓包片段：10 次主流程 1 回合内容混入 SSE 噪音且 structured response rejected，1 次重试后 10/10 落盘", async (t) => {
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

      if (turn === 8 && attempt === 1) {
        payload = {
          content: "event: message\ndata: HTTP/1.1 200 OK\n: keep-alive\nevent: message\ndata: [payload] structured response rejected { length: 134, hasThinkingBlock: true, hasJsonFence: true, reason: 'Unexpected token } in JSON at position 77' }",
          tool_calls: [{
            id: "tool_turn_8_bad_1",
            type: "function",
            function: {
              name: "submit_product_update_typo",
              arguments: "reply:'回合 8 SSE 重试',patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原回合 8 SSE\"}],questions:['是否继续核对接驳？']",
            },
          }],
        };
      } else {
        if (turn === 8 && attempt === 2) {
          retryBodies.push(body);
        }
        payload = {
          content: "event: message\ndata: 回合已恢复",
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

  for (let turn = 0; turn < 10; turn += 1) {
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原", subtitle: "基准标题" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
    }
  }

  assert.equal(requestCount, 11);
  assert.equal(successCount, 10);
  assert.equal(retryBodies.length, 1);
  const parsedRetry = JSON.parse(retryBodies[0] ?? "{}") as { messages?: Array<{ role: string; content: string }>; };
  const lastRetryUser = parsedRetry.messages?.at(-1);
  assert.equal(lastRetryUser?.role, "user");
  assert.equal(lastRetryUser?.content?.includes("上一次返回未通过结构化校验"), true);
});

test("真实抓包片段：10 次主流程 1 回合内容含 structured failure，但官方 tool-call 可落库时直接落盘，10/10 落盘", async (t) => {
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

      let payload: {
        content: string | null;
        tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
      };

      if (turn === 4 && attempt === 1) {
        payload = {
          content: "event: message\ndata: [payload] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }",
          tool_calls: [
            {
              id: "tool_turn_4_official_bad",
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: `reply:'回合 4 官方名虽在仍应重试',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 4 官方但失败"}],questions:['是否继续核对接驳？']`,
              },
            },
            {
              id: "tool_turn_4_typo",
              type: "function",
              function: {
                name: "submit_product_update_typo",
                arguments: `reply:'回合 4 typo 干扰',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 4 干扰"}],questions:['该团是否继续核对接驳？']`,
              },
            },
          ],
        };
      } else {
        payload = {
          content: "event: message\ndata: 回合已恢复",
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

  for (let turn = 0; turn < 10; turn += 1) {
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
    }
  }

  assert.equal(requestCount, 10);
  assert.equal(successCount, 10);
  assert.equal(attemptByTurn.get(4), 1);
});

test("真实抓包片段：10 次主流程 1 回合工具参数中返回结构化失败文本，正文无异常，首轮重试后恢复，10/10 落盘", async (t) => {
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

      if (turn === 2 && attempt === 1) {
        payload = {
          content: "event: message\ndata: 回合 2 已返回",
          tool_calls: [{
            id: "tool_turn_2_failure_arg",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'回合 2 工具参数里出现结构化失败日志',patch:[],notes:'[MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: "Unexpected end of JSON input" }',questions:['该团是否继续核对接驳？']`,
            },
          }],
        };
      } else {
        if (turn === 2 && attempt === 2) retryBodies.push(body);
        payload = {
          content: "event: message\ndata: 回合已恢复",
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

  for (let turn = 0; turn < 10; turn += 1) {
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
    }
  }

  assert.equal(requestCount, 11);
  assert.equal(successCount, 10);
  assert.equal(retryBodies.length, 1);
  const parsedRetry = JSON.parse(retryBodies[0] ?? "{}") as { messages?: Array<{ role: string; content: string }>; };
  const lastRetryUser = parsedRetry.messages?.at(-1);
  assert.equal(lastRetryUser?.role, "user");
  assert.equal(lastRetryUser?.content?.includes("上一次返回未通过结构化校验"), true);
});

test("真实抓包片段：10 次主流程 1 回合先报结构化失败（无 tool-call），再由标准 tool-call 恢复，10/10 落盘", async (t) => {
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

      if (turn === 9 && attempt === 1) {
        payload = {
          content: "<think>正在抓取字段映射</think>\n{ length: 134, hasThinkingBlock: true, hasJsonFence: true, reason: 'Unexpected token } in JSON at position 77' }",
          tool_calls: [],
        };
      } else {
        if (turn === 9 && attempt === 2) retryBodies.push(body);
        payload = {
          content: "event: message\ndata: 回合已恢复",
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

  for (let turn = 0; turn < 10; turn += 1) {
    const result = await service.reply({
      message: turn === 0 ? "生成第一版" : `回合 ${turn} 继续补齐`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });

    if ((result.patch?.length ?? 0) > 0) {
      successCount += 1;
    }
  }

  assert.equal(requestCount, 11);
  assert.equal(successCount, 10);
  assert.equal(retryBodies.length, 1);
  const parsedRetry = JSON.parse(retryBodies[0] ?? "{}") as { messages?: Array<{ role: string; content: string }>; };
  const retryUser = parsedRetry.messages?.at(-1);
  assert.equal(retryUser?.role, "user");
  assert.equal(retryUser?.content?.includes("上一次返回未通过结构化校验"), true);
});
