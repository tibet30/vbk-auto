import { postTrafficLineSoa, type TrafficLinePage } from "./traffic-line/client.js";

export const PRODUCT_MENU_KEYS = [
  "saleControl", "basicInfo", "pictureAndText", "TourDays", "combomanage",
  "inventory", "travelOptionNew", "newResourceClause", "trafficLineEdit", "advancedSettings",
] as const;

const PRODUCT_WIZARD_RECOVERY_STEPS = [
  { maxStep: -80, unlockedCount: 2, phase: "basic" },
  { maxStep: -70, unlockedCount: 3, phase: "presentation" },
  { maxStep: -60, unlockedCount: 4, phase: "itinerary" },
] as const;

export interface ProductMenu {
  key: string;
  title: string;
  url: string;
  enabled: "T" | "F";
}

export type ProductWizardRecoveryPhase = typeof PRODUCT_WIZARD_RECOVERY_STEPS[number]["phase"];

export type ProductMenuRecoveryEvidence = {
  maxStep: number;
  menus: readonly Pick<ProductMenu, "key" | "enabled">[];
};

/** The platform may append menus, but it must never reorder the core wizard. */
export function productMenuCore<T>(menus: readonly T[]): T[] {
  return menus.slice(0, PRODUCT_MENU_KEYS.length);
}

function hasOfficialMenuShape(
  menus: readonly Pick<ProductMenu, "key" | "enabled">[],
  unlockedCount: number,
): boolean {
  const core = productMenuCore(menus);
  return core.length === PRODUCT_MENU_KEYS.length
    && core.every((menu, index) => menu?.key === PRODUCT_MENU_KEYS[index]
      && menu.enabled === (index < unlockedCount ? "T" : "F"));
}

/**
 * Maps only the contiguous, platform-defined draft states to the phase that
 * must be recovered. Fully unlocked and malformed/noncanonical states both
 * deliberately return undefined; callers must separately verify full unlock.
 */
export function productWizardRecoveryPhase(
  evidence: ProductMenuRecoveryEvidence,
): ProductWizardRecoveryPhase | undefined {
  if (!Number.isInteger(evidence.maxStep)) return undefined;
  return PRODUCT_WIZARD_RECOVERY_STEPS.find(step => evidence.maxStep === step.maxStep
    && hasOfficialMenuShape(evidence.menus, step.unlockedCount))?.phase;
}

/**
 * A successful itinerary review advances the wizard by exactly one boundary:
 * package management becomes available while later modules stay locked until
 * their own saves.  Accept later contiguous progress too, so a read-only
 * recovery can still prove the review after another operator saved a module.
 */
export function isItineraryReviewCompletedMenus(evidence: ProductMenuRecoveryEvidence): boolean {
  if (evidence.maxStep !== 10) return false;
  const core = productMenuCore(evidence.menus);
  if (core.length !== PRODUCT_MENU_KEYS.length
    || core.some((menu, index) => menu.key !== PRODUCT_MENU_KEYS[index])) return false;
  let locked = false;
  for (const [index, menu] of core.entries()) {
    if (index < 5 && menu.enabled !== "T") return false;
    if (menu.enabled === "F") locked = true;
    else if (locked) return false;
  }
  return evidence.menus.slice(PRODUCT_MENU_KEYS.length).every(menu => menu.enabled === "T");
}

export interface ProductMenuDraftContext {
  base: Record<string, unknown>;
  tourInfo: Record<string, unknown>;
  verifiedTourInfoId: string | number;
}

function officialMenuUrl(url: string): URL | undefined {
  try {
    const parsed = new URL(url, "https://vbooking.ctrip.com");
    return parsed.origin === "https://vbooking.ctrip.com" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function menuProductId(url: string): string | undefined {
  const parsed = officialMenuUrl(url);
  const value = parsed?.searchParams.get("productId") ?? parsed?.searchParams.get("productid");
  return value && /^\d+$/.test(value) ? String(Number(value)) : undefined;
}

type ExtensionMenuScope = "product" | "unscoped";

function extensionMenuScope(menu: ProductMenu | undefined, productId: string, seen: Set<string>): ExtensionMenuScope | undefined {
  if (!menu) return undefined;
  const key = typeof menu?.key === "string" ? menu.key.trim() : "";
  if (!key || PRODUCT_MENU_KEYS.includes(key as typeof PRODUCT_MENU_KEYS[number]) || seen.has(key)) return undefined;
  seen.add(key);
  if (typeof menu.title !== "string" || (menu.enabled !== "T" && menu.enabled !== "F") || typeof menu.url !== "string") return undefined;
  const parsed = officialMenuUrl(menu.url);
  if (!parsed) return undefined;
  const id = menuProductId(menu.url);
  if (!id) return parsed.searchParams.has("productId") || parsed.searchParams.has("productid") ? undefined : "unscoped";
  return id === productId ? "product" : undefined;
}

export async function readProductMenus(page: TrafficLinePage, productId: string) {
  if (!/^\d+$/.test(productId) || Number(productId) <= 0) throw new Error("菜单回读产品 ID 无效");
  for (let attempt = 1; ; attempt += 1) {
    try { return await readProductMenusOnce(page, productId); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 3 || !/VBK 菜单回读(?:数量或固定键不一致|缺失、重复或状态无效)/u.test(message)) throw error;
      await new Promise<void>(resolve => setTimeout(resolve, attempt * 150));
    }
  }
}

async function readProductMenusOnce(page: TrafficLinePage, productId: string) {
  const result = await postTrafficLineSoa(page, "15638", "getSubMenu.json",
    { productId: Number(productId) }, "VBK 菜单解锁回读");
  if (result.hasPermission !== true) throw new Error("VBK 菜单回读未确认当前产品权限");
  if (!Number.isFinite(result.maxStep)) throw new Error("VBK 菜单回读缺少有效 maxStep");
  if (!Array.isArray(result.menus)) throw new Error("VBK 菜单回读缺少 menus");
  const menus = result.menus as ProductMenu[];
  const expectedProductId = String(Number(productId));
  if (menus.length < PRODUCT_MENU_KEYS.length) {
    const keys = menus.slice(0, 16).map(menu => String(menu?.key ?? "未知").replace(/[^a-zA-Z0-9_-]/g, "?").slice(0, 40));
    throw new Error(`VBK 菜单回读数量或固定键不一致（数量=${menus.length}，键=${keys.join(",")}）`);
  }
  for (const [index, key] of PRODUCT_MENU_KEYS.entries()) {
    const item = menus[index];
    if (!item || item.key !== key || !["T", "F"].includes(item.enabled)) {
      throw new Error(`VBK 菜单回读缺失、重复或状态无效：${key}（${safeMenuShape(menus.slice(0, 16))}）`);
    }
    if (typeof item.url !== "string" || menuProductId(item.url) !== expectedProductId) {
      throw new Error(`VBK 菜单回读产品身份不一致：${key}`);
    }
  }
  const extensionMenus = menus.slice(PRODUCT_MENU_KEYS.length);
  const seen = new Set<string>();
  const unscopedExtensionMenus: ProductMenu[] = [];
  for (const menu of extensionMenus) {
    const scope = extensionMenuScope(menu, expectedProductId, seen);
    if (!scope) {
      throw new Error(`VBK 菜单回读扩展菜单无效：${safeMenuShape(extensionMenus)}`);
    }
    if (scope === "unscoped") unscopedExtensionMenus.push(menu);
  }
  if (seen.size !== extensionMenus.length) {
    throw new Error(`VBK 菜单回读扩展菜单无效：${safeMenuShape(extensionMenus)}`);
  }
  return { productId, maxStep: result.maxStep as number, menus,
    coreMenus: productMenuCore(menus), extensionMenus, unscopedExtensionMenus,
    fullyUnlocked: result.maxStep === 10 && !unscopedExtensionMenus.length
      && menus.every(menu => menu.enabled === "T") };
}

function safeMenuShape(menus: ProductMenu[]): string {
  const keys = menus.map(menu => typeof menu?.key === "string" ? menu.key : "<invalid>");
  return `count=${menus.length}; keys=${keys.join(",") || "<none>"}`;
}

function auditStatus(tourInfo: Record<string, unknown>) {
  const value = tourInfo.auditStatus;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const status = value as Record<string, unknown>;
  const key = typeof status.key === "string" ? status.key : "";
  const label = typeof status.value === "string" ? status.value : "";
  return key && label ? { key, value: label } : undefined;
}

function isReviewBoundary(evidence: Awaited<ReturnType<typeof readProductMenus>>, context: ProductMenuDraftContext | undefined) {
  const lockedMenus = PRODUCT_MENU_KEYS.filter((_, index) => evidence.menus[index]?.enabled === "F");
  const extensionUnlocked = evidence.extensionMenus.every(menu => menu.enabled === "T");
  const audit = context && auditStatus(context.tourInfo);
  const tourInfoId = context?.verifiedTourInfoId;
  const draftSaved = (typeof tourInfoId === "number" && tourInfoId > 0)
    || (typeof tourInfoId === "string" && /^\d+$/.test(tourInfoId) && Number(tourInfoId) > 0);
  const relationIds = context ? ["tourInfoId", "draftTourInfoId", "previewTourInfoId", "auditTourInfoId"]
    .map(key => context.tourInfo[key]).filter(value => value !== undefined && value !== null && String(value) !== "0") : [];
  const relationMatches = draftSaved && relationIds.some(value => String(value) === String(tourInfoId));
  const nonCruise = context !== undefined && ![true, 1, "1"].includes(context.base.isCruise as boolean | number | string);
  return {
    lockedMenus,
    audit,
    draftSaved,
    diagnostics: {
      supportedStep: evidence.maxStep === -60,
      menuShape: hasOfficialMenuShape(evidence.menus, 4),
      extensionIdentity: evidence.unscopedExtensionMenus.length === 0,
      extensionUnlocked,
      nonCruise,
      relationMatches,
      auditMatches: audit?.key === "A" || audit?.key === "N",
    },
    matches: productWizardRecoveryPhase(evidence) === "itinerary"
      && evidence.unscopedExtensionMenus.length === 0
      && extensionUnlocked
      && nonCruise
      && relationMatches
      && (audit?.key === "A" || audit?.key === "N"),
  };
}

function verifiedUnlocked(evidence: Awaited<ReturnType<typeof readProductMenus>>) {
  const lockedMenus = evidence.menus.filter(menu => menu.enabled !== "T");
  if (evidence.fullyUnlocked) {
    return { ...evidence, verified: true as const, fullyUnlocked: true as const, lockedMenus: [],
      advancementRequiresReview: false as const, draftSaved: undefined, savedItineraryTourInfoId: undefined, auditStatus: undefined };
  }
  const incomplete = [
    ...(evidence.maxStep === 10 ? [] : [`流程未到完成步骤（maxStep=${evidence.maxStep}）`]),
    ...lockedMenus.map(menu => menu.title || menu.key),
    ...evidence.unscopedExtensionMenus.map(menu => `${menu.title || menu.key}（未绑定当前产品）`),
  ];
  throw new Error(`VBK 菜单尚未解锁（maxStep=${evidence.maxStep}）：${incomplete.join("、")}`);
}

/** Strict completion gate for writes and wizard progression: every returned menu is unlocked. */
export async function verifyProductMenusUnlocked(page: TrafficLinePage, productId: string) {
  return verifiedUnlocked(await readProductMenus(page, productId));
}

/** Read-only preflight accepts only the documented itinerary-review boundary. */
export async function verifyProductDraftMenus(
  page: TrafficLinePage,
  productId: string,
  context: ProductMenuDraftContext,
) {
  const evidence = await readProductMenus(page, productId);
  if (isItineraryReviewCompletedMenus(evidence)) {
    return { ...evidence, verified: true as const, reviewCompleted: true as const,
      lockedMenus: evidence.menus.filter(menu => menu.enabled === "F").map(menu => menu.key),
      advancementRequiresReview: false as const, draftSaved: undefined,
      savedItineraryTourInfoId: String(context.verifiedTourInfoId), auditStatus: auditStatus(context.tourInfo) };
  }
  const boundary = isReviewBoundary(evidence, context);
  if (!boundary.lockedMenus.length) return verifiedUnlocked(evidence);
  if (boundary.matches) {
    const feature = await postTrafficLineSoa(page, "15638", "inSwitch",
      { key: "product_input_opt", id: productId }, "VBK 官方行程推进模式回读");
    if (feature.switched === true) {
      return { ...evidence, verified: true as const, fullyUnlocked: false as const, lockedMenus: boundary.lockedMenus,
        advancementRequiresReview: true as const, draftSaved: true as const,
        savedItineraryTourInfoId: String(context.verifiedTourInfoId), auditStatus: boundary.audit! };
    }
  }
  const failed = Object.entries(boundary.diagnostics).filter(([, valid]) => !valid).map(([key]) => key);
  const titles = [
    ...evidence.menus.filter(menu => menu.enabled === "F").map(menu => menu.title || menu.key),
    ...evidence.unscopedExtensionMenus.map(menu => `${menu.title || menu.key}（未绑定当前产品）`),
  ];
  throw new Error(`VBK 菜单尚未解锁（maxStep=${evidence.maxStep}；审核边界不符=${failed.join(",") || "官方推进开关"}）：${titles.join("、")}`);
}
