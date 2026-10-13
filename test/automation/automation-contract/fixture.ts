/** 完整合法规划产物。 */
export function makeValidProduct(): Record<string, unknown> {
  return {
    sales: { productType: "domesticShort", productForm: "groupTour", splitGroup: false },
    basicInfo: {
      supplierProductName: "太原2天1晚跟团游",
      supplierProductCode: "P001",
      subtitle: "太原经典行程",
      days: 1,
      nights: 0,
      meetingCity: "太原",
      destinationCity: "太原",
      province: "山西",
      operationNotes: "无",
    },
    operations: {
      hotelSource: "nonPlatform",
      hotelTier: "当地3钻酒店/-3",
      transport: "charter",
      pickupCity: "太原",
      reusePickupForDropoff: true,
      mealsIncluded: false,
      bookingControls: {
        butler: {
          contactCardId: 1,
          displayName: "管家A",
          providerId: 100,
        },
      },
    },
    presentation: {
      recommendation: "2 天串联核心景点",
      features: "【古建巡礼】专业讲解",
      recommendations: [
        { category: "优选行程", text: "一日私家串联晋祠与博物院，节奏从容不赶路，体验山西人文历史" },
        { category: "精选酒店", text: "精选当地 3 钻酒店住宿含早餐，方便每日出行与休息，性价比更均衡" },
        { category: "缤纷景点", text: "覆盖晋祠与山西博物院，兼顾古建与文物鉴赏，行程内容更丰富完整" },
      ],
      cover: {
        source: "ctripLibrary",
        imageId: 79413001,
        imageUrl: "https://example.test/jinci-cover.jpg",
        poi: "晋祠博物馆",
        description: "横版晋祠外景或代表性造像",
        minQuality: 3,
      },
    },
    itinerary: [
      {
        day: 1,
        title: "太原接站—晋祠",
        spots: [{ name: "晋祠博物馆", poiName: "晋祠博物馆", poiId: 79413 }],
        description: "专车接站游览晋祠。",
        hotel: "太原市区舒适酒店",
        meals: "早餐自理；午餐自理；晚餐自理",
      },
    ],
  };
}
