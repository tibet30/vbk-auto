import type { ProductDetail } from "../../../shared/contracts.js";
import type { VbkNavigationPin } from "../../infrastructure/vbk-navigation-pin.js";

export function automationNavigationPin(product: ProductDetail | undefined): VbkNavigationPin {
  const allowedProductIds = [
    product?.productId,
    ...(product?.automation?.trafficLine?.children.map((child) => child.childProductId) ?? []),
  ].filter((id): id is string => Boolean(id && id.trim()));
  return { allowedProductIds, allowCreateSetup: true };
}
