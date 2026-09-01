import type { CreateProductInput } from "../../../shared/contracts.js";
import { isValidCreateProductDays } from "./product-days-input.js";

export type ProductBriefField = "destination" | "days" | "userIdea";
export type ProductBriefFieldErrors = Partial<Record<ProductBriefField, string>>;

export function validateProductBrief(input: CreateProductInput): ProductBriefFieldErrors {
  const errors: ProductBriefFieldErrors = {};
  if (!input.destination.trim()) errors.destination = "请填写目的地。";
  if (!isValidCreateProductDays(input.days)) errors.days = "请填写 2 至 60 天的整数。";
  if ((input.userIdea ?? "").length > 1000) errors.userIdea = "你的想法不能超过 1000 个字。";
  return errors;
}
