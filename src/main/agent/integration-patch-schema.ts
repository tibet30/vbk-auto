const ITINERARY_SPOT_PATCH_SCHEMA = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string" }, kind: { enum: ["attraction", "free", "other"] }, description: { type: "string" }, timeOfDay: { enum: ["morning", "afternoon"], description: "平台只支持上午/下午；午餐写 meals，夜间活动写入 activities（time 为晚上、type 为 other），不得伪装为下午景点。" }, relation: { enum: ["and", "or"] },
    poiName: { type: "string" }, poiId: { type: "number" },
  },
};
const ITINERARY_DAY_PATCH_SCHEMA = {
  type: "object",
  required: ["day"],
  properties: {
    day: { type: "number" }, title: { type: "string" }, description: { type: "string" }, hotel: { type: "string", minLength: 0 },
    activities: { type: "array", description: "独立活动的对象数组，禁止 {item:...} 包装。", items: {
      type: "object", required: ["time", "title", "detail", "type"], additionalProperties: false,
      properties: { time: { type: "string" }, title: { type: "string" }, detail: { type: "string" },
        type: { enum: ["transport", "visit", "meal", "hotel", "free", "other"] },
        durationMinutes: { type: "number" }, source: { enum: ["user", "ai"] } },
    } },
    meals: { type: "string" }, hotelDescription: { type: "string" }, spots: { type: "array", items: ITINERARY_SPOT_PATCH_SCHEMA },
  },
};
export const PRODUCT_PATCH_SCHEMA = {
  type: "object",
  required: ["patch"],
  properties: {
    patch: {
      type: "object",
      properties: {
        basicInfo: { type: "object" }, presentation: { type: "object" }, operations: { type: "object" }, commercial: { type: "object" },
        itinerary: { type: "array", items: ITINERARY_DAY_PATCH_SCHEMA },
      },
    },
  },
};

