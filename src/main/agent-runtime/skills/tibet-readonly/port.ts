/**
 * 三人同游只读端口的记录类型：Skill 与主进程之间的契约。
 *
 * 这里只描述「能读到什么」，不描述怎么读；凭证与 HTTP 都在主进程的客户端里，
 * Skill 拿不到令牌本身，因此结构上不可能绕开服务端身份校验。
 */

/** 服务域账号键：与 VBK、产品、本地文件分开，便于将来独立限流。 */
export const TIBET_READ_ACCOUNT = "tibet-read";

export interface TibetStatusRecord {
  /** 是否配置了格式合法的服务令牌（未配置时公共目录仍可读）。 */
  configured: boolean;
  name?: string;
  statusLabel?: string;
  permissions?: string[];
  expiresAt?: string;
  remainingDays?: number | null;
  /** 主身份（业务绑定优先，其次创建者继承）；都没有时 null。 */
  bound?: { label: string; key: string } | null;
  /** 全部已生效身份：同一个人可能有客户 / 扩展用户 / 管理员多个账号。 */
  identities?: { type: string; label: string; key: string; inherited: boolean }[];
  message: string;
}

export interface TibetCatalogServiceRecord {
  publicId: string;
  title: string;
  subtitle?: string;
  countryCode?: string;
  cityCode?: string;
  serviceType?: string;
  durationLabel?: string;
  priceFrom?: number | null;
  availableLabel?: string;
  tags?: string[];
  hot?: boolean;
  /** 后台口径才有：是否上架。 */
  enabled?: boolean;
}

export interface TibetCatalogDetailRecord extends TibetCatalogServiceRecord {
  highlights?: string[];
  includes?: string[];
  excludes?: string[];
  meeting?: string;
  notices?: string[];
  cancelPolicy?: string;
}

export interface TibetCatalogPageRecord {
  items: TibetCatalogServiceRecord[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TibetCatalogQueryRecord {
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

/** 后台目录查询：额外支持「含已下架」与排序。 */
export interface TibetAdminCatalogQueryRecord extends TibetCatalogQueryRecord {
  includeDisabled?: boolean;
  sort?: "sort_order_asc" | "sort_order_desc" | "price_asc" | "price_desc" | "hot_first";
}

export interface TibetVbkBindingRecord {
  vbkAccountKey: string;
  vbkAccountName: string;
  servicePhone: string;
  providerId?: number | null;
  butler?: { contactCardId: number; displayName: string; providerId: number } | null;
  lastUsedAt?: string | null;
}

export interface TibetOrderRecord {
  publicId: string;
  orderNo: string;
  serviceId?: string | null;
  serviceTitle?: string | null;
  destination?: string | null;
  travelDate?: string | null;
  peopleCount?: number | null;
  contactName?: string | null;
  contactPhone?: string | null;
  totalPrice?: number | null;
  payableUntil?: string | null;
  status: string;
  createdAt?: string | null;
}

/** 平台在售参考：给本地产品找平台侧可能对应的服务（只参考，不写产品事实）。 */
export interface TibetPlatformReferenceRecord {
  configured: boolean;
  title: string;
  cities: string[];
  matches: {
    publicId: string;
    title: string;
    priceFrom: number | null;
    priceGap: number | null;
    durationLabel?: string | null;
    similarity: number;
    reasons: string[];
  }[];
  message: string;
}

/** 只读端口：由主进程用服务端客户端装配，Skill 不直接持有凭证。 */
export interface TibetReadPort {
  status(): Promise<TibetStatusRecord>;
  listServices(query?: TibetCatalogQueryRecord): Promise<TibetCatalogPageRecord>;
  getService(publicId: string): Promise<TibetCatalogDetailRecord>;
  listAdminServices(query?: TibetAdminCatalogQueryRecord): Promise<TibetCatalogPageRecord>;
  listVbkBindings(): Promise<{ items: TibetVbkBindingRecord[]; activeVbkAccountKey: string | null }>;
  listOrders(query?: { status?: string }): Promise<TibetOrderRecord[]>;
  getOrder(publicId: string): Promise<TibetOrderRecord>;
  /** 按本地产品比对平台在售服务（定价参考）；产品不存在时抛错。 */
  productReference(productId: string): Promise<TibetPlatformReferenceRecord>;
}
