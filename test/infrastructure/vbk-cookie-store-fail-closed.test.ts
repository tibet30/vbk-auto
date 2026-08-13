/**
 * Contract tests for the post-safeStorage VBK cookie persistence path.
 *
 * Two scenarios are covered:
 *
 *  - G-fail-closed: VbkBrowser must never read or decrypt legacy encrypted
 *    cookie blobs. We assert the LoginSessionStore wiring in main.ts only
 *    delegates to `cookieStore.*` (the new 0600 JSON store) and never
 *    queries `db.loadSession` / SQLite's `cookies_ciphertext` /
 *    `cookies_json`. Any presence of `safeStorage.*` / `Buffer.from(
 *    ...,  'base64')` roundtripped through `safeStorage.decryptString`
 *    indicates a regression.
 *
 *  - G-async-handled: VbkBrowser.saveCurrentSession awaits the underlying
 *    store, swallows store errors with a console.warn + returns null, and
 *    never throws upward. The two callers (addLogin / switchAccount) await
 *    saveCurrentSession so any rejection propagates to the IPC boundary,
 *    where Electron's `ipcMain.handle` translates it into a renderer
 *    promise rejection (which is the intended IPC/UI boundary contract).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const mainSource = readFileSync(new URL("../../src/main/main.ts", import.meta.url), "utf8");
const createWindowSource = readFileSync(new URL("../../src/main/create-window.ts", import.meta.url), "utf8");
const browserSource = readFileSync(new URL("../../src/main/infrastructure/vbk-browser.ts", import.meta.url), "utf8");
const cookieStoreSource = readFileSync(new URL("../../src/main/infrastructure/vbk-cookie-store.ts", import.meta.url), "utf8");

test("production code never imports electron.safeStorage", () => {
  // Both main.ts and vbk-browser.ts must avoid the unsafe API entirely.
  assert.doesNotMatch(mainSource, /from\s+["']electron["'][^;]*safeStorage/, "main.ts must not import safeStorage");
  assert.doesNotMatch(browserSource, /from\s+["']electron["'][^;]*safeStorage/, "vbk-browser.ts must not import safeStorage");
  assert.doesNotMatch(mainSource, /safeStorage\./, "main.ts must not call safeStorage.* APIs");
  assert.doesNotMatch(browserSource, /safeStorage\./, "vbk-browser.ts must not call safeStorage.* APIs");
});

test("production code never references the obsolete secure-storage adapter", () => {
  // `secure-storage.ts` has been removed; any remaining reference would
  // break the build because the module no longer exists.
  for (const source of [mainSource, createWindowSource, browserSource, cookieStoreSource]) {
    assert.doesNotMatch(source, /from\s+["'][^"']*secure-storage[^"']*["']/);
    assert.doesNotMatch(source, /encryptString|decryptString|isProbablyEncrypted|encryptApiKey|decryptApiKey|isAsyncEncryptionAvailable|persistApiKeyAsync|loadApiKeyAsync/);
  }
});

test("cookie store module is pure fs (no Electron / SQLite / safeStorage)", () => {
  assert.doesNotMatch(cookieStoreSource, /from\s+["']electron["']/);
  assert.doesNotMatch(cookieStoreSource, /from\s+["']better-sqlite3["']/);
  assert.doesNotMatch(cookieStoreSource, /Database\.Database/);
  assert.doesNotMatch(cookieStoreSource, /safeStorage/);
});

test("create-window.ts wires VbkBrowser through cookieStore only (fail-closed legacy)", () => {
  // The VbkBrowser wiring inside createWindow() must only forward to
  // cookieStore.* — never to db.loadSession / db.saveSession /
  // safeStorage. We slice from the wiring block to the closing }) of
  // the VbkBrowser constructor.
  const wiringStart = createWindowSource.indexOf("const browser = new VbkBrowser(");
  const wiringEnd = createWindowSource.indexOf("await browser.initialise();", wiringStart);
  assert.ok(wiringStart > 0, "VbkBrowser wiring must exist");
  assert.ok(wiringEnd > wiringStart, "wiring must have a closing brace");
  const wiring = createWindowSource.slice(wiringStart, wiringEnd);

  // saveSession wiring must go through cookieStore. 生产代码里通常用一个
  // 已收窄的本地别名（`sessions` / `cookieStore!` 等），所以这里用宽松的
  // 正则允许两种命名。
  const SAVE_RE = /(?:sessions|cookieStore)\.saveSession\(/;
  const LOAD_RE = /(?:sessions|cookieStore)\.loadSession\(/;
  const LIST_RE = /(?:sessions|cookieStore)\.listSessions\(\)/;
  const DEL_RE = /(?:sessions|cookieStore)\.deleteSession\(/;
  assert.match(wiring, SAVE_RE, "saveSession must forward to cookieStore.saveSession");
  assert.match(wiring, LOAD_RE, "loadSession must forward to cookieStore.loadSession");
  assert.match(wiring, LIST_RE, "listSessions must forward to cookieStore.listSessions");
  assert.match(wiring, DEL_RE, "deleteSession must forward to cookieStore.deleteSession");

  // Wiring must NOT touch SQLite cookie reads / writes / safeStorage.
  assert.doesNotMatch(wiring, /db\.(saveSession|loadSession|listSessions|deleteSession)\(/, "wiring must not call db cookie methods");
  assert.doesNotMatch(wiring, /safeStorage/, "wiring must not mention safeStorage");
  assert.doesNotMatch(wiring, /cookies_ciphertext|cookies_json/, "wiring must not reference legacy encrypted columns");
});

test("vbk-browser.saveCurrentSession awaits store saveSession and catches errors", () => {
  const saveCurrentSession = browserSource.slice(
    browserSource.indexOf("  async saveCurrentSession()"),
    browserSource.indexOf("  /**\n   * \"新增登录\""),
  );
  // Must await the store's saveSession (via Promise.resolve to be safe
  // for both sync and async implementations).
  assert.match(saveCurrentSession, /await\s+Promise\.resolve\(this\.sessionStore\.saveSession\(/);
  // Must catch and return null so the method never throws upward.
  // Allow arbitrary whitespace between try / await / saveSession / catch.
  assert.match(saveCurrentSession, /try\s*\{[^}]*await[\s\S]*?saveSession[\s\S]*?\}\s*catch\s*\(/);
  assert.match(saveCurrentSession, /return null;/, "saveCurrentSession must return null on store failure");
});

test("VbkBrowser.saveCurrentSession / addLogin / switchAccount propagate errors at IPC boundary", () => {
  // addLogin and switchAccount both await saveCurrentSession. If save
  // throws, the rejection propagates to the IPC handler that called them,
  // which is the documented IPC/UI boundary contract.
  const addLogin = browserSource.slice(
    browserSource.indexOf("  async addLogin()"),
    browserSource.indexOf("  /**\n   * 切换"),
  );
  const switchAccount = browserSource.slice(
    browserSource.indexOf("  async switchAccount("),
    browserSource.indexOf("  /**\n   * 忘记"),
  );
  assert.match(addLogin, /await this\.saveCurrentSession\(\);/, "addLogin must await saveCurrentSession");
  assert.match(switchAccount, /await this\.saveCurrentSession\(\);/, "switchAccount must await saveCurrentSession");
});

test("withKnownVbkAccount save-promise has .catch handler (no unhandled rejection)", () => {
  const withKnown = mainSource.slice(
    mainSource.indexOf("function withKnownVbkAccount"),
    mainSource.indexOf("/**\n * 计算产品 readiness"),
  );
  // The saveCurrentSession chain must end with .catch(...) so that any
  // rejection becomes a warn log instead of an unhandled promise
  // rejection in the Electron main process.
  assert.match(withKnown, /browser\.saveCurrentSession\(\)/);
  // logWarn / console.warn 都会被认作可观测 warn 出口。
  assert.match(withKnown, /\.catch\(\s*\(\s*error\s*\)\s*=>\s*\{[\s\S]*(console\.warn|logWarn)/);
});
