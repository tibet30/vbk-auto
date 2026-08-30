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
  let broadcasts = 0;
  const service: TibetProductService = {
    async list() { return []; },
    async upsert(product) { return product; },
    async update(product, expectedRevision) { updates += 1; return { ...product, revision: expectedRevision + 1 }; },
    async get() { getCalls += 1; return structuredClone(base); },
    async delete() {},
  };
  const mirror = createRemoteProductMirror({
    remote: service,
    broadcast: () => { broadcasts += 1; },
    isWorkflowActive: () => active,
    // 模拟 AI / planning：即使持有工作流锁，也不能绕过远端权威快照。
    shouldBroadcastWhileActive: () => false,
  });
  mirror.emit({ ...base, revision: undefined });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(getCalls, 0);
  assert.equal(updates, 0);
  assert.equal(broadcasts, 0);
  active = false;
  await waitFor(() => updates === 1);
  assert.equal(getCalls, 1);
  assert.equal(broadcasts, 1);
});

test("自动录入工作流逐节点即时广播，并在释放后只同步最新快照", async () => {
  let active = true;
  let remote = structuredClone(base);
  const updates: ProductDetail[] = [];
  const service: TibetProductService = {
    async list() { return []; },
    async upsert(product) { return product; },
    async update(product, expectedRevision) {
      updates.push(structuredClone(product));
      remote = { ...structuredClone(product), revision: expectedRevision + 1 };
      return structuredClone(remote);
    },
    async get() { return structuredClone(remote); },
    async delete() {},
  };
  const broadcasts: ProductDetail[] = [];
  const mirror = createRemoteProductMirror({
    remote: service,
    broadcast: (product) => broadcasts.push(structuredClone(product)),
    isWorkflowActive: () => active,
    shouldBroadcastWhileActive: () => true,
  });
  const progress = (completed: number): ProductDetail => ({
    ...base,
    revision: undefined,
    automation: {
      id: "run-1",
      status: "running",
      phases: ["basic", "itinerary", "package"].map((phase, index) => ({
        phase,
        status: index < completed ? "completed" : index === completed ? "running" : "pending",
      })),
      logs: [],
    },
  });

  mirror.emit(progress(0));
  mirror.emit(progress(1));
  mirror.emit(progress(2));
  await waitFor(() => broadcasts.length === 3);
  assert.equal(updates.length, 0);
  assert.deepEqual(
    broadcasts.map((product) => product.automation?.phases.map((phase) => phase.status)),
    [
      ["running", "pending", "pending"],
      ["completed", "running", "pending"],
      ["completed", "completed", "running"],
    ],
  );

  active = false;
  await waitFor(() => updates.length === 1 && broadcasts.length === 4);
  assert.deepEqual(
    updates[0].automation?.phases.map((phase) => phase.status),
    ["completed", "completed", "running"],
  );
  assert.equal(broadcasts[3].revision, 2);
});

test("自动录入失败与取消终态也在工作流释放前即时广播", async () => {
  let active = true;
  let updates = 0;
  const service: TibetProductService = {
    async list() { return []; },
    async upsert(product) { return product; },
    async update(product, expectedRevision) { updates += 1; return { ...product, revision: expectedRevision + 1 }; },
    async get() { return structuredClone(base); },
    async delete() {},
  };
  const statuses: string[] = [];
  const mirror = createRemoteProductMirror({
    remote: service,
    broadcast: (product) => statuses.push(product.automation?.status ?? "missing"),
    isWorkflowActive: () => active,
    shouldBroadcastWhileActive: () => true,
  });

  mirror.emit({ ...base, revision: undefined, status: "blocked", automation: {
    id: "run-failed", status: "failed", phases: [{ phase: "basic", status: "failed" }], logs: [],
  } });
  mirror.emit({ ...base, revision: undefined, automation: {
    id: "run-cancelled", status: "cancelled", phases: [{ phase: "basic", status: "running" }], logs: [],
  } });
  assert.deepEqual(statuses, ["failed", "cancelled"]);
  assert.equal(updates, 0);

  active = false;
  await waitFor(() => updates === 1 && statuses.length === 3);
  assert.equal(statuses[2], "cancelled");
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for mirror");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
