/**
 * 区域 / 超统称 / 景区 / 乡镇地名 → VBK 平台可写行政地点的覆盖关系。
 *
 * 仅适用于行政地点字段；POI / 景区 / 城区 / 园区 / 片区 / 街区 / 社区 / 校区 / 厂区
 * / 矿区 / 库区等业务字段不得参与改写。
 */

/**
 * 平台不能直接接收的非行政地点别名 → 实际归属的行政短名。
 *
 * 例子:
 *  - 「潮汕」是跨越潮州/汕头/揭阳的超统称，对应平台只能写「汕头」
 *    （共机场、共铁路站点都注册在汕头名下）。
 *  - 「南澳岛」是汕头下辖海岛，平台行政地点只能写「汕头」。
 */
const NON_WRITABLE_CITY_NAMES: ReadonlyMap<string, string> = new Map([
  ["潮汕", "汕头"],
  ["南澳岛", "汕头"],
]);

/**
 * 酒店描述中可能并存的潮州片区城市，按写入顺序优先捕获最具体的地点
 * （海岛 → 行政区 → 同区域相邻地市）。
 */
const HOTEL_LOCATION_PRIORITY_ORDER: readonly string[] = ["南澳岛", "汕头", "潮州"];

/**
 * 把超统称 / 景区 / 乡镇地名改写为 VBK 行政地点短名。
 * 输入非字符串或空串时原样返回；未命中别名表时也原样返回。
 */
export function toWritableAdministrativeCityName(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return trimmed;
  return NON_WRITABLE_CITY_NAMES.get(trimmed) ?? trimmed;
}

/** 输入是否为被替换的非行政地点别名（含超统称 / 景区 / 乡镇等）。 */
export function isNonWritableCityAlias(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && NON_WRITABLE_CITY_NAMES.has(trimmed);
}

/** 酒店描述中存在多个并存的城市时，按优先级返回最具体的地点。 */
export function hotelLocationFromHotelText(value: string): string {
  // 每晚住宿字段中的明确市县优先；不能把跨城线路都回退到产品接团城市。
  // 只读取字段开头，不从途经描述或酒店品牌中猜城市。
  const administrative = value.trim().replace(/^(?:安排)?(?:入住|住在|住宿于)\s*/, "")
    .match(/^([\p{Script=Han}]{1,12}?(?:自治县|县级市|市|县|旗))/u)?.[1];
  if (administrative) return administrative;
  // Generated lodging placeholders use platform short names as well as 县/市.
  const shortLocality = value.trim().match(/^([\p{Script=Han}]{2,12}?)(?:当地|市区)(?:[1-5一二三四五]\s*(?:钻|星))?(?:酒店|住宿|民宿|客栈)/u)?.[1];
  if (shortLocality && !/(?:镇|村|景区|片区|园区|街区)$/u.test(shortLocality)) return shortLocality;
  for (const candidate of HOTEL_LOCATION_PRIORITY_ORDER) {
    if (value.includes(candidate)) return candidate;
  }
  return "";
}

/**
 * 最后一日为送团时允许保留的非行政地点别名。
 *
 * 「南澳岛」是汕头下辖海岛，最终日可以按景点名描述保留为送团节点；
 * 「潮汕」是超统称，不会以单独节点出现在行程里。
 */
const FINAL_SENDOFF_ALLOWED_ALIASES: ReadonlySet<string> = new Set([
  "南澳岛",
]);

/** 最后一送团日上，是否允许把该别名作为节点描述保留。 */
export function isFinalSendoffAllowedAlias(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && FINAL_SENDOFF_ALLOWED_ALIASES.has(trimmed);
}
