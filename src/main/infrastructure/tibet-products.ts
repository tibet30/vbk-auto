import type { ProductDetail, ProductSummary } from "../../shared/contracts.js";
import type { AppAuthStore } from "./app-auth-store.js";
import { resolveTibetApiBaseUrl } from "./tibet-auth.js";

const REQUEST_TIMEOUT_MS = 15_000;
type FetchLike = typeof fetch;

interface TibetEnvelope {
  code?: number;
  message?: string;
  data?: unknown;
}

export interface TibetProductService {
  list(): Promise<ProductSummary[]>;
  upsert(product: ProductDetail): Promise<ProductDetail>;
  update(product: ProductDetail, expectedRevision: number): Promise<ProductDetail>;
  get(id: string): Promise<ProductDetail>;
  delete(id: string): Promise<void>;
}

export class TibetProductConflictError extends Error {
  constructor(public readonly latest: ProductDetail, message = "产品已在其他位置更新，请刷新后重试。") {
    super(message);
    this.name = "TibetProductConflictError";
  }
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
  return new Error(`Tibet 产品服务返回了无法识别的数据（${routePath(path)}，HTTP ${response.status}）。`);
}

function productSummary(value: unknown): ProductSummary | null {
  const item = record(value);
  const statuses = new Set(["planning", "review", "automating", "draft_saved", "blocked"]);
  if (!item || typeof item.id !== "string" || typeof item.name !== "string"
    || typeof item.status !== "string" || !statuses.has(item.status)
    || typeof item.updatedAt !== "string") return null;
  const revision = typeof item.revision === "number" && Number.isInteger(item.revision) && item.revision > 0
    ? item.revision
    : undefined;
  return {
    id: item.id,
    name: item.name,
    status: item.status as ProductSummary["status"],
    productId: typeof item.productId === "string" && item.productId ? item.productId : undefined,
    ...(typeof item.vbkAccount === "string" && item.vbkAccount.trim() ? { vbkAccount: item.vbkAccount.trim() } : {}),
    updatedAt: item.updatedAt,
    ...(revision ? { revision } : {}),
  };
}

function productDetail(value: unknown): ProductDetail | null {
  const item = record(value);
  const summary = productSummary(item);
  if (!item || !summary || !record(item.product)
    || !Array.isArray(item.messages) || !Array.isArray(item.researchTasks)) return null;
  return item as unknown as ProductDetail;
}

export function createTibetProductService(
  store: AppAuthStore,
  options: { baseUrl?: string; fetchImpl?: FetchLike } = {},
): TibetProductService {
  const baseUrl = resolveTibetApiBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;

  const request = async (path: string, init: RequestInit = {}, allowConflict = false): Promise<TibetEnvelope> => {
    const session = store.get();
    if (!session) throw new Error("请先登录应用账号后再操作产品。");
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
      throw new Error("暂时无法连接 Tibet 产品服务，请检查网络后重试。");
    }
    let envelope: TibetEnvelope;
    try { envelope = await response.json() as TibetEnvelope; } catch {
      throw nonJsonResponseError(path, response);
    }
    if (response.status === 401 || response.status === 403) {
      store.clear();
      throw new Error(messageOf(envelope, "应用登录已失效，请重新登录。"));
    }
    if ((!response.ok || envelope.code !== 200) && !(allowConflict && response.status === 409)) {
      throw new Error(messageOf(envelope, "Tibet 产品服务请求失败，请稍后重试。"));
    }
    if (allowConflict && response.status === 409) return { ...envelope, code: 409 };
    return envelope;
  };

  return {
    async list() {
      const envelope = await request("/api/extension/desktop-products");
      if (!Array.isArray(envelope.data)) throw new Error("Tibet 产品列表格式不正确，请稍后重试。");
      const items = envelope.data.map(productSummary);
      if (items.some((item) => !item)) throw new Error("Tibet 产品列表包含无效记录，请联系管理员。");
      return items as ProductSummary[];
    },
    async upsert(product) {
      const envelope = await request("/api/extension/desktop-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: product.id, product }),
      });
      const data = record(envelope.data);
      const saved = productDetail(data?.product);
      if (!saved) throw new Error("Tibet 未返回有效的产品记录，请稍后重试。");
      return saved;
    },
    async update(product, expectedRevision) {
      const envelope = await request(`/api/extension/desktop-products/${encodeURIComponent(product.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: product.id, expected_revision: expectedRevision, product }),
      }, true);
      const data = record(envelope.data);
      const saved = productDetail(data?.product);
      if (!saved) throw new Error("Tibet 未返回有效的产品记录，请稍后重试。");
      if (envelope.code === 409) throw new TibetProductConflictError(saved, messageOf(envelope, "产品已在其他位置更新，请刷新后重试。"));
      return saved;
    },
    async get(id) {
      const envelope = await request(`/api/extension/desktop-products/${encodeURIComponent(id)}`);
      const data = record(envelope.data);
      const product = productDetail(data?.product);
      if (!product) throw new Error("Tibet 未返回有效的产品详情，请稍后重试。");
      return product;
    },
    async delete(id) {
      await request(`/api/extension/desktop-products/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  };
}
