import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";

// ───────────────────────── helpers ─────────────────────────

async function makeDb(): Promise<{ db: VbkDatabase; cleanup: () => void }> {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-test-provider-id-"));
  const db = new VbkDatabase(dataPath);
  return {
    db,
    cleanup: () => {
      try { fs.rmSync(dataPath, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// ───────────────────────── providerIdFor ─────────────────────────

test("providerIdFor: 未记录过的账号返回 null", async () => {
  const { db, cleanup } = await makeDb();
  try {
    assert.equal(db.providerIdFor("vbk_671205"), null);
    // 空字符串/null 也安全返回 null，不会抛错
    assert.equal(db.providerIdFor(""), null);
  } finally { cleanup(); }
});

test("providerIdFor: setProviderIdFor 后能查到", async () => {
  const { db, cleanup } = await makeDb();
  try {
    db.setProviderIdFor("vbk_671205", 12345);
    assert.equal(db.providerIdFor("vbk_671205"), 12345);
  } finally { cleanup(); }
});

test("providerIdFor: 不同账号互不干扰", async () => {
  const { db, cleanup } = await makeDb();
  try {
    db.setProviderIdFor("vbk_aaa", 100);
    db.setProviderIdFor("vbk_bbb", 200);
    assert.equal(db.providerIdFor("vbk_aaa"), 100);
    assert.equal(db.providerIdFor("vbk_bbb"), 200);
    assert.equal(db.providerIdFor("vbk_ccc"), null);
  } finally { cleanup(); }
});

// ───────────────────────── setProviderIdFor ─────────────────────────

test("setProviderIdFor: null 会清掉已存的 providerId", async () => {
  const { db, cleanup } = await makeDb();
  try {
    db.setProviderIdFor("vbk_x", 999);
    assert.equal(db.providerIdFor("vbk_x"), 999);
    db.setProviderIdFor("vbk_x", null);
    assert.equal(db.providerIdFor("vbk_x"), null);
  } finally { cleanup(); }
});

test("setProviderIdFor: 非法值（非正整数）会被忽略 / 清空", async () => {
  const { db, cleanup } = await makeDb();
  try {
    db.setProviderIdFor("vbk_x", -1);
    assert.equal(db.providerIdFor("vbk_x"), null, "负数应被丢弃");
    db.setProviderIdFor("vbk_x", 0);
    assert.equal(db.providerIdFor("vbk_x"), null, "0 应被丢弃");
    db.setProviderIdFor("vbk_x", 1.5);
    assert.equal(db.providerIdFor("vbk_x"), null, "小数应被丢弃");
    db.setProviderIdFor("vbk_x", 42);
    assert.equal(db.providerIdFor("vbk_x"), 42, "合法正整数应保留");
  } finally { cleanup(); }
});

test("setProviderIdFor: 空账号名直接 no-op，不会写 settings", async () => {
  const { db, cleanup } = await makeDb();
  try {
    db.setProviderIdFor("", 999);
    assert.equal(db.providerIdFor(""), null);
  } finally { cleanup(); }
});

// ───────────────────────── listKnownAccounts ─────────────────────────

test("listKnownAccounts: 没有账号历史时返回空数组", async () => {
  const { db, cleanup } = await makeDb();
  try {
    assert.deepEqual(db.listKnownAccounts(), []);
  } finally { cleanup(); }
});

test("listKnownAccounts: 当前 vbkAccountName 会被列出", async () => {
  const { db, cleanup } = await makeDb();
  try {
    db.setSetting("vbkAccountName", "vbk_current");
    const list = db.listKnownAccounts();
    const found = list.find((entry) => entry.accountName === "vbk_current");
    assert.ok(found, "current account listed");
    assert.equal(found!.providerId, undefined, "no providerId → undefined");
  } finally { cleanup(); }
});

test("listKnownAccounts: providerId 也能匹配到", async () => {
  const { db, cleanup } = await makeDb();
  try {
    db.setProviderIdFor("vbk_z", 55555);
    const list = db.listKnownAccounts();
    const found = list.find((entry) => entry.accountName === "vbk_z");
    assert.ok(found);
    assert.equal(found!.providerId, 55555);
  } finally { cleanup(); }
});

test("listKnownAccounts: 排序按 accountName 字典序，输出稳定", async () => {
  const { db, cleanup } = await makeDb();
  try {
    db.setProviderIdFor("vbk_zeta", 1);
    db.setProviderIdFor("vbk_alpha", 2);
    db.setProviderIdFor("vbk_mid", 3);
    const list = db.listKnownAccounts();
    assert.deepEqual(list.map((entry) => entry.accountName), ["vbk_alpha", "vbk_mid", "vbk_zeta"]);
  } finally { cleanup(); }
});

test("listKnownAccounts: 清掉 providerId 后只剩 accountName（需要 vbkAccountName 同时被记到）", async () => {
  const { db, cleanup } = await makeDb();
  try {
    // 仅以 providerIdByAccount 为来源的账号被清除后会被收回：
    // 这是有意为之，只提供从未在这里出现的虚拟账号会「泄露」。
    db.setProviderIdFor("vbk_orphan", 7777);
    db.setProviderIdFor("vbk_orphan", null);
    const list = db.listKnownAccounts();
    assert.equal(list.find((entry) => entry.accountName === "vbk_orphan"), undefined);

    // 但同时记为 vbkAccountName 的账号，被清除 providerId 后仍然在列表里。
    db.setSetting("vbkAccountName", "vbk_main");
    db.setProviderIdFor("vbk_main", 1234);
    db.setProviderIdFor("vbk_main", null);
    const list2 = db.listKnownAccounts();
    const found = list2.find((entry) => entry.accountName === "vbk_main");
    assert.ok(found);
    assert.equal(found!.providerId, undefined);
  } finally { cleanup(); }
});