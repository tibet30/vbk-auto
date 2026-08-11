/**
 * Local AI API key store (main-process only).
 *
 * This module replaces the previous Electron-Keychain-backed API key persistence
 * path. AI API keys (MiniMax / Evolink) are now written as plaintext to a
 * single JSON file under `app.getPath('userData')` with file mode 0600
 * and atomic rename semantics.
 *
 * Why no encryption layer / Keychain anymore:
 *   - Electron's Keychain-backed encryption rejects silently with
 *     "decryption is not available" when the macOS keychain item is missing
 *     or locked, which silently blocks AI connection setup.
 *   - User explicitly decided to keep AI keys in a local application data
 *     file. The file is 0600 (owner read/write only) on macOS / Linux;
 *     on Windows the OS-level ACL of the user profile directory applies.
 *   - No Electron Keychain dependency: this module never reads from
 *     Keychain and never produces an unhandled rejection on key rotation.
 *
 * Security contract enforced in this module:
 *   - File name is fixed (`ai-secrets.json`); temp filenames never include
 *     plaintext or any key material.
 *   - Writes go through a sibling temp file + rename for atomicity; the
 *     rename replaces the target in a single FS syscall, so concurrent
 *     readers never observe a half-written file.
 *   - File permissions are forced to 0600 after every successful write,
 *     and the temp file is also created with 0600 mode up front.
 *   - Errors thrown here are generic; callers must not log plaintext.
 *   - The renderer never observes this file. `settings.getApiKey` is
 *     intentionally rejected; only booleans (`hasKey`) leave the main
 *     process.
 *
 * Important: this module is **only** for AI API keys. VBK cookie / session
 * blobs use the sibling local 0600 atomic store in `./vbk-cookie-store.ts`.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Providers supported by the local key store. Keep aligned with AiProvider. */
export type LocalAiKeyProvider = "minimax" | "deepseek";

const SUPPORTED_PROVIDERS: readonly LocalAiKeyProvider[] = ["minimax", "deepseek"] as const;

/** Stable on-disk file name; never include any key material in the path. */
export const LOCAL_AI_KEY_FILE_NAME = "ai-secrets.json";

/** File mode for the JSON file and any temp artifact. Owner read/write only. */
const FILE_MODE = 0o600;

/** On-disk schema version. Increment when changing the JSON shape. */
const SCHEMA_VERSION = 1;

/** Internal JSON shape stored on disk. */
interface LocalAiKeyFile {
  version: number;
  providers: Partial<Record<LocalAiKeyProvider, string>>;
}

/** Public surface of the local key store. */
export interface LocalAiKeyStore {
  /** Returns whether the local store currently has a non-empty key for `provider`. */
  hasKey(provider: LocalAiKeyProvider): boolean;
  /** Returns the plaintext key, or empty string when not configured. */
  getKey(provider: LocalAiKeyProvider): string;
  /**
   * Set / replace the key for `provider`.
   * Blank input is a no-op (returns false). Returns true on successful write.
   */
  setKey(provider: LocalAiKeyProvider, plaintext: string): boolean;
  /** Read-only snapshot of all configured providers. */
  configuredProviders(): LocalAiKeyProvider[];
  /** Path to the JSON file on disk; useful for diagnostics and tests. */
  filePath(): string;
}

function isSupportedProvider(provider: unknown): provider is LocalAiKeyProvider {
  return typeof provider === "string" && (SUPPORTED_PROVIDERS as readonly string[]).includes(provider);
}

/** Construct an empty in-memory file representation. */
function emptyFile(): LocalAiKeyFile {
  const providers: Partial<Record<LocalAiKeyProvider, string>> = {};
  for (const provider of SUPPORTED_PROVIDERS) providers[provider] = "";
  return { version: SCHEMA_VERSION, providers };
}

/**
 * Read & parse the JSON file. Returns an empty file when missing or invalid.
 * Invalid JSON is treated as "no configured keys" so the next write still
 * succeeds; the corrupted file is left alone for offline inspection.
 */
function readFile(filePath: string): LocalAiKeyFile {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return emptyFile(); }
  if (!parsed || typeof parsed !== "object") return emptyFile();
  const record = parsed as Record<string, unknown>;
  const providersRecord = record.providers && typeof record.providers === "object" && !Array.isArray(record.providers)
    ? record.providers as Record<string, unknown>
    : {};
  const next = emptyFile();
  for (const provider of SUPPORTED_PROVIDERS) {
    const value = providersRecord[provider];
    next.providers[provider] = typeof value === "string" ? value : "";
  }
  return next;
}

/** Serialize the file to JSON text with stable key order. */
function serialize(file: LocalAiKeyFile): string {
  const ordered: Record<string, string> = {};
  for (const provider of SUPPORTED_PROVIDERS) ordered[provider] = file.providers[provider] ?? "";
  return JSON.stringify({ version: file.version, providers: ordered });
}

/**
 * Build a temp file path in the same directory as the target file. The temp
 * filename is random and never carries any key material.
 */
function tempPathFor(targetPath: string): string {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const nonce = randomBytes(8).toString("hex");
  return path.join(dir, `.${base}.${nonce}.tmp`);
}

/**
 * Best-effort unconditional unlink. Missing files are not treated as errors.
 */
function tryUnlink(p: string): void {
  try { fs.unlinkSync(p); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Surface non-ENOENT unlink failures to the caller via re-raise so the
      // atomic-write contract stays honest.
      throw error;
    }
  }
}

/**
 * Try to chmod a file to 0600. On platforms where chmod is restricted or
 * the file already lives in a directory with stronger perms, this is a
 * best-effort step. We still re-assert after rename because temp files
 * may inherit a wider umask.
 */
function chmod0600(p: string): void {
  try { fs.chmodSync(p, FILE_MODE); } catch { /* ignore — best effort */ }
}

/**
 * Create a LocalAiKeyStore rooted at `filePath`. The directory is created
 * (0700) if missing. The file is read on construction; the returned store
 * is otherwise stateless and safe to call from any IPC handler.
 */
export function createLocalAiKeyStore(filePath: string): LocalAiKeyStore {
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let cache: LocalAiKeyFile = readFile(filePath);

  /**
   * Helper: write the file using temp + rename. Cleans up the temp file
   * on any failure so callers never see lingering artifacts.
   */
  const writeAtomic = (next: LocalAiKeyFile): void => {
    const tempPath = tempPathFor(filePath);
    const payload = serialize(next);
    try {
      // Pre-create the temp file with 0600 so the umask cannot widen it
      // before the payload is written. We still re-assert after write.
      const fd = fs.openSync(tempPath, "wx", FILE_MODE);
      try {
        fs.writeSync(fd, payload);
      } finally {
        fs.closeSync(fd);
      }
      chmod0600(tempPath);
      fs.renameSync(tempPath, filePath);
      chmod0600(filePath);
    } catch (error) {
      tryUnlink(tempPath);
      throw error;
    }
  };

  return {
    hasKey(provider) {
      if (!isSupportedProvider(provider)) return false;
      return Boolean(cache.providers[provider]);
    },
    getKey(provider) {
      if (!isSupportedProvider(provider)) return "";
      return cache.providers[provider] ?? "";
    },
    setKey(provider, plaintext) {
      if (!isSupportedProvider(provider)) {
        throw new Error(`不支持的 AI 提供商：${String(provider)}`);
      }
      const trimmed = typeof plaintext === "string" ? plaintext.trim() : "";
      // 空白输入不覆盖。空字符串虽然「技术上」是合法 JSON，但保留现状
      // 更符合运营预期：上一次保存的密钥不会被一次误触「清空输入并保存」覆盖。
      if (!trimmed) return false;
      const current = cache.providers[provider] ?? "";
      if (current === trimmed) return true; // no-op write, no FS syscall
      const next: LocalAiKeyFile = {
        version: SCHEMA_VERSION,
        providers: { ...cache.providers, [provider]: trimmed },
      };
      writeAtomic(next);
      cache = next;
      return true;
    },
    configuredProviders() {
      const out: LocalAiKeyProvider[] = [];
      for (const provider of SUPPORTED_PROVIDERS) {
        if (cache.providers[provider]) out.push(provider);
      }
      return out;
    },
    filePath() { return filePath; },
  };
}
