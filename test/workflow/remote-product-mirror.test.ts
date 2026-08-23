import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteProductMirror } from "../../src/main/application/remote-product-mirror.js";
import type { ProductDetail } from "../../src/shared/contracts.js";
import { TibetProductConflictError, type TibetProductService } from "../../src/main/infrastructure/tibet-products.js";

const base: ProductDetail = {
  id: "17bd40b8-8d30-4c4e-9940-0aa6fa9a7323",
  name: "拉萨3天2晚私家团",
  status: "review",
  updatedAt: "2026-08-20T10:00:00.000Z",
  revision: 1,
  product: { basicInfo: { destinationCity: "拉萨" } },
  messages: [],
  researchTasks: [],
};

test("legacy local mutations are revision-patched to Tibet before broadcast", async () => {
  let remote = structuredClone(base);
  const calls: number[] = [];
  const service: TibetProductService = {
    async list() { return []; },
    async upsert(product) { return product; },
    async update(product, expectedRevision) {
      calls.push(expectedRevision);
      assert.equal(expectedRevision, remote.revision);
      remote = { ...structuredClone(product), revision: expectedRevision + 1 };
      return remote;
    },
    async get() { return structuredClone(remote); },
    async delete() {},
  };
  const broadcasts: ProductDetail[] = [];
  const mirror = createRemoteProductMirror({ remote: service, broadcast: (product) => broadcasts.push(product) });
  mirror.emit({ ...base, revision: undefined, messages: [{ id: "m1", role: "user", content: "补充", createdAt: "2026-08-20T11:00:00.000Z" }] });
  await waitFor(() => broadcasts.length === 1);
  assert.deepEqual(calls, [1]);
  assert.equal(remote.revision, 2);
  assert.equal(remote.messages.length, 1);
  assert.equal(broadcasts[0].revision, 2);
});

test("409 冲突时以最新 revision 重放本地变更，并保留最新 planning", async () => {
  let remote = structuredClone(base);
  const calls: number[] = [];
  let first = true;
  const service: TibetProductService = {
    async list() { return []; },
    async upsert(product) { return product; },
    async update(product, expectedRevision) {
      calls.push(expectedRevision);
      if (first) {
        first = false;
        remote = {
          ...remote,
          revision: 2,
          planning: { version: 2, runId: "new-plan", status: "needs_user", currentNode: "poiResolution", nodes: [], poiCandidates: [], createdAt: "now", updatedAt: "now" },
        } as ProductDetail;
        throw new TibetProductConflictError(remote);
      }
      assert.equal(expectedRevision, 2);
      assert.equal(product.planning?.runId, "new-plan");
      remote = { ...structuredClone(product), revision: 3 };
      return remote;
    },
    async get() { return structuredClone(remote); },
    async delete() {},
  };
  const broadcasts: ProductDetail[] = [];
  const mirror = createRemoteProductMirror({ remote: service, broadcast: (product) => broadcasts.push(product) });
  mirror.emit({ ...base, revision: undefined, product: { ...base.product, itinerary: [{ day: 1 }] } });
  await waitFor(() => broadcasts.length === 1);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(remote.revision, 3);
  assert.equal(remote.product.itinerary?.[0] && (remote.product.itinerary[0] as any).day, 1);
});

test("产品工作流进行中时镜像不写远端，释放后才同步", async () => {
  let active = true;
  let getCalls = 0;
  let updates = 0;
  const service: TibetProductService = {
    async list() { return []; },
    async upsert(product) { return product; },
    async update(product, expectedRevision) { updates += 1; return { ...product, revision: expectedRevision + 1 }; },
    async get() { getCalls += 1; return structuredClone(base); },
    async delete() {},
  };
  const mirror = createRemoteProductMirror({
    remote: service,
    broadcast: () => undefined,
    isWorkflowActive: () => active,
  });
  mirror.emit({ ...base, revision: undefined });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(getCalls, 0);
  assert.equal(updates, 0);
  active = false;
  await waitFor(() => updates === 1);
  assert.equal(getCalls, 1);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for mirror");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
