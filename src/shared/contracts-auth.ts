/** Tibet extension-account authentication contracts exposed to the renderer. */
export interface AppAuthUser {
  id: number;
  name: string;
  phone: string;
  status: string;
  expiresAt?: string;
}

/** Renderer-safe summary of a locally retained application login. */
export interface SavedAppAuthAccount {
  user: AppAuthUser;
  lastUsedAt: string;
}

export interface AppAuthAccountsSnapshot {
  currentUserId: number | null;
  saved: SavedAppAuthAccount[];
}

export type AppAuthStatus =
  | { state: "authenticated"; user: AppAuthUser }
  | { state: "unauthenticated" }
  | { state: "unavailable"; message: string; cachedUser?: AppAuthUser };

export interface AppAuthCaptcha {
  captchaId: string;
  imageDataUrl: string;
}

export interface AppAuthLoginInput {
  phone: string;
  password: string;
  captchaId: string;
  captchaCode: string;
}
