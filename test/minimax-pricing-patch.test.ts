import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { MiniMaxService } from "../src/main/minimax.js";

// ───────────────────────── helpers ─────────────────────────

interface ServerHandle {
  url: string;
  close: () => Promise<void>;
}

async function startServer(handler: (response: import("node:http").ServerResponse) => void): Promise<ServerHandle> {
  const server = createServer((_request, response) => handler(response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function respondWithChoices(response: import("node:http").ServerResponse, payload: unknown) {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(payload) } }],
  }));
}

// ───────────────────────── 测试 ─────────────────────────

test("AI 返回 /commercial/pricing + inventory + release 三条 patch：service 全部接受", async (t) => {
  const payload = {
    reply: "已补齐商业字段。",
    patch: [
      {
        op: "add",
        path: "/commercial/pricing",
        value: {
          currency: "CNY",
          adult: 1999,
          child: 999,
          minimumTravelers: 2,
          cost: { adult: 1500, child: 600, singleSupplement: 300, childBed: 200 },
        },
      },
      {
        op: "add",
        path: "/commercial/inventory",
        value: {
          startDate: "2026-08-10",
          endDate: "2026-08-31",
          dailyQuota: 5,
        },
      },
      {
        op: "add",
        path: "/commercial/release",
        value: {
          submitReview: true,
          publishAfterApproval: false,
          publicPriceCeiling: 2399,
          publicAuditRetries: 3,
        },
      },
    ],
    questions: [],
    researchTasks: [],
  };
  const server = await startServer((response) => respondWithChoices(response, payload));
  t.after(() => server.close());

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: server.url, model: "test-model" });
  const result = await service.reply({
    message: "补齐价格库存",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [{ day: 1 }, { day: 2 }] },
    history: [],
  });

  assert.equal(result.reply, "已补齐商业字段。");
  assert.equal(result.patch?.length, 3);
  const byPath = Object.fromEntries((result.patch ?? []).map((op) => [op.path, op]));
  assert.ok(byPath["/commercial/pricing"]);
  assert.equal(byPath["/commercial/pricing"].op, "add");
  assert.equal((byPath["/commercial/pricing"].value as { adult: number }).adult, 1999);
  assert.equal((byPath["/commercial/pricing"].value as { currency: string }).currency, "CNY");
  assert.ok(byPath["/commercial/inventory"]);
  assert.equal((byPath["/commercial/inventory"].value as { dailyQuota: number }).dailyQuota, 5);
  assert.ok(byPath["/commercial/release"]);
  assert.equal((byPath["/commercial/release"].value as { publicAuditRetries: number }).publicAuditRetries, 3);
});

test("AI 返回 cost.adult > adult 的 pricing → service 拒绝该 patch（不留 half-pricing）", async (t) => {
  const payload = {
    reply: "已设置价格（错误：成本价高于售卖价）。",
    patch: [
      {
        op: "add",
        path: "/commercial/pricing",
        value: {
          currency: "CNY",
          adult: 1500,
          child: 800,
          minimumTravelers: 2,
          cost: { adult: 1800, child: 600, singleSupplement: 0, childBed: 0 },
        },
      },
    ],
    questions: [],
    researchTasks: [],
  };
  const server = await startServer((response) => respondWithChoices(response, payload));
  t.after(() => server.close());

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: server.url, model: "test-model" });
  const result = await service.reply({
    message: "补价格",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [{ day: 1 }] },
    history: [],
  });

  // 非法 pricing 应被丢弃；reply 仍透传给运营看
  assert.equal(result.reply, "已设置价格（错误：成本价高于售卖价）。");
  assert.equal(result.patch?.length ?? 0, 0, "非法 pricing patch 不应进入 product");
});

test("AI 返回 startDate > endDate 的 inventory → service 拒绝该 patch", async (t) => {
  const payload = {
    reply: "已设置库存（错误：startDate 晚于 endDate）。",
    patch: [
      {
        op: "add",
        path: "/commercial/inventory",
        value: {
          startDate: "2026-08-31",
          endDate: "2026-08-10",
          dailyQuota: 5,
        },
      },
    ],
    questions: [],
    researchTasks: [],
  };
  const server = await startServer((response) => respondWithChoices(response, payload));
  t.after(() => server.close());

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: server.url, model: "test-model" });
  const result = await service.reply({
    message: "补库存",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [{ day: 1 }] },
    history: [],
  });

  assert.equal(result.reply, "已设置库存（错误：startDate 晚于 endDate）。");
  assert.equal(result.patch?.length ?? 0, 0, "非法 inventory patch 不应进入 product");
});

test("AI 返回 child=0 的 pricing（成本未填）：service 接受", async (t) => {
  const payload = {
    reply: "已设置价格（成本留空）。",
    patch: [
      {
        op: "add",
        path: "/commercial/pricing",
        value: {
          currency: "CNY",
          adult: 1999,
          child: 0,
          minimumTravelers: 2,
        },
      },
    ],
    questions: [],
    researchTasks: [],
  };
  const server = await startServer((response) => respondWithChoices(response, payload));
  t.after(() => server.close());

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: server.url, model: "test-model" });
  const result = await service.reply({
    message: "补价格",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [{ day: 1 }] },
    history: [],
  });

  // cost 是 optional；省略时 pricingSchema 仍合法
  assert.equal(result.patch?.length, 1);
  const value = result.patch?.[0].value as { adult: number; child: number; cost?: unknown };
  assert.equal(value.adult, 1999);
  assert.equal(value.child, 0);
  assert.equal(value.cost, undefined);
});

test("AI 同时返回合法 pricing + 非法 inventory：service 只接受 pricing", async (t) => {
  const payload = {
    reply: "已部分补齐。",
    patch: [
      {
        op: "add",
        path: "/commercial/pricing",
        value: {
          currency: "CNY",
          adult: 1999,
          child: 0,
          minimumTravelers: 2,
        },
      },
      {
        op: "add",
        path: "/commercial/inventory",
        value: {
          startDate: "2026-08-31",
          endDate: "2026-08-01",
          dailyQuota: 5,
        },
      },
    ],
    questions: [],
    researchTasks: [],
  };
  const server = await startServer((response) => respondWithChoices(response, payload));
  t.after(() => server.close());

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: server.url, model: "test-model" });
  const result = await service.reply({
    message: "补齐商业字段",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [{ day: 1 }] },
    history: [],
  });

  // pricing 合法、inventory 非法 → 只剩 pricing
  assert.equal(result.patch?.length, 1);
  assert.equal(result.patch?.[0].path, "/commercial/pricing");
});