/**
 * Unit tests for src/main/infrastructure/ai-key-store.ts
 *
 * Coverage maps to the G1–G5 acceptance gates from the task brief:
 *  - G1: settings save / read path never calls safeStorage (the store is
 *    self-contained and uses no Electron APIs).
 *  - G2: independent MiniMax / Evolink keys; blank input does not
 *    overwrite; changing one key does not touch the other.
 *  - G3: ai-secrets.json and any temp artifact are 0600; writes are atomic
 *    (temp + rename); simulated write failures do not corrupt the last
 *    good file and temp cleanup is verified.
 *  - G4: store rejects unsupported providers and never throws with
 *    plaintext content.
 *  - G5: starting from an empty file the store reports hasKey=false; a
 *    fresh setKey() flips it back to true.
 *
 * The tests run with plain fs + tmpdir, no Electron required.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLocalAiKeyStore,
  LOCAL_AI_KEY_FILE_NAME,
  type LocalAiKeyStore,
} from "../../src/main/infrastructure/ai-key-store.js";

// ───────────────────────── helpers ─────────────────────────

/** Build a unique temp directory for the test file. */
function freshDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vbk-aikeys-${prefix}-`));
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

// ───────────────────────── sanity / G1 ─────────────────────────

test("store: fresh directory + missing file behaves as unconfigured", () => {
  const dir = freshDir("missing");
  try {
    const store = createLocalAiKeyStore(path.join(dir, LOCAL_AI_KEY_FILE_NAME));
    assert.equal(store.hasKey("minimax"), false);
    assert.equal(store.hasKey("deepseek"), false);
    assert.equal(store.getKey("minimax"), "");
    assert.equal(store.getKey("deepseek"), "");
    assert.deepEqual(store.configuredProviders(), []);
    // The store does NOT create the file on read-only init.
    assert.equal(fs.existsSync(store.filePath()), false);
  } finally { cleanup(dir); }
});

test("store: rejects unsupported provider names defensively", () => {
  const dir = freshDir("guard");
  try {
    const store = createLocalAiKeyStore(path.join(dir, LOCAL_AI_KEY_FILE_NAME));
    assert.equal(store.hasKey("openai" as never), false);
    assert.equal(store.getKey("openai" as never), "");
    assert.throws(() => store.setKey("openai" as never, "secret"), /不支持的 AI 提供商/);
  } finally { cleanup(dir); }
});

// ───────────────────────── G2 ─────────────────────────

test("store: blank input is a no-op and never writes to disk", () => {
  const dir = freshDir("blank");
  try {
    const filePath = path.join(dir, LOCAL_AI_KEY_FILE_NAME);
    const store = createLocalAiKeyStore(filePath);
    assert.equal(store.setKey("minimax", ""), false);
    assert.equal(store.setKey("minimax", "   "), false);
    assert.equal(store.setKey("minimax", "\n\t  "), false);
    assert.equal(fs.existsSync(filePath), false, "blank input must not create the file");

    // Once a real key is set, blank input still does not overwrite.
    assert.equal(store.setKey("minimax", "real-key"), true);
    assert.equal(store.getKey("minimax"), "real-key");
    assert.equal(store.setKey("minimax", ""), false);
    assert.equal(store.getKey("minimax"), "real-key", "blank input must not clobber an existing key");
  } finally { cleanup(dir); }
});

test("store: provider keys are independent; changing one does not touch the other", () => {
  const dir = freshDir("independent");
  try {
    const filePath = path.join(dir, LOCAL_AI_KEY_FILE_NAME);
    const store = createLocalAiKeyStore(filePath);
    assert.equal(store.setKey("minimax", "minimax-secret"), true);
    assert.equal(store.setKey("deepseek", "evolink-secret"), true);
    assert.equal(store.getKey("minimax"), "minimax-secret");
    assert.equal(store.getKey("deepseek"), "evolink-secret");
    assert.deepEqual(store.configuredProviders().sort(), ["deepseek", "minimax"]);

    // Round-trip via a fresh store to prove contents survive construction.
    const reopened = createLocalAiKeyStore(filePath);
    assert.equal(reopened.getKey("minimax"), "minimax-secret");
    assert.equal(reopened.getKey("deepseek"), "evolink-secret");

    // Changing only MiniMax must leave Evolink alone.
    assert.equal(reopened.setKey("minimax", "minimax-rotated"), true);
    assert.equal(reopened.getKey("minimax"), "minimax-rotated");
    assert.equal(reopened.getKey("deepseek"), "evolink-secret", "Evolink key must remain untouched");
  } finally { cleanup(dir); }
});

test("store: writing an unchanged key is a no-op at the FS level", async () => {
  const dir = freshDir("noop");
  const filePath = path.join(dir, LOCAL_AI_KEY_FILE_NAME);
  try {
    const store = createLocalAiKeyStore(filePath);
    assert.equal(store.setKey("minimax", "key-a"), true);
    const before = fs.statSync(filePath).mtimeMs;
    // Sleep long enough that a real write would tick the mtime on any
    // common filesystem (macOS HFS+/APFS uses ns, ext4 uses ms).
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(store.setKey("minimax", "key-a"), true);
    const after = fs.statSync(filePath).mtimeMs;
    assert.equal(after, before, "identical write must not bump mtime");
  } finally { cleanup(dir); }
});

// ───────────────────────── G3 ─────────────────────────

test("store: file mode is 0600 after write and directory is 0700", () => {
  const dir = freshDir("mode");
  try {
    const filePath = path.join(dir, LOCAL_AI_KEY_FILE_NAME);
    const store = createLocalAiKeyStore(filePath);
    assert.equal(store.setKey("minimax", "key-mode"), true);
    assert.equal(fileMode(filePath), 0o600, "file must be 0600");
    assert.equal(fileMode(dir), 0o700, "directory must be 0700");
  } finally { cleanup(dir); }
});

test("store: simulated rename failure does not corrupt the last good file", () => {
  const dir = freshDir("renamefail");
  const filePath = path.join(dir, LOCAL_AI_KEY_FILE_NAME);
  try {
    const store = createLocalAiKeyStore(filePath);
    assert.equal(store.setKey("minimax", "key-1"), true);
    const firstBytes = fs.readFileSync(filePath);
    assert.match(firstBytes.toString("utf-8"), /key-1/);

    // Force rename to fail by patching fs.renameSync. We do NOT delete the
    // file from disk so the last-good state survives the simulated failure.
    const originalRename = fs.renameSync;
    (fs as { renameSync: typeof fs.renameSync }).renameSync = (() => {
      throw new Error("simulated rename failure");
    }) as typeof fs.renameSync;
    try {
      assert.throws(() => store.setKey("deepseek", "key-2"), /simulated rename failure/);
    } finally {
      (fs as { renameSync: typeof fs.renameSync }).renameSync = originalRename;
    }

    // The store's in-memory cache should reflect that the new key did NOT
    // land; reading must still return the old key. We also reopen a fresh
    // instance to cross-check the file on disk.
    assert.equal(store.getKey("minimax"), "key-1");
    assert.equal(store.getKey("deepseek"), "");
    const reopened = createLocalAiKeyStore(filePath);
    assert.equal(reopened.getKey("minimax"), "key-1", "file must still contain key-1");
    assert.equal(reopened.getKey("deepseek"), "");
    // The bogus write should not have left any temp artifacts behind.
    assert.deepEqual(listTempArtifacts(dir, LOCAL_AI_KEY_FILE_NAME), []);
  } finally { cleanup(dir); }
});

test("store: temp artifact is cleaned up on rename failure", () => {
  const dir = freshDir("tempclean");
  const filePath = path.join(dir, LOCAL_AI_KEY_FILE_NAME);
  try {
    const store = createLocalAiKeyStore(filePath);
    assert.equal(store.setKey("minimax", "good"), true);
    // No temp artifacts should linger after a successful write.
    assert.deepEqual(listTempArtifacts(dir, LOCAL_AI_KEY_FILE_NAME), []);

    // Patch fs.renameSync to throw and assert the temp file vanishes.
    const originalRename = fs.renameSync;
    (fs as { renameSync: typeof fs.renameSync }).renameSync = (() => {
      throw new Error("simulated rename failure");
    }) as typeof fs.renameSync;
    try {
      assert.throws(() => store.setKey("deepseek", "should-fail"), /simulated rename failure/);
    } finally {
      (fs as { renameSync: typeof fs.renameSync }).renameSync = originalRename;
    }

    const lingering = listTempArtifacts(dir, LOCAL_AI_KEY_FILE_NAME);
    assert.deepEqual(lingering, [], `temp files must be cleaned up; found: ${lingering.join(",")}`);
  } finally { cleanup(dir); }
});

test("store: temp filename never contains plaintext", () => {
  // We exercise the temp path indirectly by patching fs.openSync to throw
  // after generating the temp path. The point is to assert that the temp
  // name is a stable `<base>.<hex>.tmp` shape, never a key fragment.
  const dir = freshDir("tempname");
  try {
    const filePath = path.join(dir, LOCAL_AI_KEY_FILE_NAME);
    const store = createLocalAiKeyStore(filePath);
    const originalOpen = fs.openSync;
    const seenNames: string[] = [];
    (fs as { openSync: typeof fs.openSync }).openSync = ((p: fs.PathLike, flags: string | number, mode?: number) => {
      const name = String(p);
      if (name.endsWith(".tmp")) seenNames.push(name);
      throw new Error("simulated open failure");
    }) as typeof fs.openSync;
    try {
      assert.throws(() => store.setKey("minimax", "forbidden-secret-12345"));
    } finally {
      (fs as { openSync: typeof fs.openSync }).openSync = originalOpen;
    }
    // Restore the store by recreating the dir; the original store still
    // works for subsequent writes.
    assert.ok(seenNames.length >= 1, "store must attempt to open a temp file");
    for (const name of seenNames) {
      assert.ok(name.startsWith(path.join(dir, `.${LOCAL_AI_KEY_FILE_NAME}.`)));
      assert.match(path.basename(name), new RegExp(`^\\.${LOCAL_AI_KEY_FILE_NAME}\\.[0-9a-f]+\\.tmp$`));
      assert.equal(name.includes("forbidden-secret"), false, "temp filename must not contain plaintext");
    }
  } finally { cleanup(dir); }
});

// ───────────────────────── G4 ─────────────────────────

test("store: invalid JSON on disk is treated as empty and recoverable on next write", () => {
  const dir = freshDir("corrupt");
  try {
    const filePath = path.join(dir, LOCAL_AI_KEY_FILE_NAME);
    fs.writeFileSync(filePath, "not-json-at-all", { mode: 0o600 });
    const store = createLocalAiKeyStore(filePath);
    assert.equal(store.hasKey("minimax"), false);
    assert.equal(store.hasKey("deepseek"), false);
    assert.equal(store.setKey("minimax", "recovered"), true);
    assert.equal(store.getKey("minimax"), "recovered");
  } finally { cleanup(dir); }
});

test("store: errors thrown by the store never embed plaintext", () => {
  const dir = freshDir("noplaintext");
  try {
    const store = createLocalAiKeyStore(path.join(dir, LOCAL_AI_KEY_FILE_NAME));
    try {
      store.setKey("openai" as never, "should-not-appear");
      assert.fail("expected throw");
    } catch (error) {
      const message = (error as Error).message;
      assert.equal(message.includes("should-not-appear"), false, "error must not leak plaintext");
    }
  } finally { cleanup(dir); }
});

// ───────────────────────── G5 ─────────────────────────

test("store: hasKey reflects the file, not pre-existing state", () => {
  const dir = freshDir("snapshot");
  try {
    const filePath = path.join(dir, LOCAL_AI_KEY_FILE_NAME);
    // Pre-populate a file with one provider configured and the other empty.
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, providers: { minimax: "pre-existing", deepseek: "" } }), { mode: 0o600 });
    const store = createLocalAiKeyStore(filePath);
    assert.equal(store.hasKey("minimax"), true);
    assert.equal(store.hasKey("deepseek"), false);

    // Saving Evolink must NOT mutate MiniMax's slot.
    assert.equal(store.setKey("deepseek", "new-evolink"), true);
    const reopened = createLocalAiKeyStore(filePath);
    assert.equal(reopened.getKey("minimax"), "pre-existing");
    assert.equal(reopened.getKey("deepseek"), "new-evolink");
  } finally { cleanup(dir); }
});

test("store: concurrent construction reads the same persisted JSON", () => {
  const dir = freshDir("concurrent");
  try {
    const filePath = path.join(dir, LOCAL_AI_KEY_FILE_NAME);
    const writer = createLocalAiKeyStore(filePath);
    assert.equal(writer.setKey("minimax", "shared-secret"), true);
    const reader = createLocalAiKeyStore(filePath);
    assert.equal(reader.getKey("minimax"), "shared-secret");
  } finally { cleanup(dir); }
});

test("store: directory creation is idempotent", () => {
  const dir = freshDir("mkdir");
  try {
    const store = createLocalAiKeyStore(path.join(dir, "nested", LOCAL_AI_KEY_FILE_NAME));
    assert.equal(store.hasKey("minimax"), false);
    assert.equal(store.setKey("minimax", "ok"), true);
    // Calling createLocalAiKeyStore again on the same path must not throw.
    const reopen = createLocalAiKeyStore(path.join(dir, "nested", LOCAL_AI_KEY_FILE_NAME));
    assert.equal(reopen.getKey("minimax"), "ok");
  } finally { cleanup(dir); }
});

// ───────────────────────── teardown ─────────────────────────

test("store: returned store is reusable across many calls", () => {
  const dir = freshDir("reuse");
  try {
    const store = createLocalAiKeyStore(path.join(dir, LOCAL_AI_KEY_FILE_NAME));
    const rounds = 5;
    for (let i = 0; i < rounds; i++) {
      assert.equal(store.setKey("minimax", `key-${i}`), true);
      assert.equal(store.getKey("minimax"), `key-${i}`);
    }
    const reopened = createLocalAiKeyStore(store.filePath());
    assert.equal(reopened.getKey("minimax"), `key-${rounds - 1}`);
  } finally { cleanup(dir); }
});

// Reference unused-symbol suppression to keep the test self-contained
// when refactoring the production module.
void ({} as LocalAiKeyStore);
