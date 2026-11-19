/**
 * 三人同游服务端只读端口的真实装配。
 *
 * 凭证由设置页保存到本机 0600 文件，环境变量 `TIBET_SERVICE_TOKEN` 可临时覆盖；
 * 解析器在每次请求前读一次，所以设置页改完立刻生效，不需要重建运行时。
 * 未配置时端口仍然装配：公共目录照常可读，令牌自检如实报「未配置」。
 *
 * 这里只有读：写动作必须走动作计划 → 审批 → 收据，并且要同时具备 preview 与 reconcile，
 * 装配期由 `assertBackendWritesAreVerifiable()` 兜底。
 */

import {
  createTibetServiceClient,
  TibetServiceAuthError,
  type TibetServiceClient,
} from "../infrastructure/tibet-service-client.js";
import type { TibetServiceTokenStore } from "../infrastructure/tibet-service-token-store.js";
import { buildPlatformReference, type PlatformReferenceInput } from "../infrastructure/tibet-platform-reference.js";
import type { MainIpcContext } from "../ipc/context.js";
import type {
  TibetAdminCatalogQueryRecord,
  TibetCatalogDetailRecord,
  TibetCatalogPageRecord,
  TibetCatalogQueryRecord,
  TibetCatalogServiceRecord,
  TibetOrderRecord,
  TibetReadPort,
  TibetStatusRecord,
  TibetVbkBindingRecord,
} from "../agent-runtime/index.js";

function toServiceRecord(service: {
  publicId: string;
  title: string;
  subtitle: string | null;
  countryCode: string | null;
  cityCode: string | null;
  serviceType: string | null;
  durationLabel: string | null;
  priceFrom: number | null;
  availableLabel: string | null;
  tags: string[];
  hot: boolean;
}): TibetCatalogServiceRecord {
  return {
    publicId: service.publicId,
    title: service.title,
    ...(service.subtitle ? { subtitle: service.subtitle } : {}),
    ...(service.countryCode ? { countryCode: service.countryCode } : {}),
    ...(service.cityCode ? { cityCode: service.cityCode } : {}),
    ...(service.serviceType ? { serviceType: service.serviceType } : {}),
    ...(service.durationLabel ? { durationLabel: service.durationLabel } : {}),
    priceFrom: service.priceFrom,
    ...(service.availableLabel ? { availableLabel: service.availableLabel } : {}),
    tags: service.tags,
    hot: service.hot,
  };
}

function toPageRecord(page: { items: ReturnType<typeof toServiceRecord>[]; total: number; page: number; pageSize: number }): TibetCatalogPageRecord {
  return { items: page.items, total: page.total, page: page.page, pageSize: page.pageSize };
}

export interface TibetAdapterOptions {
  /** 本地产品读取（只读投影）：用于「按产品比对平台在售服务」。 */
  loadProduct?: (productId: string) => PlatformReferenceInput | undefined;
}

export function buildTibetReadPort(
  client: TibetServiceClient = createTibetServiceClient(),
  tokenStore?: TibetServiceTokenStore,
  options: TibetAdapterOptions = {},
): TibetReadPort {
  return {
    async status(): Promise<TibetStatusRecord> {
      if (!client.configured()) {
        return {
          configured: false,
          message: tokenStore
            ? "未配置服务令牌：可在「设置 → 三人同游服务令牌」填入，或用环境变量 TIBET_SERVICE_TOKEN 临时覆盖。"
            : "未配置服务令牌（环境变量 TIBET_SERVICE_TOKEN，需 stk_ 前缀）。",
        };
      }
      try {
        const identity = await client.selfCheck();
        return {
          configured: true,
          name: identity.name,
          statusLabel: identity.statusLabel,
          permissions: identity.permissionLabels.length ? identity.permissionLabels : identity.permissions,
          expiresAt: identity.expiresAt,
          remainingDays: identity.remainingDays,
          bound: identity.boundIdentity
            ? { label: identity.boundIdentity.label, key: identity.boundIdentity.key }
            : null,
          identities: identity.boundIdentities.map((item) => ({
            type: item.type,
            label: item.label,
            key: item.key,
            inherited: item.inherited,
          })),
          message: "",
        };
      } catch (error) {
        // 令牌无效/过期是"状态结论"，如实返回；网络与协议故障必须抛出去记 failed。
        if (error instanceof TibetServiceAuthError) {
          return { configured: true, message: error.message };
        }
        throw error;
      }
    },

    async listServices(query: TibetCatalogQueryRecord = {}): Promise<TibetCatalogPageRecord> {
      const page = await client.listServices(query);
      return toPageRecord({ ...page, items: page.items.map(toServiceRecord) });
    },

    async getService(publicId: string): Promise<TibetCatalogDetailRecord> {
      const detail = await client.getService(publicId);
      return {
        ...toServiceRecord(detail),
        highlights: detail.highlights,
        includes: detail.includes,
        excludes: detail.excludes,
        ...(detail.meeting ? { meeting: detail.meeting } : {}),
        notices: detail.notices,
        ...(detail.cancelPolicy ? { cancelPolicy: detail.cancelPolicy } : {}),
      };
    },

    async listAdminServices(query: TibetAdminCatalogQueryRecord = {}): Promise<TibetCatalogPageRecord> {
      const page = await client.listAdminServices(query);
      return toPageRecord({ ...page, items: page.items.map(toServiceRecord) });
    },

    async listVbkBindings(): Promise<{ items: TibetVbkBindingRecord[]; activeVbkAccountKey: string | null }> {
      const snapshot = await client.listVbkBindings();
      return {
        activeVbkAccountKey: snapshot.activeVbkAccountKey,
        items: snapshot.items.map((item) => ({
          vbkAccountKey: item.vbkAccountKey,
          vbkAccountName: item.vbkAccountName,
          servicePhone: item.servicePhone,
          providerId: item.providerId,
          butler: item.butler,
          lastUsedAt: item.lastUsedAt,
        })),
      };
    },

    async listOrders(query: { status?: string } = {}): Promise<TibetOrderRecord[]> {
      const orders = await client.listOrders(query);
      return orders.map(toOrderRecord);
    },

    async getOrder(publicId: string): Promise<TibetOrderRecord> {
      return toOrderRecord(await client.getOrder(publicId));
    },

    async productReference(productId: string) {
      const input = options.loadProduct?.(productId);
      if (!input) throw new Error(`本地产品不存在或缺少标题：${productId}`);
      const result = await buildPlatformReference(client, input);
      return {
        configured: result.configured,
        title: input.title,
        cities: result.query.cities,
        matches: result.matches.map((match) => ({
          publicId: match.publicId,
          title: match.title,
          priceFrom: match.priceFrom,
          priceGap: match.priceGap,
          durationLabel: match.durationLabel,
          similarity: match.similarity,
          reasons: match.reasons,
        })),
        message: result.message,
      };
    },
  };
}

function toOrderRecord(order: {
  publicId: string;
  orderNo: string;
  serviceId: string | null;
  serviceTitle: string | null;
  destination: string | null;
  travelDate: string | null;
  peopleCount: number | null;
  contactName: string | null;
  contactPhone: string | null;
  totalPrice: number | null;
  payableUntil: string | null;
  status: string;
  createdAt: string | null;
}): TibetOrderRecord {
  return {
    publicId: order.publicId,
    orderNo: order.orderNo,
    serviceId: order.serviceId,
    serviceTitle: order.serviceTitle,
    destination: order.destination,
    travelDate: order.travelDate,
    peopleCount: order.peopleCount,
    contactName: order.contactName,
    contactPhone: order.contactPhone,
    totalPrice: order.totalPrice,
    payableUntil: order.payableUntil,
    status: order.status,
    createdAt: order.createdAt,
  };
}


/**
 * 从主进程上下文装配只读端口。
 *
 * 令牌解析器每次请求前读一次本机存储，所以设置页改完立即生效；
 * 本地产品投影只给「平台在售参考」用，缺字段就留空，不改产品事实。
 */
export function buildTibetReadPortFromContext(context: MainIpcContext): TibetReadPort {
  const store = context.tibetServiceTokens;
  return buildTibetReadPort(
    createTibetServiceClient({ token: () => store?.get() ?? null }),
    store,
    {
      loadProduct: (productId) => {
        const record = context.db.getProduct(productId);
        return record ? platformReferenceInputOf(record) : undefined;
      },
    },
  );
}

/**
 * 从本地产品投影出「平台参考比对」需要的字段：标题、城市、天数、成人价。
 * 只读投影；缺字段留空，由比对逻辑如实说明。
 */
export function platformReferenceInputOf(record: { name?: string; product?: unknown }): PlatformReferenceInput {
  const product = (record.product ?? {}) as {
    basicInfo?: { title?: unknown; meetingCity?: unknown; destinationCity?: unknown; days?: unknown };
    commercial?: { pricing?: { adult?: unknown } };
  };
  const basic = product.basicInfo ?? {};
  const title = typeof basic.title === "string" && basic.title.trim()
    ? basic.title.trim()
    : (record.name ?? "").trim();
  const adult = product.commercial?.pricing?.adult;
  return {
    title,
    ...(typeof basic.meetingCity === "string" && basic.meetingCity.trim() ? { meetingCity: basic.meetingCity.trim() } : {}),
    ...(typeof basic.destinationCity === "string" && basic.destinationCity.trim() ? { destinationCity: basic.destinationCity.trim() } : {}),
    ...(typeof basic.days === "number" ? { days: basic.days } : {}),
    ...(typeof adult === "number" ? { adultPrice: adult } : {}),
  };
}
