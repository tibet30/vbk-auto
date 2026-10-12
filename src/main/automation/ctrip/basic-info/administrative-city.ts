import { toPlatformShortLocationName } from "../../../../shared/location-short-name.js";

type City = Record<string, any>;
export interface AdministrativeCityContext { province?: string; countryName?: string }

/** Same-name cities must be narrowed by the product's existing geography. */
export function selectAdministrativeCity(cities: unknown, cityName: string, context: AdministrativeCityContext = {}): City {
  const target = toPlatformShortLocationName(cityName);
  const province = toPlatformShortLocationName(context.province);
  const country = context.countryName?.trim() || (province ? "中国" : "");
  const named = (Array.isArray(cities) ? cities : []).filter((city): city is City =>
    Boolean(city) && typeof city === "object" && !Array.isArray(city)
    && toPlatformShortLocationName(String(city.cityName ?? "")) === target);
  const exact = named.filter(city =>
    (!country || String(city.countryName ?? "").trim() === country)
    && (!province || toPlatformShortLocationName(String(city.provinceName ?? "")) === province));
  if (exact.length !== 1) {
    const actual = named.map(city => `${city.countryName || "国家缺失"}/${city.provinceName || "省份缺失"}/${city.cityName}(ID=${city.cityId ?? "缺失"})`).join("、") || "无同名候选";
    throw new Error(`城市「${cityName}」无法唯一匹配：${exact.length} 个规范候选；要求${[country, province, target].filter(Boolean).join("/")}唯一城市（1个）；实际同名${named.length}个，地域筛选后${exact.length}个；差异${exact.length}≠1；候选：${actual}。`);
  }
  return exact[0]!;
}
