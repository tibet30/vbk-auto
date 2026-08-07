import { assert, MiniMaxService, MiniMaxServiceError, test } from "./minimax.core.shared.js";
import { createServer } from "node:http";

type PayloadMessage = {
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

const buildCanonicalTurnPayload = (turn: number): PayloadMessage => ({
  content: null,
  tool_calls: [{
    id: `tool_turn_${turn}_ok`,
    type: "function" as const,
    function: {
      name: "submit_product_update",
      arguments: `reply:'回合 ${turn} 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 ${turn} 恢复值"}],questions:['该团是否继续核对接驳？'],researchTasks:[{"label":"核对接驳时间","type":"vbk","detail":"逐条确认接驳点位和车型后再落库"}]`,
    },
  }],
});

test("真实抓包片段：10 次主流程 1 回合首轮 structured failure 无 tool-call，首轮失败后返回 fenced JSON 10/10 落盘", async (t) => {
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
        turn = isRetryTurn(parsed.messages);
      } catch {
        turn = 0;
      }

      const attempt = (attemptByTurn.get(turn) ?? 0) + 1;
      attemptByTurn.set(turn, attempt);
      if (turn === 6 && attempt > 1) retryBodies.push(body);

      const payload: PayloadMessage = turn === 6 && attempt === 1
        ? {
          content: "event: message\ndata: [2] [payload] [DONE] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }",
          tool_calls: [],
        }
        : turn === 6 && attempt === 2
          ? {
            content: "event: message\ndata: ```json\n{\"reply\":\"回合 6 已恢复\",\"patch\":[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原回合 6 恢复值\"}],\"questions\":[\"该团是否继续核对接驳？\"],\"researchTasks\":[{\"label\":\"接驳点位复核\",\"type\":\"vbk\",\"detail\":\"核对接驳点位、车型与时间是否一致\"}]}\n```",
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
  assert.equal(retryBodies.length, 1);
  const retryUser = JSON.parse(retryBodies[0] as string).messages?.at(-1)?.content ?? "";
  assert.ok(/回合 6/.test(retryUser));
  assert.ok(/上一次返回未通过结构化校验/.test(retryUser));
});

test("真实抓包片段：10 次主流程 2 回合首轮 structured failure 无 tool-call，重试以 content JSON 恢复，10/10 落盘", async (t) => {
  const failureTurns = new Set([2, 8]);
  const retryBodies: string[] = [];
  const attemptByTurn = new Map<number, number>();
  let requestCount = 0;
  let successCount = 0;

  const buildRecoveryPayload = (turn: number): PayloadMessage => ({
    content: `[payload] [DONE] {\"reply\":\"回合 ${turn} 已补齐\",\"patch\":[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原回合 ${turn} 恢复值\"}],\"questions\":[\"该团是否确认接驳方案？\"],\"researchTasks\":[{\"label\":\"接驳清单复核\",\"type\":\"vbk\",\"detail\":\"逐条核对接驳信息并与供应商确认\"}]}`,
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
        turn = isRetryTurn(parsed.messages);
      } catch {
        turn = 0;
      }

      const attempt = (attemptByTurn.get(turn) ?? 0) + 1;
      attemptByTurn.set(turn, attempt);
      if (failureTurns.has(turn) && attempt > 1) retryBodies.push(body);

      const payload: PayloadMessage = failureTurns.has(turn) && attempt === 1
        ? {
          content: "[2] [payload] [DONE] [MiniMax] structured response rejected { length: 134, hasJsonFence: true, reason: 'Unexpected token } in JSON at position 77' }",
          tool_calls: [],
        }
        : failureTurns.has(turn) && attempt === 2
          ? buildRecoveryPayload(turn)
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
      if (failureTurns.has(turn)) {
        assert.equal(result.patch?.[0]?.value, `太原回合 ${turn} 恢复值`);
      }
    }
  }

  assert.equal(requestCount, 12);
  assert.equal(successCount, 10);
  assert.equal(retryBodies.length, 2);
  for (const bodyItem of retryBodies) {
    const parsed = JSON.parse(bodyItem) as { messages?: Array<{ role: string; content: string }>; };
    const retryUser = parsed.messages?.at(-1)?.content ?? "";
    assert.ok(/回合 (2|8)/.test(retryUser));
    assert.ok(/上一次返回未通过结构化校验/.test(retryUser));
  }
});

test("真实抓包片段：10 次主流程 1 回合首轮 structured failure（无 tool-call）失败 4 次后恢复，10/10 落盘并记录 4 次重试提示", async (t) => {
  const result = await runMissingToolcallScenario(t, 1, 4, {
    withPayloadNoise: true,
    failureContent: "[payload] [DONE] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' } 请先检查连接或配置后再试。",
  });

  assert.equal(result.requestCount, 13);
  assert.equal(result.successCount, 10);
  assert.equal(result.attempts, 5);
  assert.equal(result.messages.length, 4);
  assert.ok(result.messages.every((messages) => {
    const retryUser = messages?.at(-1)?.content ?? "";
    return /回合 1/.test(retryUser) && /上一次返回未通过结构化校验/.test(retryUser);
  }));
});

const isRetryTurn = (messages?: Array<{ role: string; content: string }>) => {
  const userMessage = [...(messages ?? [])].reverse().find((item) => item.role === "user")?.content ?? "";
  return Number(/回合\s*(\d+)/.exec(userMessage)?.[1] ?? 0);
};

async function runMissingToolcallScenario(
  t: Parameters<typeof test>[0],
  failureTurn: number,
  failureAttempts: number,
  options: { withPayloadNoise?: boolean; allowFailure?: boolean; failureContent?: string } = {},
) {
  const attemptByTurn = new Map<number, number>();
  const retryBodies: string[] = [];
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
        turn = isRetryTurn(parsed.messages);
      } catch {
        turn = 0;
      }

      const attempt = (attemptByTurn.get(turn) ?? 0) + 1;
      attemptByTurn.set(turn, attempt);

      if (turn === failureTurn && attempt > 1) {
        retryBodies.push(body);
      }

      const payload: PayloadMessage = turn === failureTurn && attempt <= failureAttempts
        ? {
          content: options.failureContent
            ?? `${options.withPayloadNoise ? "event: message\\ndata: [2] [payload] [DONE] " : "event: message\\ndata: [2] "}[MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }`,
          // 工具字段缺失，复现部分厂商返回 payload 无 tool_calls 的真实场景
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
        if (turn === failureTurn) {
          assert.equal(result.patch?.[0]?.value, `太原回合 ${turn} 恢复值`);
          assert.equal(result.researchTasks?.length ?? 0, 1);
        }
      }
    } catch (error) {
      if (!options.allowFailure) throw error;
      failCount += 1;
      assert.ok(error instanceof MiniMaxServiceError);
      assert.equal(error.code, "invalid_model_output");
    }
  }

  return {
    requestCount,
    successCount,
    failCount,
    attempts: attemptByTurn.get(failureTurn),
    retryBodies,
    messages: retryBodies.map((rawBody) => {
      const parsed = JSON.parse(rawBody) as { messages?: Array<{ role: string; content: string }>; };
      return parsed.messages ?? [];
    }),
  };
}

test("真实抓包片段：10 次主流程 1 回合首轮 structured failure 工具字段缺失 1 次重试后 10/10 落盘", async (t) => {
  const result = await runMissingToolcallScenario(t, 3, 1);

  assert.equal(result.requestCount, 11);
  assert.equal(result.successCount, 10);
  assert.equal(result.attempts, 2);
  assert.equal(result.messages.length, 1);

  const retryUser = result.messages[0]?.at(-1)?.content ?? "";
  assert.ok(/回合 3/.test(retryUser));
  assert.ok(/上一次返回未通过结构化校验/.test(retryUser));
});

test("真实抓包片段：10 次主流程 1 回合首轮 structured failure（含连接重试尾注）无 tool-call，1 次重试后 10/10 落盘", async (t) => {
  const result = await runMissingToolcallScenario(t, 4, 1, {
    withPayloadNoise: true,
    failureContent: "[payload] [DONE] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' } 请检查连接或配置后重试。",
  });

  assert.equal(result.requestCount, 11);
  assert.equal(result.successCount, 10);
  assert.equal(result.messages.length, 1);

  const retryUser = result.messages[0]?.at(-1)?.content ?? "";
  assert.ok(/回合 4/.test(retryUser));
  assert.ok(/上一次返回未通过结构化校验/.test(retryUser));
});

test("真实抓包片段：10 次主流程 1 回合首轮 structured failure（含 thinking/json-fence 标记）无 tool-call，1 次重试后 10/10 落盘", async (t) => {
  const result = await runMissingToolcallScenario(t, 5, 1, {
    failureContent: "event: message\n[2] [payload] [DONE] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: true, hasJsonFence: true, reason: 'Unexpected end of JSON input' }",
  });

  assert.equal(result.requestCount, 11);
  assert.equal(result.successCount, 10);
  assert.equal(result.attempts, 2);
  assert.equal(result.messages.length, 1);

  const retryUser = result.messages[0]?.at(-1)?.content ?? "";
  assert.ok(/回合 5/.test(retryUser));
  assert.ok(/上一次返回未通过结构化校验/.test(retryUser));
});

test("真实抓包片段：10 次主流程 1 回合首轮 structured failure（含中文尾注变体）无 tool-call，1 次重试后 10/10 落盘", async (t) => {
  const result = await runMissingToolcallScenario(t, 4, 1, {
    failureContent: "[payload] [DONE] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: true, hasJsonFence: true, reason: 'Unexpected token' } ; 请先检查网络/配置后再试；",
  });

  assert.equal(result.requestCount, 11);
  assert.equal(result.successCount, 10);
  assert.equal(result.attempts, 2);
  assert.equal(result.messages.length, 1);

  const retryUser = result.messages[0]?.at(-1)?.content ?? "";
  assert.ok(/回合 4/.test(retryUser));
  assert.ok(/上一次返回未通过结构化校验/.test(retryUser));
});

test("真实抓包片段：10 次主流程 1 回合首轮 structured failure（中英混写尾注 + 2 次重试）无 tool-call，2 次重试后 10/10 落盘", async (t) => {
  const result = await runMissingToolcallScenario(t, 2, 2, {
    withPayloadNoise: true,
    failureContent: "event: message\n[2] [payload] [DONE] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' } ; Please check API 配置并确认网络稳定后再尝试请求。请先检查连接后再尝试。",
  });

  assert.equal(result.successCount, 10);
  assert.equal(result.requestCount, 12);
  assert.equal(result.attempts, 3);
  assert.equal(result.messages.length, 2);

  const retryUser = result.messages[0]?.at(-1)?.content ?? "";
  assert.ok(/回合 2/.test(retryUser));
  assert.ok(/上一次返回未通过结构化校验/.test(retryUser));
});

test("真实抓包片段：10 次主流程 2 回合首轮 structured failure（噪音不一致）均可重试成功，10/10 落盘", async (t) => {
  const failureTurns = new Set([1, 7]);
  const retryBodies: string[] = [];
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
        turn = isRetryTurn(parsed.messages);
      } catch {
        turn = 0;
      }

      const attempt = (attemptByTurn.get(turn) ?? 0) + 1;
      attemptByTurn.set(turn, attempt);
      if (failureTurns.has(turn) && attempt === 2) retryBodies.push(body);

      const payload: PayloadMessage = failureTurns.has(turn) && attempt === 1
        ? {
          content: turn === 1
            ? "event: message\n[2] [payload] [DONE] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }，请检查并确认 API 配置后尝试重新请求。"
            : "event: message\n[2] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: true, hasJsonFence: true, reason: 'Unexpected token' } 请先检查网络或连接，后再尝试。",
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
    }
  }

  assert.equal(requestCount, 12);
  assert.equal(successCount, 10);
  assert.equal(retryBodies.length, 2);
  for (const rawBody of retryBodies) {
    const parsed = JSON.parse(rawBody) as { messages?: Array<{ role: string; content: string }>; };
    const retryUser = parsed.messages?.at(-1)?.content ?? "";
    assert.ok(/回合 (1|7)/.test(retryUser));
    assert.ok(/上一次返回未通过结构化校验/.test(retryUser));
  }
});

test("真实抓包片段：10 次主流程 1 回合 structured failure 无 tool-call 2 次重试后 10/10 落盘", async (t) => {
  const result = await runMissingToolcallScenario(t, 2, 2);

  assert.equal(result.successCount, 10);
  assert.equal(result.requestCount, 12);
  assert.equal(result.attempts, 3);
  assert.equal(result.messages.length, 2);
  assert.ok(result.messages.every((messages) => {
    const retryUser = messages?.at(-1)?.content ?? "";
    return /回合 2/.test(retryUser) && /上一次返回未通过结构化校验/.test(retryUser);
  }));
});

test("真实抓包片段：10 次主流程 2 回合 structured failure（不同抓包噪音）无 tool-call 均重试成功，10/10 落盘", async (t) => {
  const failureTurns = new Set([1, 6]);
  const failureContentByTurn: Record<number, string> = {
    1: "event: message\n[2] [payload] [DONE] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }",
    6: "event: message\n[2] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: true, hasJsonFence: true, reason: 'Unexpected end of JSON input' } 请检查连接或配置后重试。",
  };
  const retryBodies: string[] = [];
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
        turn = isRetryTurn(parsed.messages);
      } catch {
        turn = 0;
      }

      const attempt = (attemptByTurn.get(turn) ?? 0) + 1;
      attemptByTurn.set(turn, attempt);
      if (failureTurns.has(turn) && attempt === 2) {
        retryBodies.push(body);
      }

      const payload: PayloadMessage = failureTurns.has(turn) && attempt === 1
        ? {
          content: failureContentByTurn[turn],
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
    }
  }

  assert.equal(requestCount, 12);
  assert.equal(successCount, 10);
  assert.equal(retryBodies.length, 2);
  for (const rawBody of retryBodies) {
    const parsed = JSON.parse(rawBody) as { messages?: Array<{ role: string; content: string }>; };
    const retryUser = parsed.messages?.at(-1)?.content ?? "";
    assert.ok(/回合 (1|6)/.test(retryUser));
    assert.ok(/上一次返回未通过结构化校验/.test(retryUser));
  }
});

test("真实抓包片段：10 次主流程 1 回合首轮 structured failure 无 tool-call + [payload] [DONE] 3 次重试后 10/10 落盘", async (t) => {
  const result = await runMissingToolcallScenario(t, 6, 3, { withPayloadNoise: true });

  assert.equal(result.successCount, 10);
  assert.equal(result.requestCount, 13);
  assert.equal(result.attempts, 4);
  assert.equal(result.messages.length, 3);
  assert.ok(result.messages.every((messages) => {
    const retryUser = messages?.at(-1)?.content ?? "";
    return /回合 6/.test(retryUser) && /上一次返回未通过结构化校验/.test(retryUser);
  }));
});

test("真实抓包片段：10 次主流程 1 回合首轮 structured failure 无 tool-call 连续 5 次，达到重试上限后 9/10 落盘", async (t) => {
  const result = await runMissingToolcallScenario(t, 9, 5, { allowFailure: true, withPayloadNoise: true });

  assert.equal(result.failCount, 1);
  assert.equal(result.successCount, 9);
  assert.equal(result.requestCount, 14);
  assert.equal(result.attempts, 5);
  assert.equal(result.messages.length, 4);
  assert.ok(result.messages.every((messages) => {
    const retryUser = messages?.at(-1)?.content ?? "";
    return /回合 9/.test(retryUser) && /上一次返回未通过结构化校验/.test(retryUser);
  }));
});

test("真实抓包片段：10 次主流程 1 回合首轮 structured failure（中英混合尾注）连续 5 次仍无 tool-call，允许 1 次失败（10 中 9 次）", async (t) => {
  const result = await runMissingToolcallScenario(t, 9, 5, {
    withPayloadNoise: true,
    allowFailure: true,
    failureContent: "[payload] [DONE] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: true, hasJsonFence: true, reason: 'Unexpected token' } ，请先检查 API 配置并确认网络稳定后再尝试请求，请先检查连接/配置后再试。",
  });

  assert.equal(result.failCount, 1);
  assert.equal(result.successCount, 9);
  assert.equal(result.requestCount, 14);
  assert.equal(result.attempts, 5);
  assert.equal(result.messages.length, 4);
  assert.ok(result.messages.every((messages) => {
    const retryUser = messages?.at(-1)?.content ?? "";
    return /回合 9/.test(retryUser) && /上一次返回未通过结构化校验/.test(retryUser);
  }));
});

test("真实抓包片段：10 次主流程 1 回合首轮 structured failure（混合中英尾注）2 次重试后 10/10 落盘", async (t) => {
  const result = await runMissingToolcallScenario(t, 6, 2, {
    withPayloadNoise: true,
    failureContent: "event: message\ndata: [2] [payload] [DONE] [MiniMax] structured response rejected { length: 134, hasJsonFence: true, reason: 'Unexpected token' } ，请先检查 API 配置并确认网络稳定后再尝试请求。Please check network and retry request。",
  });

  assert.equal(result.successCount, 10);
  assert.equal(result.requestCount, 12);
  assert.equal(result.attempts, 3);
  assert.equal(result.messages.length, 2);
  assert.ok(result.messages.every((messages) => {
    const retryUser = messages?.at(-1)?.content ?? "";
    return /回合 6/.test(retryUser) && /上一次返回未通过结构化校验/.test(retryUser);
  }));
});

test("真实抓包片段：10 次主流程 2 回合首轮 structured failure（无 tool-call）均可重试成功，10/10 落盘", async (t) => {
  const failureTurns = new Set([3, 8]);
  const retryBodies: string[] = [];
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
        turn = isRetryTurn(parsed.messages);
      } catch {
        turn = 0;
      }

      const attempt = (attemptByTurn.get(turn) ?? 0) + 1;
      attemptByTurn.set(turn, attempt);
      if (failureTurns.has(turn) && attempt === 2) retryBodies.push(body);

      const payload: PayloadMessage = failureTurns.has(turn) && attempt === 1
        ? {
          content: `[payload] [DONE] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }`,
          tool_calls: [],
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
    }
  }

  assert.equal(requestCount, 12);
  assert.equal(successCount, 10);
  assert.equal(retryBodies.length, 2);
  for (const rawBody of retryBodies) {
    const parsed = JSON.parse(rawBody) as { messages?: Array<{ role: string; content: string }>; };
    const retryUser = parsed.messages?.at(-1)?.content ?? "";
    assert.ok(/回合 (3|8)/.test(retryUser));
    assert.ok(/上一次返回未通过结构化校验/.test(retryUser));
  }
});

test("真实抓包片段：10 次主流程 1 回合首轮仅 typo tool-call 且无可写结构化字段，1 次重试后 10/10 落盘", async (t) => {
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
        turn = isRetryTurn(parsed.messages);
      } catch {
        turn = 0;
      }

      const attempt = (attemptByTurn.get(turn) ?? 0) + 1;
      attemptByTurn.set(turn, attempt);
      if (turn === 5 && attempt === 2) retryBodies.push(body);

      const payload: PayloadMessage = turn === 5 && attempt === 1
        ? {
          content: "[2] [payload] [DONE] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: true, hasJsonFence: true, reason: 'Unexpected end of JSON input' }",
          tool_calls: [{
            id: "tool_turn5_wrong_typo",
            type: "function",
            function: {
              name: "submit_product_update_typo",
              arguments: "reply:'回合 5 typo 仍在补齐',questions:['该团是否继续核对接驳？']",
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
  const parsed = JSON.parse(retryBodies[0] ?? "{}") as { messages?: Array<{ role: string; content: string }>; };
  const retryUser = parsed.messages?.at(-1)?.content ?? "";
  assert.equal(retryUser.includes("回合 5"), true);
  assert.equal(retryUser.includes("上一次返回未通过结构化校验"), true);
});
test("真实抓包片段：10 次主流程 1 回合首轮 structured failure 无 tool-call，2 次后以 content JSON 结构化恢复，10/10 落盘", async (t) => {
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
      if (turn === 4 && attempt > 1) retryRequestBodies.push(body);

      let payload: PayloadMessage;
      if (turn === 4 && attempt === 1) {
        payload = {
          content: "event: message\ndata: [2] [payload] [DONE] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }",
          tool_calls: [],
        };
      } else if (turn === 4 && attempt === 2) {
        payload = {
          content: "event: message\ndata: [MiniMax] structured response rejected { length: 134, hasThinkingBlock: true, hasJsonFence: true, reason: 'Unexpected token } in JSON at position 77' } ; 请检查连接或配置后重试。",
          tool_calls: [],
        };
      } else if (turn === 4 && attempt >= 3) {
        payload = {
          content: "event: message\ndata: {\"reply\":\"回合 4 已恢复\",\"patch\":[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原回合 4 恢复值\"}],\"questions\":[\"该团是否继续核对接驳？\"],\"researchTasks\":[{\"label\":\"接驳路径核验\",\"type\":\"vbk\",\"detail\":\"确认回程接驳点位与车型\"}]",
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
        assert.equal(result.questions?.[0], "该团是否继续核对接驳？");
        assert.equal(result.researchTasks?.[0]?.label, "接驳路径核验");
      }
    }
  }

  assert.equal(requestCount, 12);
  assert.equal(successCount, 10);
  assert.equal(attemptByTurn.get(4), 3);
  assert.equal(retryRequestBodies.length, 2);
  for (const bodyItem of retryRequestBodies) {
    const parsed = JSON.parse(bodyItem) as { messages?: Array<{ role: string; content: string }>; };
    const latestUser = parsed.messages?.at(-1)?.content ?? "";
    assert.ok(/回合 4/.test(latestUser));
    assert.ok(/上一次返回未通过结构化校验/.test(latestUser));
  }
});

test("真实抓包片段：10 次主流程 2 回合首轮 structured failure（无 tool-call）各 2 次后恢复，10/10 落盘", async (t) => {
  const failureTurns = new Set([2, 8]);
  const retryBodies: string[] = [];
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
      if (failureTurns.has(turn) && attempt === 2) retryBodies.push(body);

      const payload: PayloadMessage = failureTurns.has(turn) && attempt <= 2
        ? {
          content: turn === 2
            ? "[2] [payload] [DONE] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' } 请检查 API 配置并确认网络稳定后再试"
            : "event: message\n[MiniMax] structured response rejected { length: 134, hasThinkingBlock: true, hasJsonFence: true, reason: 'Unexpected token' } ; 请先检查网络或连接，后再尝试。",
          tool_calls: [],
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
    }
  }

  assert.equal(requestCount, 12);
  assert.equal(successCount, 10);
  assert.equal(attemptByTurn.get(2), 3);
  assert.equal(attemptByTurn.get(8), 3);
  assert.equal(retryBodies.length, 2);
  for (const rawBody of retryBodies) {
    const parsed = JSON.parse(rawBody) as { messages?: Array<{ role: string; content: string }>; };
    const lastUser = parsed.messages?.at(-1)?.content ?? "";
    assert.ok(/回合 (2|8)/.test(lastUser));
    assert.ok(/上一次返回未通过结构化校验/.test(lastUser));
  }
});

test("真实抓包片段：10 次主流程 1 回合首轮 structured failure（无 tool-call）2 次后以 content JSON 恢复并保留问题与核验任务，10/10 落盘", async (t) => {
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
      if (turn === 6 && attempt > 1) retryBodies.push(body);

      const payload: PayloadMessage = turn === 6 && attempt === 1
        ? {
          content: "event: message\n[2] [payload] [DONE] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' } 请先检查连接或配置后重试。",
          tool_calls: [],
        }
        : turn === 6 && attempt === 2
          ? {
            content: "event: message\n[2] [payload] [DONE] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: true, hasJsonFence: true, reason: 'Unexpected token' }",
            tool_calls: [],
          }
          : turn === 6
            ? {
              content: `event: message\ndata: {"reply":"回合 6 已恢复","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 6 恢复值"}],"questions":["该团是否确认接驳路线？"],"researchTasks":[{"label":"核验接驳时段","type":"vbk","detail":"与接驳服务商确认夜间与高峰时段是否一致"}]}`,
              tool_calls: [],
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
        assert.equal(result.questions?.[0], "该团是否确认接驳路线？");
        assert.equal(result.researchTasks?.[0]?.label, "核验接驳时段");
      }
    }
  }

  assert.equal(requestCount, 12);
  assert.equal(successCount, 10);
  assert.equal(attemptByTurn.get(6), 3);
  assert.equal(retryBodies.length, 2);
  for (const rawBody of retryBodies) {
    const parsed = JSON.parse(rawBody) as { messages?: Array<{ role: string; content: string }>; };
    const latestUser = parsed.messages?.at(-1)?.content ?? "";
    assert.ok(/回合 6/.test(latestUser));
    assert.ok(/上一次返回未通过结构化校验/.test(latestUser));
  }
});

test("真实抓包片段：10 次主流程 2 回合结构化失败（无 tool-call）一回合恢复一回合到达重试上限，9/10 落盘", async (t) => {
  const recoverTurn = 3;
  const failTurn = 9;
  const attemptByTurn = new Map<number, number>();
  const retryBodies: string[] = [];
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
      if ((turn === recoverTurn || turn === failTurn) && attempt > 1) retryBodies.push(body);

      const payload: PayloadMessage = turn === recoverTurn && attempt <= 2
        ? {
          content: "[payload] [DONE] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: true, reason: 'Unexpected end of JSON input' } 请先检查 API 配置并确认网络稳定后再尝试。",
          tool_calls: [],
        }
        : turn === failTurn && attempt <= 5
          ? {
            content: "event: message\ndata: [2] [payload] [DONE] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: true, hasJsonFence: true, reason: 'Unexpected token } in JSON at position 77' } ,请检查连接或配置后再尝试。",
            tool_calls: [],
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
      if (turn === recoverTurn) {
        assert.equal(result.patch?.[0]?.value, `太原回合 ${turn} 恢复值`);
      }
    } catch (error) {
      failCount += 1;
      assert.ok(error instanceof MiniMaxServiceError);
      assert.equal((error as MiniMaxServiceError).code, "invalid_model_output");
    }
  }

  assert.equal(successCount, 9);
  assert.equal(failCount, 1);
  assert.equal(requestCount, 16);
  assert.equal(attemptByTurn.get(recoverTurn), 3);
  assert.equal(attemptByTurn.get(failTurn), 5);
  assert.equal(retryBodies.length, 6);
  for (const rawBody of retryBodies) {
    const parsed = JSON.parse(rawBody) as { messages?: Array<{ role: string; content: string }>; };
    const lastUser = parsed.messages?.at(-1)?.content ?? "";
    assert.ok(/回合 (3|9)/.test(lastUser));
    assert.ok(/上一次返回未通过结构化校验/.test(lastUser));
  }
});
