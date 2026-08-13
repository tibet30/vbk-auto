/**
 * 通用弹窗 / modal 自愈工具集：
 *   - closeBlockingDialogs：通用关所有挡路弹窗（safeClick 失败后会自愈）；
 *   - dismissKnownNoticeDialogs：保存成功 / 线路变更提示 / 必填提示等轻量提示弹窗（保存后等「保存成功」可开启）；
 *   - dismissDataRiskDialog：境内短途旅游 + 下拉选到境外同名项时 VBK 阻断弹窗；
 *   - dismissCustomizationModal：分销渠道二次确认（泛定制加返协议等）。
 *
 * 顶部带 `// @ts-nocheck`，dialog 是动态 page.locator。
 */
// @ts-nocheck
// 通用弹窗 / modal 自愈：关闭 Playwright 操作过程中挡路的 VBK 弹窗。
// - closeBlockingDialogs：通用"关所有挡路弹窗"，safeClick 失败后会自愈。
// - dismissKnownNoticeDialogs：保存成功、线路变更提示、必填提示等轻量提示弹窗。
// - dismissDataRiskDialog：境内短途旅游但下拉选了境外同名项时的 VBK 阻断。
// - dismissCustomizationModal：分销渠道二次确认（泛定制加返协议等）。

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * 通用「关挡路弹窗」迭代器：扫 .ant-modal / .ant-drawer / popconfirm / popover / tooltip /
 * role=dialog 之类的可见弹窗；keepOpenSelectors 用于排除不能关的关键弹窗（如「请输入供应商编码」）。
 * 命中后尝试 .ant-modal-close / 取消 / 关闭 / Escape 等多种路径强制关闭；关闭过则返回 true。
 */
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

/**
 * 关闭已知轻量提示弹窗（保存成功 / 线路变更提示 / 不能输入重复省份/景点等）：
 *   - waitForSaveSuccess=true：把超时拉到 5s 并把匹配模式放宽到「保存成功」为止；
 *   - 默认 800ms 内扫一轮任一已知的提示并点「我知道了 / 知道了 / 确定」关闭。
 * 用于保存后等提示自动清掉再继续，避免 stage 误读弹窗。
 */
async function dismissKnownNoticeDialogs(page, { waitForSaveSuccess = false } = {}) {
  const deadline = Date.now() + (waitForSaveSuccess ? 5_000 : 800);
  // 线路变更提示是可安全确认的轻量白名单提示；未知/风险 modal 不匹配，绝不点击。
  const knownNotice = /保存成功|不能输入重复的国家或省或景区、景点、其他地区|线路变更提示/;

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
        // 点击前先把当前 dialog 钉成 elementHandle；handle 绑定到具体节点，
        // 即使点击后 dialogs.nth(0) 被重新解析指向后继 dialog，handle 仍跟原节点。
        const handle = await dialog.elementHandle();
        await acknowledge.first().click();
        // 严格等待原 dialog 在 DOM 上真正 hidden（节点被移除或原生隐藏）。
        // 不能用 setAttribute / display:none 绕过：会留下 modal mask / 拦截事件。
        if (handle) {
          await handle.waitForElementState("hidden", { timeout: 3_000 }).catch(async () => {
            // handle 已 detached → 原 dialog 一定不在 DOM，等价 hidden。
            const stillAttached = await page.evaluate(
              (el) => el && document.contains(el),
              handle,
            ).catch((error) => {
              // 点击确认可能立即导航；旧 frame/context 消失等价于原 dialog 已离开。
              if (/Cannot find context|Execution context was destroyed|Target closed/i.test(String(error))) {
                return false;
              }
              throw error;
            });
            if (stillAttached) throw new Error("dismissKnownNoticeDialogs: 原 dialog 未 hidden");
          });
        } else {
          await dialog.waitFor({ state: "hidden", timeout: 3_000 });
        }
        await delay(150);
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
