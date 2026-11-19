/**
 * 三人同游服务端的业务读取：VBK 绑定（扩展用户身份）与 C 端订单（客户身份）。
 *
 * 契约来源（2026-11-17 核对）：
 *  - `GET /api/extension/vbk-bindings` → `{ items: [...], activeVbkAccountKey }`，需要扩展用户身份；
 *  - `GET /api/user/orders?status=` → 订单数组，需要客户身份；`GET /api/user/orders/<public_id>` 单条。
 * 身份缺失时服务端回 403 并说明缺哪种身份——传输层会抛 `TibetServiceScopeError`，不伪装成空数据。
 */

import {
  finiteNumber,
  queryString,
  record,
  text,
  TibetServiceError,
  type TibetTransport,
} from "./tibet-service-transport.js";

export interface TibetVbkBindingButler {
  contactCardId: number;
  displayName: string;
  providerId: number;
}

export interface TibetVbkBinding {
  vbkAccountKey: string;
  vbkAccountName: string;
  servicePhone: string;
  providerId: number | null;
  butler: TibetVbkBindingButler | null;
  lastUsedAt: string | null;
  updatedAt: string | null;
}

export interface TibetVbkBindingsSnapshot {
  items: TibetVbkBinding[];
  activeVbkAccountKey: string | null;
}

export interface TibetOrder {
  publicId: string;
  orderNo: string;
  serviceId: string | null;
  serviceTitle: string | null;
  destination: string | null;
  serviceType: string | null;
  travelDate: string | null;
  peopleCount: number | null;
  contactName: string | null;
  contactPhone: string | null;
  totalPrice: number | null;
  quotedPrice: number | null;
  payableUntil: string | null;
  status: string;
  createdAt: string | null;
}

/** 订单状态码 → 平台中文标签（tibet/api/models.py `CustomerOrder.STATUS_CHOICES`）。 */
export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending_quote: "待报价",
  pending_payment: "待支付",
  paid: "待出行",
  completed: "已完成",
  cancelled: "已取消",
};

function butlerOf(value: unknown): TibetVbkBindingButler | null {
  const item = record(value);
  if (!item) return null;
  const contactCardId = finiteNumber(item.contactCardId);
  const providerId = finiteNumber(item.providerId);
  const displayName = text(item.displayName);
  if (contactCardId === null || providerId === null || !displayName) return null;
  return { contactCardId, displayName, providerId };
}

function bindingOf(value: unknown): TibetVbkBinding | null {
  const item = record(value);
  if (!item) return null;
  const vbkAccountKey = text(item.vbkAccountKey);
  if (!vbkAccountKey) return null;
  return {
    vbkAccountKey,
    vbkAccountName: text(item.vbkAccountName) ?? "（未命名账号）",
    servicePhone: text(item.servicePhone) ?? "",
    providerId: finiteNumber(item.providerId),
    butler: butlerOf(item.butler),
    lastUsedAt: text(item.lastUsedAt),
    updatedAt: text(item.updatedAt),
  };
}

function orderOf(value: unknown): TibetOrder | null {
  const item = record(value);
  if (!item) return null;
  const publicId = text(item.id) ?? text(item.orderNo);
  const status = text(item.status);
  if (!publicId || !status) return null;
  return {
    publicId,
    orderNo: text(item.orderNo) ?? publicId,
    serviceId: text(item.serviceId),
    serviceTitle: text(item.serviceTitle),
    destination: text(item.destination),
    serviceType: text(item.serviceType),
    travelDate: text(item.travelDate),
    peopleCount: finiteNumber(item.peopleCount),
    contactName: text(item.contactName),
    contactPhone: text(item.contactPhone),
    totalPrice: finiteNumber(item.totalPrice),
    quotedPrice: finiteNumber(item.quotedPrice),
    payableUntil: text(item.payableUntil),
    status,
    createdAt: text(item.createdAt),
  };
}

export interface TibetBusinessReader {
  listVbkBindings(): Promise<TibetVbkBindingsSnapshot>;
  listOrders(options?: { status?: string }): Promise<TibetOrder[]>;
  getOrder(publicId: string): Promise<TibetOrder>;
}

export function createTibetBusinessReader(transport: TibetTransport): TibetBusinessReader {
  return {
    async listVbkBindings() {
      const data = await transport.get("/api/extension/vbk-bindings");
      const envelope = record(data);
      if (!envelope || !Array.isArray(envelope.items)) {
        throw new TibetServiceError("三人同游服务端 VBK 绑定格式不正确，请稍后重试。", 500);
      }
      const items: TibetVbkBinding[] = [];
      for (const raw of envelope.items) {
        const mapped = bindingOf(raw);
        if (mapped) items.push(mapped);
      }
      return { items, activeVbkAccountKey: text(envelope.activeVbkAccountKey) };
    },

    async listOrders(options = {}) {
      const data = await transport.get(`/api/user/orders${queryString({ status: options.status?.trim() })}`);
      if (!Array.isArray(data)) {
        throw new TibetServiceError("三人同游服务端订单列表格式不正确，请稍后重试。", 500);
      }
      const orders: TibetOrder[] = [];
      for (const raw of data) {
        const mapped = orderOf(raw);
        if (mapped) orders.push(mapped);
      }
      return orders;
    },

    async getOrder(publicId) {
      const id = publicId.trim();
      if (!/^\d{8,24}$/u.test(id)) throw new Error("订单号必须是数字串。");
      const order = orderOf(await transport.get(`/api/user/orders/${id}`));
      if (!order) throw new TibetServiceError("三人同游服务端订单详情格式不正确，请稍后重试。", 500);
      return order;
    },
  };
}
