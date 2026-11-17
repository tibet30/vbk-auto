/**
 * 只读端口装配：把主进程已有的本地事实投影成 Skill 可读的结构化记录。
 *
 * 两条铁律：
 *  - 只投影，不新增事实——产品与账号的事实来源仍是产品库 / cookie 存储；
 *  - 只读端口不提供任何写能力，因此这些 Skill 结构上无法替代业务门禁。
 */

import type { ProductReadiness, ProductSummary } from "../../shared/contracts.js";
import type { PoiSuggestDetailResult } from "../../shared/contracts.js";
import type { ProviderContactCard } from "../../shared/contracts-vbk-account.js";
import type {
  AccountReadPort,
  AccountReadRecord,
  ProductReadPort,
  ProductReadRecord,
  VbkReadPort,
  VbkStatusSnapshot,
} from "../agent-runtime/index.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";

export interface SavedAccountEntry {
  accountKey: string;
  accountName: string;
  lastUsedAt: string;
}

export interface ReadonlyPortContext {
  db: VbkDatabase;
  /** 产品就绪结论；缺失时返回 undefined，由 Skill 如实说"无法读取"。 */
  readiness?: (localProductId: string) => ProductReadiness;
  /** 平台 POI 建议查询（只读）。 */
  searchPoi?: (keyword: string) => Promise<PoiSuggestDetailResult>;
  /** 缓存缺失时现场探测 providerId（只读）；缺失时直接失败。 */
  detectProviderId?: () => Promise<number | null>;
  /** 探测到 providerId 后写回缓存。 */
  rememberProviderId?: (accountKey: string, providerId: number) => void;
  /** 本机 cookie 记录的账号快照；缺失时视为"没有账号记录"。 */
  browser?: {
    listKnownLoginAccounts(): { current: SavedAccountEntry | null; saved: SavedAccountEntry[] };
    status?(refresh?: boolean): Promise<VbkStatusSnapshot>;
    listProviderContactCards?(providerId: number, keyword?: string): Promise<ProviderContactCard[]>;
  };
}

function toProductRecord(
  product: ProductSummary & { planVersion?: number; basicInfoSaved?: boolean },
): ProductReadRecord {
  return {
    id: product.id,
    name: product.name,
    status: product.status,
    ...(product.productId ? { productId: product.productId } : {}),
    ...(product.planVersion !== undefined ? { planVersion: product.planVersion } : {}),
    ...(product.basicInfoSaved !== undefined ? { basicInfoSaved: product.basicInfoSaved } : {}),
    ...(product.updatedAt ? { updatedAt: product.updatedAt } : {}),
  };
}

export function buildProductReadPort(context: ReadonlyPortContext): ProductReadPort {
  return {
    list: () => context.db.listProducts().map((product) => toProductRecord(product)),
    get: (id) => {
      const detail = context.db.getProduct(id);
      return detail ? toProductRecord(detail) : undefined;
    },
    readiness: (id) => {
      try {
        return typeof context.readiness === "function" ? context.readiness(id) : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

export function buildAccountReadPort(context: ReadonlyPortContext): AccountReadPort {
  return {
    accounts: (): AccountReadRecord[] => {
      const snapshot = typeof context.browser?.listKnownLoginAccounts === "function"
        ? context.browser.listKnownLoginAccounts()
        : { current: null, saved: [] };
      const entries: SavedAccountEntry[] = [
        ...(snapshot.current ? [snapshot.current] : []),
        ...snapshot.saved,
      ];
      return entries.map((entry) => {
        const fixed = context.db.getAccountFixedInfo(entry.accountName);
        const providerId = context.db.providerIdFor(entry.accountKey) ?? context.db.providerIdFor(entry.accountName);
        const butler = fixed.values.butlerName;
        return {
          accountKey: entry.accountKey,
          accountName: entry.accountName,
          active: snapshot.current?.accountKey === entry.accountKey,
          ...(providerId !== null && providerId !== undefined ? { providerId } : {}),
          ...(entry.lastUsedAt ? { savedAt: entry.lastUsedAt } : {}),
          ...(typeof fixed.values.servicePhone === "string" ? { servicePhone: fixed.values.servicePhone } : {}),
          ...(typeof butler === "string"
            ? { butlerName: butler }
            : butler
              ? { butlerName: butler.displayName }
              : {}),
        } satisfies AccountReadRecord;
      });
    },
  };
}


/**
 * VBK 只读端口：登录状态与账号来自现有 VBK 浏览器适配器。
 * 浏览器不可用（例如未初始化或当前环境没有浏览器）时如实返回，不编造登录态。
 */
export function buildVbkReadPort(context: ReadonlyPortContext): VbkReadPort {
  /** providerId 省略时先用缓存；缓存缺失才现场探测一次，都拿不到才报错。 */
  const cachedProviderId = (): { providerId: number; accountKey: string } | undefined => {
    const activeKey = context.db.getSetting("vbkActiveAccountKey")?.value?.trim();
    const byKey = activeKey ? context.db.providerIdFor(activeKey) : null;
    if (byKey && activeKey) return { providerId: byKey, accountKey: activeKey };
    const name = context.db.getSetting("vbkAccountName")?.value?.trim();
    const byName = name ? context.db.providerIdFor(name) : null;
    if (byName && name) return { providerId: byName, accountKey: name };
    return undefined;
  };

  const resolveProviderId = async (): Promise<number> => {
    const cached = cachedProviderId();
    if (cached) return cached.providerId;
    if (context.detectProviderId) {
      const detected = await context.detectProviderId();
      if (detected) {
        const accountKey = context.db.getSetting("vbkActiveAccountKey")?.value?.trim()
          ?? context.db.getSetting("vbkAccountName")?.value?.trim();
        if (accountKey) context.rememberProviderId?.(accountKey, detected);
        return detected;
      }
    }
    throw new Error("无法确定当前供应商 id：缓存缺失且当前会话探测不到，请先登录 VBK 或显式传入 providerId。");
  };

  return {
    status: async (options) => {
      if (typeof context.browser?.status !== "function") {
        return { loggedIn: false, message: "VBK 浏览器不可用，无法读取后台状态。" };
      }
      return context.browser.status(options?.refresh === true);
    },
    contacts: async (options) => {
      if (typeof context.browser?.listProviderContactCards !== "function") {
        throw new Error("VBK 浏览器不可用，无法读取联系人卡片。");
      }
      const providerId = options.providerId ?? await resolveProviderId();
      const cards = await context.browser.listProviderContactCards(providerId, options.keyword);
      return { providerId, cards };
    },
    searchPoi: async (keyword: string) => {
      if (typeof context.searchPoi !== "function") throw new Error("POI 查询能力不可用。");
      return context.searchPoi(keyword);
    },
  };
}
