import type { VbkDatabase } from "../../../infrastructure/database/database.js";
import {
  resolveActiveServicePhoneContext,
  resolveProductButlerSelection,
} from "../automation.main.class.helpers.js";

/** Contacts belong to the product snapshot; the service phone belongs to its account. */
export function automationAccountContext(db: VbkDatabase, product: Record<string, unknown>, required: boolean) {
  const accountName = db.getSetting("vbkAccountName")?.value;
  const butlerSelection = required ? resolveProductButlerSelection(product) : null;
  if (required && !butlerSelection) {
    throw new Error("录入前检查未通过：产品 JSON 缺少管家联系人（请重新创建或在基础信息中写入负责人）");
  }
  const phoneContext = resolveActiveServicePhoneContext(db, accountName);
  if (required && !phoneContext) {
    if (!accountName) throw new Error("未检测到当前登录的 VBK 账号，无法读取 400 电话。");
    throw new Error("录入前检查未通过：400 电话（请在账号设置里维护）");
  }
  if (phoneContext?.fallbackUsed) db.setSetting("vbkAccountName", phoneContext.accountName);
  return { butlerSelection, servicePhone: required ? phoneContext?.servicePhone ?? "" : "" };
}
