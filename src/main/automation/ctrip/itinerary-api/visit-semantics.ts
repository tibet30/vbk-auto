/** Only explicit exterior-only wording may remove the included-ticket promise. */
export function isExteriorOnlyVisit(description: string | null | undefined): boolean {
  const text = description?.replace(/\s+/g, "") ?? "";
  if (/(?:并非不上|不是远观|不是外观|可上桥|入内参观)/u.test(text)) return false;
  return /(?:远观|外观).*(?:不上|不登|不入|不安排上桥)|(?:不上|不登|不入|不安排上桥).*(?:桥|楼|馆|园|寺|景|通行)/u.test(text);
}
