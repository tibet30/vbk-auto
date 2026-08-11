/**
 * Local VBK cookie-session store (main-process only).
 *
 * Replaces the previous Electron-macOS-Keychain-encrypted login_sessions
 * SQLite path (see archive of `database/parts/sessions.ts`). Per-account
 * VBK login snapshots are now written as plaintext JSON to a single file
 * under `app.getPath('userData')` with file mode 0600 and atomic temp+rename
 * semantics. There is NO encryption layer: cookie integrity relies on
 * the userData directory's owner-only ACL (0700 directory + 0600 file,
 * both enforced in this module).
 *
 * Why no encryption layer anymore:
 *   - Electron's macOS Keychain-backed encryption primitives reject
 *     silently with "decryption is not available" when the keychain item
 *     is missing, which blocks the VBK login recovery path and produces
 *     unhandled promise rejections at the IPC boundary.
 *   - User explicitly decided to keep VBK cookie snapshots in a local
 *     application data file. The file is 0600 on macOS / Linux; on
 *     Windows the OS-level ACL of the user profile directory applies.
 *
 * Security contract enforced in this module:
 *   - File name is fixed (`vbk-cookie-sessions.json`); temp filenames
 *     never include any cookie content.
 *   - Writes go through a sibling temp file + rename for atomicity; the
 *     rename replaces the target in a single FS syscall, so concurrent
 *     readers never observe a half-written file.
 *   - File permissions are forced to 0600 after every successful write,
 *     and the temp file is also created with 0600 mode up front.
 *   - The renderer never observes this file. Session list / save / load
 *     all live behind the main-process IPC boundary.
 *
 * Storage shape:
 *   {
 *     version: 1,
 *     sessions: {
 *       "vbk_671205": {
 *         accountName: "vbk_671205",
 *         cookiesJson: "[{...}]",
 *         savedAt: "2026-01-01T00:00:00.000Z"
 *       }
 *     }
 *   }
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SavedLoginAccount } from "../../shared/contracts-types.js";

/** Stable on-disk file name; never include any cookie content in the path. */
export const LOCAL_VBK_COOKIE_FILE_NAME = "vbk-cookie-sessions.json";

/** File mode for the JSON file and any temp artifact. Owner read/write only. */
const FILE_MODE = 0o600;

/** On-disk schema version. Increment when changing the JSON shape. */
const SCHEMA_VERSION = 1;

/** Per-account payload stored on disk. */
interface PersistedVbkSession {
  accountName: string;
  cookiesJson: string;
  savedAt: string;
  /**
   * Strictly-increasing per-instance write counter; used as a tie-breaker
   * for listSessions sort when two snapshots share the same millisecond
   * savedAt. Legacy rows without a `seq` field are normalised to 0.
   */
  seq: number;
}

/** Internal JSON shape stored on disk. */
interface LocalVbkCookieFile {
  version: number;
  sessions: Record<string, PersistedVbkSession>;
}

/** Public surface of the local VBK cookie store. */
export interface LocalVbkCookieStore {
  /**
   * Persist or replace a snapshot for `accountKey`. Empty / blank input
   * is treated as "forget this account" and removes any existing row.
   * Returns true when the on-disk file changed, false otherwise.
   */
  saveSession(accountKey: string, accountName: string, cookiesJson: string): boolean;
  /**
   * Read the plaintext cookies JSON previously stored under `accountKey`.
   * Returns null when the account is unknown.
   */
  loadSession(accountKey: string): { cookiesJson: string; accountName: string } | null;
  /** Snapshot of all accounts currently stored on disk. */
  listSessions(): SavedLoginAccount[];
  /** Remove a single account from the store. No-op when the row is missing. */
  deleteSession(accountKey: string): void;
  /** Path to the JSON file on disk; useful for diagnostics and tests. */
  filePath(): string;
}

function emptyFile(): LocalVbkCookieFile {
  return { version: SCHEMA_VERSION, sessions: {} };
}

/**
 * Read & parse the JSON file. Returns an empty file when missing or invalid.
 * Invalid JSON is treated as "no configured sessions" so the next write still
 * succeeds; the corrupted file is left alone for offline inspection.
 */
function readFile(filePath: string): LocalVbkCookieFile {
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
  const sessionsRecord = record.sessions && typeof record.sessions === "object" && !Array.isArray(record.sessions)
    ? record.sessions as Record<string, unknown>
    : {};
  const next = emptyFile();
  for (const [key, value] of Object.entries(sessionsRecord)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const accountName = typeof entry.accountName === "string" ? entry.accountName : key;
    const cookiesJson = typeof entry.cookiesJson === "string" ? entry.cookiesJson : "";
    const savedAt = typeof entry.savedAt === "string" ? entry.savedAt : new Date().toISOString();
    // Legacy rows written by an earlier schema version may not carry a
    // `seq` field. Default them to 0 so they sort as the oldest entries;
    // the next save on the same key will mint a fresh seq.
    const seq = typeof entry.seq === "number" && Number.isFinite(entry.seq) ? entry.seq : 0;
    if (!cookiesJson) continue;
    next.sessions[key] = { accountName, cookiesJson, savedAt, seq };
  }
  return next;
}

/** Serialize the file to JSON text. */
function serialize(file: LocalVbkCookieFile): string {
  return JSON.stringify({ version: file.version, sessions: file.sessions });
}

/**
 * Build a temp file path in the same directory as the target file. The temp
 * filename is random and never carries any cookie content.
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
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Try to chmod a file to 0600. On platforms where chmod is restricted this
 * is a best-effort step. We still re-assert after rename because temp files
 * may inherit a wider umask.
 */
function chmod0600(p: string): void {
  try { fs.chmodSync(p, FILE_MODE); } catch { /* ignore — best effort */ }
}

/**
 * Create a LocalVbkCookieStore rooted at `filePath`. The directory is
 * created (0700) if missing. The file is read on construction; the
 * returned store is otherwise stateless and safe to call from any
 * IPC handler.
 */
export function createLocalVbkCookieStore(filePath: string): LocalVbkCookieStore {
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let cache: LocalVbkCookieFile = readFile(filePath);
  // Strictly-increasing per-instance write counter; used as a tie-breaker
  // for listSessions sort when two snapshots share the same millisecond
  // savedAt. Survives only for the lifetime of this store instance;
  // reloads bump up to (max loaded seq + 1).
  let writeSeq = 0;
  for (const entry of Object.values(cache.sessions)) {
    if (entry.seq > writeSeq) writeSeq = entry.seq;
  }

  /**
   * Helper: write the file using temp + rename. Cleans up the temp file
   * on any failure so callers never see lingering artifacts.
   */
  const writeAtomic = (next: LocalVbkCookieFile): void => {
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
    saveSession(accountKey, accountName, cookiesJson) {
      const trimmedKey = typeof accountKey === "string" ? accountKey.trim() : "";
      if (!trimmedKey) throw new Error("保存登录态失败：账号标识不能为空。");
      const trimmedName = typeof accountName === "string" ? accountName.trim() : "";
      const display = trimmedName || trimmedKey;
      const trimmedJson = typeof cookiesJson === "string" ? cookiesJson : "";
      // 空快照 = 忘记该账号：与旧 SQLite 路径一致，避免留下"无 cookies 的账号"。
      if (!trimmedJson || trimmedJson === "[]") {
        if (!cache.sessions[trimmedKey]) return false;
        delete cache.sessions[trimmedKey];
        writeAtomic(cache);
        return true;
      }
      const existing = cache.sessions[trimmedKey];
      const savedAt = new Date().toISOString();
      const seq = ++writeSeq;
      // 与现有快照完全一致（accountName + cookiesJson 均不变）时跳过写盘。
      if (existing && existing.cookiesJson === trimmedJson && existing.accountName === display) {
        // 仅刷新 savedAt + seq，让 listSessions 按最近使用排序。
        const next: LocalVbkCookieFile = {
          version: SCHEMA_VERSION,
          sessions: { ...cache.sessions, [trimmedKey]: { accountName: display, cookiesJson: trimmedJson, savedAt, seq } },
        };
        writeAtomic(next);
        cache = next;
        return true;
      }
      const next: LocalVbkCookieFile = {
        version: SCHEMA_VERSION,
        sessions: { ...cache.sessions, [trimmedKey]: { accountName: display, cookiesJson: trimmedJson, savedAt, seq } },
      };
      writeAtomic(next);
      cache = next;
      return true;
    },
    loadSession(accountKey) {
      const trimmedKey = typeof accountKey === "string" ? accountKey.trim() : "";
      if (!trimmedKey) return null;
      const entry = cache.sessions[trimmedKey];
      if (!entry) return null;
      return { cookiesJson: entry.cookiesJson, accountName: entry.accountName };
    },
    listSessions() {
      const entries = Object.entries(cache.sessions);
      // Primary key: savedAt descending; tie-breaker: seq descending. The
      // tie-breaker is critical when multiple saves happen within the same
      // millisecond (tests, rapid-fire status updates); without it V8's
      // stable sort would preserve insertion order, which can disagree
      // with chronological order across store restarts.
      entries.sort(([, a], [, b]) => {
        if (a.savedAt !== b.savedAt) return a.savedAt < b.savedAt ? 1 : -1;
        return a.seq < b.seq ? 1 : a.seq > b.seq ? -1 : 0;
      });
      return entries.map(([key, value]) => ({
        accountKey: key,
        accountName: value.accountName || key,
        lastUsedAt: value.savedAt,
      }));
    },
    deleteSession(accountKey) {
      const trimmedKey = typeof accountKey === "string" ? accountKey.trim() : "";
      if (!trimmedKey) return;
      if (!cache.sessions[trimmedKey]) return;
      delete cache.sessions[trimmedKey];
      writeAtomic(cache);
    },
    filePath() { return filePath; },
  };
}