/**
 * 「当前账号的管家联系人」自动注入到 product 的小工具。
 *
 * 用途：
 *  - 新建项目时：若当前 VBK 已登录、账号已配管家、且 product.operations.bookingControls.butler
 *    尚未写入，则把 AccountFixedInfo.butlerName 注入到 product；让运营在 review 面板打开时
 *    直接看到「已绑定账号」，而不是再去手动点「保存到方案」。
 *  - AI 首次生成完成时：同样以「仅当 product 还没有 butler」为前提补一次，避免
 *    AI 在补齐其它模块时把已配的管家清掉。
 *
 * 行为约束（必须与 UI 行为一致）：
 *  - 未登录 / 账号未配 / 管家值为非合法 ContactCardSelection → 直接返回 { written: false }，
 *    不抛错、不修改 product。
 *  - product.operations.bookingControls.butler 已存在 → 不覆盖（保留运营手工写的）。
 *  - 写入走 applyManualReviewField 以复用其 ContactCardSelection 校验与 advanceBooking
 *    保留逻辑；再走 productSchema.parseProduct 做软校验、最后 db.updateProduct 落库。
 *
 * 与 UI 中「已选择 / 清除」按钮的契约：UI 仅在「未写入」时显示「保存到方案」按钮，且
 * 按钮 disabled when butlerSnapshot.selection exists。本工具把那个缺失的「自动注入」
 * 步骤补上，与 UI 行为完全一致。
 */
import { applyManualReviewField } from "./manual-review-field.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import type { ContactCardSelection, CreateProjectInput, ProjectDetail } from "../../shared/contracts.js";

export interface InjectAccountButlerResult {
  /** true = 已经把账号默认管家写入 product；false = 没写（不报错）。 */
  written: boolean;
  /** 当 written=false 时给出原因，便于日志。 */
  reason?: string;
}

export interface CreateProjectWithAccountButlerResult {
  project: ProjectDetail;
  injectResult: InjectAccountButlerResult;
}

function isContactCardSelection(value: unknown): value is ContactCardSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const id = Number(candidate.contactCardId);
  const providerId = Number(candidate.providerId);
  const name = typeof candidate.displayName === "string" ? candidate.displayName.trim() : "";
  return Number.isInteger(id) && id > 0
    && Number.isInteger(providerId) && providerId > 0
    && name.length > 0;
}

function hasExistingButler(product: Record<string, unknown>): boolean {
  const operations = product.operations;
  if (!operations || typeof operations !== "object" || Array.isArray(operations)) return false;
  const bookingControls = (operations as Record<string, unknown>).bookingControls;
  if (!bookingControls || typeof bookingControls !== "object" || Array.isArray(bookingControls)) return false;
  return "butler" in (bookingControls as Record<string, unknown>);
}

/**
 * 把当前账号的管家联系人（若已配置）注入到 product.operations.bookingControls.butler。
 * 严格遵守「已有 butler 不覆盖」「未登录 / 未配置不写」两条硬约束。
 */
export function injectAccountButler(
  db: VbkDatabase,
  projectId: string,
  accountName: string | null | undefined,
): InjectAccountButlerResult {
  if (!accountName || !accountName.trim()) {
    return { written: false, reason: "未登录 VBK 或账号名为空" };
  }
  const project = db.getProject(projectId);
  if (!project) return { written: false, reason: "项目不存在" };
  if (hasExistingButler(project.product)) {
    return { written: false, reason: "product 已存在 butler，不覆盖" };
  }
  const fixed = db.getAccountFixedInfo(accountName.trim());
  const raw = fixed.values.butlerName;
  if (!isContactCardSelection(raw)) {
    return { written: false, reason: "账号未配置合法管家联系人" };
  }
  // applyManualReviewField 内部还会再走一次 isContactCardSelection 校验；
  // 若 raw 不通过会抛错；这里把它转成早退，避免影响主流程。
  let next: Record<string, unknown>;
  try {
    next = applyManualReviewField(project.product, { field: "butlerContact", selection: raw });
  } catch (error) {
    return { written: false, reason: `applyManualReviewField 拒绝：${(error as Error).message}` };
  }
  db.updateProduct(projectId, next, "review");
  return { written: true };
}

export function createProjectWithAccountButler(
  db: VbkDatabase,
  input: CreateProjectInput,
  accountName: string | null | undefined,
): CreateProjectWithAccountButlerResult {
  const created = db.createProject(input);
  const injectResult = injectAccountButler(db, created.id, accountName);
  return {
    project: db.getProject(created.id) ?? created,
    injectResult,
  };
}
