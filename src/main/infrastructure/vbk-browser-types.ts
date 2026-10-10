import type { SavedLoginAccount } from "../../shared/contracts-types.js";

export interface LoginSessionStore {
  saveSession(accountKey: string, accountName: string, cookiesJson: string): void | Promise<void>;
  loadSession(accountKey: string): { cookiesJson: string; accountName: string } | null;
  listSessions(): SavedLoginAccount[];
  deleteSession(accountKey: string): void;
  getActiveAccountKey(): string | undefined;
  setActiveAccountKey(key: string): void;
  clearActiveAccountKey(): void;
}

export type LoginSessionRecord = ReturnType<LoginSessionStore["loadSession"]>;
