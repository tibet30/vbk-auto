import { PRODUCT_MENU_KEYS, type ProductMenu } from "../../src/main/automation/ctrip/product-menu-readback.ts";

export function unlockedMenus(productId = "79712643") {
  const menus: ProductMenu[] = PRODUCT_MENU_KEYS.map(key => ({
    key, title: key, enabled: "T", url: `/ivbk/vendor/${key}?productId=${productId}`,
  }));
  return { maxStep: 10, hasPermission: true, menus };
}

export function unlockedMenusWithExtensions(productId = "79712643") {
  const result = unlockedMenus(productId);
  result.menus.push(...["optionalAddonA", "optionalAddonB"].map(key => ({
    key, title: key, enabled: "T" as const, url: `/ivbk/vendor/${key}?productId=${productId}`,
  })));
  return result;
}
