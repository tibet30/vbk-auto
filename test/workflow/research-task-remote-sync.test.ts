import assert from "node:assert/strict";
import test from "node:test";
import type { ProductDetail, ResearchTask } from "../../src/shared/contracts.js";
import { TibetProductConflictError, type TibetProductService } from "../../src/main/infrastructure/tibet-products.js";
import { syncConfirmedResearchTasksToRemote } from "../../src/main/operations/research-task-remote-sync.js";

function task(id: string, state: ResearchTask["state"]): ResearchTask {
  return { id, label: `核查 ${id}`, type: "vbk", status: state === "confirmed" ? "succeeded" : "queued", state, evidence: [] };
}

function product(revision: number, researchTasks: ResearchTask[]): ProductDetail {
  return {
    id: "product-1", name: "测试产品", status: "review", updatedAt: "2026-09-07T00:00:00.000Z",
    revision, product: {}, messages: [], researchTasks,
  };
}

test("research confirmation is persisted while remote-only tasks are preserved", async () => {
    const local = product(1, [task("matched", "confirmed")]);
    let remote = product(2, [task("matched", "researching"), task("remote-only", "researching")]);
    const broadcasts: ProductDetail[] = [];
    const service = {
      get: async () => remote,
      update: async (next: ProductDetail) => { remote = { ...next, revision: 3 }; return remote; },
    } as TibetProductService;
    const db = {
      getProduct: () => local,
      importProductSnapshot: (snapshot: ProductDetail) => snapshot,
    };

    const saved = await syncConfirmedResearchTasksToRemote({ db, remote: service, localProductId: local.id, broadcast: (p) => broadcasts.push(p) });

    assert.deepEqual(saved.researchTasks.map(({ id, state }) => [id, state]), [
      ["matched", "confirmed"], ["remote-only", "researching"],
    ]);
    assert.deepEqual(broadcasts, [saved]);
});

test("research confirmation is replayed once after a revision conflict", async () => {
    const local = product(1, [task("matched", "confirmed")]);
    const firstRemote = product(2, [task("matched", "researching")]);
    const latest = product(3, [task("matched", "researching"), task("new", "researching")]);
    let calls = 0;
    const service = {
      get: async () => firstRemote,
      update: async (next: ProductDetail) => {
        calls += 1;
        if (calls === 1) throw new TibetProductConflictError(latest);
        return { ...next, revision: 4 };
      },
    } as TibetProductService;
    const db = {
      getProduct: () => local,
      importProductSnapshot: (snapshot: ProductDetail) => snapshot,
    };

    const saved = await syncConfirmedResearchTasksToRemote({ db, remote: service, localProductId: local.id, broadcast: () => {} });

    assert.equal(calls, 2);
    assert.deepEqual(saved.researchTasks.map(({ id, state }) => [id, state]), [
      ["matched", "confirmed"], ["new", "researching"],
    ]);
});

test("conflict replay keeps the more advanced remote automation instead of clobbering it", async () => {
  const local = {
    ...product(1, [task("matched", "confirmed")]),
    automation: {
      id: "local-stale", status: "failed", logs: [],
      phases: [{ phase: "basic", status: "completed" }, { phase: "hotelResource", status: "failed" }],
    },
    basicInfoSaved: false,
  } as ProductDetail;
  const latest = {
    ...product(3, [task("matched", "researching")]),
    automation: {
      id: "remote-run", status: "running", logs: [],
      phases: [{ phase: "basic", status: "completed" }, { phase: "hotelResource", status: "completed" }, { phase: "preflight", status: "running" }],
    },
    basicInfoSaved: true,
    productId: "77970001",
  } as ProductDetail;
  let calls = 0;
  let written: ProductDetail | undefined;
  const service = {
    get: async () => product(2, [task("matched", "researching")]),
    update: async (next: ProductDetail) => {
      calls += 1;
      if (calls === 1) throw new TibetProductConflictError(latest);
      written = next;
      return { ...next, revision: 4 };
    },
  } as TibetProductService;
  const db = {
    getProduct: () => local,
    importProductSnapshot: (snapshot: ProductDetail) => snapshot,
  };

  const saved = await syncConfirmedResearchTasksToRemote({ db, remote: service, localProductId: local.id, broadcast: () => {} });

  assert.equal(calls, 2);
  assert.equal(written?.automation?.id, "remote-run");
  assert.equal(written?.automation?.status, "running");
  assert.equal(written?.basicInfoSaved, true);
  assert.equal(written?.productId, "77970001");
  assert.deepEqual(saved.researchTasks.map(({ id, state }) => [id, state]), [["matched", "confirmed"]]);
});

test("conflict replay keeps a more advanced local automation when remote is stale", async () => {
  const local = {
    ...product(1, [task("matched", "confirmed")]),
    automation: {
      id: "local-run", status: "running", logs: [],
      phases: [{ phase: "basic", status: "completed" }, { phase: "preflight", status: "running" }],
    },
    basicInfoSaved: true,
    productId: "77970002",
  } as ProductDetail;
  const latest = {
    ...product(3, [task("matched", "researching")]),
    automation: {
      id: "remote-stale", status: "queued", logs: [],
      phases: [{ phase: "basic", status: "pending" }],
    },
    basicInfoSaved: false,
  } as ProductDetail;
  let written: ProductDetail | undefined;
  const service = {
    get: async () => product(2, [task("matched", "researching")]),
    update: async (next: ProductDetail) => {
      if (!written) {
        written = next;
        throw new TibetProductConflictError(latest);
      }
      written = next;
      return { ...next, revision: 4 };
    },
  } as TibetProductService;

  await syncConfirmedResearchTasksToRemote({
    db: { getProduct: () => local, importProductSnapshot: (snapshot) => snapshot },
    remote: service, localProductId: local.id, broadcast: () => {},
  });

  assert.equal(written?.automation?.id, "local-run");
  assert.equal(written?.basicInfoSaved, true);
  assert.equal(written?.productId, "77970002");
});

test("a failed remote confirmation never replaces the durable local mutation with stale remote data", async () => {
    const local = product(1, [task("matched", "confirmed")]);
    const remote = product(2, [task("matched", "researching")]);
    let imported = 0;
    const service = {
      get: async () => remote,
      update: async () => { throw new Error("network unavailable"); },
    } as unknown as TibetProductService;
    const db = {
      getProduct: () => local,
      importProductSnapshot: () => { imported += 1; return local; },
    };

    await assert.rejects(
      syncConfirmedResearchTasksToRemote({ db, remote: service, localProductId: local.id, broadcast: () => {} }),
      /network unavailable/,
    );
    assert.equal(imported, 0);
    assert.equal(local.researchTasks[0]!.state, "confirmed");
});
