/**
 * 产品自身的行政锚点不是 POI。
 *
 * 原始逐日路线会把「行政地点」直接写进景点段：
 *   - 省市连写：`出发地-重庆万州-住万州`（重庆市 + 万州区）；
 *   - 城市加接送动作：`万州送站`、`重庆集合`。
 * 这些名称没有、也不应有可绑定的景点 POI。若按普通景点锁定，规划期会反复
 * 要求「保留为景点类型」，而真实 POI 查询永远查不到，产品就卡在行程阶段。
 *
 * 判定只用产品自身已锁定的行政字段（接团城市 / 目的地 / 省份 / 接送城市），
 * 不做泛化的“看起来像地名”猜测，避免把「万州大瀑布」这类真实景点降级。
 */

import { isAdministrativeLocationName, toPlatformShortLocationName } from "./location-short-name.js";

const PROVINCE_LEVEL_PREFIXES = ["北京", "天津", "上海", "重庆", "香港", "澳门"] as const;
const TRANSFER_SERVICE_SUFFIX = /(?:接站|送站|接机|送机|接团|送团|集合|解散|接送|返程)$/u;

type Json = Record<string, unknown>;

/** 名称是否只是产品自身的行政/接送节点，而非可绑定 POI 的景点。 */
export function isProductAdministrativeRouteName(product: Json, value: unknown): boolean {
  const name = compact(value);
  if (!name) return false;
  if (isAdministrativeLocationName(value)) return true;

  const basic = record(product.basicInfo);
  const operations = record(product.operations);
  const trafficLine = record(operations?.trafficLine);
  const anchors = [
    basic?.meetingCity,
    basic?.destinationCity,
    basic?.destination,
    operations?.pickupCity,
    trafficLine?.arrivalCity,
    trafficLine?.departureCity,
  ].map(short).filter((item): item is string => Boolean(item));
  if (anchors.includes(name)) return true;

  const province = short(basic?.province);
  const prefixes = [province, ...PROVINCE_LEVEL_PREFIXES].filter((item): item is string => Boolean(item));
  // 「重庆万州」= 直辖市前缀 + 产品城市；只接受由产品字段拼出的组合。
  if (prefixes.some((prefix) => anchors.some((anchor) => name === `${prefix}${anchor}`))) return true;

  // 「万州送站」「重庆集合」：城市锚点 + 接送/集合动作。
  const served = name.replace(TRANSFER_SERVICE_SUFFIX, "");
  return served !== name && (anchors.includes(served) || (Boolean(province) && served === province));
}

function compact(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, "") : "";
}

function short(value: unknown): string {
  return toPlatformShortLocationName(compact(value));
}

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}
