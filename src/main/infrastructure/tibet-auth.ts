/** Tibet extension-user authentication client. Tokens never leave main. */
import type {
  AppAuthAccountsSnapshot,
  AppAuthCaptcha,
  AppAuthLoginInput,
  AppAuthStatus,
  AppAuthUser,
} from "../../shared/contracts-auth.js";
import type { AppAuthStore, StoredAppAuthSession } from "./app-auth-store.js";

const DEFAULT_TIBET_API_BASE_URL = "https://www.atdtour.com";
const REQUEST_TIMEOUT_MS = 15_000;

type FetchLike = typeof fetch;
interface TibetEnvelope { code?: unknown; message?: unknown; data?: unknown }

export interface TibetAuthService {
  status(): Promise<AppAuthStatus>;
  listAccounts(): Promise<AppAuthAccountsSnapshot>;
  captcha(): Promise<AppAuthCaptcha>;
  login(input: AppAuthLoginInput): Promise<AppAuthStatus>;
  switchAccount(userId: number): Promise<AppAuthStatus>;
  startLogin(): Promise<void>;
  logout(): Promise<void>;
}

export function resolveTibetApiBaseUrl(raw = process.env.TIBET_API_BASE_URL): string {
  const candidate = raw?.trim() || DEFAULT_TIBET_API_BASE_URL;
  let url: URL;
  try { url = new URL(candidate); } catch { throw new Error("Tibet 服务地址格式不正确。"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("Tibet 服务地址必须使用 HTTPS（本机调试可使用 loopback HTTP）。");
  }
  return url.origin;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function userFrom(value: unknown, expiresAt?: string): AppAuthUser | null {
  const data = record(value);
  const id = Number(data?.id);
  if (!Number.isInteger(id) || id <= 0 || typeof data?.name !== "string"
    || typeof data.phone !== "string" || typeof data.status !== "string") return null;
  return { id, name: data.name.trim(), phone: data.phone.trim(), status: data.status, expiresAt };
}

function messageOf(envelope: TibetEnvelope, fallback: string): string {
  return typeof envelope.message === "string" && envelope.message.trim()
    ? envelope.message.trim()
    : fallback;
}

function isExpired(expiresAt: string): boolean {
  const timestamp = Date.parse(expiresAt.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(expiresAt) ? "" : "+08:00"));
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

export function createTibetAuthService(
  store: AppAuthStore,
  options: { baseUrl?: string; fetchImpl?: FetchLike } = {},
): TibetAuthService {
  const baseUrl = resolveTibetApiBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;

  const request = async (path: string, init: RequestInit = {}) => {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Accept: "application/json", ...init.headers },
      });
    } catch {
      throw new Error("暂时无法连接账号服务，请检查网络后重试。");
    }
    let envelope: TibetEnvelope;
    try { envelope = await response.json() as TibetEnvelope; } catch {
      throw new Error("账号服务返回了无法识别的数据，请稍后重试。");
    }
    return { response, envelope };
  };

  const validate = async (session: StoredAppAuthSession): Promise<AppAuthStatus> => {
    if (isExpired(session.expiresAt)) {
      store.remove(session.user.id);
      return { state: "unauthenticated" };
    }
    try {
      const { response, envelope } = await request("/api/extension/auth/me", {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      if (response.status === 401 || response.status === 403) {
        store.remove(session.user.id);
        return { state: "unauthenticated" };
      }
      if (!response.ok || envelope.code !== 200) {
        return { state: "unavailable", message: messageOf(envelope, "暂时无法验证登录状态，请重试。"), cachedUser: session.user };
      }
      const data = record(envelope.data);
      const expiresAt = typeof data?.expires_at === "string" ? data.expires_at : session.expiresAt;
      const user = userFrom(data, expiresAt);
      if (!user) return { state: "unavailable", message: "账号服务返回的用户信息不完整，请重试。", cachedUser: session.user };
      store.set({ ...session, expiresAt, user });
      return { state: "authenticated", user };
    } catch (error) {
      return {
        state: "unavailable",
        message: error instanceof Error ? error.message : "暂时无法验证登录状态，请重试。",
        cachedUser: session.user,
      };
    }
  };

  return {
    async status() {
      const session = store.get();
      return session ? validate(session) : { state: "unauthenticated" };
    },
    async listAccounts() {
      for (const session of store.list()) {
        if (isExpired(session.expiresAt)) store.remove(session.user.id);
      }
      return {
        currentUserId: store.get()?.user.id ?? null,
        saved: store.list().map((session) => ({
          user: session.user,
          lastUsedAt: session.lastUsedAt ?? "",
        })),
      };
    },
    async captcha() {
      const { response, envelope } = await request("/api/extension/captcha");
      const data = record(envelope.data);
      if (!response.ok || envelope.code !== 200 || typeof data?.captcha_id !== "string"
        || typeof data.image_base64 !== "string" || !data.image_base64.startsWith("data:image/")) {
        throw new Error(messageOf(envelope, "获取验证码失败，请重试。"));
      }
      return { captchaId: data.captcha_id, imageDataUrl: data.image_base64 };
    },
    async login(input) {
      const phone = input.phone.trim();
      if (!/^1\d{10}$/.test(phone)) throw new Error("请输入正确的 11 位手机号。");
      if (!input.password) throw new Error("请输入密码。");
      if (!input.captchaId || !input.captchaCode.trim()) throw new Error("请输入图形验证码。");
      const { response, envelope } = await request("/api/extension/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone,
          password: input.password,
          captcha_id: input.captchaId,
          captcha_code: input.captchaCode.trim().toUpperCase(),
        }),
      });
      const data = record(envelope.data);
      const token = typeof data?.token === "string" ? data.token : "";
      const expiresAt = typeof data?.expires_at === "string" ? data.expires_at : "";
      const user = userFrom(data?.user, expiresAt);
      if (!response.ok || envelope.code !== 200 || !token || !expiresAt || !user) {
        throw new Error(messageOf(envelope, "登录失败，请检查账号信息后重试。"));
      }
      store.set({ token, expiresAt, user });
      return { state: "authenticated", user };
    },
    async switchAccount(userId) {
      const session = store.getByUserId(userId);
      if (!session) throw new Error("该账号的本机登录记录不存在，请重新登录。");
      const status = await validate(session);
      if (status.state === "authenticated") return status;
      if (status.state === "unavailable") throw new Error(status.message);
      throw new Error("该账号的登录状态已失效，请重新登录。");
    },
    async startLogin() {
      store.deactivate();
    },
    async logout() {
      const session = store.get();
      try {
        if (session) await request("/api/extension/auth/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${session.token}` },
        });
      } finally {
        if (session) store.remove(session.user.id);
      }
    },
  };
}
