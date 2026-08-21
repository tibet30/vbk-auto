/**
 * Main-process-only Tibet application session store.
 *
 * The token follows the repository's existing local-secret convention: one
 * owner-only JSON file, written through a sibling temporary file and atomic
 * rename. Passwords are never accepted by this module and never persisted.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppAuthUser } from "../../shared/contracts-auth.js";

export const LOCAL_APP_AUTH_FILE_NAME = "app-auth-session.json";
const FILE_MODE = 0o600;

export interface StoredAppAuthSession {
  token: string;
  expiresAt: string;
  user: AppAuthUser;
  lastUsedAt?: string;
}

export interface AppAuthStore {
  get(): StoredAppAuthSession | null;
  getByUserId(userId: number): StoredAppAuthSession | null;
  list(): StoredAppAuthSession[];
  set(session: StoredAppAuthSession): void;
  activate(userId: number): StoredAppAuthSession | null;
  deactivate(): void;
  remove(userId: number): void;
  /** Remove only the active account; retained accounts remain switchable. */
  clear(): void;
  filePath(): string;
}

interface StoredAppAuthState {
  activeUserId: number | null;
  sessions: StoredAppAuthSession[];
}

function isUser(value: unknown): value is AppAuthUser {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const user = value as Record<string, unknown>;
  return Number.isInteger(user.id) && Number(user.id) > 0
    && typeof user.name === "string"
    && typeof user.phone === "string"
    && typeof user.status === "string";
}

function isSession(value: unknown): value is StoredAppAuthSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  return typeof session.token === "string" && Boolean(session.token)
    && typeof session.expiresAt === "string"
    && isUser(session.user);
}

function normalizedSession(session: StoredAppAuthSession, fallbackLastUsedAt: string): StoredAppAuthSession {
  return {
    token: session.token,
    expiresAt: session.expiresAt,
    user: session.user,
    lastUsedAt: typeof session.lastUsedAt === "string" && session.lastUsedAt
      ? session.lastUsedAt
      : fallbackLastUsedAt,
  };
}

function readState(filePath: string): StoredAppAuthState {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { activeUserId: null, sessions: [] };
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const fallbackLastUsedAt = (() => {
      try { return fs.statSync(filePath).mtime.toISOString(); } catch { return new Date(0).toISOString(); }
    })();
    if (parsed.version === 1 && isSession(parsed)) {
      const session = normalizedSession(parsed, fallbackLastUsedAt);
      return { activeUserId: session.user.id, sessions: [session] };
    }
    if (parsed.version !== 2 || !Array.isArray(parsed.sessions)) {
      return { activeUserId: null, sessions: [] };
    }
    const byUserId = new Map<number, StoredAppAuthSession>();
    for (const candidate of parsed.sessions) {
      if (!isSession(candidate)) continue;
      const session = normalizedSession(candidate, fallbackLastUsedAt);
      if (!byUserId.has(session.user.id)) byUserId.set(session.user.id, session);
    }
    const sessions = [...byUserId.values()];
    const activeCandidate = Number(parsed.activeUserId);
    const activeUserId = Number.isInteger(activeCandidate)
      && sessions.some((session) => session.user.id === activeCandidate)
      ? activeCandidate
      : null;
    return { activeUserId, sessions };
  } catch {
    return { activeUserId: null, sessions: [] };
  }
}

function chmodOwnerOnly(filePath: string): void {
  try { fs.chmodSync(filePath, FILE_MODE); } catch { /* best effort on Windows */ }
}

export function createAppAuthStore(filePath: string): AppAuthStore {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let cached = readState(filePath);

  const write = (state: StoredAppAuthState) => {
    const tempPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      fs.writeFileSync(tempPath, JSON.stringify({ version: 2, ...state }), {
        encoding: "utf8",
        flag: "wx",
        mode: FILE_MODE,
      });
      chmodOwnerOnly(tempPath);
      fs.renameSync(tempPath, filePath);
      chmodOwnerOnly(filePath);
    } catch (error) {
      try { fs.unlinkSync(tempPath); } catch { /* no-op */ }
      throw error;
    }
  };

  const persist = () => {
    if (cached.sessions.length > 0) {
      write(cached);
      return;
    }
    try { fs.unlinkSync(filePath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };

  const sessionFor = (userId: number) => cached.sessions.find((session) => session.user.id === userId) ?? null;

  return {
    get: () => cached.activeUserId === null ? null : sessionFor(cached.activeUserId),
    getByUserId: sessionFor,
    list: () => [...cached.sessions].sort((a, b) =>
      String(b.lastUsedAt ?? "").localeCompare(String(a.lastUsedAt ?? ""))),
    set(session) {
      const next = normalizedSession(session, new Date().toISOString());
      next.lastUsedAt = new Date().toISOString();
      cached = {
        activeUserId: next.user.id,
        sessions: [next, ...cached.sessions.filter((entry) => entry.user.id !== next.user.id)],
      };
      persist();
    },
    activate(userId) {
      const session = sessionFor(userId);
      if (!session) return null;
      const next = { ...session, lastUsedAt: new Date().toISOString() };
      cached = {
        activeUserId: userId,
        sessions: [next, ...cached.sessions.filter((entry) => entry.user.id !== userId)],
      };
      persist();
      return next;
    },
    deactivate() {
      if (cached.activeUserId === null) return;
      cached = { ...cached, activeUserId: null };
      persist();
    },
    remove(userId) {
      cached = {
        activeUserId: cached.activeUserId === userId ? null : cached.activeUserId,
        sessions: cached.sessions.filter((entry) => entry.user.id !== userId),
      };
      persist();
    },
    clear() {
      if (cached.activeUserId !== null) this.remove(cached.activeUserId);
    },
    filePath: () => filePath,
  };
}
