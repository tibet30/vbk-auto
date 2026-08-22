import { randomUUID } from "node:crypto";
import type { CreateProductInput, ProductDetail } from "../../../../shared/contracts.js";
import { DEFAULT_HOTEL_TIER } from "../../../../shared/hotel-tiers.js";
import { defaultCommercialInventory } from "../../../data/commercial-defaults.js";
import { now, newSupplierProductCode } from "./types.js";
import { toPlatformShortLocationName } from "../../../../shared/location-short-name.js";

/** Build the initial product snapshot without writing local or remote state. */
export function buildProductSnapshot(input: CreateProductInput, supplierContactName?: string | null): ProductDetail {
  const id = randomUUID();
  const createdAt = now();
  const destination = toPlatformShortLocationName(input?.destination);
  if (!destination) throw new Error("请填写有效的目的地。");

  const days = Number(input.days);
  if (!Number.isInteger(days) || days < 1 || days > 60) throw new Error("天数需为 1 至 60 天的整数。");
  const productForm = input.productForm;
  if (productForm !== "privateTour" && productForm !== "groupTour") throw new Error("请选择有效的产品形态。");
  const userIdea = typeof input.userIdea === "string" ? input.userIdea.trim() : "";
  if (userIdea.length > 1000) throw new Error("用户想法不能超过 1000 个字。");

  const formLabel = productForm === "privateTour" ? "私家团" : "跟团游";
  const nights = Math.max(0, days - 1);
  const destinationCity = destination;
  const province = "";
  const name = `${destination}${days}天${nights}晚${formLabel}`;
  const product = {
    sales: { productType: days <= 5 ? "domesticShort" : "domesticLong", productForm, splitGroup: false },
    basicInfo: {
      supplierProductName: name,
      supplierProductCode: newSupplierProductCode(supplierContactName),
      destination,
      days,
      nights,
      meetingCity: destinationCity,
      destinationCity,
      subtitle: "",
      province,
      operationNotes: "",
      userIdea,
    },
    operations: {
      hotelSource: "nonPlatform",
      hotelTier: DEFAULT_HOTEL_TIER,
      mealsIncluded: false,
      pickupCity: "",
      vehicleResource: {},
    },
    commercial: { inventory: defaultCommercialInventory() },
    itinerary: [],
  };
  return {
    id,
    name,
    status: "planning",
    updatedAt: createdAt,
    product,
    messages: [{
      id: randomUUID(),
      role: "assistant",
      content: `已创建「${name}」。已带入产品上下文：目的地「${destination}」、产品形态「${formLabel}」、行程「${days}天${nights}晚」。`,
      createdAt,
    }],
    researchTasks: [],
    basicInfoSaved: false,
  };
}
