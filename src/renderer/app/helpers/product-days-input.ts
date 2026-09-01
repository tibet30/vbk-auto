export const CREATE_PRODUCT_MIN_DAYS = 2;
export const CREATE_PRODUCT_MAX_DAYS = 60;

/** 输入替换期间允许暂时清空，不要在每次输入时恢复默认天数。 */
export function parseProductDaysInput(value: string): number {
  if (value === "") return 0;
  const days = Number(value);
  return Number.isInteger(days) ? days : 0;
}

export function productDaysInputValue(days: number): number | "" {
  return days > 0 ? days : "";
}

export function isValidCreateProductDays(days: number): boolean {
  return Number.isInteger(days) && days >= CREATE_PRODUCT_MIN_DAYS && days <= CREATE_PRODUCT_MAX_DAYS;
}
