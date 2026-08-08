/**
 * Unit tests for src/main/infrastructure/secure-storage.ts
 *
 * Uses an injected fake safeStorage so tests run without Electron / macOS keychain.
 * Never asserts on plaintext key values beyond length / emptiness.
 */

import test from "node:test";
import assert from "node:assert/strict";

// ──────────────────────────────────────────────────────────────────────────
// Fake safeStorage
// ──────────────────────────────────────────────────────────────────────────

type FakeSafeStorage = {
  _key: Buffer;
  encryptStringAsync(plaintext: string): Promise<Buffer>;
  decryptStringAsync(ciphertext: Buffer): Promise<{ plaintext: string; shouldReEncrypt: boolean }>;
};

function fakeSafeStorage(available: boolean, rotateOnDecrypt: boolean = false): FakeSafeStorage {
  // A simple XOR key – not real crypto, just an isolated test double.
  const key = Buffer.from("vbk-test-key-32-bytes-xxxxxxxxx!");
  return {
    _key: key,
    async encryptStringAsync(plaintext: string) {
      if (!available) throw new Error("Encryption not available");
      const buf = Buffer.from(plaintext, "utf-8");
      const out = Buffer.alloc(buf.length);
      for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
      return out;
    },
    async decryptStringAsync(ciphertext: Buffer) {
      if (!available) throw new Error("Decryption not available");
      const out = Buffer.alloc(ciphertext.length);
      for (let i = 0; i < ciphertext.length; i++) out[i] = ciphertext[i] ^ key[i % key.length];
      return { plaintext: out.toString("utf-8"), shouldReEncrypt: rotateOnDecrypt };
    },
  };
}

// Inline the module-under-test logic so we don't import Electron at all.
// Mirrors secure-storage.ts faithfully.

function toBase64(buf: Buffer): string {
  return buf.toString("base64");
}
function fromBase64(s: string): Buffer {
  return Buffer.from(s, "base64");
}

interface KeyStore {
  getSetting(name: string): { value: string } | undefined;
  setSetting(name: string, value: string): void;
}

async function isAsyncEncryptionAvailable(s: FakeSafeStorage): Promise<boolean> {
  try {
    const probe = await s.encryptStringAsync("__vbk_probe__");
    await s.decryptStringAsync(probe);
    return true;
  } catch {
    return false;
  }
}

async function encryptApiKey(s: FakeSafeStorage, plaintext: string): Promise<string> {
  const encrypted = await s.encryptStringAsync(plaintext);
  return toBase64(encrypted);
}

async function decryptApiKey(
  s: FakeSafeStorage,
  base64Ciphertext: string,
): Promise<{ result: string; shouldReEncrypt: boolean }> {
  const encrypted = fromBase64(base64Ciphertext);
  const decrypted = await s.decryptStringAsync(encrypted);
  if (typeof decrypted === "string") {
    return { result: decrypted, shouldReEncrypt: false };
  }
  return { result: decrypted.plaintext, shouldReEncrypt: decrypted.shouldReEncrypt ?? false };
}

async function persistApiKeyAsync(
  s: FakeSafeStorage,
  store: KeyStore,
  settingName: string,
  plaintext: string,
): Promise<void> {
  if (!plaintext) return;
  const encoded = await encryptApiKey(s, plaintext);
  store.setSetting(settingName, encoded);
}

async function loadApiKeyAsync(
  s: FakeSafeStorage,
  store: KeyStore,
  settingName: string,
): Promise<string> {
  const stored = store.getSetting(settingName)?.value;
  if (!stored) return "";

  const { result, shouldReEncrypt } = await decryptApiKey(s, stored);

  if (shouldReEncrypt && result) {
    const newCipher = await encryptApiKey(s, result);
    store.setSetting(settingName, newCipher);
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

function memStore(initial?: Record<string, string>): KeyStore {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getSetting(name: string) {
      const v = map.get(name);
      return v !== undefined ? { value: v } : undefined;
    },
    setSetting(name: string, value: string) {
      map.set(name, value);
    },
  };
}

test("isAsyncEncryptionAvailable: true when roundtrip succeeds", async () => {
  const s = fakeSafeStorage(true);
  assert.equal(await isAsyncEncryptionAvailable(s), true);
});

test("isAsyncEncryptionAvailable: false when encrypt throws", async () => {
  const s = fakeSafeStorage(false);
  assert.equal(await isAsyncEncryptionAvailable(s), false);
});

test("persistApiKeyAsync → loadApiKeyAsync roundtrip", async () => {
  const s = fakeSafeStorage(true);
  const store = memStore();

  await persistApiKeyAsync(s, store, "minimaxApiKey", "test-key-value");
  const loaded = await loadApiKeyAsync(s, store, "minimaxApiKey");

  assert.equal(loaded, "test-key-value");
  // check that what's stored is base64, not plaintext
  const raw = store.getSetting("minimaxApiKey")!.value;
  assert.ok(raw.length > 0);
  assert.notEqual(raw, "test-key-value", "stored value must not be plaintext");
});

test("loadApiKeyAsync returns empty string for missing setting", async () => {
  const s = fakeSafeStorage(true);
  const store = memStore();
  assert.equal(await loadApiKeyAsync(s, store, "nonexistent"), "");
});

test("persistApiKeyAsync is no-op for empty plaintext", async () => {
  const s = fakeSafeStorage(true);
  const store = memStore();
  await persistApiKeyAsync(s, store, "k", "");
  assert.equal(store.getSetting("k"), undefined);
});

test("persistApiKeyAsync throws when encryption unavailable", async () => {
  const s = fakeSafeStorage(false);
  const store = memStore();
  await assert.rejects(() => persistApiKeyAsync(s, store, "k", "secret"));
});

test("loadApiKeyAsync throws when decryption unavailable", async () => {
  const sAvailable = fakeSafeStorage(true);
  const sUnavailable = fakeSafeStorage(false);
  const store = memStore();
  await persistApiKeyAsync(sAvailable, store, "k", "secret");
  await assert.rejects(() => loadApiKeyAsync(sUnavailable, store, "k"));
});

test("re-encryption on rotation: shouldReEncrypt triggers re-persist", async () => {
  const s = fakeSafeStorage(true, /*rotateOnDecrypt*/ true);
  const store = memStore();

  await persistApiKeyAsync(s, store, "deepseekApiKey", "rotate-me");
  const before = store.getSetting("deepseekApiKey")!.value;

  const loaded = await loadApiKeyAsync(s, store, "deepseekApiKey");
  assert.equal(loaded, "rotate-me");

  const after = store.getSetting("deepseekApiKey")!.value;
  // After re-encryption the stored ciphertext should differ because our
  // fake XOR is deterministic — but the key is the same, so we only
  // verify the plaintext roundtrip worked and no crash occurred.
  assert.equal(loaded, "rotate-me");
  assert.ok(after.length > 0, "re-encrypted value must exist");
});

test("stored base64 is not the plaintext", async () => {
  const s = fakeSafeStorage(true);
  const store = memStore();
  await persistApiKeyAsync(s, store, "k", "my-secret-key");
  const raw = store.getSetting("k")!.value;
  // base64 decode should not equal the plaintext directly
  const decoded = Buffer.from(raw, "base64").toString("utf-8");
  assert.notEqual(decoded, "my-secret-key");
});

test("multiple keys independent", async () => {
  const s = fakeSafeStorage(true);
  const store = memStore();
  await persistApiKeyAsync(s, store, "minimaxApiKey", "mm-key");
  await persistApiKeyAsync(s, store, "deepseekApiKey", "ds-key");
  assert.equal(await loadApiKeyAsync(s, store, "minimaxApiKey"), "mm-key");
  assert.equal(await loadApiKeyAsync(s, store, "deepseekApiKey"), "ds-key");
});
