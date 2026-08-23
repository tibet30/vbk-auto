type ProductLike = Record<string, unknown>;

const borderPermitIssuePattern = /边防证|边境地区通行证|边境通行证|边境通行|边境管控|通行范围/i;
const borderItineraryPattern = /边境|国门|口岸|乃堆拉|珠峰|定日|亚东|樟木|吉隆|普兰|札达/i;
const permitResolutionPattern = /边防证|边境地区通行证|边境通行证|边境通行|有效身份证件/i;
const unresolvedPermitPattern = /待确认|待核查|复核|人工确认|需确认|最终确认|确认为准|以.*确认|是否/i;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function dayText(day: unknown): string {
  const record = asObject(day);
  const chunks = [
    record.title,
    record.description,
    record.hotel,
    record.hotelDescription,
    record.meals,
  ];
  const spots = Array.isArray(record.spots) ? record.spots : [];
  for (const spotValue of spots) {
    const spot = asObject(spotValue);
    chunks.push(spot.name, spot.poiName);
  }
  const activities = Array.isArray(record.activities) ? record.activities : [];
  for (const activityValue of activities) {
    const activity = asObject(activityValue);
    chunks.push(activity.title, activity.detail);
  }
  return chunks.map(textValue).filter(Boolean).join(" ");
}

export function isBorderPermitIssueText(text: string): boolean {
  return borderPermitIssuePattern.test(text);
}

export function itineraryDayHasBorderPermitTrigger(day: unknown): boolean {
  return borderItineraryPattern.test(dayText(day));
}

export function hasBorderPermitItineraryTrigger(product: ProductLike): boolean {
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary : [];
  return itinerary.some(itineraryDayHasBorderPermitTrigger);
}

export function hasResolvedBorderPermitNote(product: ProductLike): boolean {
  const commercial = asObject(product.commercial);
  const terms = asObject(commercial.terms);
  const bookingNotes = textValue(terms.bookingNotes);
  return permitResolutionPattern.test(bookingNotes) && !unresolvedPermitPattern.test(bookingNotes);
}

function hasResolvedBorderPermitVisibleText(text: string): boolean {
  return permitResolutionPattern.test(text) && !unresolvedPermitPattern.test(text);
}

export function hasResolvedBorderPermitVisibleFields(product: ProductLike): boolean {
  const basic = asObject(product.basicInfo);
  if (hasResolvedBorderPermitVisibleText(textValue(basic.operationNotes))) return true;

  const itinerary = Array.isArray(product.itinerary) ? product.itinerary : [];
  return itinerary.some((day) =>
    itineraryDayHasBorderPermitTrigger(day) && hasResolvedBorderPermitVisibleText(dayText(day)),
  );
}
