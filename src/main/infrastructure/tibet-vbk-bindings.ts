import type {
  TibetVbkBindingService,
  VbkBinding,
  VbkBindingButler,
  VbkBindingsSnapshot,
  VbkBindingUpsertPatch,
} from "../../shared/contracts-vbk-binding.js";
import type { AppAuthStore } from "./app-auth-store.js";
import { resolveTibetApiBaseUrl } from "./tibet-auth.js";

const REQUEST_TIMEOUT_MS = 15_000;
type FetchLike = typeof fetch;

interface TibetEnvelope {
  code?: number;
  message?: string;
  data?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function messageOf(envelope: TibetEnvelope, fallback: string): string {
  return typeof envelope.message === "string" && envelope.message.trim() ? envelope.message.trim() : fallback;
}

function routePath(path: string): string {
  return path.split("?", 1)[0] || path;
}

function nonJsonResponseError(path: string, response: Response): Error {
  return new Error(`Tibet VBK 绑定服务返回了无法识别的数据（${routePath(path)}，HTTP ${response.status}）。`);
}

function butlerOf(value: unknown): VbkBindingButler | null {
  if (value === null) return null;
  const item = record(value);
  if (!item
    || typeof item.contactCardId !== "number" || !Number.isInteger(item.contactCardId)
    || typeof item.displayName !== "string" || !item.displayName.trim()
    || typeof item.providerId !== "number" || !Number.isInteger(item.providerId)) {
    return null;
  }
  return {
    contactCardId: item.contactCardId,
    displayName: item.displayName.trim(),
    providerId: item.providerId,
  };
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function bindingOf(value: unknown): VbkBinding | null {
  const item = record(value);
  if (!item
    || typeof item.vbkAccountKey !== "string" || !item.vbkAccountKey.trim()
    || typeof item.vbkAccountName !== "string"
    || typeof item.servicePhone !== "string"
    || !("butler" in item)) {
    return null;
  }
  const butler = item.butler === null ? null : butlerOf(item.butler);
  if (item.butler !== null && !butler) return null;
  const providerId = item.providerId === undefined || item.providerId === null
    ? item.providerId as number | null | undefined
    : (typeof item.providerId === "number" && Number.isInteger(item.providerId) ? item.providerId : undefined);
  if (item.providerId !== undefined && item.providerId !== null && providerId === undefined) return null;
  const lastUsedAt = optionalString(item.lastUsedAt);
  const updatedAt = optionalString(item.updatedAt);
  if (item.lastUsedAt !== undefined && lastUsedAt === undefined) return null;
  if (item.updatedAt !== undefined && updatedAt === undefined) return null;
  return {
    vbkAccountKey: item.vbkAccountKey.trim(),
    vbkAccountName: item.vbkAccountName,
    ...(providerId !== undefined ? { providerId } : {}),
    servicePhone: item.servicePhone,
    butler,
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

function snapshotOf(value: unknown): VbkBindingsSnapshot | null {
  const data = record(value);
  if (!data || !Array.isArray(data.items)) return null;
  if (data.activeVbkAccountKey !== null
    && data.activeVbkAccountKey !== undefined
    && typeof data.activeVbkAccountKey !== "string") {
    return null;
  }
  const items = data.items.map(bindingOf);
  if (items.some((item) => !item)) return null;
  return {
    items: items as VbkBinding[],
    activeVbkAccountKey: typeof data.activeVbkAccountKey === "string"
      ? data.activeVbkAccountKey
      : null,
  };
}

function bindingPath(vbkAccountKey: string, suffix = ""): string {
  return `/api/extension/vbk-bindings/${encodeURIComponent(vbkAccountKey)}${suffix}`;
}

export function createTibetVbkBindingService(
  store: AppAuthStore,
  options: { baseUrl?: string; fetchImpl?: FetchLike } = {},
): TibetVbkBindingService {
  const baseUrl = resolveTibetApiBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;

  const request = async (path: string, init: RequestInit = {}): Promise<TibetEnvelope> => {
    const session = store.get();
    if (!session) throw new Error("请先登录应用账号后再操作 VBK 绑定。");
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${session.token}`,
          ...init.headers,
        },
      });
    } catch {
      throw new Error("暂时无法连接 Tibet VBK 绑定服务，请检查网络后重试。");
    }
    let envelope: TibetEnvelope;
    try { envelope = await response.json() as TibetEnvelope; } catch {
      throw nonJsonResponseError(path, response);
    }
    if (response.status === 401 || response.status === 403) {
      store.clear();
      throw new Error(messageOf(envelope, "应用登录已失效，请重新登录。"));
    }
    if (!response.ok || envelope.code !== 200) {
      throw new Error(messageOf(envelope, "Tibet VBK 绑定服务请求失败，请稍后重试。"));
    }
    return envelope;
  };

  return {
    async list() {
      const envelope = await request("/api/extension/vbk-bindings");
      const snapshot = snapshotOf(envelope.data);
      if (!snapshot) throw new Error("Tibet VBK 绑定列表格式不正确，请稍后重试。");
      return snapshot;
    },
    async upsert(vbkAccountKey, patch: VbkBindingUpsertPatch) {
      const envelope = await request(bindingPath(vbkAccountKey), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const saved = bindingOf(envelope.data);
      if (!saved) throw new Error("Tibet 未返回有效的 VBK 绑定记录，请稍后重试。");
      return saved;
    },
    async activate(vbkAccountKey) {
      const envelope = await request(bindingPath(vbkAccountKey, "/activate"), { method: "POST" });
      const saved = bindingOf(envelope.data);
      if (!saved) throw new Error("Tibet 未返回有效的 VBK 绑定记录，请稍后重试。");
      return saved;
    },
    async delete(vbkAccountKey) {
      await request(bindingPath(vbkAccountKey), { method: "DELETE" });
    },
  };
}
