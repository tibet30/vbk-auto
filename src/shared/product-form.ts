export const PRODUCT_FORMS = [
  "privateTour",
  "groupTour",
  "freeTravel",
  "semiSelfGuided",
] as const;

export type ProductForm = (typeof PRODUCT_FORMS)[number];

export const PRODUCT_FORM_LABELS: Record<ProductForm, string> = {
  privateTour: "私家团",
  groupTour: "跟团游",
  freeTravel: "自由行",
  semiSelfGuided: "半自助游",
};

export function isProductForm(value: unknown): value is ProductForm {
  return typeof value === "string" && (PRODUCT_FORMS as readonly string[]).includes(value);
}

export function isPrivateTourForm(value: unknown): boolean {
  return value === "privateTour";
}

export function requiresVehicleResource(value: unknown): boolean {
  return value === "privateTour";
}

export function requiresGuide(value: unknown): boolean {
  return value === "groupTour";
}

export function supportsSmallGroupSettings(value: unknown): boolean {
  return value === "groupTour" || value === "semiSelfGuided";
}
