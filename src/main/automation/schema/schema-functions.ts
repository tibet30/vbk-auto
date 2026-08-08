import {
  HHMM_REGEX,
  productSchema,
} from "./schema-definitions.js";

/**
 * 自动化层产品 schema 工具。
 *
 * 绝大多数函数都是「从产品对象里抽出某个字段、并在 VBK 下拉里挑出对应选项」。
 * 入口处一定要在调用 VBK 前完成基础信息（productId、basicInfoSaved 等）检查，
 * 这些 helper 不再重复校验上游状态。
 *
 * 主要导出：
 *  - parseProduct：用 zod 校验一个产品对象是否符合契约
 *  - findBestCtripLibraryImage：从携程图片库挑选最佳封面
 *  - resolveAdvanceBooking / shouldRefillBasicInfo / basicInfoCompletenessIssues：basic 阶段决策
 *  - automationBlockers：列出阻止自动录入启动的卡点
 *  - findFirstEnabledOptionIndex / findProvinceOptionIndex / findButlerOptionIndex：下拉匹配
 *  - pickKeySpotsFromItinerary：从行程里挑"重点景点"（无 LLM 调用）
 */

/** zod 校验入口；schema 定义见 ./schema-definitions.js。 */
export function parseProduct(input: unknown) {
  return productSchema.parse(input);
}

export type CtripLibraryImageAspect = "landscape" | "any";

export function findBestCtripLibraryImage(
  images: ReadonlyArray<{ quality: string; resolution: string }>,
  minQuality: number,
  aspect: CtripLibraryImageAspect = "landscape",
) {
  let bestIndex = -1;
  let bestQuality: number = -Infinity;
  images.forEach((image, index) => {
    const qualities: number[] = image.quality.match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
    const lowestQuality: number = qualities.length ? Math.min(...qualities) : -Infinity;
    const dimensions: number[] = image.resolution.match(/\d+/g)?.map(Number) || [];
    const [width = 0, height = 0] = dimensions;
    if (lowestQuality < minQuality || width < 1280 || height < 800) return;
    if (aspect === "landscape" && width < height) return;
    if (lowestQuality > bestQuality) {
      bestQuality = lowestQuality;
      bestIndex = index;
    }
  });
  return bestIndex;
}

export const DEFAULT_ADVANCE_BOOKING_DAYS = 1;
export const DEFAULT_ADVANCE_BOOKING_TIME = "12:00";

/**
 * 读取提前预订配置；缺失时回落到默认值 1 天 12:00。源数据为无效值时返回 null，
 * 调用方应将其视为「运营配置错误」并阻断 basic 阶段。
 */
export function resolveAdvanceBooking(product: Record<string, unknown>): { days: number; time: string } | null {
  const operations = product.operations as Record<string, unknown> | undefined;
  const raw = operations?.bookingControls as Record<string, unknown> | undefined;
  const value = raw?.advanceBooking as Record<string, unknown> | undefined;
  const rawDays = value?.days ?? DEFAULT_ADVANCE_BOOKING_DAYS;
  const rawTime = value?.time ?? DEFAULT_ADVANCE_BOOKING_TIME;
  const days = typeof rawDays === "number" ? rawDays : DEFAULT_ADVANCE_BOOKING_DAYS;
  const time = typeof rawTime === "string" ? rawTime : DEFAULT_ADVANCE_BOOKING_TIME;
  if (!Number.isInteger(days) || days < 0) return null;
  if (!HHMM_REGEX.test(time)) return null;
  return { days, time };
}

/**
 * 决定 basic 阶段运行的上下文状态：
 *   - "noProductId"：尚未创建远程草稿（首次运行）
 *   - "complete"：之前阶段成功保存且当前产品仍可视为完整
 *   - "retry"：存在 productId 但 basic 阶段尚未确认保存，或产品缺失必填字段
 *
 * 注意：调用方当前总是要求重跑 basic —— fillAndSaveBasicInfo 内部走幂等
 * 填写并在保存后做红错校验，错误会立即抛错阻断后续阶段。本函数仅决定日志
 * 标签以供运营查看 “为什么这一轮又要走一次 basic”。
 */
export function shouldRefillBasicInfo({
  productId,
  basicInfoSaved,
  product,
}: {
  productId?: string;
  basicInfoSaved?: boolean;
  product: Record<string, unknown>;
}): { refill: boolean; reason: "noProductId" | "retry" | "complete" } {
  if (!productId) return { refill: true, reason: "noProductId" };
  const operations = product.operations as Record<string, unknown> | undefined;
  if (!operations?.bookingControls) {
    return { refill: true, reason: "retry" };
  }
  if (basicInfoSaved && !basicInfoCompletenessIssues(product).length) {
    return { refill: false, reason: "complete" };
  }
  return { refill: true, reason: "retry" };
}

/**
 * 基本信息完整性检查：基本页关键字段是否齐备。
 * 返回缺失字段标签数组；空数组表示基本信息完整。
 * 地接社与管家联系人不在产品 JSON 里，运行时由账号固定信息或 VBK 下拉负责。
 */
export function basicInfoCompletenessIssues(product: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const basic = product.basicInfo as Record<string, unknown> | undefined;
  if (!basic?.province || typeof basic.province !== "string" || !basic.province.trim()) {
    issues.push("国家景区（省份）");
  }
  if (!resolveAdvanceBooking(product)) issues.push("提前预订");
  return issues;
}

// 第一版允许暂不维护库存与费用包含：有完整数据时自动录入，没有时跳过对应
// VBK 阶段。价格仍用于运营审查，但只有同时存在库存时才写入价格库存页。
export function automationBlockers(product: Record<string, unknown>, options: { researchTasks?: Array<{ state: string; label?: string; type?: string }> } = {}) {
  const blockers: Array<{ label: string; detail: string }> = [];
  const commercial = product.commercial as Record<string, unknown> | undefined;
  if (!commercial) {
    blockers.push({ label: "套餐与价格", detail: "缺少套餐、价格库存与条款配置，自动录入无法完成。" });
  } else {
    if (!commercial.packageName) blockers.push({ label: "套餐名称", detail: "请补充套餐名称。" });
    if (!commercial.pricing) blockers.push({ label: "价格", detail: "请补充成人价、儿童价与最低成团人数。" });
  }
  const sales = product.sales as Record<string, unknown> | undefined;
  if (sales?.productForm === "privateTour") {
    const operations = product.operations as Record<string, unknown> | undefined;
    const vehicle = operations?.vehicleResource as Record<string, unknown> | undefined;
    if (!vehicle?.resourceGroupId) {
      blockers.push({ label: "用车资源组", detail: "私家团需要在 VBK 核查并填写现有用车资源组 ID。" });
    }
  }
  // 草稿默认安全：release 还在 draft-only 状态时，禁止进入自动录入。人工 / VBK
  // 会在审核后逐项打开 submitReview / publishAfterApproval。
  const release = commercial?.release as Record<string, unknown> | undefined;
  if (release) {
    if (release.submitReview === true) blockers.push({ label: "submitReview 仍为草稿状态", detail: "需在 VBK 或运营面板中明确开启后才能自动录入。" });
    if (release.publishAfterApproval === true) blockers.push({ label: "publishAfterApproval 仍为草稿状态", detail: "需在 VBK 或运营面板中明确开启后才能自动录入。" });
  }
  // 未解决的 pricing / inventory / 车辆 / 酒店 research task 也会阯。
  const tasks = options.researchTasks ?? [];
  const openTasks = tasks.filter((task) => task.state !== "confirmed" && task.state !== "resolved");
  const blockingLabels = {
    price: /价格|成人价|儿童价|成本|单房差|加床费|售价/,
    inventory: /库存|班期|每日配额|起订|起止日期/,
    vehicle: /用车|车辆|资源组|接送|司机/,
    hotel: /酒店|住宿|客栈|民宿/,
  };
  for (const task of openTasks) {
    const label = task.label || "";
    if (blockingLabels.price.test(label)) blockers.push({ label: `价格核查：${label}`, detail: task.type === "vbk" ? "需在 VBK 核查后才能自动录入。" : "需人工确认后才能自动录入。" });
    else if (blockingLabels.inventory.test(label)) blockers.push({ label: `库存核查：${label}`, detail: "需人工 / VBK 核查后才能自动录入。" });
    else if (blockingLabels.vehicle.test(label)) blockers.push({ label: `车辆核查：${label}`, detail: "需 VBK 匹配资源组后才能自动录入。" });
    else if (blockingLabels.hotel.test(label)) blockers.push({ label: `酒店核查：${label}`, detail: "需 VBK 匹配酒店资源后才能自动录入。" });
  }
  return blockers;
}

/**
 * 在 VBK 下拉里挑第一个「可用且非 disabled」的选项。返回 index；没有可用
 * 项返回 -1。emptyTexts 表示空态文案（应排除），disableds 与 texts 同长
 * （true 表示该行不可选）。
 */
export function findFirstEnabledOptionIndex(
  texts: ReadonlyArray<string>,
  disableds: ReadonlyArray<boolean>,
  emptyTexts: ReadonlyArray<string> = [],
): number {
  for (let index = 0; index < texts.length; index += 1) {
    if (disableds[index]) continue;
    const text = (texts[index] || "").trim();
    if (!text) continue;
    if (emptyTexts.some((empty) => empty.trim() === text)) continue;
    return index;
  }
  return -1;
}

/**
 * 国家景区省份下拉匹配：去掉「省/市/自治区/特别行政区」等行政区后缀后做
 * 精确匹配，命中后返回 index；否则返回 -1。
 */
export function findProvinceOptionIndex(
  texts: ReadonlyArray<string>,
  province: string,
): number {
  const label = (province || "").trim();
  if (!label) return -1;
  const exact = texts.findIndex((text) => (text || "").trim() === label);
  if (exact >= 0) return exact;
  const normalise = (value: string) => value
    .replace(/\s+/g, "")
    // VBK 远程搜索结果会把所属国家直接拼在行政区后面，例如“山西中国”。
    .replace(/中国$/, "")
    .replace(/(维吾尔自治区|壮族自治区|回族自治区|特别行政区|自治区|省|市)$/g, "");
  const normalised = normalise(label);
  return texts.findIndex((text) => normalise((text || "").trim()) === normalised);
}

/**
 * 管家联系人下拉：优先按 stable contactCardId 匹配（option.value 携带），
 * 失败回退到 displayName 匹配。VBK 下拉会把邮箱和手机号拼到姓名后面，
 * 因此既接受纯姓名，也接受「姓名 + 空白 + 联系方式」；不接受
 * 「姓名-国际」这类同名前缀，避免选错联系人。都失败返回 -1。
 */
export function findButlerOptionIndex(
  options: ReadonlyArray<{ value: string; label: string }>,
  selection: { contactCardId: number; displayName?: string },
): number {
  const byId = options.findIndex((option) => String(option.value) === String(selection.contactCardId));
  if (byId >= 0) return byId;
  if (selection.displayName) {
    const targetName = selection.displayName.trim();
    const byName = options.findIndex((option) => {
      // VBK 实际选项前会带私有区图标字符（例如“󰄼 安思科 ...”），
      // 先剥掉姓名前的非字母数字装饰，再做严格姓名边界匹配。
      const label = (option.label || "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[^\p{L}\p{N}]+/u, "");
      return label === targetName || label.startsWith(`${targetName} `);
    });
    if (byName >= 0) return byName;
  }
  return -1;
}

/**
 * 从行程中按确定性规则挑选「重点景点」：先取行程里出现在产品推荐语或
 * 产品特点中的景点，再按行程顺序补足。这样会优先选择产品主打 IP，同时
 * 不调用任何 LLM。括号中的别名也参与匹配，例如「永祚寺（双塔寺）」可由
 * 推荐语中的「永祚寺」命中。
 */
export function pickKeySpotsFromItinerary(
  product: Record<string, unknown>,
  max = 3,
): string[] {
  const limit = Number.isInteger(max) && max > 0 ? max : 3;
  const itinerary = Array.isArray(product.itinerary) ? (product.itinerary as Array<Record<string, unknown>>) : [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  // 净化输入名：把「云冈石窟游览」「华严寺参观」之类动作后缀去掉，只喂景点名字。
  // 这些后缀是行程里的口述写法，VBK 景点下拉里不存在“游览”这个子串。
  // 同时清掉括号别名、掊点号与空格。
  const normalizeSpot = (text: string) =>
    text
      .replace(/[\s\u3000]+/g, "")
      .replace(/[（(][^）)]+[）)]/g, "")
      .replace(/(?:游览|参观|参观游览|游览参观|参观游览参观)$/u, "")
      .replace(/[·・•・]/g, "");
  for (const day of itinerary) {
    if (!day || typeof day !== "object") continue;
    const spots = Array.isArray(day.spots) ? (day.spots as Array<unknown>) : [];
    for (const raw of spots) {
      if (typeof raw !== "string") continue;
      const text = raw.trim();
      if (!text) continue;
      const cleaned = normalizeSpot(text);
      if (!cleaned || cleaned.length < 2) continue;
      // 接团/送团/返程/自由活动 这种非景点词跳过，避免下拉误点。
      if (/(?:接团|送团|送机|接机|返程|出发|报到|入住|退房|自由活动)/u.test(cleaned)) continue;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(cleaned);
    }
  }
  const presentation = product.presentation as Record<string, unknown> | undefined;
  const corpus = [presentation?.recommendation, presentation?.features]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .replace(/\s+/g, "");
  const isHighlighted = (spot: string) => {
    const compact = spot.replace(/\s+/g, "");
    const aliases = [
      compact,
      compact.replace(/[（(].*?[）)]/g, ""),
      ...Array.from(compact.matchAll(/[（(]([^）)]+)[）)]/g), (match) => match[1]),
    ].filter(Boolean);
    return aliases.some((alias) => corpus.includes(alias));
  };
  // 首日第一个景点通常是行程落地后的核心到访点；先保留它，再从产品
  // 推荐语中挑主打景点。当前太原行程因此得到“柳巷、晋祠、山西博物院”。
  const firstItinerarySpot = candidates[0];
  const result: string[] = [];
  const seenFinal = new Set<string>();
  const pushUnique = (spot: string) => {
    const key = spot.toLowerCase();
    if (seenFinal.has(key)) return;
    seenFinal.add(key);
    result.push(spot);
  };
  if (firstItinerarySpot) pushUnique(firstItinerarySpot);
  for (const spot of candidates) {
    if (result.length >= limit) break;
    if (spot === firstItinerarySpot) continue;
    if (!isHighlighted(spot)) continue;
    pushUnique(spot);
  }
  for (const spot of candidates) {
    if (result.length >= limit) break;
    if (spot === firstItinerarySpot) continue;
    if (isHighlighted(spot)) continue;
    pushUnique(spot);
  }
  return result;
}
