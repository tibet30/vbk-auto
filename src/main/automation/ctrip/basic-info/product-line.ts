type Json = Record<string, any>;

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function list(value: unknown): Json[] {
  return Array.isArray(value)
    ? value.filter((item): item is Json => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function trimAdministrativeSuffix(value: unknown): string {
  return String(value ?? "").trim()
    .replace(/(维吾尔自治区|壮族自治区|回族自治区|特别行政区|自治区|省|市)$/u, "");
}

const PROVINCE_LEVEL_NAMES = new Set([
  "北京", "天津", "河北", "山西", "内蒙古", "辽宁", "吉林", "黑龙江",
  "上海", "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南",
  "湖北", "湖南", "广东", "广西", "海南", "重庆", "四川", "贵州",
  "云南", "西藏", "陕西", "甘肃", "青海", "宁夏", "新疆", "香港", "澳门",
]);

/** 遗留省级城市锚点使用已规划的明确接送城市自愈。 */
export function resolveBasicInfoCityAnchor(product: Json): string {
  const info = record(product.basicInfo);
  const meetingCity = String(info.meetingCity ?? "").trim();
  const destinationCity = String(info.destinationCity ?? "").trim();
  if (!meetingCity || destinationCity !== meetingCity) {
    throw new Error("基本信息 API 要求集合城市与目的城市使用同一已锁定城市");
  }
  const pickupCity = String(record(product.operations).pickupCity ?? "").trim();
  if (pickupCity && PROVINCE_LEVEL_NAMES.has(trimAdministrativeSuffix(meetingCity))) return pickupCity;
  return meetingCity;
}

/** 精确城市优先；只有省级范围产品可唯一降级到“省内/全景”线路。 */
export function selectProductLine(productLineDtos: unknown, info: Json, cityName: string): Json {
  const candidates = [...new Set([
    `${cityName}一地`,
    `${String(info.destinationCity ?? "").trim()}一地`,
    `${trimAdministrativeSuffix(info.province)}一地`,
  ].filter((value) => value !== "一地"))];
  const lines = list(productLineDtos);
  for (const name of candidates) {
    const matches = lines.filter((item) => String(item.lineName ?? "").trim() === name);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`产品线「${name}」无法唯一匹配：${matches.length} 个候选`);
  }

  const destination = trimAdministrativeSuffix(info.destinationCity);
  const province = trimAdministrativeSuffix(info.province);
  const isProvinceScope = Boolean(province)
    && destination === province
    && PROVINCE_LEVEL_NAMES.has(province);
  if (isProvinceScope) {
    for (const alias of [`${province}省内`, `${province}全景`]) {
      const matches = lines.filter((item) => String(item.lineName ?? "").trim().includes(alias));
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) throw new Error(`省级产品线「${alias}」无法唯一匹配：${matches.length} 个候选`);
    }
  }

  const available = lines.map((item) => String(item.lineName ?? "").trim()).filter(Boolean);
  throw new Error(
    `产品线无法按城市/省份精确匹配：${candidates.join("、") || "无候选"}`
    + `；平台可选：${available.join("、") || "无"}`,
  );
}

export function isProductLineResolutionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.startsWith("产品线无法按城市/省份精确匹配：")
    || message.startsWith("产品线「")
    || message.startsWith("省级产品线「");
}

export function hasProductLineResolutionFailure(recovery: unknown): boolean {
  const phase = record(recovery);
  const attempts = [...list(phase.attemptsHistory), ...list(phase.attempts)];
  return attempts.some((attempt) => isProductLineResolutionError(attempt.error))
    || isProductLineResolutionError(phase.finalError);
}

/** null 表示重试降级：保存包中完全不出现 productLineID。 */
export function productLineSaveField(productLine: Json | null): Json {
  return productLine ? { productLineID: Number(productLine.lineId) } : {};
}
