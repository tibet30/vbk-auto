const userActivityProperties = {
  id: { type: "string", minLength: 1 },
  day: { type: "integer", minimum: 0 },
  title: { type: "string", minLength: 1 },
  kind: { type: "string", enum: ["poi", "activity", "transport", "meal", "hotel", "free"] },
  time: { type: "string" },
  detail: { type: "string" },
  durationMinutes: { type: "integer", minimum: 1 },
} as const;

export const userIntentTool = {
  type: "function" as const,
  function: {
    name: "submit_user_planning_intent",
    description: "把用户原始想法投影为全局偏好和明确的逐日活动。",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["preferences", "activities"],
      properties: {
        preferences: { type: "array", items: { type: "string" } },
        activities: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "day", "title", "kind", "time", "detail", "durationMinutes"],
            properties: {
              ...userActivityProperties,
              time: { anyOf: [{ type: "string" }, { type: "null" }] },
              detail: { anyOf: [{ type: "string" }, { type: "null" }] },
              durationMinutes: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
            },
          },
        },
      },
    },
  },
};

export const spotTool = {
  type: "function" as const,
  function: {
    name: "submit_attraction_candidates",
    description: "提交可独立检索的真实景点名称候选。",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["names"],
      properties: {
        names: { type: "array", minItems: 1, maxItems: 30, items: { type: "string" } },
      },
    },
  },
};

export const locationTool = {
  type: "function" as const,
  function: {
    name: "submit_standard_location",
    description: "把原始目的地结构化为标准上级地区和目的地城市名称。",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["province", "destinationCity"],
      properties: {
        province: { type: "string", minLength: 1 },
        destinationCity: { type: "string", minLength: 1 },
      },
    },
  },
};

export const poiDisambiguationTool = {
  type: "function" as const,
  function: {
    name: "submit_poi_disambiguation",
    description: "只能从真实候选中选择最符合大众常规游览理解的代表性主景点，或明确表示无法确定。",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["decision", "candidateId", "confidence", "reason"],
      properties: {
        decision: { type: "string", enum: ["selected", "uncertain"] },
        candidateId: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        reason: { type: "string" },
      },
    },
  },
};

export const itineraryTool = {
  type: "function" as const,
  function: {
    name: "submit_verified_itinerary",
    description: "用真实 POI ID 编排逐日行程；有用户其他活动的日期允许 POI 为空。",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["days"],
      properties: {
        days: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["day", "title", "description", "poiIds", "meals", "mealDescriptions"],
            properties: {
              day: { type: "integer", minimum: 1 },
              title: { type: "string" },
              description: { type: "string" },
              poiIds: { type: "array", items: { type: "integer", minimum: 1 } },
              meals: { type: "string" },
              mealDescriptions: { type: "array", minItems: 3, maxItems: 3, items: { type: "string" } },
            },
          },
        },
      },
    },
  },
};

export const vehicleCostTool = {
  type: "function" as const,
  function: {
    name: "submit_vehicle_total_cost",
    description: "提交私家团整段行程的预计用车总成本。",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["requestedTotalCost"],
      properties: { requestedTotalCost: { type: "number", exclusiveMinimum: 0 } },
    },
  },
};

export type ThreeStageTool =
  | typeof userIntentTool
  | typeof spotTool
  | typeof locationTool
  | typeof poiDisambiguationTool
  | typeof itineraryTool
  | typeof vehicleCostTool;
