/**
 * 省级地名归一 + 省级目的地接受度：
 *   - normaliseProvinceName：去行政区后缀（特别行政区 / 自治区 / 省 / 市）；
 *   - isProvinceLevelName：判定是否本身就是省级行政区（接受「内蒙古」/「内蒙古自治区」）；
 *   - isAcceptablePlanningRegionName：校验 province 字段能不能接受（拒绝带数字 /
 *     机场车站等）；
 *   - resolveTravelScope：把省级目的地解析为「主城市 + 邻近核心城市」，
 *     用于跨区移动 POI 检索。
 */

const PROVINCE_LEVEL_NAMES = new Set([
  "北京", "天津", "河北", "山西", "内蒙古", "辽宁", "吉林", "黑龙江",
  "上海", "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南",
  "湖北", "湖南", "广东", "广西", "海南", "重庆", "四川", "贵州",
  "云南", "西藏", "陕西", "甘肃", "青海", "宁夏", "新疆", "香港", "澳门",
]);

const PROVINCE_TRAVEL_SCOPES: Record<string, { primaryCity: string; nearbyCoreCities: string[] }> = {
  北京: { primaryCity: "北京", nearbyCoreCities: [] },
  天津: { primaryCity: "天津", nearbyCoreCities: [] },
  上海: { primaryCity: "上海", nearbyCoreCities: [] },
  重庆: { primaryCity: "重庆", nearbyCoreCities: [] },
  河北: { primaryCity: "石家庄", nearbyCoreCities: ["正定"] },
  山西: { primaryCity: "太原", nearbyCoreCities: ["晋中"] },
  内蒙古: { primaryCity: "呼和浩特", nearbyCoreCities: ["包头"] },
  辽宁: { primaryCity: "沈阳", nearbyCoreCities: ["抚顺"] },
  吉林: { primaryCity: "长春", nearbyCoreCities: ["吉林市"] },
  黑龙江: { primaryCity: "哈尔滨", nearbyCoreCities: [] },
  江苏: { primaryCity: "南京", nearbyCoreCities: ["镇江", "扬州"] },
  浙江: { primaryCity: "杭州", nearbyCoreCities: ["绍兴"] },
  安徽: { primaryCity: "合肥", nearbyCoreCities: [] },
  福建: { primaryCity: "福州", nearbyCoreCities: ["泉州"] },
  江西: { primaryCity: "南昌", nearbyCoreCities: [] },
  山东: { primaryCity: "济南", nearbyCoreCities: ["泰安"] },
  河南: { primaryCity: "郑州", nearbyCoreCities: ["开封", "洛阳"] },
  湖北: { primaryCity: "武汉", nearbyCoreCities: [] },
  湖南: { primaryCity: "长沙", nearbyCoreCities: ["湘潭"] },
  广东: { primaryCity: "广州", nearbyCoreCities: ["佛山"] },
  广西: { primaryCity: "南宁", nearbyCoreCities: ["柳州"] },
  海南: { primaryCity: "海口", nearbyCoreCities: ["文昌"] },
  四川: { primaryCity: "成都", nearbyCoreCities: ["都江堰"] },
  贵州: { primaryCity: "贵阳", nearbyCoreCities: [] },
  云南: { primaryCity: "昆明", nearbyCoreCities: [] },
  西藏: { primaryCity: "拉萨", nearbyCoreCities: [] },
  陕西: { primaryCity: "西安", nearbyCoreCities: ["咸阳"] },
  甘肃: { primaryCity: "兰州", nearbyCoreCities: [] },
  青海: { primaryCity: "西宁", nearbyCoreCities: [] },
  宁夏: { primaryCity: "银川", nearbyCoreCities: [] },
  新疆: { primaryCity: "乌鲁木齐", nearbyCoreCities: [] },
  香港: { primaryCity: "香港", nearbyCoreCities: [] },
  澳门: { primaryCity: "澳门", nearbyCoreCities: [] },
};

const TRAVEL_SCOPE_CITIES = new Set<string>(
  Object.values(PROVINCE_TRAVEL_SCOPES).flatMap(({ primaryCity, nearbyCoreCities }) => [primaryCity, ...nearbyCoreCities]),
);

function isCoreTravelCity(name: string): boolean {
  return TRAVEL_SCOPE_CITIES.has(normaliseProvinceName(name));
}

export function normaliseProvinceName(value: string): string {
  return value.trim().replace(/(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市)$/, "").trim();
}

/**
 * 判断一个名称是否本身就是省级行政区，而不是普通目的地城市。
 *
 * 规划输入允许用户直接写「内蒙古」或「内蒙古自治区」作为目的地；
 * 这类名称在 basicInfo 中会同时出现在 province / destinationCity，
 * 但不能因此被当作「把城市伪装成省份」而拒绝。
 */
export function isProvinceLevelName(value: string): boolean {
  return PROVINCE_LEVEL_NAMES.has(normaliseProvinceName(value));
}

export function isAcceptablePlanningRegionName(value: string, destinationCity = ""): boolean {
  const region = normaliseProvinceName(value);
  const city = normaliseProvinceName(destinationCity);
  if (!region || region.length > 40 || /\d/.test(region)) return false;
  if (/[机场车站码头酒店民宿景区]/.test(region)) return false;
  if (!isProvinceLevelName(region) && isCoreTravelCity(region)) return false;
  if (city && region === city && !isProvinceLevelName(region)) return false;
  return true;
}

export function resolveTravelScope(destination: string): { input: string; isProvinceLevel: boolean; primaryCity: string; nearbyCoreCities: string[] } {
  const input = destination.trim();
  const province = normaliseProvinceName(input);
  const scope = PROVINCE_TRAVEL_SCOPES[province];
  if (!scope) return { input, isProvinceLevel: false, primaryCity: input, nearbyCoreCities: [] };
  return { input, isProvinceLevel: true, primaryCity: scope.primaryCity, nearbyCoreCities: scope.nearbyCoreCities };
}