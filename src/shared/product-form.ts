export const PRODUCT_FORMS = [
  "privateTour",
  "groupTour",
  "freeTravel",
  "semiSelfGuided",
] as const;

export type ProductForm = (typeof PRODUCT_FORMS)[number];

/** 与 VBK「当天用车」单选项一致的产品内存值。 */
export type DailyTransport = "charter" | "shared" | "none";

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

export function isDailyTransport(value: unknown): value is DailyTransport {
  return value === "charter" || value === "shared" || value === "none";
}

/**
 * 新建或缺少当天用车选择时的团态默认值。
 *
 * 自由行不含用车；私家团始终包车；其余已启用拼小团的产品使用拼车。
 * 非拼小团的其它历史团态沿用既有的包车默认，避免改变已有业务语义。
 */
export function defaultDailyTransport(productForm: unknown, splitGroup: unknown): DailyTransport {
  if (productForm === "freeTravel") return "none";
  if (productForm === "privateTour") return "charter";
  return splitGroup === true ? "shared" : "charter";
}
