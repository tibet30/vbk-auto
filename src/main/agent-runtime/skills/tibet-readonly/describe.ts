/**
 * 三人同游只读结果的「人话」渲染。
 *
 * 原则：只呈现端口给的事实。缺字段就说缺，不推断、不补全、不把 0 当未知。
 */

import type {
  TibetCatalogDetailRecord,
  TibetPlatformReferenceRecord,
  TibetCatalogPageRecord,
  TibetCatalogServiceRecord,
  TibetOrderRecord,
  TibetStatusRecord,
  TibetVbkBindingRecord,
} from "./port.js";

const LIST_LIMIT = 15;

/** 订单状态码 → 中文；未知状态原样展示，不猜。 */
const ORDER_STATUS_LABELS: Record<string, string> = {
  pending_quote: "待报价",
  pending_payment: "待支付",
  paid: "待出行",
  completed: "已完成",
  cancelled: "已取消",
};

export function describeStatus(record: TibetStatusRecord): string {
  if (!record.configured) {
    return [
      `三人同游服务令牌未配置：${record.message}`,
      "公共服务目录仍可查询（目录接口不需要令牌）。",
    ].join("\n");
  }
  const identities = record.identities?.length
    ? record.identities.map((identity) => {
      const tag = identity.inherited ? "继承创建者" : "显式绑定";
      return `${identity.label}（${identity.key || "未公开 key"}，${tag}）`;
    })
    : [];
  const lines = [
    `三人同游服务令牌「${record.name ?? "未命名"}」：${record.statusLabel ?? "状态未知"}`,
    record.permissions?.length ? `权限：${record.permissions.join("、")}` : "",
    record.expiresAt
      ? `有效期至 ${record.expiresAt}${typeof record.remainingDays === "number" ? `（剩余 ${record.remainingDays} 天）` : ""}`
      : "",
    identities.length
      ? `可用身份：${identities.join("；")}`
      : record.bound
        ? `可用身份：${record.bound.label}（${record.bound.key || "未公开 key"}）`
        : "可用身份：未绑定——只能访问公共接口，个人数据接口会被服务端拒绝（403）",
    record.message ? `服务端说明：${record.message}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export function priceLabel(value: number | null | undefined): string {
  return typeof value === "number" ? `¥${value}` : "价格未标注";
}

function serviceMeta(item: TibetCatalogServiceRecord): string {
  const place = [item.countryCode, item.cityCode].filter(Boolean).join("/");
  return [place, item.serviceType, item.durationLabel, priceLabel(item.priceFrom)]
    .filter(Boolean).join("，");
}

export function describeService(item: TibetCatalogServiceRecord): string {
  const extra = [item.availableLabel, item.hot ? "热门" : "", item.enabled === false ? "已下架" : ""]
    .filter(Boolean).join("，");
  const meta = serviceMeta(item);
  return `- ${item.title}（public_id ${item.publicId}）${meta ? `：${meta}` : ""}${extra ? `；${extra}` : ""}`;
}

export function describePage(page: TibetCatalogPageRecord, options: { admin?: boolean } = {}): string {
  const scope = options.admin ? "后台服务目录（含管理字段）" : "服务目录";
  if (!page.items.length) {
    return `${scope}第 ${page.page} 页没有匹配的服务（共 ${page.total} 条）。`;
  }
  const shown = page.items.slice(0, LIST_LIMIT);
  const more = page.items.length > shown.length ? `\n…本页另有 ${page.items.length - shown.length} 条未展示` : "";
  return [
    `${scope}共 ${page.total} 条，第 ${page.page} 页（每页 ${page.pageSize} 条）：`,
    ...shown.map(describeService),
    more,
  ].filter(Boolean).join("\n");
}

export function describeDetail(item: TibetCatalogDetailRecord): string {
  const lines = [
    `${item.title}（public_id ${item.publicId}）`,
    item.subtitle ? `副标题：${item.subtitle}` : "",
    `地区/类型：${[item.countryCode, item.cityCode].filter(Boolean).join("/") || "未标注"}，${item.serviceType ?? "类型未标注"}`,
    `时长：${item.durationLabel ?? "未标注"}；起价：${priceLabel(item.priceFrom)}；可售说明：${item.availableLabel ?? "未标注"}`,
    item.highlights?.length ? `亮点：${item.highlights.join("、")}` : "",
    item.includes?.length ? `包含：${item.includes.join("、")}` : "",
    item.excludes?.length ? `不包含：${item.excludes.join("、")}` : "",
    item.meeting ? `集合说明：${item.meeting}` : "",
    item.notices?.length ? `须知：${item.notices.join("；")}` : "",
    item.cancelPolicy ? `取消规则：${item.cancelPolicy}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export function describeBindings(
  items: readonly TibetVbkBindingRecord[],
  activeVbkAccountKey: string | null,
): string {
  if (!items.length) return "该账号还没有保存过 VBK 绑定。";
  const lines = items.slice(0, LIST_LIMIT).map((item) => {
    const butler = item.butler
      ? `管家 ${item.butler.displayName}（联系人卡 ${item.butler.contactCardId}）`
      : "未配置管家联系人";
    const active = item.vbkAccountKey === activeVbkAccountKey ? " ← 当前使用" : "";
    const phone = item.servicePhone ? `，400 电话 ${item.servicePhone}` : "";
    return `- ${item.vbkAccountName}（${item.vbkAccountKey}）：${butler}${item.providerId ? `，供应商 ${item.providerId}` : ""}${phone}${active}`;
  });
  const more = items.length > lines.length ? `\n…另有 ${items.length - lines.length} 个未展示` : "";
  return `VBK 绑定 ${items.length} 个${activeVbkAccountKey ? `（当前使用 ${activeVbkAccountKey}）` : ""}：\n${lines.join("\n")}${more}`;
}

function orderTitle(order: TibetOrderRecord): string {
  if (order.serviceTitle) return order.serviceTitle;
  return order.serviceId ? `服务 ${order.serviceId}（平台未返回标题）` : "（未命名服务）";
}

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status;
}

export function describeOrders(orders: readonly TibetOrderRecord[], status: string | undefined): string {
  const scope = status ? `状态为「${orderStatusLabel(status)}」的订单` : "订单";
  if (!orders.length) return `该客户账号下没有${scope}。`;
  const lines = orders.slice(0, LIST_LIMIT).map((order) => {
    const money = typeof order.totalPrice === "number" ? `¥${order.totalPrice}` : "金额未标注";
    const travel = order.travelDate ? `，出行 ${order.travelDate}` : "";
    const people = typeof order.peopleCount === "number" ? `，${order.peopleCount} 人` : "";
    return `- ${orderTitle(order)}｜${orderStatusLabel(order.status)}｜${money}${travel}${people}｜订单号 ${order.orderNo}`;
  });
  const more = orders.length > lines.length ? `\n…另有 ${orders.length - lines.length} 条未展示` : "";
  return `${scope}共 ${orders.length} 条：\n${lines.join("\n")}${more}`;
}

export function describeOrder(order: TibetOrderRecord): string {
  const lines = [
    `订单 ${order.orderNo}：${orderTitle(order)}（${orderStatusLabel(order.status)}）`,
    order.destination ? `目的地：${order.destination}` : "",
    order.travelDate ? `出行日期：${order.travelDate}` : "",
    typeof order.peopleCount === "number" ? `人数：${order.peopleCount}` : "",
    order.contactName || order.contactPhone
      ? `联系人：${order.contactName ?? "未填写"}${order.contactPhone ? `（${order.contactPhone}）` : ""}`
      : "",
    typeof order.totalPrice === "number" ? `应付金额：¥${order.totalPrice}` : "应付金额：未标注",
    order.payableUntil ? `支付截止：${order.payableUntil}` : "",
    order.createdAt ? `下单时间：${order.createdAt}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}


export function describePlatformReference(record: TibetPlatformReferenceRecord): string {
  const head = `平台在售参考：${record.title}（比对城市：${record.cities.join("、") || "未填"}）`;
  if (!record.matches.length) return `${head}\n${record.message}`;
  const lines = record.matches.map((match) => {
    const price = typeof match.priceFrom === "number" ? `¥${match.priceFrom}` : "价格未标注";
    const gap = typeof match.priceGap === "number"
      ? `（与产品成人价差 ${match.priceGap >= 0 ? "+" : ""}${match.priceGap}）`
      : "";
    const duration = match.durationLabel ? `，${match.durationLabel}` : "";
    return `- ${match.title}｜${price}${gap}${duration}｜${match.reasons.join("，")}｜public_id ${match.publicId}`;
  });
  return [head, ...lines, record.message].join("\n");
}
