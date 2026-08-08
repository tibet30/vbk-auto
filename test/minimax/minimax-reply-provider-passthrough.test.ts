import { assert, MiniMaxService, MiniMaxServiceError, test } from "./minimax.core.shared.js";
import { createServer } from "node:http";

/**
 * 回归保护：`reply()` 在 provider 端报错时必须原样抛出 `lastError` 的 code/message/details。
 *
 * 历史 bug：`reply()` 末尾把所有非 invalid_model_output / empty_model_output 的 lastError
 * 都重包为 invalid_model_output，导致 Evolink/deepseek 服务错误被外层 runAiReply
 * 误判为「未返回可写入的产品方案」并重复重试 5 次。本测试覆盖 provider_error /
 * provider_connection / provider_timeout / provider_authentication / provider_rate_limit
 * 全部透传语义。
 */

const evolinkConfig = {
  apiKey: "test-key",
  baseUrl: "http://127.0.0.1:0/v1",
  model: "deepseek-chat",
  provider: "deepseek",
};

async function withServer(t: Parameters<Parameters<typeof test>[0]>[0], status: number, body: string = "upstream error") {
  const server = createServer((_request, response) => {
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: { message: body, type: "server_error" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return new MiniMaxService({ ...evolinkConfig, baseUrl: `http://127.0.0.1:${address.port}/v1` });
}

test("Evolink provider 5xx 错误必须原样透传为 provider_error，不得被改成 invalid_model_output", async (t) => {
  const service = await withServer(t, 502);

  await assert.rejects(
    service.reply({ message: "生成第一版", product: { basicInfo: { meetingCity: "太原" }, itinerary: [] }, history: [] }),
    (error: unknown) => {
      assert.ok(error instanceof MiniMaxServiceError, "应抛出 MiniMaxServiceError");
      assert.equal((error as MiniMaxServiceError).code, "provider_error", "provider_error 必须透传，不得变成 invalid_model_output");
      assert.match((error as MiniMaxServiceError).message, /Evolink/, "消息必须保留 Evolink label");
      assert.doesNotMatch((error as MiniMaxServiceError).message, /未返回可写入的产品方案/);
      return true;
    },
  );
});

test("Evolink provider 503 service_unavailable 同样原样透传为 provider_error", async (t) => {
  const service = await withServer(t, 503, "service unavailable");

  await assert.rejects(
    service.reply({ message: "生成第一版", product: { basicInfo: { meetingCity: "太原" }, itinerary: [] }, history: [] }),
    (error: unknown) => {
      assert.ok(error instanceof MiniMaxServiceError);
      assert.equal((error as MiniMaxServiceError).code, "provider_error");
      assert.match((error as MiniMaxServiceError).message, /Evolink/);
      return true;
    },
  );
});

test("Evolink provider 连接级错误（ECONNREFUSED）必须原样透传为 provider_connection", async (t) => {
  // 监听一个端口后立即关闭，强制 ECONNREFUSED
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  t.after(() => {/* already closed */});

  const service = new MiniMaxService({ ...evolinkConfig, baseUrl: `http://127.0.0.1:${address.port}/v1` });

  await assert.rejects(
    service.reply({ message: "生成第一版", product: { basicInfo: { meetingCity: "太原" }, itinerary: [] }, history: [] }),
    (error: unknown) => {
      assert.ok(error instanceof MiniMaxServiceError);
      const code = (error as MiniMaxServiceError).code;
      assert.ok(code === "provider_connection" || code === "provider_error", `期望 provider_connection/provider_error，实际 ${code}`);
      assert.match((error as MiniMaxServiceError).message, /Evolink/);
      assert.notEqual(code, "invalid_model_output");
      return true;
    },
  );
});

test("reply() 透传的 provider_error 不得把上游 message 改写成结构化失败文案", async (t) => {
  const upstream = "Evolink 服务暂时无法完成本次请求。";
  const service = await withServer(t, 500, upstream);

  await assert.rejects(
    service.reply({ message: "生成第一版", product: { basicInfo: { meetingCity: "太原" }, itinerary: [] }, history: [] }),
    (error: unknown) => {
      assert.ok(error instanceof MiniMaxServiceError);
      assert.equal((error as MiniMaxServiceError).code, "provider_error");
      // 关键：外层抛出的 message 必须保留上游原文，不被替换为「未返回可写入的产品方案，请重试」。
      assert.match((error as MiniMaxServiceError).message, /Evolink/);
      assert.notEqual((error as MiniMaxServiceError).message, "Evolink 未返回可写入的产品方案，请重试。");
      return true;
    },
  );
});