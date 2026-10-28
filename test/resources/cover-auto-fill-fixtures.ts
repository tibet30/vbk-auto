/** cover-auto-fill 系列测试共用的产品夹具（太原 2 天 1 晚私家团）。 */
export function makeBaseProduct(extra: Record<string, unknown> = {}) {
  return {
    sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false },
    basicInfo: {
      supplierProductName: "太原2天1晚私家团",
      supplierProductCode: "TY-AUTO-1",
      subtitle: "太原经典私家团",
      days: 2,
      nights: 1,
      meetingCity: "太原",
      destinationCity: "太原",
      province: "山西",
      operationNotes: "无",
    },
    presentation: {
      recommendation: "推荐语",
      features: "产品特点",
      cover: {
        source: "ctripLibrary",
        poi: "云冈石窟",
        description: "云冈石窟 1",
        minQuality: 3,
      },
    },
    operations: { transport: "charter", pickupCity: "太原" },
    itinerary: [
      { day: 1, title: "太原出发", spots: [{ name: "晋祠" }] },
      { day: 2, title: "云冈石窟", spots: [{ name: "云冈石窟" }] },
    ],
    ...extra,
  };
}
