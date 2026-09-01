import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { OpenAIThreeStagePlanningAi } from "../../src/main/planning/adapters/three-stage-ai.js";

test("ThreeStage 把 userIdea 作为需求数据结构化并记录逐日安排", async (t) => {
  let captured: Record<string, unknown> | undefined;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      captured = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        choices: [{ message: { tool_calls: [{
          id: "intent-call",
          type: "function",
          function: {
            name: "submit_user_planning_intent",
            arguments: JSON.stringify({
              preferences: ["节奏舒缓"],
              activities: [{
                id: "model-id", day: 2, title: "藏香制作", kind: "activity",
                time: "下午", detail: "体验制作", durationMinutes: 120,
              }],
            }),
          },
        }] } }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  const ai = new OpenAIThreeStagePlanningAi({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: "test-model",
  });
  const intent = await ai.structureUserIntent({
    userIdea: "第二天下午做全网最佳、唯一的藏香，整体慢一点",
    destination: "拉萨",
    days: 3,
  });
  assert.equal(intent.rawIdea, "第二天下午做全网最佳、唯一的藏香，整体慢一点");
  assert.equal(intent.activities[0].id, "user-1", "活动 ID 必须由本地稳定生成");
  assert.equal(intent.activities[0].day, 2);
  const body = captured!;
  const messages = body.messages as Array<{ content: string }>;
  assert.match(messages[0].content, /用户原始产品想法/);
  assert.match(messages[0].content, /没有指定日期时 day=0/);
  assert.match(messages[1].content, /第二天下午做.*藏香/);
  assert.doesNotMatch(messages[1].content, /全网|最佳|唯一/);
  const tools = body.tools as Array<{ function: { name: string } }>;
  assert.equal(tools[0].function.name, "submit_user_planning_intent");
});

test("ThreeStage POI 消歧只从真实候选编号中选择大众常游主景点", async (t) => {
  let captured: Record<string, unknown> | undefined;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      captured = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        choices: [{ message: { tool_calls: [{
          id: "poi-call",
          type: "function",
          function: {
            name: "submit_poi_disambiguation",
            arguments: JSON.stringify({
              decision: "selected",
              candidateId: "candidate-1",
              confidence: 0.93,
              reason: "天安门广场是大多数游客通常游览的代表性主景点",
            }),
          },
        }] } }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  const ai = new OpenAIThreeStagePlanningAi({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: "test-model",
  });
  const result = await ai.disambiguatePoiCandidate({
    requestedName: "天安门",
    destination: "北京",
    province: "北京",
    city: "北京",
    preferredDay: 1,
    userIdea: "第一天天安门、故宫",
    candidates: [
      { candidateId: "candidate-1", poiName: "天安门广场", city: "北京" },
      { candidateId: "candidate-2", poiName: "天安门城楼", city: "北京" },
    ],
  });
  assert.deepEqual(result, {
    decision: "selected",
    candidateId: "candidate-1",
    confidence: 0.93,
    reason: "天安门广场是大多数游客通常游览的代表性主景点",
  });
  const body = captured!;
  const messages = body.messages as Array<{ content: string }>;
  assert.match(messages[0].content, /大多数普通游客通常前往/);
  assert.match(messages[0].content, /禁止生成候选之外/);
  assert.doesNotMatch(messages[1].content, /poiId/);
  assert.equal((body.tools as Array<{ function: { name: string } }>)[0].function.name, "submit_poi_disambiguation");
});

test("ThreeStage POI 消歧拒绝候选列表外编号和低置信选择", async (t) => {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      choices: [{ message: { tool_calls: [{
        id: "poi-call",
        type: "function",
        function: {
          name: "submit_poi_disambiguation",
          arguments: JSON.stringify({
            decision: "selected", candidateId: "invented", confidence: 0.7, reason: "猜测",
          }),
        },
      }] } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  const ai = new OpenAIThreeStagePlanningAi({
    apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}`, model: "test-model",
  });
  const result = await ai.disambiguatePoiCandidate({
    requestedName: "长城", destination: "北京", province: "北京", city: "北京",
    candidates: [{ candidateId: "candidate-1", poiName: "八达岭长城", city: "北京" }],
  });
  assert.deepEqual(result, { decision: "uncertain", confidence: 0.7, reason: "猜测" });
});
