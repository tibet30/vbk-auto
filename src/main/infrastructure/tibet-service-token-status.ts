/**
 * 「三人同游服务令牌」状态的组装：把本地存储事实与服务端自检结果拼成一份可展示快照。
 *
 * 关键区分：
 *  - 本地有令牌 ≠ 令牌可用。`configured` 只表示本地拿到了格式合法的令牌；
 *  - `identity` / `verifiedAt` 只有在真正调用过 `/api/open/me` 之后才有值；
 *  - 401（无效/过期/吊销）属于**状态结论**，如实写进 `message`；
 *    网络与协议故障必须抛出去，让设置页显示错误而不是假装「未配置」。
 */

import {
  createTibetServiceClient,
  TibetServiceError,
  type TibetServiceClient,
} from "./tibet-service-client.js";
import type { TibetServiceTokenStore } from "./tibet-service-token-store.js";
import type { TibetServiceTokenIdentity, TibetServiceTokenSnapshot } from "../../shared/contracts-service-token.js";

export interface DescribeOptions {
  /** true 时向服务端自检（网络请求）；false 只读本地状态。 */
  verify?: boolean;
  client?: TibetServiceClient;
}

function baseSnapshot(store: TibetServiceTokenStore): TibetServiceTokenSnapshot {
  const state = store.state();
  return {
    configured: state.configured,
    source: state.source,
    maskedToken: state.maskedToken,
    savedAt: state.savedAt,
    filePath: store.filePath(),
    identity: null,
    verifiedAt: null,
    message: state.configured
      ? "已保存到本机，尚未向服务端验证。"
      : "尚未配置三人同游服务令牌：填入后智能体才能读平台接口。",
  };
}

function identityOf(identity: Awaited<ReturnType<TibetServiceClient["selfCheck"]>>): TibetServiceTokenIdentity {
  return {
    name: identity.name,
    status: identity.status,
    statusLabel: identity.statusLabel,
    permissions: identity.permissionLabels.length ? identity.permissionLabels : identity.permissions,
    expiresAt: identity.expiresAt,
    remainingDays: identity.remainingDays,
    boundType: identity.boundIdentity?.type ?? null,
    boundLabel: identity.boundIdentity?.label ?? null,
    boundKey: identity.boundIdentity?.key ?? null,
    inherited: identity.boundIdentity?.type === "admin",
  };
}

export async function describeTibetServiceToken(
  store: TibetServiceTokenStore,
  options: DescribeOptions = {},
): Promise<TibetServiceTokenSnapshot> {
  const snapshot = baseSnapshot(store);
  if (!options.verify || !snapshot.configured) return snapshot;

  const client = options.client ?? createTibetServiceClient({ token: () => store.get() });
  try {
    const identity = await client.selfCheck();
    return {
      ...snapshot,
      identity: identityOf(identity),
      verifiedAt: new Date().toISOString(),
      message: `服务端已确认：${identity.name}（${identity.statusLabel}）。`,
    };
  } catch (error) {
    // 无效/过期/吊销是结论；网络与协议故障继续抛给调用方。
    if (error instanceof TibetServiceError && (error.code === 401 || error.code === 403)) {
      return { ...snapshot, verifiedAt: new Date().toISOString(), message: error.message };
    }
    throw error;
  }
}
