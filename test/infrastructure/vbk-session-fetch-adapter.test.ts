import assert from "node:assert/strict";
import test from "node:test";
import { attachVbkSessionFetch, observeVbkSessionFetch } from "../../src/main/infrastructure/vbk-session-fetch-adapter.js";

test("native session fetch observer receives an ephemeral request and parsed response", async () => {
  const page = { url: () => "https://vbooking.ctrip.com/product/input" } as any;
  const session = {
    cookies: { get: async () => [] },
    fetch: async () => ({ status: 200, text: async () => JSON.stringify({ ResponseStatus: { Ack: "Success" }, value: 7 }) }),
  } as any;
  attachVbkSessionFetch(page, session);
  const observed: Array<{ endpoint: string; observedAt: string; requestBody: object; responsePayload: unknown }> = [];
  const stop = observeVbkSessionFetch(page, (exchange) => observed.push(exchange));
  await page.vbkSessionFetch({
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/checkTourDaily",
    body: { head: { cid: "" }, productTourInfo: { productId: "79189107" } }, errorLabel: "native observer test",
    headers: { "content-type": "application/json" }, includeCidQuery: false, requireReadableCid: false,
  });
  stop();
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.endpoint.endsWith("/checkTourDaily"), true);
  assert.match(observed[0]?.observedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(observed[0]?.responsePayload, { ResponseStatus: { Ack: "Success" }, value: 7 });
});
