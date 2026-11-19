/**
 * 三人同游服务端客户端门面：把传输层、公共目录、业务读取装配成一个入口。
 *
 * 分层：
 *  - `tibet-service-transport.ts`：基地址 / 服务令牌 / 信封 / 错误分类；
 *  - `tibet-service-catalog.ts`：公共目录与后台目录（服务目录）；
 *  - `tibet-service-business.ts`：VBK 绑定（扩展用户身份）与 C 端订单（客户身份）。
 *
 * 身份边界（服务端契约）：
 *  - 公共目录不需要身份；
 *  - `/api/extension/*`、`/api/user/*`、`/api/admin/*` 需要令牌绑定对应身份，未绑定回 403 并说明；
 *  - 令牌管理接口 `/api/service-tokens*` 永不接受服务令牌。
 */

import {
  createTibetTransport,
  finiteNumber,
  record,
  strings,
  text,
  TibetServiceAuthError,
  TibetServiceError,
  type TibetTransport,
} from "./tibet-service-transport.js";
import { createTibetCatalogReader, type TibetCatalogReader } from "./tibet-service-catalog.js";
import { createTibetBusinessReader, type TibetBusinessReader } from "./tibet-service-business.js";

export {
  isValidServiceToken,
  TIBET_SERVICE_TOKEN_ENV,
  TibetServiceAuthError,
  TibetServiceError,
  TibetServiceScopeError,
} from "./tibet-service-transport.js";
export type {
  TibetCatalogDetail,
  TibetCatalogPage,
  TibetCatalogQuery,
  TibetCatalogService,
  TibetAdminCatalogQuery,
} from "./tibet-service-catalog.js";
export type {
  TibetBusinessReader,
  TibetOrder,
  TibetVbkBinding,
  TibetVbkBindingButler,
  TibetVbkBindingsSnapshot,
} from "./tibet-service-business.js";
export { ORDER_STATUS_LABELS } from "./tibet-service-business.js";

export interface TibetBoundIdentity {
  type: string;
  label: string;
  key: string;
  /** true = 继承自创建者管理员（不是显式业务绑定）。 */
  inherited: boolean;
}

/** `/api/open/me` 的可用字段子集：只投影调用方需要的事实，不转发凭证。 */
export interface TibetServiceIdentity {
  name: string;
  tokenPrefix: string;
  permissions: string[];
  permissionLabels: string[];
  status: string;
  statusLabel: string;
  expiresAt: string;
  remainingDays: number | null;
  /** 主身份（业务绑定优先，其次创建者继承）。 */
  boundIdentity: TibetBoundIdentity | null;
  /** 全部已生效身份；同一个人可能同时有客户 / 扩展用户 / 管理员账号。 */
  boundIdentities: TibetBoundIdentity[];
  lastUsedAt: string | null;
  useCount: number;
}

export interface TibetServiceClient extends TibetCatalogReader, TibetBusinessReader {
  /** 是否配置了格式合法的服务令牌；未配置时仍可读公共目录。 */
  configured(): boolean;
  selfCheck(): Promise<TibetServiceIdentity>;
}

function boundIdentityOf(value: unknown): TibetBoundIdentity | null {
  const item = record(value);
  if (!item) return null;
  const type = text(item.type);
  if (!type) return null;
  return {
    type,
    label: text(item.label) ?? type,
    key: text(item.key) ?? "",
    inherited: item.inherited === true || type === "admin",
  };
}

function identityOf(value: unknown): TibetServiceIdentity {
  const data = record(value);
  if (!data) throw new TibetServiceError("服务端未返回令牌信息，请稍后重试。", 500);
  const name = text(data.name);
  const status = text(data.status);
  const expiresAt = text(data.expires_at);
  if (!name || !status || !expiresAt) {
    throw new TibetServiceError("服务端令牌信息格式不正确，请稍后重试。", 500);
  }
  // 服务端同时返回 bound_identities（全部）与 bound_identity（主身份）；
  // 旧版本只有主身份，因此这里以全部列表为准、缺省时退回主身份。
  const all = Array.isArray(data.bound_identities)
    ? data.bound_identities.map(boundIdentityOf).filter((item): item is TibetBoundIdentity => item !== null)
    : [];
  const primary = boundIdentityOf(data.bound_identity);
  const boundIdentities = all.length ? all : primary ? [primary] : [];
  return {
    name,
    tokenPrefix: text(data.token_prefix) ?? "",
    permissions: strings(data.permissions),
    permissionLabels: strings(data.permission_labels),
    status,
    statusLabel: text(data.status_label) ?? status,
    expiresAt,
    remainingDays: finiteNumber(data.remaining_days),
    boundIdentity: primary ?? boundIdentities[0] ?? null,
    boundIdentities,
    lastUsedAt: text(data.last_used_at),
    useCount: finiteNumber(data.use_count) ?? 0,
  };
}

export function createTibetServiceClient(options: {
  baseUrl?: string;
  /** 字符串直接给定；函数形式每次请求前解析（设置页保存后无需重建客户端）。 */
  token?: string | (() => string | null);
  fetchImpl?: typeof fetch;
} = {}): TibetServiceClient {
  const transport: TibetTransport = createTibetTransport(options);
  const catalog = createTibetCatalogReader(transport);
  const business = createTibetBusinessReader(transport);

  return {
    ...catalog,
    ...business,
    configured: () => transport.configured(),
    async selfCheck() {
      if (!transport.configured()) {
        throw new TibetServiceAuthError("未配置三人同游服务令牌（设置页或环境变量 TIBET_SERVICE_TOKEN）。");
      }
      return identityOf(await transport.get("/api/open/me"));
    },
  };
}
