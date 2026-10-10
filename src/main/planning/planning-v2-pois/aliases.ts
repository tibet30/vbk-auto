/**
 * 行政地名别名表 + 归一化 / 键集 / 类型识别：
 *   - ADMINISTRATIVE_ALIASES：行政区 / 城市级中文名 → 拼音 / 英文别名；
 *   - normaliseLocation：去掉省 / 市 / 自治区 / 直辖市等行政词，便于跨语言匹配；
 *   - locationKeys：把 actual / expected 两边都归一化并叠加别名键；
 *   - administrativeType：把 district / city / province / municipality 文本归类。
 *
 * 这套同义 + location 归一 + 拼音别名，是 POI 地域核验（provinceMatches /
 * cityMatches）的核心，只有同义键命中才视为同一地名。
 */

export const FACILITY_RE = /入口|出口|停车场|售票处|游客中心|服务中心|换乘中心|检票口|接驳站|码头|车站|机场/;

export const ADMINISTRATIVE_ALIASES: Record<string, string[]> = {
  北京: ["beijing", "peking"],
  天津: ["tianjin"],
  河北: ["hebei"],
  山西: ["shanxi"],
  内蒙古: ["inner mongolia", "neimenggu"],
  辽宁: ["liaoning"],
  吉林: ["jilin"],
  黑龙江: ["heilongjiang"],
  上海: ["shanghai"],
  江苏: ["jiangsu"],
  浙江: ["zhejiang"],
  安徽: ["anhui"],
  福建: ["fujian"],
  江西: ["jiangxi"],
  山东: ["shandong"],
  河南: ["henan"],
  湖北: ["hubei"],
  湖南: ["hunan"],
  广东: ["guangdong", "canton"],
  广西: ["guangxi"],
  海南: ["hainan"],
  重庆: ["chongqing"],
  四川: ["sichuan"],
  贵州: ["guizhou"],
  云南: ["yunnan"],
  西藏: ["tibet", "xizang"],
  陕西: ["shaanxi", "shensi"],
  甘肃: ["gansu"],
  青海: ["qinghai"],
  宁夏: ["ningxia"],
  新疆: ["xinjiang"],
  香港: ["hong kong"],
  澳门: ["macau", "macao"],
  拉萨: ["lhasa"],
  日喀则: ["shigatse", "xigaze", "rikaze"],
  江孜: ["gyantse"],
  林芝: ["nyingchi", "linzhi"],
  西安: ["xi'an", "xian"],
  成都: ["chengdu"],
  北京市: ["beijing"],
  上海市: ["shanghai"],
  重庆市: ["chongqing"],
  广州: ["guangzhou"],
  深圳: ["shenzhen"],
  昆明: ["kunming"],
  大理: ["dali"],
  丽江: ["lijiang"],
  乌鲁木齐: ["urumqi", "urumchi", "wulumuqi"],
  喀什: ["kashgar", "kashi"],
  杭州: ["hangzhou"],
  黄山: ["huangshan"],
  桂林: ["guilin"],
  三亚: ["sanya"],
  厦门: ["xiamen"],
  大同: ["datong"],
  太原: ["taiyuan"],
  兰州: ["lanzhou"],
  西宁: ["xining"],
  敦煌: ["dunhuang"],
  嘉峪关: ["jiayuguan"],
  张家界: ["zhangjiajie"],
};

export function normaliseLocation(value: string): string {
  return value.trim()
    .replace(/特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市|地区|自治州/g, "")
    .replace(/special administrative region|autonomous region|province|municipality|prefecture|city|district|county|league|state/gi, "")
    .replace(/[\s'’`·.-]/g, "")
    .toLowerCase();
}

export function locationKeys(value: string): Set<string> {
  const normalised = normaliseLocation(value);
  const keys = new Set([normalised]);
  for (const [canonical, aliases] of Object.entries(ADMINISTRATIVE_ALIASES)) {
    const aliasKeys = [canonical, ...aliases].map(normaliseLocation);
    if (aliasKeys.includes(normalised)) keys.add(normaliseLocation(canonical));
  }
  return keys;
}

export function administrativeType(value: string | undefined): "province" | "city" | "municipality" | "district" | undefined {
  const type = (value ?? "").trim().replace(/[\s'’`·.-]/g, "").toLowerCase();
  if (/province|autonomousregion|specialadministrativeregion|省|自治区|特别行政区/.test(type)) return "province";
  if (/municipality|直辖市/.test(type)) return "municipality";
  if (/city|prefecture|市|州|地区/.test(type)) return "city";
  if (/district|county|banner|旗|区|县/.test(type)) return "district";
  return undefined;
}