/**
 * Async safeStorage adapter for macOS keychain resilience.
 *
 * The sync safeStorage API (isEncryptionAvailable / encryptString / decryptString)
 * fails when the macOS Safe Storage keychain item has been deleted. Electron's
 * async API (encryptStringAsync / decryptStringAsync) lazily initializes the
 * keychain and handles temporary unavailability.
 *
 * All API-key persistence flows through these three functions:
 *  - isAsyncEncryptionAvailable: probe before saving a new key
 *  - persistApiKeyAsync: encrypt + base64-encode + write to DB
 *  - loadApiKeyAsync: read from DB + base64-decode + decrypt; re-encrypt on rotation
 *
 * Callers must never log plaintext keys, error messages containing keys, or
 * base64 ciphertext.
 */

import { safeStorage } from "electron";
import type { VbkDatabase } from "./database/database.js";

/**
 * Checks whether async encryption is actually available by attempting a test
 * encrypt/decrypt roundtrip. The sync isEncryptionAvailable() can return false
 * on macOS even when the async API would succeed, so this is the authoritative
 * check before saving a new key.
 */
export async function isAsyncEncryptionAvailable(): Promise<boolean> {
  try {
    const probe = await safeStorage.encryptStringAsync("__vbk_probe__");
    await safeStorage.decryptStringAsync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypt a plaintext API key using the async safeStorage API.
 * Returns a base64-encoded ciphertext suitable for storage in the DB.
 * Throws if encryption is unavailable.
 */
export async function encryptApiKey(plaintext: string): Promise<string> {
  const encrypted = await safeStorage.encryptStringAsync(plaintext);
  return Buffer.from(encrypted).toString("base64");
}

/**
 * Decrypt a base64-encoded ciphertext from the DB using the async safeStorage API.
 *
 * Returns:
 *  - result: the decrypted plaintext string.
 *  - shouldReEncrypt: true when the OS-level key material has rotated and the
 *    ciphertext should be re-encrypted with the current key.
 */
export async function decryptApiKey(
  base64Ciphertext: string,
): Promise<{ result: string; shouldReEncrypt: boolean }> {
  const encrypted = Buffer.from(base64Ciphertext, "base64");
  return safeStorage.decryptStringAsync(encrypted);
}

/**
 * Encrypt a plaintext API key and persist it to the DB under `settingName`.
 * Throws if encryption is unavailable.
 */
export async function persistApiKeyAsync(
  db: VbkDatabase,
  settingName: string,
  plaintext: string,
): Promise<void> {
  const encoded = await encryptApiKey(plaintext);
  db.setSetting(settingName, encoded);
}

/**
 * Load and decrypt a stored API key from the DB.
 *
 * Returns the plaintext key, or "" if no key is stored under `settingName`.
 * If shouldReEncrypt is signaled by the OS (key rotation), the same plaintext
 * is re-encrypted and persisted without logging.
 */
export async function loadApiKeyAsync(
  db: VbkDatabase,
  settingName: string,
): Promise<string> {
  const stored = db.getSetting(settingName)?.value;
  if (!stored) return "";
  const { result, shouldReEncrypt } = await decryptApiKey(stored);
  if (shouldReEncrypt) {
    try {
      const reEncrypted = await encryptApiKey(result);
      db.setSetting(settingName, reEncrypted);
    } catch {
      // Re-encryption failure is non-fatal; the plaintext is still valid
    }
  }
  return result;
}
