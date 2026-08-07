import { assert, MiniMaxService, MiniMaxServiceError, test } from "./minimax.core.shared.js";
import { createServer } from "node:http";

test("真实抓包片段：10 次主流程混合非结构化首轮，仅 1 回合不可恢复，其余回合通过重试 9/10 落盘", async (t) => {
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

      let payload: { content: string | null; tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>; };
      if (turn === 0 && attempt === 1) {
        payload = {
          content: "event: message\ndata: 回合 0 首轮是说明文本，先不落盘。",
          tool_calls: [{
            id: `tool_turn_0_typo_${attempt}`,
            type: "function",
            function: {
              name: "submit_product_update_typo",
              arguments: "reply:'回合0 错工具名',patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原回合 0 错名\"}]",
            },
          }],
        };
      } else if (turn === 7 && attempt <= 5) {
        payload = {
          content: `回合 7 持续返回非结构化字符串，尝试 ${attempt} 次仍失败`,
          tool_calls: [{
            id: `tool_turn_7_bad_${attempt}`,
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: "heartbeat",
            },
          }],
        };
      } else {
        payload = {
          content: "event: message\ndata: 回合内容可恢复",
          tool_calls: [{
            id: `tool_turn_${turn}_ok_${attempt}`,
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'回合 ${turn} 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 ${turn} 恢复值"}],questions:['该团是否继续核对酒店？']`,
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

  assert.equal(requestCount, 15);
  assert.equal(successCount, 9);
  assert.equal(failCount, 1);
});

test("真实抓包片段：tool_calls 同时出现错名与官方名时，仅官方名可恢复为可落盘内容", async (t) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [
            {
              id: "tool_wrong_name",
              type: "function",
              function: {
                name: "submit_product_update_typo",
                arguments: "reply:'错误工具名不应命中',patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"坏答案\"}],questions:['坏答案']",
              },
            },
            {
              id: "tool_official",
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: "reply:'官方名已恢复',patch:[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原正式恢复\"}],questions:['该团是否继续核对夜间接驳？']",
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

  const service = new MiniMaxService({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "test-model",
  });

  const result = await service.reply({
    message: "生成第一版",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [],
  });

  assert.equal(requestCount, 1);
  assert.equal(result.reply, "官方名已恢复");
  assert.equal(result.patch?.[0]?.path, "/basicInfo/subtitle");
  assert.equal(result.patch?.[0]?.value, "太原正式恢复");
  assert.equal(result.questions?.[0], "该团是否继续核对夜间接驳？");
});

test("真实抓包片段：10 次主流程含空响应，首轮可恢复、1 回合 5 次空响应仍 9/10 可落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  const retryRequestBodies: string[] = [];
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

      if (attempt === 2 && turn === 0) {
        retryRequestBodies.push(body);
      }

      type ToolCallMessage = {
        content: string | null;
        tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
      };
      let payload: ToolCallMessage | Record<string, never>;

      if (turn === 0 && attempt === 1) {
        payload = {}; // 空 message 回传，触发 empty_model_output 并重试
      } else if (turn === 6) {
        payload = {}; // 该回合持续空响应，保留 1 次失败
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
      if ((result.patch?.length ?? 0) > 0) successCount += 1;
    } catch (error) {
      failCount += 1;
      assert.ok(error instanceof MiniMaxServiceError);
      assert.equal((error as MiniMaxServiceError).code, "invalid_model_output");
    }
  }

  assert.equal(requestCount, 15);
  assert.equal(successCount, 9);
  assert.equal(failCount, 1);
  assert.equal(retryRequestBodies.length, 1);

  const parsedRetryBody = JSON.parse(retryRequestBodies[0] || "{}");
  const latestUserMessage = parsedRetryBody.messages?.filter((item: { role: string; content: string }) => item.role === "user").at(-1)?.content ?? "";
  assert.match(latestUserMessage, /上一次返回未通过结构化校验/);
});

test("真实抓包片段：10 次主流程 1 回合首轮仅说明文本、1 回合连续 5 次未可写响应，仍 9/10 落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  const retryRequestBodies: string[] = [];
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

      if (turn === 3 && attempt === 1) {
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: `回合 3 首轮先说明：请在下条回复中带上完整结构化参数，当前先记要点。`,
              tool_calls: [],
            },
          }],
        }));
        requestCount += 1;
        return;
      }

      if (turn === 7 && attempt <= 5) {
        if (attempt >= 2) {
          const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }>; };
          const lastUser = [...(parsed.messages ?? [])]
            .reverse()
            .find((item) => item.role === "user")?.content ?? "";
          retryRequestBodies.push(lastUser);
        }
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: "回合 7 持续回复说明，tool-call 等待下一次重试。",
              tool_calls: [],
            },
          }],
        }));
        requestCount += 1;
        return;
      }

      response.end(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: `tool_turn_${turn}_ok_${attempt}`,
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: `reply:'回合 ${turn} 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 ${turn} 恢复值"}],questions:['该团是否继续核对接驳？']`,
              },
            }],
          },
        }],
      }));
      requestCount += 1;
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

  assert.equal(requestCount, 15);
  assert.equal(successCount, 9);
  assert.equal(failCount, 1);
  assert.equal(retryRequestBodies.length, 5);
  for (const retryBody of retryRequestBodies) {
    assert.match(retryBody, /上一次返回未通过结构化校验/);
  }
});

test("真实抓包片段：10 次主流程 mixed 异常：tool-call 名错位后 1 次恢复、1 回合 5 次空 message 仍 9/10", async (t) => {
  const attemptByTurn = new Map<number, number>();
  const retryRequestBodies: string[] = [];
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

      if (turn === 0 && attempt === 1) {
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: "回合 0 首次返回说明文本",
              tool_calls: [{
                id: "tool_turn0_typo",
                type: "function",
                function: {
                  name: "submit_product_update_typo",
                  arguments: "reply:'回合 0 工具名错位',patch:[{'op':'replace','path':'/basicInfo/subtitle','value':'太原回合0-错名'}]",
                },
              }],
            },
          }],
        }));
        requestCount += 1;
        return;
      }

      if (turn === 6 && attempt <= 5) {
        const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }>; };
        const lastUser = [...(parsed.messages ?? [])]
          .reverse()
          .find((item) => item.role === "user")?.content ?? "";
        retryRequestBodies.push(lastUser);
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: "",
              tool_calls: [{
                id: `tool_turn_6_bad_${attempt}`,
                type: "function",
                function: {
                  name: "submit_product_update",
                  arguments: "payload-truncated-[",
                },
              }],
            },
          }],
        }));
        requestCount += 1;
        return;
      }

      if (turn === 0 && attempt === 2) {
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "tool_turn0_recover",
                type: "function",
                function: {
                  name: "submit_product_update",
                  arguments: `reply:'回合 0 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合0恢复"}],questions:['是否继续核对酒店？']`,
                },
              }],
            },
          }],
        }));
        requestCount += 1;
        return;
      }

      response.end(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: `tool_turn_${turn}_ok_${attempt}`,
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: `reply:'回合 ${turn} 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 ${turn} 恢复值"}],questions:['是否继续核对接驳？']`,
              },
            }],
          },
        }],
      }));
      requestCount += 1;
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

  assert.equal(requestCount, 15);
  assert.equal(successCount, 9);
  assert.equal(failCount, 1);
  assert.equal(retryRequestBodies.length, 5);
  for (const retryBody of retryRequestBodies) {
    assert.match(retryBody, /上一次返回未通过结构化校验/);
  }
});

test("真实抓包片段：10 次主流程 1 回合 5 次纯文本失败（无 JSON fence/无 <think> 标记）仍 9/10 落盘", async (t) => {
  const attemptByTurn = new Map<number, number>();
  const retryRequestBodies: string[] = [];
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

      if (turn === 8 && attempt <= 5) {
        if (attempt >= 2) retryRequestBodies.push(body);
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: `回合 8 结构化片段回复有缺口。\nraw=JSON.parse(undefined) | reason=Unexpected end of JSON input`,
              tool_calls: [],
            },
          }],
        }));
        requestCount += 1;
        return;
      }

      response.end(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: `tool_turn_${turn}_ok_${attempt}`,
              type: "function",
              function: {
                name: "submit_product_update",
                arguments: `reply:'回合 ${turn} 已恢复',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原回合 ${turn} 恢复值"}],questions:['该团是否继续核对接驳？']`,
              },
            }],
          },
        }],
      }));
      requestCount += 1;
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

  assert.equal(requestCount, 15);
  assert.equal(successCount, 9);
  assert.equal(failCount, 1);
  assert.equal(retryRequestBodies.length, 4);
  for (const retryBody of retryRequestBodies) {
    assert.match(retryBody, /上一次返回未通过结构化校验/);
  }
});
