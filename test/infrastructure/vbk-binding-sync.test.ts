import test from "node:test";
import assert from "node:assert/strict";
import { createVbkBindingSync } from "../../src/main/infrastructure/vbk-binding-sync.js";
import type {
  TibetVbkBindingService,
  VbkBinding,
  VbkBindingUpsertPatch,
  VbkBindingsSnapshot,
} from "../../src/shared/contracts-vbk-binding.js";
import type { AccountFixedInfoValue, ContactCardSelection } from "../../src/shared/contracts.js";

const butler: ContactCardSelection = {
  contactCardId: 1,
  displayName: "小王",
  providerId: 123456,
};

function memoryDb() {
  const map = new Map<string, string>();
  return {
    getSetting: (key: string) => map.get(key),
    setSetting: (key: string, value: string) => { map.set(key, value); },
    deleteSetting: (key: string) => { map.delete(key); },
    map,
  };
}

function fakeRemote(initial: VbkBindingsSnapshot = { items: [], activeVbkAccountKey: null }) {
  let snapshot: VbkBindingsSnapshot = {
    items: initial.items.map((item) => ({ ...item })),
    activeVbkAccountKey: initial.activeVbkAccountKey,
  };
  const calls: Array<{ op: string; key?: string; patch?: VbkBindingUpsertPatch }> = [];
  const remote: TibetVbkBindingService = {
    async list() {
      calls.push({ op: "list" });
      return {
        items: snapshot.items.map((item) => ({ ...item })),
        activeVbkAccountKey: snapshot.activeVbkAccountKey,
      };
    },
    async upsert(vbkAccountKey, patch) {
      calls.push({ op: "upsert", key: vbkAccountKey, patch: { ...patch } });
      const existing = snapshot.items.find((item) => item.vbkAccountKey === vbkAccountKey);
      const next: VbkBinding = {
        vbkAccountKey,
        vbkAccountName: patch.vbkAccountName ?? existing?.vbkAccountName ?? vbkAccountKey,
        providerId: patch.providerId !== undefined ? patch.providerId : existing?.providerId,
        servicePhone: patch.servicePhone !== undefined
          ? (patch.servicePhone ?? "")
          : (existing?.servicePhone ?? ""),
        butler: patch.butler !== undefined ? patch.butler : (existing?.butler ?? null),
        lastUsedAt: existing?.lastUsedAt ?? null,
        updatedAt: "2026-08-23T12:00:00+08:00",
      };
      snapshot.items = [...snapshot.items.filter((item) => item.vbkAccountKey !== vbkAccountKey), next];
      return { ...next };
    },
    async activate(vbkAccountKey) {
      calls.push({ op: "activate", key: vbkAccountKey });
      snapshot.activeVbkAccountKey = vbkAccountKey;
      const existing = snapshot.items.find((item) => item.vbkAccountKey === vbkAccountKey);
      if (!existing) {
        const created: VbkBinding = {
          vbkAccountKey,
          vbkAccountName: vbkAccountKey,
          servicePhone: "",
          butler: null,
          lastUsedAt: "2026-08-23T12:00:00+08:00",
          updatedAt: "2026-08-23T12:00:00+08:00",
        };
        snapshot.items = [...snapshot.items, created];
        return { ...created };
      }
      existing.lastUsedAt = "2026-08-23T12:00:00+08:00";
      return { ...existing };
    },
    async delete(vbkAccountKey) {
      calls.push({ op: "delete", key: vbkAccountKey });
      snapshot.items = snapshot.items.filter((item) => item.vbkAccountKey !== vbkAccountKey);
      if (snapshot.activeVbkAccountKey === vbkAccountKey) snapshot.activeVbkAccountKey = null;
    },
  };
  return { remote, calls, setSnapshot: (next: VbkBindingsSnapshot) => { snapshot = next; } };
}

test("空远端会 claim 合法 vbk_* legacy，并整机只认领一次", async () => {
  const db = memoryDb();
  db.setSetting("accountFixedInfo:vbk_a", JSON.stringify({
    servicePhone: "400-111",
    butlerName: butler,
  }));
  db.setSetting("accountFixedInfo:小璐", JSON.stringify({
    servicePhone: "400-bad",
    butlerName: butler,
  }));
  const { remote, calls } = fakeRemote();
  const sync = createVbkBindingSync({
    remote,
    db,
    listLegacyFixedInfoKeys: () => ["vbk_a", "小璐"],
  });

  const snapshot = await sync.syncFromRemote(7);
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0]?.vbkAccountKey, "vbk_a");
  assert.equal(snapshot.items[0]?.servicePhone, "400-111");
  assert.deepEqual(snapshot.items[0]?.butler, butler);
  assert.ok(calls.some((c) => c.op === "upsert" && c.key === "vbk_a"));
  assert.ok(!calls.some((c) => c.op === "upsert" && c.key === "小璐"));
  assert.ok(db.getSetting("vbkBindingLegacyClaimDone"));
  assert.equal(db.getSetting("accountFixedInfo:7:vbk_a"), JSON.stringify({
    servicePhone: "400-111",
    butlerName: butler,
  }));
  assert.ok(db.getSetting("accountFixedInfo:vbk_a"));

  // 第二个空用户不再 claim（整机一次）
  const other = fakeRemote();
  const sync2 = createVbkBindingSync({
    remote: other.remote,
    db,
    listLegacyFixedInfoKeys: () => ["vbk_a"],
  });
  const snap2 = await sync2.syncFromRemote(8);
  assert.equal(snap2.items.length, 0);
  assert.ok(!other.calls.some((c) => c.op === "upsert"));
});

test("touchActive / saveFixedInfo 拒绝非 vbk_* 主键写远端", async () => {
  const db = memoryDb();
  const { remote, calls } = fakeRemote();
  const sync = createVbkBindingSync({ remote, db });

  await sync.touchActive(7, "小璐", { accountName: "小璐" });
  assert.ok(!calls.some((c) => c.op === "upsert" || c.op === "activate"));

  await sync.saveFixedInfo(7, "小璐", { servicePhone: "400-x" }, { accountName: "小璐" });
  assert.ok(!calls.some((c) => c.op === "upsert"));
  assert.ok(db.getSetting("accountFixedInfo:7:小璐"));
});

test("scoped get/save：有 userId 时读写 user 作用域缓存", async () => {
  const db = memoryDb();
  const { remote } = fakeRemote({
    items: [{
      vbkAccountKey: "vbk_a",
      vbkAccountName: "甲",
      servicePhone: "400-old",
      butler: null,
      updatedAt: "2026-08-20T00:00:00+08:00",
    }],
    activeVbkAccountKey: "vbk_a",
  });
  const sync = createVbkBindingSync({ remote, db });

  const saved = await sync.saveFixedInfo(7, "vbk_a", {
    servicePhone: "400-new",
    butlerName: butler,
  }, { accountName: "甲", providerId: 99 });
  assert.equal(saved.accountName, "vbk_a");
  assert.equal(saved.values.servicePhone, "400-new");
  assert.deepEqual(saved.values.butlerName, butler);
  assert.equal(db.getSetting("accountFixedInfo:7:vbk_a"), JSON.stringify({
    servicePhone: "400-new",
    butlerName: butler,
  }));

  const got = sync.getFixedInfo(7, "vbk_a");
  assert.deepEqual(got.values.servicePhone, "400-new");
  assert.deepEqual(got.values.butlerName, butler);
});

test("远端 updatedAt 更新时 remote wins，覆盖本地 dirty", async () => {
  const db = memoryDb();
  const notices: string[] = [];
  const failingRemote: TibetVbkBindingService = {
    async list() {
      return {
        items: [{
          vbkAccountKey: "vbk_a",
          vbkAccountName: "甲",
          servicePhone: "400-remote",
          butler: null,
          updatedAt: "2026-08-23T18:00:00+08:00",
        }],
        activeVbkAccountKey: "vbk_a",
      };
    },
    async upsert() { throw new Error("offline"); },
    async activate() { throw new Error("offline"); },
    async delete() { throw new Error("offline"); },
  };
  const sync = createVbkBindingSync({
    remote: failingRemote,
    db,
    onRemoteWins: ({ accountKey }) => { notices.push(accountKey); },
  });

  await sync.saveFixedInfo(7, "vbk_a", { servicePhone: "400-local" });
  assert.equal(sync.getFixedInfo(7, "vbk_a").values.servicePhone, "400-local");
  assert.ok(db.getSetting("accountFixedInfoDirty:7:vbk_a"));

  const online = fakeRemote({
    items: [{
      vbkAccountKey: "vbk_a",
      vbkAccountName: "甲",
      servicePhone: "400-remote",
      butler: null,
      updatedAt: "2026-08-23T18:00:00+08:00",
    }],
    activeVbkAccountKey: "vbk_a",
  });
  const sync2 = createVbkBindingSync({
    remote: online.remote,
    db,
    onRemoteWins: ({ accountKey }) => { notices.push(accountKey); },
  });
  // dirty 时间戳早于远端
  db.setSetting("accountFixedInfoDirty:7:vbk_a", "2026-08-23T10:00:00+08:00");

  await sync2.syncFromRemote(7);
  assert.equal(sync2.getFixedInfo(7, "vbk_a").values.servicePhone, "400-remote");
  assert.equal(db.getSetting("accountFixedInfoDirty:7:vbk_a"), undefined);
  assert.deepEqual(notices, ["vbk_a"]);
});

test("touchActive 调用 upsert + activate，并带上本地固定信息", async () => {
  const db = memoryDb();
  db.setSetting("accountFixedInfo:7:vbk_a", JSON.stringify({
    servicePhone: "400-x",
    butlerName: butler,
  }));
  const { remote, calls } = fakeRemote();
  const sync = createVbkBindingSync({ remote, db });

  await sync.touchActive(7, "vbk_a", { accountName: "甲", providerId: 42 });
  const upsert = calls.find((c) => c.op === "upsert" && c.key === "vbk_a");
  assert.ok(upsert);
  assert.equal(upsert?.patch?.vbkAccountName, "甲");
  assert.equal(upsert?.patch?.providerId, 42);
  assert.equal(upsert?.patch?.servicePhone, "400-x");
  assert.deepEqual(upsert?.patch?.butler, butler);
  assert.ok(calls.some((c) => c.op === "activate" && c.key === "vbk_a"));
});

test("touchActive 会把旧展示名缓存迁移到真实 VBK loginAccount", async () => {
  const db = memoryDb();
  db.setSetting("accountFixedInfo:7:唐璐&党荣", JSON.stringify({
    servicePhone: "0609068",
    butlerName: { contactCardId: 1351925, displayName: "安思科", providerId: 2806511 },
  }));
  const { remote, calls } = fakeRemote();
  const sync = createVbkBindingSync({ remote, db });

  await sync.touchActive(7, "vbk_2405770", {
    accountName: "唐璐&党荣",
    providerId: 2806511,
  });

  assert.equal(
    db.getSetting("accountFixedInfo:7:vbk_2405770"),
    db.getSetting("accountFixedInfo:7:唐璐&党荣"),
  );
  const upsert = calls.find((c) => c.op === "upsert" && c.key === "vbk_2405770");
  assert.equal(upsert?.patch?.providerId, 2806511);
  assert.deepEqual(upsert?.patch?.butler, {
    contactCardId: 1351925,
    displayName: "安思科",
    providerId: 2806511,
  });
});

test("restoreActiveVbk：有 cookie 则 switch，无 cookie 返回 missing-cookies", async () => {
  const db = memoryDb();
  const { remote } = fakeRemote();
  const sync = createVbkBindingSync({ remote, db });
  const snapshot: VbkBindingsSnapshot = {
    items: [{
      vbkAccountKey: "vbk_a",
      vbkAccountName: "甲",
      servicePhone: "",
      butler: null,
    }],
    activeVbkAccountKey: "vbk_a",
  };

  const switched: string[] = [];
  assert.equal(
    await sync.restoreActiveVbk(snapshot, () => true, async (key) => { switched.push(key); }),
    "switched",
  );
  assert.deepEqual(switched, ["vbk_a"]);

  assert.equal(
    await sync.restoreActiveVbk(snapshot, () => false, async () => { throw new Error("should not"); }),
    "missing-cookies",
  );

  assert.equal(
    await sync.restoreActiveVbk(
      { items: [], activeVbkAccountKey: null },
      () => true,
      async () => { throw new Error("should not"); },
    ),
    "none",
  );
});

test("无 extensionUserId 时 get/save 走 legacy key", async () => {
  const db = memoryDb();
  const { remote } = fakeRemote();
  const sync = createVbkBindingSync({ remote, db });
  const values: Partial<Record<"servicePhone" | "butlerName", AccountFixedInfoValue | null>> = {
    servicePhone: "400-legacy",
  };
  await sync.saveFixedInfo(null, "party_a", values);
  assert.equal(db.getSetting("accountFixedInfo:party_a"), JSON.stringify({ servicePhone: "400-legacy" }));
  assert.equal(sync.getFixedInfo(null, "party_a").values.servicePhone, "400-legacy");
});

test("有 extensionUserId 时 getFixedInfo 不回落 legacy（防跨用户串读）", () => {
  const db = memoryDb();
  db.setSetting("accountFixedInfo:vbk_a", JSON.stringify({ servicePhone: "400-other-user" }));
  const { remote } = fakeRemote();
  const sync = createVbkBindingSync({ remote, db });
  const got = sync.getFixedInfo(7, "vbk_a");
  assert.equal(got.accountName, "vbk_a");
  assert.deepEqual(got.values, {});
});
