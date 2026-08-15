import {
  HHMM_REGEX,
  productSchema,
} from "./schema-definitions.js";
import { mergeReadinessIssues } from "../../../shared/readiness-issues.js";
import { hasSatisfiedVehicleResource, isResearchTaskSatisfiedByProduct } from "../../../shared/research-task-satisfaction.js";
import { readCover } from "../../operations/cover-info.js";
import { evaluateAutomationContract } from "../automation-contract.js";
import { findVbkCopyBadCase } from "../../planning/vbk-copy-policy.js";

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
 *  - pickKeySpotsFromItinerary：按行程顺序提取国家景区景点（无 LLM 调用）
 */

/** zod 校验入口；schema 定义见 ./schema-definitions.js。 */
export function parseProduct(input: unknown) {
  return productSchema.parse(input);
}

export type CtripLibraryImageAspect = "landscape" | "any";

/**
 * 在候选图中挑「质量分最低值 ≥ minQuality、分辨率 ≥ 1280×800、landscape 时保证宽 ≥ 高」中
 * 最低质量分最高的那张。返回其 index；都不达标返回 -1。
 */
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

/**
 * 规划 / 草稿阶段不把价格、库存、套餐名、条款成本口径作为阻塞项；这些由
 * 上架时在 VBK 里核算。这里仅保留资源、安全发布态等会影响草稿自动化的卡点。
 *
 * 实现原则：把 VBK 实际写入/读取的字段契约集中到 automation-contract.ts，
 * 本函数只做「ready = 没有任何 ai-planning / account-fixed 字段缺失」的
 * 转发 + 兼容旧 release 阻断 / research task 阻断语义。
 */
export function automationBlockers(product: Record<string, unknown>, options: { researchTasks?: Array<{ state: string; label?: string; type?: string }> } = {}) {
  const blockers: Array<{ label: string; detail: string }> = [];
  const commercial = product.commercial as Record<string, unknown> | undefined;
  // 1) 核心 VBK 字段契约（ai-planning / account-fixed 缺失 = 阻断）。
  const contract = evaluateAutomationContract(product);
  for (const failure of contract.failures) {
    blockers.push({ label: failure.field.label, detail: failure.reason });
  }
  // 旧草稿可能绕过 stage-runner 的输出门禁；启动自动化前重新扫描产品文案，
  // 避免平台黑名单词进入 VBK 页面后才失败。
  const copyBadCase = findVbkCopyBadCase(product);
  if (copyBadCase) {
    blockers.push({
      label: "VBK 文案黑名单",
      detail: `${copyBadCase.path} 命中「${copyBadCase.term}」：${copyBadCase.reason}；请改写为「${copyBadCase.alternatives.join("」或「")}」。`,
    });
  }
  // 2) 手动上传封面是单独阻断：自动化阶段不支持，UI 上要走别的提示。
  const cover = readCover(product);
  if (cover?.source === "manualUpload") {
    blockers.push({
      label: "封面来源",
      detail: "手动上传封面暂不支持自动录入，请改用携程图库或手动处理。",
    });
  }
  // 3) 私家团用车资源组是预检硬阻断：VBK 资源组匹配要等 vehicleResource
  //    阶段才能走，在那之前让运营先核查 / 重算后填好 resourceGroupId + Name。
  //    vbk-runtime 阶段的「资源组 ID 是 VBK 回填」是事实，但 readiness 必须
  //    在这之前就拦下，否则自动录入起跑后会一直走直到 vehicleResource 阶段
  //    才报错，前面的 basic / presentation / itinerary / package / pricing
  //    / terms 阶段白跑。
  const sales = product.sales as Record<string, unknown> | undefined;
  if (sales?.productForm === "privateTour" && !hasSatisfiedVehicleResource(product)) {
    blockers.push({ label: "用车资源组", detail: "私家团需要在 VBK 核查并填写现有用车资源组 ID。" });
  }
  // 3) 草稿默认安全：release 还在 draft-only 状态时，禁止进入自动录入。人工 / VBK
  // 会在审核后逐项打开 submitReview / publishAfterApproval。
  const release = commercial?.release as Record<string, unknown> | undefined;
  if (release) {
    if (release.submitReview === true) blockers.push({ label: "submitReview 仍为草稿状态", detail: "需在 VBK 或运营面板中明确开启后才能自动录入。" });
    if (release.publishAfterApproval === true) blockers.push({ label: "publishAfterApproval 仍为草稿状态", detail: "需在 VBK 或运营面板中明确开启后才能自动录入。" });
  }
  // 未解决且不能由当前 product 本地字段满足的资源类 research task 才阻断。
  const tasks = options.researchTasks ?? [];
  const openTasks = tasks.filter((task) =>
    task.state !== "confirmed" &&
    task.state !== "resolved" &&
    !isResearchTaskSatisfiedByProduct(task, product),
  );
  const blockingLabels = {
    vehicle: /用车|车辆|资源组|接送|司机/,
    hotel: /酒店|住宿|客栈|民宿/,
  };
  for (const task of openTasks) {
    const label = task.label || "";
    if (blockingLabels.vehicle.test(label)) blockers.push({ label: `车辆核查：${label}`, detail: "需 VBK 匹配资源组后才能自动录入。" });
    else if (blockingLabels.hotel.test(label)) blockers.push({ label: `酒店核查：${label}`, detail: "需 VBK 匹配酒店资源后才能自动录入。" });
  }
  return mergeReadinessIssues(blockers);
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
 * 管家联系人下拉：优先按 stable contactCardId 匹配（option.value 携带）。
 *
 * 失败回退策略（核心安全契约，绝不允许误选）：
 *  - 优先按 ID 严格相等匹配；命中即返回。
 *  - 只有当 VBK 整列都未提供 value（说明这是 VBK 未带 contactCardId 的
 *    退化下拉，例如老版本或网络异常场景）时，才允许按 displayName 回退。
 *    一旦任何一项携带非空 value（VBK 已给出 contactCardId），就绝对不能
 *    落到 byName 回退，否则会把「ID 已删除 / 已停用但同姓名仍存在」的
 *    旧联系人误选到当前产品上（真实 run 09306ec1 复现：固定联系人
 *    「安思科」ID 1368298 在 VBK 列表里已不存在，但同姓名的另一张卡
 *    仍存在，byName 回退会把它选成新的负责人）。
 *  - byName 接受纯姓名，也接受「姓名 + 空白 + 联系方式」（VBK 会把邮箱
 *    和手机号拼到姓名后面）；不接受「姓名-国际」这类同名前缀，避免
 *    选错联系人。
 *  - 都失败返回 -1，让 fillButlerContact 走「显式抛错」路径而不是
 *    「默认第一项」之类的隐式兜底。
 */
export function findButlerOptionIndex(
  options: ReadonlyArray<{ value: string; label: string }>,
  selection: { contactCardId: number; displayName?: string },
): number {
  const targetId = String(selection.contactCardId);
  // 1) 严格按 contactCardId 匹配（value 与 targetId 完全相等；含 value 为
  //    空字符串时与 targetId 不等，自然落到 -1，不会误选「value=空」的项）。
  const byId = options.findIndex((option) => option.value === targetId);
  if (byId >= 0) return byId;
  // 2) byName 回退的安全门：仅当整列都未提供 value 时才允许按姓名匹配；
  //    只要任何一项带非空 value，就立即 -1，不做 byName。这是「固定联系
  //    人已被 VBK 移除」与「VBK 同姓名新建了另一张卡」两个场景的
  //    安全防线：宁可让 fillButlerContact 显式抛错，也不要被静默选错。
  const hasAnyValue = options.some((option) => option.value && option.value.length > 0);
  if (hasAnyValue) return -1;
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
 * 国家景区的景点完全以当前 itinerary[].spots[].name 为来源：按行程顺序
 * 去除空名称和重复项后全部交给 VBK。历史字符串项不再作为主路径，安全跳过。
 */
export function pickKeySpotsFromItinerary(product: Record<string, unknown>): string[] {
  const itinerary = Array.isArray(product.itinerary) ? (product.itinerary as Array<Record<string, unknown>>) : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const day of itinerary) {
    if (!day || typeof day !== "object") continue;
    const spots = Array.isArray(day.spots) ? (day.spots as Array<unknown>) : [];
    for (const raw of spots) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      // 优先使用 poiName（VBK 内部标签名），回退到 name（行程描述名）；
      // poiName 更贴近 VBK 景区的实际下拉选项，可显著提升精确匹配率。
      const spotRecord = raw as { name?: unknown; poiName?: unknown };
      const rawName = typeof spotRecord.poiName === "string" && spotRecord.poiName.trim()
        ? spotRecord.poiName.trim()
        : typeof spotRecord.name === "string" ? spotRecord.name.trim() : "";
      const spot = rawName.trim();
      if (!spot) continue;
      const key = spot.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(spot);
    }
  }
  return result;
}
