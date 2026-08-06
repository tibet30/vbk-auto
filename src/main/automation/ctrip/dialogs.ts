// @ts-nocheck
// 通用弹窗 / modal 自愈：关闭 Playwright 操作过程中挡路的 VBK 弹窗。
// - closeBlockingDialogs：通用"关所有挡路弹窗"，safeClick 失败后会自愈。
// - dismissKnownNoticeDialogs：保存成功、必填提示等轻量提示弹窗。
// - dismissDataRiskDialog：境内短途旅游但下拉选了境外同名项时的 VBK 阻断。
// - dismissCustomizationModal：分销渠道二次确认（泛定制加返协议等）。

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function closeBlockingDialogs(page, keepOpenSelectors = []) {
  const candidates = [
    ".ant-modal-wrap:not(.ant-modal-wrap-hidden) .ant-modal",
    ".ant-drawer-open .ant-drawer-content",
    ".ant-popconfirm:not(.ant-popconfirm-hidden)",
    ".ant-popover:not(.ant-popover-hidden) .ant-popover-inner",
    ".ant-tooltip:not(.ant-tooltip-hidden) .ant-tooltip-inner",
    '[role="dialog"]:not([aria-hidden="true"])',
    '[role="alertdialog"]:not([aria-hidden="true"])',
  ];
  const seen = new Set();
  let closedAny = false;
  for (const selector of candidates) {
    if (keepOpenSelectors.some((keep) => keep === selector || selector.includes(keep))) continue;
    let locators;
    try {
      locators = page.locator(selector);
    } catch {
      continue;
    }
    const count = await locators.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const dialog = locators.nth(index);
      let visible = false;
      try {
        visible = await dialog.isVisible({ timeout: 200 });
      } catch {
        continue;
      }
      if (!visible) continue;
      if (await dialog.evaluate((el, keeps) => keeps.some((k) => el.matches(k) || el.querySelector(k)), keepOpenSelectors).catch(() => false)) continue;
      const sig = `${selector}::${index}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const closeBtn = dialog.locator(
        ".ant-modal-close, .ant-drawer-close, [aria-label='Close'], [aria-label='关闭']",
      );
      const button = dialog.getByRole("button", { name: /^(取\s*消|取消|关\s*闭|关闭|我知道了|知道了|确\s*定|确定|Cancel|Close)$/ });
      try {
        if (await closeBtn.count()) {
          await closeBtn.first().click({ force: true, timeout: 1_500 });
        } else if (await button.count()) {
          await button.first().click({ force: true, timeout: 1_500 });
        } else {
          await page.mouse.click(8, 8);
          await page.keyboard.press("Escape");
        }
        await delay(150);
        closedAny = true;
      } catch {
        closedAny = true;
      }
    }
  }
  return closedAny;
}

async function dismissKnownNoticeDialogs(page, { waitForSaveSuccess = false } = {}) {
  const deadline = Date.now() + (waitForSaveSuccess ? 5_000 : 800);
  const knownNotice = waitForSaveSuccess
    ? /保存成功/
    : /保存成功|不能输入重复的国家或省或景区、景点、其他地区/;

  do {
    const dialogs = page.getByRole("dialog");
    const count = await dialogs.count();
    for (let index = 0; index < count; index += 1) {
      const dialog = dialogs.nth(index);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      const text = (await dialog.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (!knownNotice.test(text)) continue;
      const acknowledge = dialog.getByRole("button", {
        name: /^(我知道了|知道了|确 定|确定)$/,
      });
      if (await acknowledge.count()) {
        await acknowledge.first().click();
        await dialog.waitFor({ state: "hidden", timeout: 3_000 });
        await delay(300);
        return true;
      }
    }
    await delay(150);
  } while (Date.now() < deadline);

  return false;
}

/**
 * 数据风险弹窗：VBK 在「国家景区」添加景点/省份时，如果产品是境内短途旅游
 * 但下拉返回了境外同名项（典型：朝鲜-大同 / 北朝鲜-大同等），点「添加」
 * 会弹出"数据风险，原因：途径地：XXX 且 产品类型：境内短途旅游，
 * 请修改后重新操作！"的阻断弹窗。点确定/我知道了关闭，调用方应决定
 * 是跳过（景点）还是报错（省份）。
 */
async function dismissDataRiskDialog(page, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  const pattern = /数据风险/;
  const buttonName = /^(我知道了|知道了|确\s*定|确定|关闭|取\s*消|取消)$/;
  do {
    const dialogs = page.getByRole("dialog");
    const count = await dialogs.count();
    for (let index = 0; index < count; index += 1) {
      const dialog = dialogs.nth(index);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      const text = (await dialog.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (!pattern.test(text)) continue;
      const button = dialog.getByRole("button", { name: buttonName });
      if (await button.count()) {
        await button.first().click();
        await dialog.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {});
        await delay(200);
        return text;
      }
    }
    await delay(150);
  } while (Date.now() < deadline);
  return null;
}

/**
 * 勾选分销渠道时可能弹出"泛定制加返补充协议 / 佣金规则"之类的二次确认 modal。
 * modal 含"确定 / 取消"两个按钮，本函数一律关闭（点取消或 × ）以保留"默认
 * 不勾泛定制-C"的语义；其它未预期的弹窗也走 Esc 关闭。
 */
async function dismissCustomizationModal(page) {
  const candidates = ["取消", "我知道了", "确定"];
  for (const name of candidates) {
    const buttons = page.getByRole("button", { name, exact: true });
    const count = await buttons.count();
    for (let index = 0; index < count; index += 1) {
      const btn = buttons.nth(index);
      const visible = await btn.isVisible().catch(() => false);
      if (!visible) continue;
      const insideModal = await btn
        .evaluate((el) => !!el.closest(".ant-modal-wrap:not(.ant-modal-wrap-hidden), [role='dialog']"))
        .catch(() => false);
      if (!insideModal) continue;
      await btn.click().catch(() => {});
      await delay(200);
      return name;
    }
  }
  await page.keyboard.press("Escape").catch(() => {});
  await delay(200);
  return null;
}

export {
  closeBlockingDialogs,
  dismissKnownNoticeDialogs,
  dismissDataRiskDialog,
  dismissCustomizationModal,
};
export {
  delay,
};
