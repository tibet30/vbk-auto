import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { findAvailablePort } from "../../scripts/dev.mjs";

test("开发启动端口被占用时选择后续可用端口", async (t) => {
  const occupied = net.createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => occupied.close());

  const address = occupied.address();
  assert.ok(address && typeof address === "object");
  const selected = await findAvailablePort(address.port, "127.0.0.1", 20);

  assert.ok(selected > address.port, "不能继续使用已被占用的端口");
});

test("开发启动端口空闲时保留首选端口", async () => {
  const reservation = net.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  assert.ok(address && typeof address === "object");
  const preferred = address.port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));

  assert.equal(await findAvailablePort(preferred), preferred);
});
