export interface ProductBriefMessage {
  type: "product_brief";
  destination: string;
  productFormLabel: string;
  days: number;
  nights: number;
  userIdea?: string;
}

export function buildProductBriefMessageContent(input: {
  destination: string;
  productFormLabel: string;
  days: number;
  nights: number;
  userIdea?: string;
}): string {
  const brief: ProductBriefMessage = {
    type: "product_brief",
    destination: input.destination,
    productFormLabel: input.productFormLabel,
    days: input.days,
    nights: input.nights,
    ...(input.userIdea?.trim() ? { userIdea: input.userIdea.trim() } : {}),
  };
  return JSON.stringify(brief);
}

export function parseProductBriefMessage(content: string): ProductBriefMessage | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes('"product_brief"')) return undefined;
  try {
    const value = JSON.parse(trimmed) as Partial<ProductBriefMessage>;
    if (value.type !== "product_brief") return undefined;
    if (typeof value.destination !== "string" || !value.destination.trim()) return undefined;
    if (typeof value.productFormLabel !== "string" || !value.productFormLabel.trim()) return undefined;
    if (!Number.isInteger(value.days) || !Number.isInteger(value.nights)) return undefined;
    return {
      type: "product_brief",
      destination: value.destination.trim(),
      productFormLabel: value.productFormLabel.trim(),
      days: value.days!,
      nights: value.nights!,
      ...(typeof value.userIdea === "string" && value.userIdea.trim()
        ? { userIdea: value.userIdea.trim() }
        : {}),
    };
  } catch {
    return undefined;
  }
}
