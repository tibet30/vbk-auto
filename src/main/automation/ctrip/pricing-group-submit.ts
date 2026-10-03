import type { GroupPricingExpectation } from "./pricing-group-contract.js";

/** 平台 formatSaveParams 使用首日四档价格作为模板，由 dateChoose 应用到整批日期。 */
export function priceInventorySingleProductBody(
  productId: string,
  item: any,
  dates: string[],
  pricing: any,
  expected: GroupPricingExpectation,
) {
  if (!dates.length) throw new Error("拼小团批量提交日期为空。");
  const singleResourcePriceInventory = {
    adultCostPrice: expected.adultCostPrice,
    adultSalePrice: expected.adultSalePrice,
    chdCostPrice: expected.childCostPrice,
    chdSalePrice: expected.childSalePrice,
    isLimit: "T",
    isExceed: "F",
    total: expected.dailyQuota,
  };
  const cost = pricing.cost ?? {};
  const singleSupplementCost = Number(cost.singleSupplement ?? 0);
  const singleSupplementSale = Number(
    pricing.singleSupplementSale
      ?? (singleSupplementCost > 0 && Number(cost.adult) > 0
        ? Math.ceil(singleSupplementCost * Number(pricing.adult) / Number(cost.adult))
        : singleSupplementCost),
  );
  const unitPrices = expected.units.map((unit) => ({
    costPrice: unit.costPrice,
    salePrice: unit.salePrice,
    unitInfo: { ageBandId: unit.ageBandId, tierId: unit.tierId },
  }));
  const body: Record<string, unknown> = {
    productId: Number(productId) || productId,
    singleResourceId: item.singleResourceId,
    optionResourceId: item.optionalResourceId,
    childOccupationBedResourceId: item.childOccupationBedResourceId,
    priceTerms: 1,
    range: "PI",
    dateChoose: { submitType: "D", dates },
    priceOperate: "COVER",
    inventoryOperate: "COVER",
    singleResourceUnitPriceInventory: {
      singleResourceUnitPriceDtos: unitPrices.map((price) => ({ ...price, date: dates[0] })),
      singleResourceInventoryVO: singleResourcePriceInventory,
    },
  };
  if (item.isHotelResource === "T") {
    body.optionalResourcePriceInventory = {
      costPrice: singleSupplementCost,
      salePrice: singleSupplementSale,
      isLimit: "T",
      isExceed: "F",
      total: expected.dailyQuota,
    };
  }
  return body;
}

