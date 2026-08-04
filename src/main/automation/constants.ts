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
    packageManage: `/ivbk/vendor/packageManage?productid=${id}&from=vbk`,
    pricingInventory: `/ivbk/vendor/priceInventory?productid=${id}&from=vbk`,
    vehicleResource: `/product/input/newResourceRule?productid=${id}&from=vbk`,
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

// 携程列表页的状态列同时包含「上线」与「未上线」，直接用 includes("上线")
// 会把未上线的产品判成已上线。这里要求出现「上线」且不是「未上线/待上线/下线」。
export function isOnlineStatus(text: string) {
  const normalised = String(text ?? "").replace(/\s+/g, "");
  if (!normalised.includes("上线")) return false;
  return !/(未上线|待上线|不上线|已下线|下线中)/.test(normalised);
}

export function isValidStatus(text: string) {
  const normalised = String(text ?? "").replace(/\s+/g, "");
  if (!normalised.includes("有效")) return false;
  return !/(无效|失效|未生效)/.test(normalised);
}
