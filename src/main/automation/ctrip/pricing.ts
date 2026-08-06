// @ts-nocheck
// 套餐价格库存 / 条款 / 基础资源校验辅助分层。

import { delay, fillVisibleInputs } from "./utils.js";
import { clickExact, ensureCheckboxChecked } from "./itinerary/itinerary.js";
import { clickSection, clickSafeSave } from "./tabs.js";
import { productSectionUrl } from "../constants.js";

function dateTitle(date) {
  const [year, month, day] = date.split("-").map(Number);
  return `${year}年${month}月${day}日`;
}

async function pickCalendarDate(page, input, date) {
  const title = dateTitle(date);
  const alreadyOpen = await page.evaluate(() => {
    const picker = document.querySelector(".ant-calendar-picker-container .ant-calendar");
    return !!picker && picker.getBoundingClientRect().width > 100;
  });
  if (!alreadyOpen) {
    await input.click();
    await delay(400);
  }

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const popupOpen = await page.evaluate(() => {
      const picker = document.querySelector(".ant-calendar-picker-container .ant-calendar");
      return !!picker && picker.getBoundingClientRect().width > 100;
    });
    if (!popupOpen) {
      await input.click();
      await delay(400);
      continue;
    }

    const targetInfo = await page.evaluate((targetTitle) => {
      const popup = document.querySelector(".ant-calendar-picker-container .ant-calendar");
      if (!popup) return { hasPopup: false };
      const cell = popup.querySelector(`td[title="${targetTitle}"]`);
      if (!cell) return { hasPopup: true, hasCell: false };
      const rect = cell.getBoundingClientRect();
      return { hasPopup: true, hasCell: true, visible: rect.width > 0 && rect.height > 0 };
    }, title);

    if (targetInfo.hasCell && targetInfo.visible) {
      await page.locator(`.ant-calendar-picker-container td[title="${title}"]`).first().click();
      return;
    }

    const advanced = await page.evaluate(() => {
      const popup = document.querySelector(".ant-calendar-picker-container .ant-calendar");
      if (!popup) return false;
      const leftNext = popup.querySelector(".ant-calendar-range-left .ant-calendar-next-month-btn");
      if (leftNext) {
        leftNext.click();
        return "left";
      }
      const rightNext = popup.querySelector(".ant-calendar-range-right .ant-calendar-next-month-btn");
      if (rightNext) {
        rightNext.click();
        return "right";
      }
      const fallback = popup.querySelector(".ant-calendar-next-month-btn");
      if (fallback) {
        fallback.click();
        return "fallback";
      }
      return false;
    });
    if (!advanced) break;
    await delay(200);
  }
  throw new Error(`日期选择器无法定位 ${date}`);
}

export async function fillAndSubmitPricingInventory(page, product, productId) {
  if (!product.commercial?.pricing || !product.commercial.inventory) throw new Error("缺少价格库存配置");
  const { pricing, inventory } = product.commercial;
  await page.goto(productSectionUrl(productId, "pricingInventory"), {
    waitUntil: "domcontentloaded",
  });
  await clickExact(page, "套餐价格库存");
  const knowBtn = page.getByRole("button", { name: "我知道了", exact: true }).first();
  if (await knowBtn.isVisible().catch(() => false)) {
    await knowBtn.click({ force: true }).catch(() => false);
    await delay(500);
  }

  let setupBtnDisabled = true;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await delay(500);
    const btnInfo = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button")).filter(
        (b) => b.textContent.trim() === "设置价格/库存" && b.offsetParent !== null,
      );
      if (!btns.length) return { found: false, allDisabled: true, count: 0 };
      return { found: true, allDisabled: btns.every((b) => b.disabled), count: btns.length };
    });
    if (btnInfo.found && !btnInfo.allDisabled) {
      setupBtnDisabled = false;
      break;
    }
  }
  if (setupBtnDisabled) {
    return { skipped: "套餐未保存，价格库存按钮 disabled", dailyQuota: inventory.dailyQuota };
  }

  const directClicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent.trim() === "设置价格/库存" && b.offsetParent !== null,
    );
    if (!btn) return { ok: false, reason: "no-button" };
    const handlersKey = Object.keys(btn).find((k) => k.startsWith("__reactEventHandlers"));
    if (!handlersKey) return { ok: false, reason: "no-react-handlers" };
    const handlers = (btn as any)[handlersKey];
    if (typeof handlers.onClick !== "function") return { ok: false, reason: "no-onclick" };
    handlers.onClick({});
    return { ok: true };
  });
  if (!directClicked.ok) {
    await clickExact(page, "设置价格/库存");
  }

  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: 15_000 });

  await page.evaluate(() => {
    const radios = document.querySelectorAll('input[type="radio"][value="1"]');
    for (const r of radios) {
      const label = r.closest("label");
      if (label && label.offsetParent !== null) {
        label.click();
        return;
      }
    }
  });
  await delay(500);

  const rangeInputs = dialog.locator("input[readonly]");
  if ((await rangeInputs.count()) < 2) throw new Error("价格库存日期范围控件缺失");
  await pickCalendarDate(page, rangeInputs.nth(0), inventory.startDate);
  await pickCalendarDate(page, rangeInputs.nth(1), inventory.endDate);

  const allWeekdays = dialog.locator('input[type="checkbox"][value="all"]');
  if (await allWeekdays.count()) await ensureCheckboxChecked(allWeekdays.first());
  const limitStock = dialog.locator('input[type="radio"][value="isLimit"], input[type="radio"][value="T"]');
  if (await limitStock.count()) await limitStock.last().click({ force: true });

  const cost = pricing.cost ?? {
    adult: pricing.adult,
    child: pricing.child,
    singleSupplement: 0,
    childBed: 0,
  };
  const adultActual = dialog.locator("#adultActual");
  if (await adultActual.count()) {
    await adultActual.fill(String(cost.adult));
    await dialog.locator("#childActual").fill(String(cost.child));
    const diffActual = dialog.locator("#diffActual");
    if (await diffActual.count()) {
      await diffActual.fill(String(cost.singleSupplement));
    }
    const childBedActual = dialog.locator("#childOccupationBedActual");
    if (await childBedActual.count()) {
      await childBedActual.fill(String(cost.childBed));
    }
    const quotaInputs = dialog.locator('input[type="number"]:not([id]):not([disabled])');
    await fillVisibleInputs(quotaInputs, [inventory.dailyQuota], "库存");
  } else {
    const numbers = dialog.locator("input[type=\"text\"]:not([readonly]):not([disabled])");
    await fillVisibleInputs(
      numbers,
      [
        cost.adult,
        inventory.dailyQuota,
        cost.child,
        cost.singleSupplement,
        cost.childBed,
      ],
      "价格库存",
    );
  }
  const sendReview = dialog.getByRole("button", { name: /发.*审核/ });
  await sendReview.waitFor({ state: "visible", timeout: 10_000 });
  await sendReview.click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 });
  return {
    range: [inventory.startDate, inventory.endDate],
    dailyQuota: inventory.dailyQuota,
    submitted: true,
  };
}

// 仅保存，不接入通用 helper。
export async function fillAndSaveTerms(page, product) {
  // 绝不触碰任何「提审」 / 「提交审核」入口。
  if (!product.commercial?.terms) throw new Error("缺少条款配置");
  const tabDisabled = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll(".ant-tabs-tab"));
    const target = tabs.find((t) => t.textContent?.trim() === "条款维护");
    return target ? target.className.includes("ant-tabs-tab-disabled") || target.getAttribute("aria-disabled") === "true" : false;
  });
  if (tabDisabled) {
    return { skipped: "条款维护 tab disabled（套餐未保存）" };
  }
  await clickSection(page, "条款维护");
  const terms = product.commercial.terms;
  const textareas = page.locator("textarea");
  const values = [terms.inclusions, terms.exclusions, terms.bookingNotes, terms.refundPolicy];
  await fillVisibleInputs(textareas, values, "条款");
  return clickSafeSave(page, ["保存", "保存并下一步"]);

}

export {
  dateTitle,
  pickCalendarDate,
};

// source-slicing anchor（仅供测试切片识别，不在运行时使用）：
export async function ensureHotelResource(_page, _product, _productId) { return null; }
