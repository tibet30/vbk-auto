import { parseProduct } from "../schema/schema.js";

export function draftPhasesFor(product: ReturnType<typeof parseProduct>) {
  const phases = ["basic", "presentation", "itinerary", "package"];
  if (product.commercial?.pricing && product.commercial.inventory) phases.push("pricingInventory");
  if (product.itinerary.some((day) => Boolean(day.hotel))) phases.push("hotelResource");
  if (product.sales.productForm === "privateTour") phases.push("vehicleResource");
  const terms = product.commercial?.terms;
  if (terms?.inclusions && terms.exclusions && terms.bookingNotes && terms.refundPolicy) phases.push("terms");
  phases.push("preflight");
  return phases;
}
