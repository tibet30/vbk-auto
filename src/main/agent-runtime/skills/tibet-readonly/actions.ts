/**
 * 三人同游只读动作定义。
 *
 * 全部动作都是 `kind: "read"`：不申请审批、不写票据以外的副作用。
 * 参数校验在 `target()` 阶段完成——非法参数不会发出任何网络请求。
 */

import type { AgentSkillAction } from "../../types.js";
import {
  describeBindings,
  describeDetail,
  describeOrder,
  describeOrders,
  describePage,
  describePlatformReference,
  describeStatus,
  orderStatusLabel,
} from "./describe.js";
import { TIBET_READ_ACCOUNT, type TibetReadPort } from "./port.js";

const MAX_PAGE_SIZE = 50;

function positiveInteger(value: unknown, field: string, max?: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${field} 必须是正整数。`);
  if (max !== undefined && parsed > max) throw new Error(`${field} 不能超过 ${max}。`);
  return parsed;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} 必须是字符串。`);
  return value.trim() || undefined;
}

function optionalMoney(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${field} 必须是非负数字。`);
  return parsed;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} 必须是布尔值。`);
  return value;
}

const SORTS = ["sort_order_asc", "sort_order_desc", "price_asc", "price_desc", "hot_first"] as const;

function queryFrom(args: Record<string, unknown>) {
  const search = optionalText(args.search, "search");
  const country = optionalText(args.country, "country");
  const city = optionalText(args.city, "city");
  const type = optionalText(args.type, "type");
  const hot = optionalBoolean(args.hot, "hot");
  const priceMin = optionalMoney(args.priceMin, "priceMin");
  const priceMax = optionalMoney(args.priceMax, "priceMax");
  const page = positiveInteger(args.page, "page");
  const pageSize = positiveInteger(args.pageSize, "pageSize", MAX_PAGE_SIZE);
  return {
    ...(search ? { search } : {}),
    ...(country ? { country } : {}),
    ...(city ? { city } : {}),
    ...(type ? { type } : {}),
    ...(hot !== undefined ? { hot } : {}),
    ...(priceMin !== undefined ? { priceMin } : {}),
    ...(priceMax !== undefined ? { priceMax } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(pageSize !== undefined ? { pageSize } : {}),
  };
}

function adminQueryFrom(args: Record<string, unknown>) {
  const base = queryFrom(args);
  const includeDisabled = optionalBoolean(args.includeDisabled, "includeDisabled");
  const sort = optionalText(args.sort, "sort");
  if (sort && !(SORTS as readonly string[]).includes(sort)) {
    throw new Error(`sort 只能是 ${SORTS.join(" / ")}。`);
  }
  return {
    ...base,
    ...(includeDisabled !== undefined ? { includeDisabled } : {}),
    ...(sort ? { sort: sort as (typeof SORTS)[number] } : {}),
  };
}

export function statusAction(port: TibetReadPort): AgentSkillAction {
  return {
    name: "tibet.status",
    kind: "read",
    label: "查询三人同游服务令牌状态",
    risk: "low",
    description: "读取三人同游服务端服务令牌的状态、权限、有效期与可用身份；只读，不修改任何服务端数据。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async target() {
      return { action: "tibet.status", targetKey: "tibet:status", accountKey: TIBET_READ_ACCOUNT, risk: "low" };
    },
    async execute() {
      const record = await port.status();
      return {
        content: describeStatus(record),
        summary: record.configured ? `令牌${record.statusLabel ?? "状态未知"}` : "未配置服务令牌",
        result: `configured=${record.configured} status=${record.statusLabel ?? "unknown"} identities=${record.identities?.length ?? 0}`,
      };
    },
  };
}

export function servicesAction(port: TibetReadPort): AgentSkillAction {
  return {
    name: "tibet.services",
    kind: "read",
    label: "查询三人同游在售服务目录",
    risk: "low",
    description: "按关键词与筛选条件查询三人同游平台的公共在售服务目录（标题、地区、类型、时长、起价）；只读。",
    parameters: {
      type: "object",
      properties: {
        search: { type: "string", description: "关键词，匹配标题/副标题/标签；后台口径还支持按 public_id 精确匹配" },
        country: { type: "string", description: "国家 code，例如 au" },
        city: { type: "string", description: "城市 code，例如 sydney" },
        type: { type: "string", description: "服务类型 code，例如 sightseeing" },
        hot: { type: "boolean", description: "只看热门" },
        priceMin: { type: "number", description: "起价下限" },
        priceMax: { type: "number", description: "起价上限" },
        page: { type: "number", description: "页码，从 1 开始" },
        pageSize: { type: "number", description: `每页条数，最多 ${MAX_PAGE_SIZE}` },
      },
      additionalProperties: false,
    },
    async target(args) {
      const query = queryFrom(args);
      const key = ["tibet:services", query.search, query.city, query.country, query.type, query.page]
        .filter((part) => part !== undefined && part !== "").join(":");
      return { action: "tibet.services", targetKey: key, accountKey: TIBET_READ_ACCOUNT, risk: "low" };
    },
    async execute(args) {
      const page = await port.listServices(queryFrom(args));
      return {
        content: describePage(page),
        summary: `服务目录：本页 ${page.items.length} 条，共 ${page.total} 条`,
        result: `total=${page.total} page=${page.page} pageSize=${page.pageSize} items=${page.items.length}`,
      };
    },
  };
}

export function adminServicesAction(port: TibetReadPort): AgentSkillAction {
  return {
    name: "tibet.adminServices",
    kind: "read",
    label: "查询三人同游后台服务目录",
    risk: "low",
    description: "以继承的管理员身份读取后台服务目录（可含已下架项、排序值与上下架状态）；只读，不能改上下架。",
    parameters: {
      type: "object",
      properties: {
        search: { type: "string", description: "关键词；支持 public_id 精确匹配" },
        country: { type: "string" },
        city: { type: "string" },
        type: { type: "string" },
        hot: { type: "boolean" },
        priceMin: { type: "number" },
        priceMax: { type: "number" },
        includeDisabled: { type: "boolean", description: "是否包含已下架服务" },
        sort: { type: "string", description: "sort_order_asc / sort_order_desc / price_asc / price_desc / hot_first" },
        page: { type: "number" },
        pageSize: { type: "number" },
      },
      additionalProperties: false,
    },
    async target(args) {
      const query = adminQueryFrom(args);
      const key = ["tibet:admin-services", query.search, query.city, query.page, query.includeDisabled ? "all" : "enabled"]
        .filter((part) => part !== undefined && part !== "").join(":");
      return { action: "tibet.adminServices", targetKey: key, accountKey: TIBET_READ_ACCOUNT, risk: "low" };
    },
    async execute(args) {
      const page = await port.listAdminServices(adminQueryFrom(args));
      const disabled = page.items.filter((item) => item.enabled === false).length;
      return {
        content: describePage(page, { admin: true }),
        summary: `后台服务目录：本页 ${page.items.length} 条（下架 ${disabled} 条），共 ${page.total} 条`,
        result: `total=${page.total} page=${page.page} items=${page.items.length} disabled=${disabled}`,
      };
    },
  };
}

export function serviceDetailAction(port: TibetReadPort): AgentSkillAction {
  return {
    name: "tibet.service",
    kind: "read",
    label: "查询单个服务详情",
    risk: "low",
    description: "按 public_id 读取三人同游平台单个服务的亮点、包含/不包含、集合说明与取消规则；只读。",
    parameters: {
      type: "object",
      properties: { publicId: { type: "string", description: "服务 public_id（18 位数字）" } },
      required: ["publicId"],
      additionalProperties: false,
    },
    async target(args) {
      const publicId = typeof args.publicId === "string" ? args.publicId.trim() : "";
      if (!publicId) throw new Error("缺少必填参数 publicId。");
      return { action: "tibet.service", targetKey: `tibet:service:${publicId}`, accountKey: TIBET_READ_ACCOUNT, risk: "low" };
    },
    async execute(args) {
      const detail = await port.getService(String(args.publicId).trim());
      return {
        content: describeDetail(detail),
        summary: `服务详情：${detail.title}`,
        result: `publicId=${detail.publicId} priceFrom=${detail.priceFrom ?? "none"}`,
      };
    },
  };
}

export function vbkBindingsAction(port: TibetReadPort): AgentSkillAction {
  return {
    name: "tibet.vbkBindings",
    kind: "read",
    label: "查询三人同游侧的 VBK 账号绑定",
    risk: "low",
    description: "以扩展用户身份读取本账号在三人同游平台保存的 VBK 账号绑定（管家联系人、400 电话、供应商 id、当前使用账号）；只读。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async target() {
      return { action: "tibet.vbkBindings", targetKey: "tibet:vbk-bindings", accountKey: TIBET_READ_ACCOUNT, risk: "low" };
    },
    async execute() {
      const snapshot = await port.listVbkBindings();
      return {
        content: describeBindings(snapshot.items, snapshot.activeVbkAccountKey),
        summary: `VBK 绑定：${snapshot.items.length} 个`,
        result: `items=${snapshot.items.length} active=${snapshot.activeVbkAccountKey ?? "none"}`,
      };
    },
  };
}

export function ordersAction(port: TibetReadPort): AgentSkillAction {
  return {
    name: "tibet.orders",
    kind: "read",
    label: "查询三人同游客户订单",
    risk: "low",
    description: "以客户身份读取该账号在三人同游平台的订单列表（服务、状态、金额、出行日期、人数、联系人）；可按状态筛选，只读。",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "订单状态：pending_quote（待报价）/ pending_payment（待支付）/ paid（待出行）/ completed（已完成）/ cancelled（已取消）",
        },
      },
      additionalProperties: false,
    },
    async target(args) {
      const status = optionalText(args.status, "status");
      if (status && !(status in { pending_quote: 1, pending_payment: 1, paid: 1, completed: 1, cancelled: 1 })) {
        throw new Error("status 只能是 pending_quote / pending_payment / paid / completed / cancelled。");
      }
      return {
        action: "tibet.orders",
        targetKey: `tibet:orders:${status ?? "all"}`,
        accountKey: TIBET_READ_ACCOUNT,
        risk: "low",
      };
    },
    async execute(args) {
      const status = optionalText(args.status, "status");
      const orders = await port.listOrders(status ? { status } : {});
      return {
        content: describeOrders(orders, status),
        summary: `订单：${orders.length} 条${status ? `（${orderStatusLabel(status)}）` : ""}`,
        result: `count=${orders.length} status=${status ?? "all"}`,
      };
    },
  };
}

export function orderDetailAction(port: TibetReadPort): AgentSkillAction {
  return {
    name: "tibet.order",
    kind: "read",
    label: "查询单笔订单详情",
    risk: "low",
    description: "按订单号读取该客户账号下单笔订单的详情（服务、日期、人数、联系人、金额、支付截止）；只读。",
    parameters: {
      type: "object",
      properties: { orderNo: { type: "string", description: "订单号（public_id，数字串）" } },
      required: ["orderNo"],
      additionalProperties: false,
    },
    async target(args) {
      const orderNo = typeof args.orderNo === "string" ? args.orderNo.trim() : "";
      if (!orderNo) throw new Error("缺少必填参数 orderNo。");
      return { action: "tibet.order", targetKey: `tibet:order:${orderNo}`, accountKey: TIBET_READ_ACCOUNT, risk: "low" };
    },
    async execute(args) {
      const order = await port.getOrder(String(args.orderNo).trim());
      return {
        content: describeOrder(order),
        summary: `订单详情：${order.orderNo}（${orderStatusLabel(order.status)}）`,
        result: `orderNo=${order.orderNo} status=${order.status}`,
      };
    },
  };
}


export function productReferenceAction(port: TibetReadPort): AgentSkillAction {
  return {
    name: "tibet.productReference",
    kind: "read",
    label: "比对平台在售服务（定价参考）",
    risk: "low",
    description: "按本地产品的标题与城市，在三人同游平台找出可能对应的在售服务及其起价，作为定价参考；只读，不修改产品。",
    parameters: {
      type: "object",
      properties: { productId: { type: "string", description: "本地产品 id" } },
      required: ["productId"],
      additionalProperties: false,
    },
    async target(args) {
      const productId = typeof args.productId === "string" ? args.productId.trim() : "";
      if (!productId) throw new Error("缺少必填参数 productId。");
      return {
        action: "tibet.productReference",
        targetKey: `tibet:product-reference:${productId}`,
        accountKey: TIBET_READ_ACCOUNT,
        risk: "low",
      };
    },
    async execute(args) {
      const record = await port.productReference(String(args.productId).trim());
      return {
        content: describePlatformReference(record),
        summary: `平台参考：${record.matches.length} 条相近服务`,
        result: `matches=${record.matches.length} configured=${record.configured}`,
      };
    },
  };
}
