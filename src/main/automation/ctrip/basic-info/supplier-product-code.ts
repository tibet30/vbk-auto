// @ts-nocheck
/**
 * 供应商产品编号的最小同步路径。
 *
 * 已保存产品升级编号时，只写 VBK 的 vendorProductCode 并回读验证；不得借机重填
 * 电话、景区或联系人等无关字段，避免历史页面配置阻断编号迁移。
 */
import { clickSection } from "../tabs.js";
import { dismissKnownNoticeDialogs } from "../dialogs.js";

export async function syncSupplierProductCode(page, supplierProductCode) {
  await clickSection(page, ["产品信息", "基本信息"]).catch(() => {});
  const input = await findVisibleSupplierProductCodeInput(page);
  await input.fill(supplierProductCode);
  // Ant Design 表单在 blur 后才把输入值提交给字段模型；否则 UI 虽显示新值，
  // 保存请求仍携带旧编号。必须先失焦再点击保存。
  await input.press("Tab");

  const save = page.getByRole("button", { name: "保存", exact: true });
  if (await save.count() !== 1 || !(await save.isVisible()) || !(await save.isEnabled())) {
    throw new Error("供应商产品编号同步失败：基本信息「保存」按钮不可用。");
  }
  await save.click();
  await dismissKnownNoticeDialogs(page, { waitForSaveSuccess: true });

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (/300045.*供应商产品编号不得重复|供应商产品编号不得重复.*300045/.test(bodyText)) {
    throw new Error(`供应商产品编号同步被平台拒绝：${bodyText.replace(/\s+/g, " ").trim()}`);
  }

  await page.reload({ waitUntil: "domcontentloaded" });
  const savedInput = await findVisibleSupplierProductCodeInput(page);
  const saved = await savedInput.inputValue();
  if (saved !== supplierProductCode) {
    throw new Error(`供应商产品编号平台回读不一致：期望「${supplierProductCode}」，实际「${saved || "空"}」。`);
  }
}

async function findVisibleSupplierProductCodeInput(page) {
  const inputs = page.locator("#baseInfo\\.vendorProductCode");
  const count = await inputs.count();
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    if (await input.isVisible().catch(() => false)) return input;
  }
  throw new Error("供应商产品编号平台回读失败：未找到可见输入框。");
}
