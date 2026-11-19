/**
 * 三人同游服务端的公共目录读取（无需身份，任何令牌甚至无令牌都可读）。
 *
 * 契约来源：`tibet/api/views.py` 的 `list_services` / `get_service`（2026-11-17 核对）。
 */

import {
  finiteNumber,
  queryString,
  record,
  strings,
  text,
  TibetServiceError,
  type TibetTransport,
} from "./tibet-service-transport.js";

const PUBLIC_ID_PATTERN = /^\d{18}$/u;

export interface TibetCatalogService {
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
  /** 仅后台接口返回：是否上架。 */
  enabled?: boolean;
  /** 仅后台接口返回：排序值。 */
  sortOrder?: number | null;
}

export interface TibetCatalogDetail extends TibetCatalogService {
  highlights: string[];
  includes: string[];
  excludes: string[];
  meeting: string | null;
  notices: string[];
  cancelPolicy: string | null;
}

export interface TibetCatalogPage {
  items: TibetCatalogService[];
  total: number;
  page: number;
  pageSize: number;
}

/** 平台字典项（`/api/dictionaries` 按 type 分组返回，这里拍平）。 */
export interface TibetDictionaryItem {
  type: string;
  code: string;
  name: string;
}

export interface TibetCatalogQuery {
  search?: string;
  country?: string;
  city?: string;
  type?: string;
  hot?: boolean;
  priceMin?: number;
  priceMax?: number;
  page?: number;
  pageSize?: number;
}

/** 后台目录额外支持：是否包含已下架、排序方式。 */
export interface TibetAdminCatalogQuery extends TibetCatalogQuery {
  includeDisabled?: boolean;
  sort?: "sort_order_asc" | "sort_order_desc" | "price_asc" | "price_desc" | "hot_first";
}

function serviceOf(value: unknown, withAdminFields = false): TibetCatalogService | null {
  const item = record(value);
  if (!item) return null;
  const publicId = text(item.public_id);
  const title = text(item.title);
  if (!publicId || !title) return null;
  return {
    publicId,
    title,
    subtitle: text(item.subtitle),
    countryCode: text(item.country_code),
    cityCode: text(item.city_code),
    serviceType: text(item.service_type),
    durationLabel: text(item.duration_label),
    priceFrom: finiteNumber(item.price_from),
    availableLabel: text(item.available_label),
    tags: strings(item.tags),
    hot: item.hot === true,
    ...(withAdminFields && typeof item.is_enabled === "boolean" ? { enabled: item.is_enabled } : {}),
    ...(withAdminFields ? { sortOrder: finiteNumber(item.sort_order) } : {}),
  };
}

function pageOf(value: unknown, fallbackPage: number, fallbackSize: number, admin = false): TibetCatalogPage {
  const data = record(value);
  if (!data || !Array.isArray(data.items)) {
    throw new TibetServiceError("三人同游服务端服务目录格式不正确，请稍后重试。", 500);
  }
  const items: TibetCatalogService[] = [];
  for (const raw of data.items) {
    const mapped = serviceOf(raw, admin);
    if (mapped) items.push(mapped);
  }
  return {
    items,
    total: finiteNumber(data.total) ?? items.length,
    page: finiteNumber(data.page) ?? fallbackPage,
    pageSize: finiteNumber(data.page_size) ?? fallbackSize,
  };
}

function catalogQuery(query: TibetCatalogQuery = {}): string {
  return queryString({
    search: query.search?.trim(),
    country: query.country?.trim(),
    city: query.city?.trim(),
    type: query.type?.trim(),
    hot: query.hot,
    price_min: query.priceMin,
    price_max: query.priceMax,
    page: query.page,
    page_size: query.pageSize,
  });
}

export interface TibetCatalogReader {
  listServices(query?: TibetCatalogQuery): Promise<TibetCatalogPage>;
  getService(publicId: string): Promise<TibetCatalogDetail>;
  /** 后台管理口径：可含已下架项与排序字段（需要管理员身份）。 */
  listAdminServices(query?: TibetAdminCatalogQuery): Promise<TibetCatalogPage>;
  /** 平台字典（国家/城市/类型等），用于把中文城市名映射成 code。 */
  listDictionaries(): Promise<TibetDictionaryItem[]>;
}

export function createTibetCatalogReader(transport: TibetTransport): TibetCatalogReader {
  return {
    async listServices(query = {}) {
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 20;
      return pageOf(
        await transport.get(`/api/services${catalogQuery({ ...query, page, pageSize })}`),
        page,
        pageSize,
      );
    },

    async getService(publicId) {
      const id = publicId.trim();
      if (!PUBLIC_ID_PATTERN.test(id)) throw new Error("public_id 必须是 18 位数字。");
      const data = await transport.get(`/api/services/${id}`);
      const base = serviceOf(data);
      const item = record(data);
      if (!base || !item) throw new TibetServiceError("三人同游服务端服务详情格式不正确，请稍后重试。", 500);
      return {
        ...base,
        highlights: strings(item.highlights),
        includes: strings(item.includes),
        excludes: strings(item.excludes),
        meeting: text(item.meeting),
        notices: strings(item.notice),
        cancelPolicy: text(item.cancel_policy),
      };
    },

    async listAdminServices(query = {}) {
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 20;
      const path = `/api/admin/services${queryString({
        include_disabled: query.includeDisabled ? "1" : undefined,
        search: query.search?.trim(),
        country: query.country?.trim(),
        city: query.city?.trim(),
        type: query.type?.trim(),
        hot: query.hot,
        price_min: query.priceMin,
        price_max: query.priceMax,
        sort: query.sort,
        page,
        page_size: pageSize,
      })}`;
      return pageOf(await transport.get(path), page, pageSize, true);
    },

    async listDictionaries() {
      const data = record(await transport.get("/api/dictionaries"));
      if (!data) throw new TibetServiceError("三人同游服务端字典格式不正确，请稍后重试。", 500);
      const items: TibetDictionaryItem[] = [];
      for (const [type, value] of Object.entries(data)) {
        if (!Array.isArray(value)) continue;
        for (const raw of value) {
          const item = record(raw);
          const code = text(item?.code);
          // 平台字典的展示名有 `name`（部分类型）与 `label`（城市/国家）两种写法，
          // 缺一不可：只认 `name` 时城市字典会被整体丢弃，中文城市名就映射不到 code。
          const name = text(item?.name) ?? text(item?.label);
          if (!code || !name) continue;
          items.push({ type, code, name });
        }
      }
      return items;
    },
  };
}
