/**
 * 「产品创建前置守卫」：在主进程 IPC 层 products:create / 数据库层 createProduct
 * 调用之前，对登录态 + 当前账号固定信息做硬性校验。
 *
 * 硬约束（必须满足至少一条，否则抛错）：
 *  1. 当前 VBK 账号已登录（settings.vbkAccountName 非空）；
 *  2. 当前账号已配置 400 电话（servicePhone 非空字符串）；
 *  3. 当前账号已配置合法管家联系人（butlerName 是合法 ContactCardSelection）。
 *
 * 设计意图：
 *  - 这是主进程与数据库层唯一的「产品创建防线」，UI 端只做辅助提示，绝不能
 *    绕过此守卫；
 *  - 错误文案必须中文、明确、可被运营一眼看懂，列出缺失项以便补救；
 *  - 不做 best-effort：不满足条件时直接抛错，不写库、不发 product:updated。
 *
 * 调用契约：
 *  - assertCreatePreconditions(db) 在不满足时抛 Error，message 包含具体缺失项；
 *  - 不写任何数据库状态，调用方可放心在任何 create 路径前调用。
 */
import type { ContactCardSelection } from "../../shared/contracts.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";

const SETTING_CURRENT_ACCOUNT = "vbkAccountName";

/** 校验一个对象是否是合法 ContactCardSelection（contactCardId / providerId 都是正整数、displayName 非空）。 */
export function isValidContactCardSelection(value: unknown): value is ContactCardSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const id = Number(candidate.contactCardId);
  const providerId = Number(candidate.providerId);
  const name = typeof candidate.displayName === "string" ? candidate.displayName.trim() : "";
  return Number.isInteger(id) && id > 0
    && Number.isInteger(providerId) && providerId > 0
    && name.length > 0;
}

/** 校验失败原因清单（UI 可直接映射到错误文案）。 */
export interface CreateGuardFailures {
  /** 当前未登录 VBK / settings.vbkAccountName 为空。 */
  notLoggedIn: boolean;
  /** 当前账号未填写 400 电话（servicePhone）。 */
  missingServicePhone: boolean;
  /** 当前账号未配置管家联系人（butlerName）或不合法。 */
  missingButler: boolean;
}

/**
 * 列出当前账号缺失的「必备前置条件」；全都不缺失时返回各字段都为 false。
 * 测试可直接断言结构而不依赖文案顺序。
 */
export function detectCreateGuardFailures(db: VbkDatabase): CreateGuardFailures {
  const accountName = db.getSetting(SETTING_CURRENT_ACCOUNT)?.value?.trim() ?? "";
  if (!accountName) {
    return { notLoggedIn: true, missingServicePhone: true, missingButler: true };
  }
  const fixed = db.getAccountFixedInfo(accountName);
  const phone = typeof fixed.values.servicePhone === "string" ? fixed.values.servicePhone.trim() : "";
  const butlerOk = isValidContactCardSelection(fixed.values.butlerName);
  return {
    notLoggedIn: false,
    missingServicePhone: phone.length === 0,
    missingButler: !butlerOk,
  };
}

/**
 * 把缺失项拼成一条中文错误信息，列出具体补救路径。
 */
export function formatGuardFailureMessage(failures: CreateGuardFailures): string {
  const lines: string[] = ["无法创建产品：缺少以下前置条件。"];
  if (failures.notLoggedIn) {
    lines.push("• 未登录 VBK：请先在「账号」面板登录当前账号。");
  }
  if (failures.missingServicePhone) {
    lines.push("• 缺少 400 电话：请在「账号设置」中为当前账号填写 400 客服电话。");
  }
  if (failures.missingButler) {
    lines.push("• 缺少管家联系人：请在「账号设置」中为当前账号选择一个有效的管家联系人。");
  }
  return lines.join("\n");
}

/**
 * 主进程 IPC / 数据库 create 路径共用的硬守卫。
 * 不满足时抛 Error，message 为中文且列出所有缺失项。
 * 满足时静默返回（无返回值）。
 */
export function assertCreatePreconditions(db: VbkDatabase): void {
  const failures = detectCreateGuardFailures(db);
  if (failures.notLoggedIn || failures.missingServicePhone || failures.missingButler) {
    throw new Error(formatGuardFailureMessage(failures));
  }
}