export function explicitlyDeclinesTrafficLine(product: Record<string, unknown>): boolean {
  const basicInfo = product.basicInfo;
  if (!basicInfo || typeof basicInfo !== "object" || Array.isArray(basicInfo)) return false;
  const userIdea = (basicInfo as Record<string, unknown>).userIdea;
  if (typeof userIdea !== "string") return false;
  const negative = "(?:不含|不需要|无需|不要|不创建|不启用|不安排|不录入|禁用|关闭)";
  return new RegExp(`${negative}\\s*(?:大交通(?:子产品)?|交通子产品)`, "u").test(userIdea)
    || new RegExp(`${negative}\\s*(?:飞机\\s*(?:或|和|及|、|，|,)\\s*火车|火车\\s*(?:或|和|及|、|，|,)\\s*飞机)\\s*(?:等)?\\s*(?:大交通(?:子产品)?|交通(?:子产品)?|子产品)`, "u").test(userIdea);
}
