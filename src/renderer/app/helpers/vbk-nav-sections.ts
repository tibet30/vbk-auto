import type { ProductDetail } from "../../../shared/contracts.js";
import { requiresVehicleResource } from "../../../shared/product-form.js";

// 自动录入阶段的展示文案 + VBK 入口 URL。
// VBK 产品录入页面的实际导航顺序。顺序与 VBK 后台页签一致：
//   销售控制 → 产品信息 → 产品图文 → 行程描述 → 套餐管理 →
//   价格库存班期 → 资源配置 → 条款维护
// 「销售控制」是新建产品 shell 的入口页（saleControlMerge），位于基本
// 信息之前；它不是自动化阶段，不映射到任何 phase。「资源配置」同时承载
// hotelResource / vehicleResource 两个阶段（同 newResourceRule 页面，
// 点不同入口切酒店/用车）；preflight 是最终一致性校验，对应不到独立
// VBK 页面，所以从这张导航表中省略。状态由 section.phaseNames 所列
// 阶段聚合给出；每个可重跑阶段在同一 section 内提供独立操作。
export interface VbkNavSection {
  key: string;
  label: string;
  /** 构造页面 URL；销售控制在尚无 productId 时回退到新增产品入口。 */
  buildUrl: (productId: string | undefined) => string | null;
  /** 映射到本页面的自动化阶段名；空数组表示该页面不直接对应阶段。 */
  phaseNames: string[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** 与自动化阶段矩阵保持一致：仅显示当前产品实际会执行的资源阶段。 */
export function resourcePhaseNamesForProduct(product: ProductDetail | null | undefined): string[] {
  const data = record(product?.product);
  const operations = record(data.operations);
  const sales = record(data.sales);
  const itinerary = Array.isArray(data.itinerary) ? data.itinerary : [];
  const platformHotel = record(operations.hotelResource).source === "ctrip"
    || product?.automation?.phases.some(item => item.phase === "hotelResource" && item.status === "completed");
  const needsHotel = (operations.hotelSource !== "nonPlatform" || platformHotel)
    && itinerary.some((day) => Boolean(record(day).hotel));
  const phases: string[] = [];
  if (needsHotel) phases.push("hotelResource");
  if (requiresVehicleResource(sales.productForm)) phases.push("vehicleResource");
  return phases;
}

export const VBK_HOST = "https://vbooking.ctrip.com";

// URL 栏只显示 pathname + 关键查询参数，完整 URL 太长会被省略号隐藏。
// productId/query 是「进入」跳转是否生效的关键判断依据，必须留下；
// 其余参数（from=vbk 之类）用 … 占位，避免地址栏变一长串。
export function formatBrowserPath(raw: string): string {
  try {
    const url = new URL(raw);
    const path = url.pathname || "/";
    const productId = url.searchParams.get("productId") ?? url.searchParams.get("productid");
    const producttype = url.searchParams.get("producttype");
    const parts: string[] = [path];
    if (productId) parts.push(`productId=${productId}`);
    if (producttype) parts.push(`producttype=${producttype}`);
    const compact = parts.join("?");
    const others = [...url.searchParams.entries()].filter(([k]) => k !== "productId" && k !== "productid" && k !== "producttype");
    return others.length > 0 ? `${compact}…` : compact;
  } catch {
    return raw || "/";
  }
}

export const VBK_NAV_SECTIONS: VbkNavSection[] = [
  {
    key: "saleControl",
    label: "销售控制",
    // 已生成 productId 时必须打开当前产品的销售控制；静态 producttype=0
    // 地址是“新增产品”入口，只能在产品壳尚未创建时使用。
    buildUrl: (id) => id
      ? `${VBK_HOST}/ivbk/vendor/saleControlMerge?from=vbk&productId=${encodeURIComponent(id)}`
      : `${VBK_HOST}/ivbk/vendor/saleControlMerge?producttype=0&from=vbk`,
    phaseNames: [],
  },
  {
    key: "basic",
    label: "产品信息",
    buildUrl: (id) => id ? `${VBK_HOST}/ivbk/vendor/baseInfoMerge?productId=${encodeURIComponent(id)}&from=vbk` : null,
    phaseNames: ["basic"],
  },
  {
    key: "presentation",
    label: "产品图文",
    // VBK 当前产品菜单返回的独立 productImageText 路由；baseInfoMerge
    // 的默认落点始终是“产品信息”。
    buildUrl: (id) => id ? `${VBK_HOST}/product/input/productImageText?productId=${encodeURIComponent(id)}&pattern=4&from=vbk` : null,
    phaseNames: ["presentation"],
  },
  {
    key: "itinerary",
    label: "行程描述",
    buildUrl: (id) => id ? `${VBK_HOST}/ivbk/vendor/tourdays?productid=${encodeURIComponent(id)}&istab=1&from=vbk` : null,
    phaseNames: ["itinerary"],
  },
  {
    key: "package",
    label: "套餐管理",
    buildUrl: (id) => id ? `${VBK_HOST}/ivbk/vendor/packageManage?productid=${encodeURIComponent(id)}&from=vbk` : null,
    phaseNames: ["package"],
  },
  {
    key: "pricingInventory",
    label: "价格库存班期",
    buildUrl: (id) => id ? `${VBK_HOST}/ivbk/vendor/priceInventory?productId=${encodeURIComponent(id)}&from=vbk` : null,
    phaseNames: ["pricingInventory"],
  },
  {
    key: "resource",
    label: "资源配置",
    buildUrl: (id) => id ? `${VBK_HOST}/product/input/newResourceRule?productid=${encodeURIComponent(id)}&from=vbk` : null,
    phaseNames: ["hotelResource", "vehicleResource"],
  },
  {
    key: "terms",
    label: "条款维护",
    buildUrl: (id) => id ? `${VBK_HOST}/ivbk/vendor/newResourceClause?productid=${encodeURIComponent(id)}&from=vbk` : null,
    phaseNames: ["terms"],
  },
  {
    key: "trafficLine",
    label: "线路及交通规划",
    buildUrl: (id) => id ? `${VBK_HOST}/ivbk/vendor/trafficLineEdit?productid=${encodeURIComponent(id)}&istab=1&from=vbk` : null,
    phaseNames: ["trafficLine"],
  },
];

/**
 * 将静态导航定义投影为当前产品的实际执行列表。
 * 资源配置没有适用阶段时完全隐藏，既不提供无效操作，也不影响进度状态。
 */
export function visibleVbkNavSections(product: ProductDetail | null | undefined): VbkNavSection[] {
  return VBK_NAV_SECTIONS.flatMap((section) => {
    if (section.key === "trafficLine" && record(record(product?.product).operations).trafficLine) {
      const traffic = record(record(record(product?.product).operations).trafficLine);
      if (traffic.enabled === false && !product?.automation?.trafficLine?.children.length) return [];
    }
    if (section.key !== "resource") return [section];
    const phaseNames = resourcePhaseNamesForProduct(product);
    return phaseNames.length > 0 ? [{ ...section, phaseNames }] : [];
  });
}

// 操作日志的 stage 名 → VBK_NAV_SECTIONS 的 key。
// 自动化日志记录阶段时使用带 Info 后缀的命名（basicInfo），而导航 section
// key 是 basic；统一在这里归一，让「详情」按钮能把 VBK 浏览器导航到对应页面。
export const OPERATION_STAGE_TO_SECTION: Record<string, string> = {
  basicInfo: "basic",
  basic: "basic",
  saleControl: "saleControl",
  presentation: "presentation",
  itinerary: "itinerary",
  package: "package",
  pricingInventory: "pricingInventory",
  priceInventory: "pricingInventory",
  hotelResource: "resource",
  vehicleResource: "resource",
  trafficLine: "trafficLine",
  terms: "terms",
};

/** 把日志条目的 stage 映射到可导航的 VBK section；无法映射时返回 undefined。 */
export function operationStageToSection(stage: string | undefined): VbkNavSection | undefined {
  if (!stage) return undefined;
  const key = OPERATION_STAGE_TO_SECTION[stage];
  if (!key) return undefined;
  return VBK_NAV_SECTIONS.find((section) => section.key === key);
}
