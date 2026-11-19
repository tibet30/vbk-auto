/**
 * 三人同游服务令牌的本地存储与设置页契约。
 *
 * 两条硬约束：
 *  1. 明文令牌**永不**回传给 renderer —— 设置页只看得到前缀掩码、来源与保存时间；
 *  2. 令牌状态既可能来自本地（是否配置），也可能来自服务端自检（`/api/open/me`），
 *     两者的可信度不同：`source` / `verifiedAt` 用来区分，不允许把「已保存」当成「已验证」。
 */

/** 令牌来源：环境变量优先于本地文件（便于开发与 CI 临时覆盖）。 */
export type TibetServiceTokenSource = "env" | "file";

/** 令牌身份摘要，来自服务端 `/api/open/me`，不是本地推断。 */
export interface TibetServiceTokenIdentity {
  name: string;
  status: string;
  statusLabel: string;
  permissions: string[];
  expiresAt: string;
  remainingDays: number | null;
  /** 身份类型（admin / customer / extension / designer），未绑定为 null。 */
  boundType: string | null;
  boundLabel: string | null;
  boundKey: string | null;
  inherited: boolean;
}

export interface TibetServiceTokenSnapshot {
  /** 本地是否拿到了一条格式合法的令牌。 */
  configured: boolean;
  source: TibetServiceTokenSource | null;
  /** `stk_7d3c74e8…` 形态的前缀掩码；绝不包含秘密部分。 */
  maskedToken: string | null;
  savedAt: string | null;
  filePath: string;
  /** 服务端自检结果；未验证时为 null。 */
  identity: TibetServiceTokenIdentity | null;
  /** 最近一次自检时间（ISO）。 */
  verifiedAt: string | null;
  /** 给用户看的结论或失败原因（例如「服务令牌已过期」「未配置」）。 */
  message: string;
}


/** 平台在售参考：命中项与差价（只参考，不写产品事实）。 */
export interface TibetPlatformReferenceMatch {
  publicId: string;
  title: string;
  priceFrom: number | null;
  cityCode: string | null;
  cityName: string | null;
  serviceType: string | null;
  durationLabel: string | null;
  similarity: number;
  priceGap: number | null;
  reasons: string[];
}

export interface TibetPlatformReferenceResult {
  configured: boolean;
  query: { title: string; cities: string[]; cityCodes: string[]; days: number | null };
  matches: TibetPlatformReferenceMatch[];
  message: string;
}

export interface TibetServiceStatusSummary {
  configured: boolean;
  source: TibetServiceTokenSource | null;
  maskedToken: string | null;
  message: string;
}
