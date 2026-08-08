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
  const outcome = await safeStorage.decryptStringAsync(encrypted);
  // Electron 32+ always returns { result, shouldReEncrypt }; treat plain strings as
  // backwards-compatible fall-through (older runtimes returned the plaintext directly).
  if (typeof outcome === "string") {
    return { result: outcome, shouldReEncrypt: false };
  }
  return {
    result: outcome.result,
    shouldReEncrypt: Boolean(outcome.shouldReEncrypt),
  };
}

// ──────────────────────────────────────────────────────────────────────
// 通用 ciphertext 工具：用于 cookie / session blob 等非 API Key 秘密。
// 与 API Key 不同之处：
//   - 不参与 setSetting → 一律直接走数据库列；
//   - 不应被当成 settings 读出；
//   - 仅暴露 encryptString / decryptString 两个无状态函数，对调用方
//     透明返回 base64 与明文。
// 检测明文 vs 密文：密文必须能 base64 解码成 Buffer，再通过 safeStorage
// 解密；解不开则视作明文（迁移前置）。loadSession / loadSessionBlob
// 统一用 isProbablyEncrypted 决定走加密分支还是走迁移分支。
// ──────────────────────────────────────────────────────────────────────

/**
 * 把任意 UTF-8 字符串加密成 base64。
 *   - 与 encryptApiKey 行为一致，但只走安全存储层，不直接落 settings；
 *   - 调用方负责把返回值写到合适列（login_sessions.cookies_ciphertext）。
 */
export async function encryptString(plaintext: string): Promise<string> {
  if (!plaintext) return "";
  const encrypted = await safeStorage.encryptStringAsync(plaintext);
  return Buffer.from(encrypted).toString("base64");
}

/**
 * 解密任意 base64 密文。返回明文 + 是否需要 re-encrypt（OS 密钥轮换）。
 * 失败时抛错（让调用方决定是迁移、降级还是删除）。
 */
export async function decryptString(
  base64Ciphertext: string,
): Promise<{ result: string; shouldReEncrypt: boolean }> {
  if (!base64Ciphertext) return { result: "", shouldReEncrypt: false };
  return decryptApiKey(base64Ciphertext);
}

/**
 * 检测一段字符串看起来是否像 base64 密文（而不是历史明文 JSON）：
 *   - 长度需 >= 4（最小 base64 单元）；
 *   - 仅由 [A-Za-z0-9+/=] 组成；
 *   - 长度足够大（避免误把单字符明文判定为密文）。
 * 这是粗筛，不是真解密；解密失败仍可能由历史引入（字段被截断 / 字符
 * 集错误），调用方需有兜底。
 */
export function isProbablyEncrypted(value: string): boolean {
  if (!value || value.length < 8) return false;
  return /^[A-Za-z0-9+/]+=*$/.test(value);
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
