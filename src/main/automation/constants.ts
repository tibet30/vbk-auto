/**
 * 自动化阶段共用的常量与 URL 构造器：
 *   - URLS：产品列表 / 创建套装入口；
 *   - productEditorUrl / productSectionUrl：根据 productId + section 拼出对应 VBK 编辑器 URL；
 *   - PROFILE_DIR / ARTIFACTS_DIR：持久化目录；
 *   - PRODUCT_TYPE_LABELS / PRODUCT_FORM_LABELS：UI 中文映射；
 *   - isOnlineStatus / isValidStatus：稳健地判定列表里的「有效 / 上线」（避免被「未上线 / 已下线」误判）。
 *
 * 头部带 `// @ts-nocheck`，因为参数 productId / section 都是动态传入。
 */

// @ts-nocheck
export const URLS = {
  list: "https://vbooking.ctrip.com/product/input/productListMerge?from=vbk",
  createSetup:
    "https://vbooking.ctrip.com/ivbk/vendor/saleControlMerge?producttype=0&from=vbk",
};

export function productEditorUrl(productId) {
  return `https://vbooking.ctrip.com/ivbk/vendor/baseInfoMerge?productId=${encodeURIComponent(productId)}&from=vbk`;
}

export function productSectionUrl(productId, section) {
  const id = encodeURIComponent(productId);
  const routes = {
    basic: `/ivbk/vendor/baseInfoMerge?productId=${id}&from=vbk`,
    presentation: `/product/input/productImageText?productId=${id}&pattern=4&from=vbk`,
    itinerary: `/ivbk/vendor/tourdays?productid=${id}&istab=1&from=vbk`,
    packageManage: `/ivbk/vendor/packageManage?productid=${id}&from=vbk`,
    pricingInventory: `/ivbk/vendor/priceInventory?productid=${id}&from=vbk`,
    hotelResource: `/product/input/newResourceRule?productid=${id}&from=vbk`,
    vehicleResource: `/product/input/newResourceRule?productid=${id}&from=vbk`,
    terms: `/ivbk/vendor/newResourceClause?productid=${id}&istab=1&from=vbk`,
  };
  if (!routes[section]) throw new Error(`未知产品页面：${section}`);
  return `https://vbooking.ctrip.com${routes[section]}`;
}

export const PROFILE_DIR = ".data/chrome-profile";
export const ARTIFACTS_DIR = "artifacts";

export const PRODUCT_TYPE_LABELS = {
  domesticShort: "境内短途旅游",
  domesticLong: "境内长途旅游",
};

export const PRODUCT_FORM_LABELS = {
  groupTour: "跟团游",
  semiSelfGuided: "半自助游",
  privateTour: "私家团",
  freeTravel: "自由行",
};

/**
 * 携程列表页的状态列同时包含「上线」与「未上线」，直接用 includes("上线")
 * 会把未上线的产品判成已上线。这里要求出现「上线」且不是「未上线/待上线/下线」。
 */
export function isOnlineStatus(text: string) {
  const normalised = String(text ?? "").replace(/\s+/g, "");
  if (!normalised.includes("上线")) return false;
  return !/(未上线|待上线|不上线|已下线|下线中)/.test(normalised);
}

/**
 * 有效状态判定：要求出现「有效」且不是「无效 / 失效 / 未生效」。
 * 用于套装列表筛掉历史 / 被作废的套装。
 */
export function isValidStatus(text: string) {
  const normalised = String(text ?? "").replace(/\s+/g, "");
  if (!normalised.includes("有效")) return false;
  return !/(无效|失效|未生效)/.test(normalised);
}
