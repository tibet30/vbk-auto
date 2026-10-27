/**
 * 行程原文里的「体验 / 服务 / 泛称」不是可绑定 POI 的景点。
 *
 * 只用于新建行程的结构化投影，不会改写已保存产品；因此这里可以比
 * `itinerarySpotKind` 更主动，把「雪乡轻旅拍」「冰上娱乐」「本地宝藏点」
 * 这类没有稳定官方 POI 的条目直接落成 other，避免生成注定失败的核查项。
 * 真实场馆名（滑雪场、温泉酒店、漂流风景区）带场所尾缀，不在命中范围内。
 */
const VAGUE_PLACE = /(?:宝藏点|小众秘境|网红打卡地|特色体验)$/u;
const SERVICE_TEXT = /(?:门票|费用|司导服务|导游服务|管家服务|接送服务|服务费|服务包含|租借|装备|单列|说明|全程专车|另计|不含|包含建议)/u;
const ACTIVITY_SUFFIX = /(?:体验|旅拍|跟拍|航拍|蹦迪|徒步|穿越|骑行|滑雪|雪圈|冬捕|捕鱼|娱乐|探秘|越野|摩托)$/u;
const ACTIVITY_CONTAINS = /(?:马拉爬犁|雪地摩托|旅拍|跟拍|航拍|蹦迪|轻徒步|泡温泉)/u;

export function isItineraryActivityPhrase(value: string): boolean {
  const name = value.replace(/\s+/gu, "").trim();
  if (!name) return false;
  if (VAGUE_PLACE.test(name) || SERVICE_TEXT.test(name) || ACTIVITY_CONTAINS.test(name)) return true;
  return ACTIVITY_SUFFIX.test(name);
}
