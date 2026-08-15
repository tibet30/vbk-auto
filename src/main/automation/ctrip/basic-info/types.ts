/**
 * 基本信息面板下拉选项的纯类型 + 选择器工具：
 *   - CityOptionMatch：描述从候选 labels 中挑城市的判定结果（matched / ambiguous / missing）；
 *   - PRODUCT_IMAGE_TEXT_PATH：与 ../tabs.ts 中的 isProductImageTextUrl 配合使用；
 *   - pickCityOption：纯函数，在传入 labels + city + preferredCountry 时按
 *     「中国- city」优先 / 不带前缀时只允许 1 个候选 / 其它情形 ambiguous 提示规则返回。
 * 顶部带 `// @ts-nocheck`，类型文件以注释为主。
 */

export type CityOptionMatch =
  | { kind: "matched"; index: number; label: string }
  | { kind: "ambiguous"; labels: string[] }
  | { kind: "missing"; seen: string[]; reason: "notFound" | "wrongCountry" };

/**
 * 产品图文页 URL 路径段常量，对应 VBK 的 productImageText 路径。
 */
export const PRODUCT_IMAGE_TEXT_PATH = "productImageText";

/**
 * 在 labels 数组中按目标 city + 可选 preferredCountry 判定匹配结果：
 *   - preferredCountry 提供时，仅当某条「${country}-${city}」精确命中 1 个 → matched；
 *     若没有国家前缀但裸城市名唯一，也允许 matched，避免国内城市被无谓拖慢；
 *     0 个或多个分别 → wrongCountry / ambiguous（让上层拒绝回退 / 让 AI 兜底）；
 *   - 不提供时，要求 city 无前缀条目唯一；若所有带前缀但只有 1 个也 matched；多个则 ambiguous。
 * 任何完全无候选返回 missing = "notFound"。
 */
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
    const text = label.trim().replace(/[—–]/g, "-");
    const dash = text.indexOf("-");
    if (dash > 0 && dash < text.length - 1) {
      const country = text.slice(0, dash).trim();
      let city = text.slice(dash + 1).trim();
      // 旧版 VBK 的一个 option 内含两列：城市「中国-西安」+ 省份
      // 「中国-陕西」。某些 DOM 结构会把它们拼成
      // 「中国-西安中国-陕西」，但仍然只有一个可点击城市候选。
      // 只裁掉“同一国家前缀开头”的上下文列，不能把「西安郊区」一类
      // 相似城市误判为精确命中。
      if (city.startsWith(target)) {
        const suffix = city.slice(target.length).trim();
        if (suffix.startsWith(`${country}-`)) city = target;
      }
      return { country, city };
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
    const exactCity = matches.filter((entry) => entry.country === "");
    if (exactCity.length === 1) {
      return { kind: "matched", index: exactCity[0].index, label: exactCity[0].label };
    }
    if (exactCity.length > 1) {
      return { kind: "ambiguous", labels: exactCity.map((entry) => entry.label) };
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
