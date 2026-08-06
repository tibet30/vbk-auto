// @ts-nocheck



export type CityOptionMatch =
  | { kind: "matched"; index: number; label: string }
  | { kind: "ambiguous"; labels: string[] }
  | { kind: "missing"; seen: string[]; reason: "notFound" | "wrongCountry" };

export const PRODUCT_IMAGE_TEXT_PATH = "productImageText";
export function pickCityOption(
  labels: ReadonlyArray<string>,
  city: string,
  preferredCountry?: string,
): CityOptionMatch {
  const target = String(city || "").trim();
  if (!target) {
    return { kind: "missing", seen: labels.map((value) => value.trim()).filter(Boolean), reason: "notFound" };
  }
  const seen = labels.map((value) => value.trim()).filter(Boolean);
  const splitLabel = (label: string) => {
    const text = label.trim();
    const dash = text.indexOf("-");
    if (dash > 0 && dash < text.length - 1) {
      return { country: text.slice(0, dash).trim(), city: text.slice(dash + 1).trim() };
    }
    return { country: "", city: text };
  };
  const matches = seen
    .map((label, index) => ({ label, index, ...splitLabel(label) }))
    .filter((entry) => entry.city === target);

  if (preferredCountry) {
    const wantedCountry = preferredCountry.trim();
    const inCountry = matches.filter((entry) => entry.country === wantedCountry);
    if (inCountry.length === 1) {
      return { kind: "matched", index: inCountry[0].index, label: inCountry[0].label };
    }
    if (inCountry.length > 1) {
      return { kind: "ambiguous", labels: inCountry.map((entry) => entry.label) };
    }
    return { kind: "missing", seen, reason: "wrongCountry" };
  }

  const exactCity = matches.filter((entry) => entry.country === "");
  if (exactCity.length === 1) {
    return { kind: "matched", index: exactCity[0].index, label: exactCity[0].label };
  }
  if (exactCity.length > 1) {
    return { kind: "ambiguous", labels: exactCity.map((entry) => entry.label) };
  }
  if (matches.length === 1) {
    return { kind: "matched", index: matches[0].index, label: matches[0].label };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", labels: matches.map((entry) => entry.label) };
  }
  return { kind: "missing", seen, reason: "notFound" };
}

