/**
 * 平台行政地点短名：保留产品可检索的常用名称，去掉行政区尾缀。
 *
 * 只应对行政地点字段调用本函数；POI / 景区 / 城区等业务名称必须原样保留。
 */

const COMMON_ADMINISTRATIVE_SHORT_NAMES: ReadonlyMap<string, string> = new Map([
  ["内蒙古自治区", "内蒙古"],
  ["广西壮族自治区", "广西"],
  ["宁夏回族自治区", "宁夏"],
  ["新疆维吾尔自治区", "新疆"],
  ["西藏自治区", "西藏"],
  ["延边朝鲜族自治州", "延边"],
  ["临夏回族自治州", "临夏"],
  ["甘南藏族自治州", "甘南"],
  ["海北藏族自治州", "海北"],
  ["黄南藏族自治州", "黄南"],
  ["海南藏族自治州", "海南"],
  ["果洛藏族自治州", "果洛"],
  ["玉树藏族自治州", "玉树"],
  ["楚雄彝族自治州", "楚雄"],
  ["红河哈尼族彝族自治州", "红河"],
  ["文山壮族苗族自治州", "文山"],
  ["大理白族自治州", "大理"],
  ["德宏傣族景颇族自治州", "德宏"],
  ["怒江傈僳族自治州", "怒江"],
  ["恩施土家族苗族自治州", "恩施"],
  ["湘西土家族苗族自治州", "湘西"],
  ["黔西南布依族苗族自治州", "黔西南"],
  ["黔东南苗族侗族自治州", "黔东南"],
  ["黔南布依族苗族自治州", "黔南"],
  ["阿坝藏族羌族自治州", "阿坝"],
  ["甘孜藏族自治州", "甘孜"],
  ["凉山彝族自治州", "凉山"],
  ["迪庆藏族自治州", "迪庆"],
  ["西双版纳傣族自治州", "西双版纳"],
  ["海西蒙古族藏族自治州", "海西"],
  ["博尔塔拉蒙古自治州", "博尔塔拉"],
  ["巴音郭楞蒙古自治州", "巴音郭楞"],
  ["克孜勒苏柯尔克孜自治州", "克孜勒苏"],
  ["伊犁哈萨克自治州", "伊犁"],
]);

const ADMINISTRATIVE_SUFFIXES = [
  "特别行政区",
  "维吾尔自治区",
  "壮族自治区",
  "回族自治区",
  "自治县",
  "自治旗",
  "自治州",
  "自治区",
  "县级市",
  "地区",
  "盟",
  "省",
  "市",
  "县",
  "旗",
  "州",
  "区",
] as const;

const PROTECTED_NAME_SUFFIX = /(?:景区|市区|城区|园区|片区|街区|社区|校区|厂区|矿区|库区)$/u;

/** 将省、市、自治区、自治州等行政地点归一为平台常用短名。 */
export function toPlatformShortLocationName(value: unknown): string {
  const input = typeof value === "string" ? value.trim() : "";
  if (!input || PROTECTED_NAME_SUFFIX.test(input)) return input;

  const mapped = COMMON_ADMINISTRATIVE_SHORT_NAMES.get(input);
  if (mapped) return mapped;

  for (const suffix of ADMINISTRATIVE_SUFFIXES) {
    if (input.endsWith(suffix) && input.length > suffix.length) {
      return input.slice(0, -suffix.length).trim();
    }
  }
  return input;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 归一产品中明确的行政地点字段，并用 meetingCity 作为城市锚点。
 * `lockedMeetingCity` 由统一写入口传入时，优先于待写入产品中的城市字段。
 */
export function normaliseProductLocationFields(
  product: Record<string, unknown>,
  lockedMeetingCity?: string,
): Record<string, unknown> {
  const next = { ...product };
  const currentBasic = asRecord(product.basicInfo);
  const basic = { ...currentBasic };
  const meeting = toPlatformShortLocationName(text(lockedMeetingCity) || text(currentBasic.meetingCity));
  const destination = toPlatformShortLocationName(text(currentBasic.destinationCity));
  const anchor = meeting || destination;

  if (text(currentBasic.destination)) basic.destination = toPlatformShortLocationName(text(currentBasic.destination));
  if (text(currentBasic.province)) basic.province = toPlatformShortLocationName(text(currentBasic.province));
  if (anchor) {
    basic.meetingCity = anchor;
    basic.destinationCity = anchor;
  }
  next.basicInfo = basic;

  const currentOperations = asRecord(product.operations);
  const operations = { ...currentOperations };
  if (text(currentOperations.pickupCity)) {
    operations.pickupCity = toPlatformShortLocationName(text(currentOperations.pickupCity));
  }
  next.operations = operations;
  return next;
}
