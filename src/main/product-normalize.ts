function textValue(value: unknown) { return typeof value === "string" ? value.trim() : ""; }

export function normalisePresentation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const highlights = Array.isArray(record.highlights) ? record.highlights.map(textValue).filter(Boolean) : [];
  const recommendation = textValue(record.recommendation) || textValue(record.description) || textValue(record.subtitle) || textValue(record.productName);
  const features = textValue(record.features) || highlights.join("\n") || textValue(record.highlightsMore);
  if (!recommendation || !features) return undefined;
  const cover = record.cover && typeof record.cover === "object" && !Array.isArray(record.cover) ? record.cover : undefined;
  return {
    recommendationCategory: textValue(record.recommendationCategory) || "优选行程",
    recommendation,
    features,
    ...(cover ? { cover } : {}),
  };
}

function normaliseMeals(value: unknown) {
  if (typeof value === "string") return { summary: value, descriptions: undefined };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { summary: "餐食以实际确认单为准", descriptions: undefined };
  const record = value as Record<string, unknown>;
  const entries = [
    ["早餐", textValue(record.breakfast)],
    ["午餐", textValue(record.lunch)],
    ["晚餐", textValue(record.dinner)],
  ].map(([label, detail]) => `${label}${detail || "待确认"}`);
  return { summary: entries.join("；"), descriptions: entries };
}

export function normaliseItinerary(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const days = value.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const activities = Array.isArray(record.activities)
      ? record.activities.filter((activity): activity is Record<string, unknown> => Boolean(activity) && typeof activity === "object" && !Array.isArray(activity))
      : [];
    const spots = Array.isArray(record.spots)
      ? record.spots.map(textValue).filter(Boolean)
      : activities.map((activity) => textValue(activity.name)).filter((name) => name && !/接站|接机|送站|送机|早餐|午餐|晚餐|入住|酒店/.test(name));
    const activityDescription = activities
      .map((activity) => [textValue(activity.time), textValue(activity.name), textValue(activity.detail)].filter(Boolean).join(" "))
      .filter(Boolean)
      .join("；");
    const meals = normaliseMeals(record.meals);
    const title = textValue(record.title) || `第 ${index + 1} 天行程`;
    const description = textValue(record.description) || [textValue(record.summary), activityDescription].filter(Boolean).join("。") || title;
    const hotel = textValue(record.hotel) || textValue(record.stay);
    return [{
      day: Number.isInteger(record.day) && Number(record.day) > 0 ? Number(record.day) : index + 1,
      title,
      spots,
      description,
      hotel,
      meals: meals.summary,
      ...(meals.descriptions ? { mealDescriptions: meals.descriptions } : {}),
      ...(hotel ? { hotelDescription: hotel } : {}),
    }];
  });
  return days.length ? days : undefined;
}

export function normaliseProductDraft(product: Record<string, unknown>) {
  const result = structuredClone(product);
  const presentation = normalisePresentation(result.presentation);
  const itinerary = normaliseItinerary(result.itinerary);
  if (presentation) result.presentation = presentation;
  if (itinerary) result.itinerary = itinerary;
  if (result.operations && typeof result.operations === "object" && !Array.isArray(result.operations)) {
    const operations = { ...(result.operations as Record<string, unknown>) };
    if (!(["charter", "shared", "none"] as unknown[]).includes(operations.transport)) delete operations.transport;
    if (!textValue(operations.pickupCity)) delete operations.pickupCity;
    if (typeof operations.reusePickupForDropoff !== "boolean") delete operations.reusePickupForDropoff;
    if (operations.hotelSource !== "nonPlatform") delete operations.hotelSource;
    if (!(["当地2钻酒店/-2", "当地3钻酒店/-3", "当地4钻酒店/-4", "当地5钻酒店/-5"] as unknown[]).includes(operations.hotelTier)) delete operations.hotelTier;
    if (typeof operations.mealsIncluded !== "boolean") delete operations.mealsIncluded;
    if (Object.keys(operations).length) result.operations = operations; else delete result.operations;
  }
  if (result.commercial && typeof result.commercial === "object" && !Array.isArray(result.commercial)) {
    const commercial = { ...(result.commercial as Record<string, unknown>) };
    if (!textValue(commercial.packageName)) delete commercial.packageName;
    if (!commercial.terms || typeof commercial.terms !== "object" || Array.isArray(commercial.terms)) delete commercial.terms;
    if (Object.keys(commercial).length) result.commercial = commercial; else delete result.commercial;
  }
  return result;
}
