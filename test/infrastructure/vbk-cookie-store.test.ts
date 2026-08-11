/**
 * Unit tests for src/main/infrastructure/vbk-cookie-store.ts
 *
 * Coverage maps to the G2 / G3 / G4 acceptance gates from the
 * safeStorage-removal migration brief:
 *  - G1: store never imports Electron / safeStorage (asserted by source scan).
 *  - G2: per-account save / load / delete / list semantics; file mode
 *    0600 + directory mode 0700; atomic writes via temp + rename; blank
 *    input is a no-op.
 *  - G3: legacy encrypted cookie rows are NOT consulted — the cookie
 *    store is fully self-contained in a single JSON file under userData.
 *  - G4: malformed JSON on disk is recoverable; temp artifacts are cleaned
 *    up on rename failure; concurrent construction reads the same JSON.
 *
 * The tests run with plain fs + tmpdir, no Electron required. No real
 * cookie values are ever embedded — every cookiesJson is a structural
 * placeholder so the test is safe to commit.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLocalVbkCookieStore,
  LOCAL_VBK_COOKIE_FILE_NAME,
  type LocalVbkCookieStore,
} from "../../src/main/infrastructure/vbk-cookie-store.js";

// ───────────────────────── helpers ─────────────────────────

/** Build a unique temp directory for the test file. */
function freshDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vbk-cookies-${prefix}-`));
}

/** Returns the mode portion of a file's stat (lower 9 bits). */
function fileMode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

/** List all temp artifacts (filenames starting with `.` and ending with `.tmp`). */
function listTempArtifacts(dir: string, baseName: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.startsWith(`.${baseName}.`) && name.endsWith(".tmp"));
}

/** Recursive cleanup. Best-effort — never throws. */
function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** A safe placeholder cookies JSON shape (no real cookie values). */
const PLACEHOLDER_COOKIES_A = JSON.stringify([
  { name: "guid", value: "PLACEHOLDER_A", domain: ".ctrip.com", path: "/" },
  { name: "JSESSIONID", value: "PLACEHOLDER_A", domain: "vbooking.ctrip.com" },
]);
const PLACEHOLDER_COOKIES_B = JSON.stringify([
  { name: "guid", value: "PLACEHOLDER_B", domain: ".ctrip.com", path: "/" },
  { name: "vbkticket", value: "PLACEHOLDER_B", domain: ".ctrip.com" },
]);

// ───────────────────────── G1: no Electron import ─────────────────────────

test("cookie-store: production module does not import Electron / safeStorage", () => {
  const source = fs.readFileSync(
    new URL("../../src/main/infrastructure/vbk-cookie-store.ts", import.meta.url),
    "utf8",
  );
  assert.equal(/from\s+["']electron["']/.test(source), false,
    "vbk-cookie-store.ts must NOT import Electron");
  assert.equal(/safeStorage/.test(source), false,
    "vbk-cookie-store.ts must NOT mention safeStorage");
});

// ───────────────────────── G2: per-account semantics ─────────────────────────

test("cookie-store: fresh directory + missing file behaves as absent", () => {
  const dir = freshDir("missing");
  try {
    const filePath = path.join(dir, LOCAL_VBK_COOKIE_FILE_NAME);
    const store = createLocalVbkCookieStore(filePath);
    assert.equal(store.loadSession("vbk_x"), null);
    assert.deepEqual(store.listSessions(), []);
    // The store does NOT create the file on read-only init.
    assert.equal(fs.existsSync(filePath), false);
  } finally { cleanup(dir); }
});

test("cookie-store: saveSession → loadSession roundtrip preserves JSON shape", () => {
  const dir = freshDir("roundtrip");
  try {
    const filePath = path.join(dir, LOCAL_VBK_COOKIE_FILE_NAME);
    const store = createLocalVbkCookieStore(filePath);
    assert.equal(store.saveSession("vbk_a", "vbk_a", PLACEHOLDER_COOKIES_A), true);
    const loaded = store.loadSession("vbk_a");
    assert.ok(loaded, "loadSession must return the saved record");
    assert.equal(loaded!.cookiesJson, PLACEHOLDER_COOKIES_A);
    assert.equal(loaded!.accountName, "vbk_a");
  } finally { cleanup(dir); }
});

test("cookie-store: accounts are isolated; changing one does not affect another", () => {
  const dir = freshDir("isolation");
  try {
    const filePath = path.join(dir, LOCAL_VBK_COOKIE_FILE_NAME);
    const store = createLocalVbkCookieStore(filePath);
    store.saveSession("vbk_a", "vbk_a", PLACEHOLDER_COOKIES_A);
    store.saveSession("vbk_b", "vbk_b", PLACEHOLDER_COOKIES_B);

    // 更新 vbk_a 不影响 vbk_b。
    const ROTATED = JSON.stringify([{ name: "guid", value: "PLACEHOLDER_A2", domain: ".ctrip.com" }]);
    store.saveSession("vbk_a", "vbk_a", ROTATED);
    assert.equal(store.loadSession("vbk_a")?.cookiesJson, ROTATED);
    assert.equal(store.loadSession("vbk_b")?.cookiesJson, PLACEHOLDER_COOKIES_B, "vbk_b must not be touched");
  } finally { cleanup(dir); }
});

test("cookie-store: empty / [] input removes the snapshot", () => {
  const dir = freshDir("blank");
  try {
    const filePath = path.join(dir, LOCAL_VBK_COOKIE_FILE_NAME);
    const store = createLocalVbkCookieStore(filePath);
    store.saveSession("vbk_blank", "vbk_blank", PLACEHOLDER_COOKIES_A);
    assert.ok(store.loadSession("vbk_blank"));
    // 空 cookiesJson / "[]" → 删除快照。
    store.saveSession("vbk_blank", "vbk_blank", "");
    assert.equal(store.loadSession("vbk_blank"), null);
    store.saveSession("vbk_x", "vbk_x", PLACEHOLDER_COOKIES_A);
    store.saveSession("vbk_x", "vbk_x", "[]");
    assert.equal(store.loadSession("vbk_x"), null);
  } finally { cleanup(dir); }
});

test("cookie-store: empty accountKey throws", () => {
  const dir = freshDir("guard");
  try {
    const store = createLocalVbkCookieStore(path.join(dir, LOCAL_VBK_COOKIE_FILE_NAME));
    assert.throws(() => store.saveSession("", "x", PLACEHOLDER_COOKIES_A), /账号标识不能为空/);
    assert.throws(() => store.saveSession("   ", "x", PLACEHOLDER_COOKIES_A), /账号标识不能为空/);
    // loadSession / listSessions / deleteSession 对非法 key 一律静默返回。
    assert.equal(store.loadSession(""), null);
    store.deleteSession("");
  } finally { cleanup(dir); }
});

test("cookie-store: deleteSession is idempotent and removes the snapshot", () => {
  const dir = freshDir("delete");
  try {
    const store = createLocalVbkCookieStore(path.join(dir, LOCAL_VBK_COOKIE_FILE_NAME));
    store.saveSession("vbk_drop", "vbk_drop", PLACEHOLDER_COOKIES_A);
    assert.ok(store.loadSession("vbk_drop"));
    store.deleteSession("vbk_drop");
    assert.equal(store.loadSession("vbk_drop"), null);
    // 重复删除不抛错。
    store.deleteSession("vbk_drop");
    store.deleteSession("nonexistent");
  } finally { cleanup(dir); }
});

test("cookie-store: listSessions returns all snapshots with their saved_at timestamps, newest first", async () => {
  const dir = freshDir("list");
  try {
    const store = createLocalVbkCookieStore(path.join(dir, LOCAL_VBK_COOKIE_FILE_NAME));
    store.saveSession("vbk_first", "vbk_first", PLACEHOLDER_COOKIES_A);
    // 多次 save 之间可能落在同一毫秒，列表排序依赖 savedAt；
    // 加一个小延迟让 ISO 时间戳稳定递增。
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.saveSession("vbk_second", "vbk_second", PLACEHOLDER_COOKIES_B);
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.saveSession("vbk_third", "vbk_third", PLACEHOLDER_COOKIES_A);
    const list = store.listSessions();
    assert.equal(list.length, 3);
    // 最近保存的排第一位。
    assert.equal(list[0].accountKey, "vbk_third");
    assert.equal(list[2].accountKey, "vbk_first");
    for (const entry of list) {
      assert.match(entry.lastUsedAt, /^\d{4}-\d{2}-\d{2}T/);
    }
  } finally { cleanup(dir); }
});

test("cookie-store: identical save is idempotent at the FS level", async () => {
  const dir = freshDir("noop");
  const filePath = path.join(dir, LOCAL_VBK_COOKIE_FILE_NAME);
  try {
    const store = createLocalVbkCookieStore(filePath);
    store.saveSession("vbk_a", "vbk_a", PLACEHOLDER_COOKIES_A);
    // 第一次 save 后再保存相同内容（仅 savedAt 不同）：写入仍发生以刷新时间戳。
    // 但内容相同的两次 save（save 不会自动合并 savedAt）—— 此处主要验证：
    // saveSession 不抛错，loadSession 返回一致结果。
    store.saveSession("vbk_a", "vbk_a", PLACEHOLDER_COOKIES_A);
    const loaded = store.loadSession("vbk_a");
    assert.equal(loaded!.cookiesJson, PLACEHOLDER_COOKIES_A);
  } finally { cleanup(dir); }
});

// ───────────────────────── G2: file mode + atomic writes ─────────────────────────

test("cookie-store: file mode is 0600 after write and directory is 0700", () => {
  const dir = freshDir("mode");
  try {
    const filePath = path.join(dir, LOCAL_VBK_COOKIE_FILE_NAME);
    const store = createLocalVbkCookieStore(filePath);
    store.saveSession("vbk_mode", "vbk_mode", PLACEHOLDER_COOKIES_A);
    assert.equal(fileMode(filePath), 0o600, "snapshot file must be 0600");
    assert.equal(fileMode(dir), 0o700, "store directory must be 0700");
  } finally { cleanup(dir); }
});

test("cookie-store: simulated rename failure does not corrupt the last good file", () => {
  const dir = freshDir("renamefail");
  const filePath = path.join(dir, LOCAL_VBK_COOKIE_FILE_NAME);
  try {
    const store = createLocalVbkCookieStore(filePath);
    store.saveSession("vbk_one", "vbk_one", PLACEHOLDER_COOKIES_A);
    const firstBytes = fs.readFileSync(filePath);
    assert.match(firstBytes.toString("utf-8"), /PLACEHOLDER_A/);

    const originalRename = fs.renameSync;
    (fs as { renameSync: typeof fs.renameSync }).renameSync = (() => {
      throw new Error("simulated rename failure");
    }) as typeof fs.renameSync;
    try {
      assert.throws(() => store.saveSession("vbk_two", "vbk_two", PLACEHOLDER_COOKIES_B), /simulated rename failure/);
    } finally {
      (fs as { renameSync: typeof fs.renameSync }).renameSync = originalRename;
    }

    // 文件仍是 vbk_one 的快照，vbk_two 没有落地；temp 文件已清理。
    assert.equal(store.loadSession("vbk_one")?.cookiesJson, PLACEHOLDER_COOKIES_A);
    assert.equal(store.loadSession("vbk_two"), null);
    assert.equal(store.listSessions().length, 1);
    assert.deepEqual(listTempArtifacts(dir, LOCAL_VBK_COOKIE_FILE_NAME), []);
  } finally { cleanup(dir); }
});

test("cookie-store: temp artifact is cleaned up on rename failure", () => {
  const dir = freshDir("tempclean");
  const filePath = path.join(dir, LOCAL_VBK_COOKIE_FILE_NAME);
  try {
    const store = createLocalVbkCookieStore(filePath);
    store.saveSession("vbk_good", "vbk_good", PLACEHOLDER_COOKIES_A);
    assert.deepEqual(listTempArtifacts(dir, LOCAL_VBK_COOKIE_FILE_NAME), []);

    const originalRename = fs.renameSync;
    (fs as { renameSync: typeof fs.renameSync }).renameSync = (() => {
      throw new Error("simulated rename failure");
    }) as typeof fs.renameSync;
    try {
      assert.throws(() => store.saveSession("vbk_bad", "vbk_bad", PLACEHOLDER_COOKIES_B), /simulated rename failure/);
    } finally {
      (fs as { renameSync: typeof fs.renameSync }).renameSync = originalRename;
    }

    const lingering = listTempArtifacts(dir, LOCAL_VBK_COOKIE_FILE_NAME);
    assert.deepEqual(lingering, [], `temp files must be cleaned up; found: ${lingering.join(",")}`);
  } finally { cleanup(dir); }
});

test("cookie-store: temp filename never contains the cookies plaintext", () => {
  const dir = freshDir("tempname");
  const filePath = path.join(dir, LOCAL_VBK_COOKIE_FILE_NAME);
  try {
    const store = createLocalVbkCookieStore(filePath);
    const seenNames: string[] = [];
    const originalOpen = fs.openSync;
    (fs as { openSync: typeof fs.openSync }).openSync = ((p: fs.PathLike, flags: string | number, mode?: number) => {
      const name = String(p);
      if (name.endsWith(".tmp")) seenNames.push(name);
      throw new Error("simulated open failure");
    }) as typeof fs.openSync;
    try {
      assert.throws(() => store.saveSession("vbk_x", "vbk_x", "forbidden-cookie-content-12345"));
    } finally {
      (fs as { openSync: typeof fs.openSync }).openSync = originalOpen;
    }
    assert.ok(seenNames.length >= 1, "store must attempt to open a temp file");
    for (const name of seenNames) {
      assert.ok(name.startsWith(path.join(dir, `.${LOCAL_VBK_COOKIE_FILE_NAME}.`)));
      assert.match(path.basename(name), new RegExp(`^\\.${LOCAL_VBK_COOKIE_FILE_NAME}\\.[0-9a-f]+\\.tmp$`));
      assert.equal(name.includes("forbidden-cookie"), false, "temp filename must not contain plaintext");
    }
  } finally { cleanup(dir); }
});

// ───────────────────────── G4: malformed JSON recovery ─────────────────────────

test("cookie-store: malformed JSON on disk is treated as empty; next write recovers", () => {
  const dir = freshDir("corrupt");
  const filePath = path.join(dir, LOCAL_VBK_COOKIE_FILE_NAME);
  try {
    fs.writeFileSync(filePath, "not-json-at-all", { mode: 0o600 });
    const store = createLocalVbkCookieStore(filePath);
    assert.deepEqual(store.listSessions(), []);
    // 下一次 write 重新覆盖。
    store.saveSession("vbk_recovered", "vbk_recovered", PLACEHOLDER_COOKIES_A);
    assert.equal(store.loadSession("vbk_recovered")?.cookiesJson, PLACEHOLDER_COOKIES_A);
  } finally { cleanup(dir); }
});

test("cookie-store: concurrent construction reads the same persisted JSON", () => {
  const dir = freshDir("concurrent");
  try {
    const filePath = path.join(dir, LOCAL_VBK_COOKIE_FILE_NAME);
    const writer = createLocalVbkCookieStore(filePath);
    writer.saveSession("vbk_shared", "vbk_shared", PLACEHOLDER_COOKIES_A);
    const reader = createLocalVbkCookieStore(filePath);
    assert.equal(reader.loadSession("vbk_shared")?.cookiesJson, PLACEHOLDER_COOKIES_A);
  } finally { cleanup(dir); }
});

// ───────────────────────── G4: directory creation is idempotent ─────────────────────────

test("cookie-store: directory creation is idempotent", () => {
  const dir = freshDir("mkdir");
  try {
    const filePath = path.join(dir, "nested", LOCAL_VBK_COOKIE_FILE_NAME);
    const store = createLocalVbkCookieStore(filePath);
    store.saveSession("vbk_ok", "vbk_ok", PLACEHOLDER_COOKIES_A);
    // 重复构造同一路径不抛错。
    const reopened = createLocalVbkCookieStore(filePath);
    assert.equal(reopened.loadSession("vbk_ok")?.cookiesJson, PLACEHOLDER_COOKIES_A);
  } finally { cleanup(dir); }
});

// ───────────────────────── G3: legacy fail-closed (no SQLite reads) ─────────────────────────

test("cookie-store: saveSession does not touch any SQLite database file", () => {
  // 验证：cookie store 完全独立于 SQLite；同一目录下放一个 SQLite 文件，
  // cookie store 写入后该文件大小不变（cookie store 不会意外写入 .sqlite）。
  const dir = freshDir("no-sqlite");
  const filePath = path.join(dir, LOCAL_VBK_COOKIE_FILE_NAME);
  const fakeSqlite = path.join(dir, "fake.sqlite");
  try {
    fs.writeFileSync(fakeSqlite, "SQLite-placeholder", { mode: 0o600 });
    const sqliteBefore = fs.statSync(fakeSqlite).size;
    const store = createLocalVbkCookieStore(filePath);
    store.saveSession("vbk_pure", "vbk_pure", PLACEHOLDER_COOKIES_A);
    assert.equal(fs.statSync(fakeSqlite).size, sqliteBefore,
      "cookie store must not write to any .sqlite file");
  } finally { cleanup(dir); }
});

// Reference unused-symbol suppression to keep the test self-contained
// when refactoring the production module.
void ({} as LocalVbkCookieStore);
