/**
 * Legacy-fail-closed contract tests for the safeStorage removal.
 *
 * 这组测试断言：
 *  - G3 (legacy encrypted snapshot fails closed): cookie store 完全不读
 *    SQLite，因此「旧 login_sessions 表里残留的 cookies_ciphertext /
 *    cookies_json 历史密文」对新代码不可见；用户必须重新登录；
 *  - G4 (async store rejection handled at session boundary):
 *    VbkBrowser.saveCurrentSession 必须捕获底层 cookie store 抛出的
 *    任何异常（磁盘满、权限被改、JSON 损坏等），把错误降级为 console.warn
 *    + 返回 null，绝不让 IPC / UI 边界看到 unhandled promise rejection。
 *
 * 不 import Electron / safeStorage：测试仅 fs + 源码静态扫描 + 一个 mock
 * cookie store，与生产路径同形但避免运行时依赖。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLocalVbkCookieStore,
  LOCAL_VBK_COOKIE_FILE_NAME,
} from "../../src/main/infrastructure/vbk-cookie-store.js";
import Database from "better-sqlite3";

// ───────────────────────── helpers ─────────────────────────

function freshDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vbk-cookies-legacy-${prefix}-`));
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const PLACEHOLDER_COOKIES = JSON.stringify([
  { name: "guid", value: "PLACEHOLDER", domain: ".ctrip.com" },
]);

// ───────────────────────── G3: legacy fail-closed ─────────────────────────

test("legacy fail-closed: cookie store 完全不读 SQLite，遗留密文被无视", () => {
  const dir = freshDir("sqlite-ignored");
  try {
    const cookieFilePath = path.join(dir, LOCAL_VBK_COOKIE_FILE_NAME);
    const sqliteFilePath = path.join(dir, "vbk-desktop.sqlite");

    // 1. 构造一个「旧版数据库」：含 login_sessions 表 + cookies_ciphertext / cookies_json 列，
    //    并在其中插入历史 safeStorage 加密后的行。
    const sqlite = new Database(sqliteFilePath);
    sqlite.exec(`
      CREATE TABLE login_sessions (
        account_key TEXT PRIMARY KEY,
        account_name TEXT NOT NULL,
        cookies_json TEXT NOT NULL,
        saved_at TEXT NOT NULL
      )
    `);
    sqlite.exec(`ALTER TABLE login_sessions ADD COLUMN cookies_ciphertext TEXT`);
    sqlite
      .prepare(
        `INSERT INTO login_sessions(account_key, account_name, cookies_json, cookies_ciphertext, saved_at)
         VALUES(?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy_vbk_x",
        "legacy_vbk_x",
        // 历史「明文回退列」残留（0006 之前可能存在）
        "[{\"name\":\"guid\",\"value\":\"PLAINTEXT_LEAK\"}]",
        // 历史 safeStorage base64 密文
        "AAAAaaaaXXXXxxxxQQQQqqqqZZZZzzzz1111aaaa2222bbbb3333cccc4444dddd",
        "2024-01-01T00:00:00.000Z",
      );
    sqlite.close();

    // 2. 创建 cookie store。同目录下有 SQLite 文件 + cookie 文件不存在。
    const store = createLocalVbkCookieStore(cookieFilePath);

    // 3. cookie store 必须返回 0 个 sessions —— 它从不读 SQLite。
    assert.deepEqual(store.listSessions(), []);
    assert.equal(store.loadSession("legacy_vbk_x"), null);

    // 4. 在 cookie store 里写入新会话，旧 SQLite 数据仍然被无视。
    store.saveSession("new_vbk_y", "new_vbk_y", PLACEHOLDER_COOKIES);
    assert.deepEqual(store.listSessions().map((s) => s.accountKey), ["new_vbk_y"]);
    assert.equal(store.loadSession("legacy_vbk_x"), null,
      "legacy_vbk_x must remain invisible even after a new save");
  } finally { cleanup(dir); }
});

test("legacy fail-closed: cookie store 写入后不会创建或修改 .sqlite 文件", () => {
  const dir = freshDir("no-sqlite-write");
  try {
    const cookieFilePath = path.join(dir, LOCAL_VBK_COOKIE_FILE_NAME);
    const sqliteFilePath = path.join(dir, "vbk-desktop.sqlite");

    // 预置一个 SQLite 文件，cookie store 不应触碰它。
    fs.writeFileSync(sqliteFilePath, "SQLite-placeholder", { mode: 0o600 });
    const sqliteBefore = fs.statSync(sqliteFilePath).size;

    const store = createLocalVbkCookieStore(cookieFilePath);
    store.saveSession("vbk_pure", "vbk_pure", PLACEHOLDER_COOKIES);

    // SQLite 文件大小不变（cookie store 既不读也不写 SQLite）。
    assert.equal(fs.statSync(sqliteFilePath).size, sqliteBefore,
      "cookie store must not touch any .sqlite file");
  } finally { cleanup(dir); }
});

// ───────────────────────── G4: async store rejection handled at session boundary ─────────────────────────

test("VbkBrowser.saveCurrentSession: cookie store 抛错时被 try/catch 捕获，函数返回 null", () => {
  const source = fs.readFileSync(
    new URL("../../src/main/infrastructure/vbk-browser.ts", import.meta.url),
    "utf8",
  );
  // 必须包在 try / catch 里，catch 里 console.warn + return null，
  // 不让错误冒泡到 IPC handler。
  const saveCurrentSession = source.slice(
    source.indexOf("async saveCurrentSession()"),
    source.indexOf("  /**\n   * \"新增登录\""),
  );
  assert.match(saveCurrentSession, /try\s*\{/);
  assert.match(saveCurrentSession, /catch\s*\(/);
  assert.match(saveCurrentSession, /console\.warn/);
  assert.match(saveCurrentSession, /return null/);
  // 必须 await Promise.resolve(sessionStore.saveSession(...)) —— 契约的一部分。
  assert.match(saveCurrentSession, /await\s+Promise\.resolve\(\s*this\.sessionStore\.saveSession\(/);
});

test("withKnownVbkAccount in main.ts: saveCurrentSession 抛错被 .catch 捕获，绝不形成 unhandled rejection", () => {
  // 静态契约：调用方在 fire-and-forget 路径上必须显式 .catch(...)，
  // 防止 fs 错误变成 unhandled promise rejection。
  const mainSource = fs.readFileSync(
    new URL("../../src/main/main.ts", import.meta.url),
    "utf8",
  );
  // 必须在 browser 存在时直接 .saveCurrentSession().then(...).catch(...) 调用，
  // 且先做 browser 判空避免 TypeError。任意写法退化都会让 unhandled rejection
  // 重新出现。
  const withKnown = mainSource.slice(
    mainSource.indexOf("function withKnownVbkAccount"),
    mainSource.indexOf("/**\n * 计算项目 readiness"),
  );
  assert.match(withKnown, /browser\.saveCurrentSession\(\)/);
  assert.match(withKnown, /\.then\(\(saved\)/);
  assert.match(withKnown, /\.catch\(\(error\)/);
  assert.match(withKnown, /console\.warn/);
  // 不允许 `void browser?.saveCurrentSession().then(...)` —— 这种写法在 browser
  // 为 undefined 时会同步抛 TypeError，且不会被 .catch 捕获。
  assert.equal(/void\s+browser\?\.saveCurrentSession/.test(withKnown), false,
    "withKnownVbkAccount must not use void browser?.saveCurrentSession() — that pattern yields a synchronous TypeError when browser is undefined");
});

// ───────────────────────── G3+G4: production source must not read legacy columns ─────────────────────────

test("main.ts: 不再以 SQL 语句引用 cookies_ciphertext / cookies_json 列", () => {
  const mainSource = fs.readFileSync(
    new URL("../../src/main/main.ts", import.meta.url),
    "utf8",
  );
  // fail-closed 的静态保证：源码里不能出现包含这两个列名的字符串字面量
  // （SQL 拼装 / better-sqlite3 prepare 参数）。仅文档注释里的引用是允许的，
  // 它们解释「为什么这里不再读写旧列」。
  assert.equal(/["'`].*cookies_ciphertext/.test(mainSource), false,
    "main.ts must not have a SQL literal containing cookies_ciphertext");
  assert.equal(/["'`].*cookies_json/.test(mainSource), false,
    "main.ts must not have a SQL literal containing cookies_json");
  // db.prepare / db.exec 周围不应出现旧列名。
  assert.equal(/prepare\([^)]*cookies_ciphertext/.test(mainSource), false,
    "main.ts must not prepare a SQL statement referencing cookies_ciphertext");
  assert.equal(/prepare\([^)]*cookies_json/.test(mainSource), false,
    "main.ts must not prepare a SQL statement referencing cookies_json");
});

test("vbk-browser.ts: 不再以 SQL 语句引用 cookies_ciphertext / cookies_json 列", () => {
  const source = fs.readFileSync(
    new URL("../../src/main/infrastructure/vbk-browser.ts", import.meta.url),
    "utf8",
  );
  assert.equal(/["'`].*cookies_ciphertext/.test(source), false,
    "vbk-browser.ts must not have a SQL literal containing cookies_ciphertext");
  assert.equal(/["'`].*cookies_json/.test(source), false,
    "vbk-browser.ts must not have a SQL literal containing cookies_json");
  assert.equal(/prepare\([^)]*cookies_ciphertext/.test(source), false,
    "vbk-browser.ts must not prepare a SQL statement referencing cookies_ciphertext");
  assert.equal(/prepare\([^)]*cookies_json/.test(source), false,
    "vbk-browser.ts must not prepare a SQL statement referencing cookies_json");
});
