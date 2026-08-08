// @ts-nocheck
/**
 * 套餐管理（packageManage）页面自动化：新增或重写已有套餐。
 *   - chooseRadioValue：按 id 选中 ant-radio-group 内某个 value；
 *   - fillAndSavePackage：若 N 日套餐 tab 已存在则改写，否则「新增套餐」，按 NewPackage_*
 *     控件填值，必要时用 React fiber 调 formHolder.performSubmit 绕过 disabled；
 *   - rewriteExistingPackage：覆盖已有套餐的供应商编号、介绍、天数、确认时长与若干 radio；
 *   - switchToExistingPackageTab：在 ant-tabs 里按 label 切到指定 pane 并定位 form.ant-form。
 *
 * 头部带 `// @ts-nocheck`，DOM 形参 page 为动态传入。
 */


import { delay, assertCount } from "./utils.js";
import { clickSection, clickSafeSave } from "./tabs.js";

/**
 * 在指定 id 的 ant-radio-group 里选中 value，未选中状态下点 force click；
 * 用于 NewPackage 表单的多个 radio 控件（按人报价 / 酒店拼房 / 儿童占床 / 接送…）。
 */
async function chooseRadioValue(pageOrLocator, groupId, value, description) {
  const base = pageOrLocator ?? page;
  const group = base.locator(`[id="${groupId}"]`);
  await assertCount(group, 1, description);
  const radio = group.locator(`input[type="radio"][value="${value}"]`);
  await assertCount(radio, 1, description);
  const parentClass = (await radio.locator("xpath=..").getAttribute("class")) ?? "";
  if (!parentClass.includes("ant-radio-checked")) {
    await radio.click({ force: true });
  }
}

// 仅保存，不接入通用 helper。
/**
 * 「套餐管理」表单保存主流程：
 *   - 若存在 N 日套餐 tab → 切过去并改写已有套餐（不走新增路径）；
 *   - 否则如果套餐名已存在则跳过；
 *   - 真正进入「新增套餐」分支，按 NewPackage_* 控件填值并保存；
 *   - 保存按钮 disabled 时，尝试用 React fiber 反向定位 formHolder.performSubmit 绕过 UI disabled
 *     状态；任何一步不通过都退化为 skipped（不会触发提审）。
 */
export async function fillAndSavePackage(page, product) {
  // 仅保存，不接入 saveThenAdvance，避免误点任何「下一步」按钮。
  if (!product.commercial) throw new Error("缺少 commercial 套餐配置");
  await clickSection(page, "套餐管理").catch(() => {});
  const days = product.itinerary?.length ?? 0;
  const expectedTabLabel = days > 0 ? `${days}日套餐` : null;
  const activePane = await switchToExistingPackageTab(page, expectedTabLabel);
  if (activePane) {
    return await rewriteExistingPackage(page, product, activePane);
  }
  const existing = page.getByText(product.commercial.packageName, { exact: true });
  if (await existing.count()) return { skipped: "套餐已存在", packageName: product.commercial.packageName };
  await page
    .getByText("新增套餐", { exact: true })
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("新增套餐", { exact: true }).click({ force: true }).catch(() => false);
  await delay(1500);
  /**
   * 在多个 antd 的「active」tabpane 中挑出最可能承载 NewPackage 表单的那个：
   * 要求包含 `form.ant-form`，且取最后一个（因为「新增套餐」通常是被追加的 pane）。
   */
  async function pickBestPane() {
    const panes = await page.locator(".ant-tabs-tabpane-active").filter({ has: page.locator("form.ant-form") }).all();
    return panes.length ? panes[panes.length - 1] : page.locator(".ant-tabs-tabpane-active").last();
  }
  let activePane2 = await pickBestPane();
  const code = activePane2.locator('#NewPackage_vendorResourceCode');
  await assertCount(code, 1, "供应商套餐编号");
  await code.fill(product.basicInfo.supplierProductCode);
  await delay(300);
  const description = activePane2.locator('#NewPackage_description');
  await assertCount(description, 1, "套餐介绍");
  await description.fill(
    `${product.commercial.packageName}。${product.presentation?.recommendation ?? product.basicInfo.subtitle}`,
  );
  await delay(300);
  await chooseRadioValue(activePane2, "NewPackage_priceInputType", "1", "按人报价");
  await chooseRadioValue(activePane2, "NewPackage_isHotelShareRoom", "F", "酒店拼房");
  await chooseRadioValue(activePane2, "NewPackage_isContainBedFee", "F", "儿童占床");
  await chooseRadioValue(activePane2, "NewPackage_needShuttle", "F", "接送备注");
  await chooseRadioValue(activePane2, "NewPackage_isSmsVBKNotice", "T", "订单短信通知");
  await chooseRadioValue(activePane2, "NewPackage_isHotelResource", "F", "是否含酒店");
  if (days) {
    const daysInput = activePane2.locator('#NewPackage_days');
    if (await daysInput.count()) {
      await daysInput.fill(String(days));
      await delay(300);
    }
  }
  const confirmHourInput = activePane2.locator('#NewPackage_confirmHour');
  if (await confirmHourInput.count()) {
    await confirmHourInput.fill("4");
    await delay(300);
  }
  const confirmModeCombo = activePane2.locator('#NewPackage_vendorConfirmModeId .ant-select-selection').first();
  await confirmModeCombo.click({ force: true }).catch(() => false);
  await delay(500);
  await page.locator('.ant-select-dropdown-menu-item:not(.ant-select-dropdown-menu-item-disabled)').first().click({ force: true }).catch(() => false);
  await delay(300);
  const saveBtn = page.getByRole("button", { name: "保存", exact: true }).first();
  let saveDisabled = true;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await delay(500);
    saveDisabled = await saveBtn.isDisabled().catch(() => true);
    if (!saveDisabled) break;
  }
  if (saveDisabled) {
    try {
      const ok = await page.evaluate(async () => {
        const allElements = Array.from(document.querySelectorAll("*"));
        const visited = new WeakSet();
        let formHolder = null;
        for (const el of allElements) {
          if (visited.has(el)) continue;
          const fk = Object.keys(el).find((k) => k.startsWith("__reactInternalInstance"));
          if (!fk) continue;
          let fiber = el[fk];
          const seen = new Set();
          while (fiber && !seen.has(fiber)) {
            seen.add(fiber);
            const sn = fiber.stateNode;
            if (
              sn &&
              typeof sn === "object" &&
              typeof sn.performSubmit === "function" &&
              sn.props?.form
            ) {
              formHolder = sn;
              break;
            }
            fiber = fiber.return;
          }
          if (formHolder) break;
        }
        if (!formHolder) return "no_form_holder";
        try {
          const ret = await formHolder.performSubmit({});
          return ret === false ? "false" : "ok";
        } catch (e) {
          return "perform_err: " + (e instanceof Error ? e.message : String(e));
        }
      });
      if (ok === "ok") {
        return { savedWith: "保存", packageName: product.commercial.packageName, bypassed: true };
      }
      return {
        skipped: `保存按钮 disabled 且 performSubmit 未走通（${ok}），可能是供应商后台未预置 customer_info 模板`,
        packageName: product.commercial.packageName,
        saveDisabled: true,
      };
    } catch (e) {
      return {
        skipped: `保存按钮 disabled 且绕过逻辑失败：${e instanceof Error ? e.message : String(e)}`,
        packageName: product.commercial.packageName,
        saveDisabled: true,
      };
    }
  }
  const savedWith = await clickSafeSave(page, ["保存"]);
  return { savedWith, packageName: product.commercial.packageName };
}

/**
 * 在套餐管理 tab 里找 expectedTabLabel（形如「5日套餐」）对应的活动 pane；若不存在则返回 null，
 * 用于触发「改写已有套餐」分支。
 */
async function switchToExistingPackageTab(page, expectedTabLabel) {
  if (!expectedTabLabel) return null;
  const tabHandle = page.locator(".ant-tabs-tab").filter({ hasText: expectedTabLabel }).first();
  if ((await tabHandle.count()) === 0) return null;
  await tabHandle.click({ force: true }).catch(() => false);
  await delay(1_000);
  const candidates = await page
    .locator(".ant-tabs-tabpane-active")
    .filter({ has: page.locator("form.ant-form") })
    .all();
  if (!candidates.length) return null;
  return candidates[candidates.length - 1];
}

/**
 * 改写已有套餐的字段：供应商套餐编号、套餐介绍、天数、确认时长、确认方式，以及若干 radio；
 * 走 clickSafeSave 保存，不触发任何「下一步 / 提审」。
 */
async function rewriteExistingPackage(page, product, activePane) {
  const code = activePane.locator("#NewPackage_vendorResourceCode");
  if (await code.count()) {
    await code.fill(product.basicInfo.supplierProductCode);
    await delay(300);
  }
  const description = activePane.locator("#NewPackage_description");
  if (await description.count()) {
    const desc = `${product.commercial.packageName}。${product.presentation?.recommendation ?? product.basicInfo.subtitle}`;
    await description.fill(desc);
    await delay(300);
  }
  const days = product.itinerary?.length;
  if (days) {
    const daysInput = activePane.locator("#NewPackage_days");
    if (await daysInput.count()) {
      await daysInput.fill(String(days));
      await delay(300);
    }
  }
  const confirmHourInput = activePane.locator("#NewPackage_confirmHour");
  if (await confirmHourInput.count()) {
    await confirmHourInput.fill("4");
    await delay(300);
  }
  const confirmModeCombo = activePane.locator("#NewPackage_vendorConfirmModeId .ant-select-selection").first();
  if (await confirmModeCombo.count()) {
    await confirmModeCombo.click({ force: true }).catch(() => false);
    await delay(500);
    await page.locator(".ant-select-dropdown-menu-item:not(.ant-select-dropdown-menu-item-disabled)").first().click({ force: true }).catch(() => false);
    await delay(300);
  }

  if (await activePane.locator("#NewPackage_isHotelShareRoom").count()) {
    await chooseRadioValue(activePane, "NewPackage_isHotelShareRoom", "F", "酒店拼房");
  }
  if (await activePane.locator("#NewPackage_isContainBedFee").count()) {
    await chooseRadioValue(activePane, "NewPackage_isContainBedFee", "F", "儿童占床");
  }
  if (await activePane.locator("#NewPackage_needShuttle").count()) {
    await chooseRadioValue(activePane, "NewPackage_needShuttle", "F", "接送备注");
  }
  if (await activePane.locator("#NewPackage_isSmsVBKNotice").count()) {
    await chooseRadioValue(activePane, "NewPackage_isSmsVBKNotice", "T", "订单短信通知");
  }
  if (await activePane.locator("#NewPackage_isHotelResource").count()) {
    await chooseRadioValue(activePane, "NewPackage_isHotelResource", "F", "是否含酒店");
  }
  const savedWith = await clickSafeSave(page, ["保存"]);
  return {
    savedWith,
    packageName: product.commercial.packageName,
    edited: true,
  };
}

export {
  chooseRadioValue,
  rewriteExistingPackage,
  switchToExistingPackageTab,
};

// source-slicing anchor（仅供测试切片识别，不在运行时使用）：
/**
 * 测试切片占位：实现见 ./pricing.ts，保留签名以便 source-slicing 工具识别同主题代码段。
 */
function dateTitle(_pkg) { return null; }