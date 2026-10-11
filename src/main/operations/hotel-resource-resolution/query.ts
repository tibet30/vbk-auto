import type { ProductDetail } from "../../../shared/contracts.js";
import { toPlatformShortLocationName } from "../../../shared/location-short-name.js";

const textValue = (value: unknown) => typeof value === "string" ? value.trim() : "";

export function hotelResourceCity(product: Pick<ProductDetail, "product">): string {
  const basic = product.product.basicInfo as Record<string, unknown> | undefined;
  return toPlatformShortLocationName(textValue(basic?.meetingCity) || textValue(basic?.destinationCity));
}

export function hotelResourceQuery(product: Pick<ProductDetail, "product">) {
  const productData = product.product;
  const operations = productData.operations && typeof productData.operations === "object" && !Array.isArray(productData.operations) ? productData.operations as Record<string, unknown> : {};
  const city = hotelResourceCity(product);
  const tier = textValue(operations.hotelTier).replace(/^当地/, "").replace(/\/-\d+$/, "") || "酒店";
  return `${city}${tier}`;
}
