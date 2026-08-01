// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";
import {
  ARTIFACTS_DIR,
  PRODUCT_FORM_LABELS,
  PRODUCT_TYPE_LABELS,
  URLS,
  productEditorUrl,
  productSectionUrl,
} from "./constants.js";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function assertCount(locator, expected, description) {
  const count = await locator.count();
  if (count !== expected) {
    throw new Error(`${description}数量异常：期望 ${expected}，实际 ${count}`);
  }
  return locator;
}

async function selectVisibleOption(page, label) {
  const option = page.getByRole("option", { name: label, exact: true });
  await assertCount(option, 1, `选项“${label}”`);
  await option.click();
}

export async function inspectProductList(page) {
  const addButton = page.locator("a.clego-order-btn").filter({
    hasText: "新增产品",
  });
  await assertCount(addButton, 1, "新增产品入口");

  const rows = page.locator("table tbody tr");
  return {
    url: page.url(),
    title: await page.title(),
    visibleRows: await rows.count(),
    addProductAvailable: await addButton.isVisible(),
  };
}

export async function configureProductShell(page, product) {
  await page.goto(URLS.createSetup, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "下一步", exact: true })
    .waitFor({ state: "visible", timeout: 30_000 });

  let comboboxes = page.getByRole("combobox");
  const initialCount = await comboboxes.count();
  if (initialCount < 3) {
    throw new Error(`创建页下拉框结构异常：仅找到 ${initialCount} 个`);
  }

  await comboboxes.nth(0).click();
  await selectVisibleOption(page, PRODUCT_TYPE_LABELS[product.sales.productType]);

  comboboxes = page.getByRole("combobox");
  await comboboxes.nth(1).click();
  await selectVisibleOption(page, PRODUCT_FORM_LABELS[product.sales.productForm]);

  await page
    .getByRole("combobox")
    .nth(3)
    .waitFor({ state: "visible", timeout: 30_000 });

  if (product.sales.productForm === "groupTour") {
    const splitGroup = page.getByRole("radio", {
      name: product.sales.splitGroup ? "是" : "否",
      exact: true,
    });
    const count = await splitGroup.count();
    if (count >= 1) await splitGroup.first().check();
  }

  return page;
}

export async function createProductShell(page) {
  const nextButton = page.getByRole("button", { name: "下一步", exact: true });
  await assertCount(nextButton, 1, "下一步按钮");
  await nextButton.click();
  await page.waitForURL(/\/ivbk\/vendor\/baseInfoMerge\?productId=\d+/, {
    timeout: 15_000,
  });

  const productId = new URL(page.url()).searchParams.get("productId");
  if (!productId) throw new Error("携程已进入详情页，但未返回产品 ID");
  return productId;
}

async function fillById(page, id, value, description) {
  const locator = page.locator(`[id="${id}"]`);
  await assertCount(locator, 1, description);
  await locator.fill(String(value));
}

async function fillCitySelect(page, id, city) {
  // Ant Design renders the select container and its searchable input with the
  // same id. Scope to the select container first so duplicate ids do not make
  // the locator ambiguous.
  const select = page.locator(`div[id="${id}"]`);
  await assertCount(select, 1, `${city}城市选择器`);
  await select.getByRole("combobox").click();

  const input = select.locator("input.ant-select-search__field");
  await assertCount(input, 1, `${city}城市输入框`);
  await input.fill("");
  // Ant Select only starts its remote search after real keyboard input. fill()
  // alone updates the DOM value but does not trigger the debounce request.
  await input.type(city, { delay: 80 });

  const options = page.getByRole("option").filter({ hasText: city });
  await options.first().waitFor({ state: "visible", timeout: 8_000 });
  const optionTexts = (await options.allTextContents()).map((text) => text.trim());
  const exactIndex = optionTexts.findIndex((text) => text === city);
  const chosenIndex = exactIndex >= 0 ? exactIndex : 0;
  await options.nth(chosenIndex).click();
}

export async function openProductEditor(page, productId) {
  await page.goto(productEditorUrl(productId), { waitUntil: "domcontentloaded" });
  await page.getByText("基本信息", { exact: true }).first().waitFor({ timeout: 30_000 });
}

async function clickSection(page, label) {
  const target = page.getByText(label, { exact: true });
  const count = await target.count();
  for (let index = 0; index < count; index += 1) {
    if (await target.nth(index).isVisible()) {
      await target.nth(index).click();
      await delay(500);
      return;
    }
  }
  throw new Error(`找不到“${label}”入口`);
}

async function clickSafeSave(page, names) {
  for (const name of names) {
    const button = page.getByRole("button", { name, exact: true });
    if ((await button.count()) && (await button.first().isVisible())) {
      await button.first().click();
      await delay(800);
      return name;
    }
  }
  throw new Error(`找不到安全保存按钮：${names.join("、")}`);
}

export async function submitCurrentSectionAndNext(page) {
  const label = "提交审核并下一步";
  const button = page.getByRole("button", { name: label, exact: true });
  await assertCount(button, 1, `${label}按钮`);
  if (!(await button.isVisible())) throw new Error(`${label}按钮当前不可见`);
  await button.click();
  await delay(1_000);
  return { action: label };
}

export async function fillAndSaveBasicInfo(page, product) {
  await clickSection(page, "基本信息").catch(() => {});
  await fillBasicInfo(page, product);
  return clickSafeSave(page, ["保存", "保存并下一步"]);
}

async function fillFirstVisible(locator, value, description) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const current = locator.nth(index);
    if (await current.isVisible()) {
      await current.fill(value);
      return;
    }
  }
  throw new Error(`找不到${description}`);
}

export async function fillAndSavePresentation(page, product) {
  if (!product.presentation) return { skipped: "产品数据未配置图文信息" };
  await clickSection(page, "图文信息");
  await fillFirstVisible(
    page.locator('textarea[placeholder*="推荐"], textarea'),
    product.presentation.recommendation,
    "推荐语输入框",
  );
  const editor = page.locator('[contenteditable="true"]');
  for (let index = 0; index < (await editor.count()); index += 1) {
    if (await editor.nth(index).isVisible()) {
      await editor.nth(index).fill(product.presentation.features);
      break;
    }
  }
  // Cover images must come from Ctrip's real-photo library. If no suitable
  // photo is already selected, stop here instead of uploading generated art.
  return clickSafeSave(page, ["保存", "保存并下一步"]);
}

function dayScopeFor(titleInput) {
  return titleInput.locator(
    'xpath=ancestor::*[contains(@class,"td-day-item--")][1]',
  );
}

async function ensureOtherCard(page, dayScope, { afterFirstCard = false } = {}) {
  const otherCards = dayScope
    .locator('[class*="td-day-card--"]')
    .filter({ hasText: "其他" });
  while ((await otherCards.count()) > 1) {
    const before = await otherCards.count();
    await otherCards.last().getByText("删除", { exact: true }).click({ force: true });
    await delay(300);
    const confirm = page.getByText("确定", { exact: true });
    for (let index = (await confirm.count()) - 1; index >= 0; index -= 1) {
      if (await confirm.nth(index).isVisible()) {
        await confirm.nth(index).click({ force: true });
        break;
      }
    }
    for (let attempt = 0; attempt < 20 && (await otherCards.count()) >= before; attempt += 1) {
      await delay(100);
    }
  }
  if (await otherCards.count()) return otherCards.first();

  const addBoxes = dayScope.locator('[class*="td-add-box"]');
  const addBox = addBoxes.nth(afterFirstCard ? 1 : 0);
  await addBox.locator('[class*="td-add-plus-btn"]').click();
  await delay(500);
  const menuItem = addBox
    .locator('[class*="td-add-item-btn-new"]')
    .filter({ hasText: "其他" });
  let clicked = false;
  for (let index = 0; index < (await menuItem.count()); index += 1) {
    if (await menuItem.nth(index).isVisible()) {
      await menuItem.nth(index).click();
      clicked = true;
      break;
    }
  }
  if (!clicked) throw new Error("新增菜单已打开，但找不到可点击的“其他”节点");
  await otherCards.first().waitFor({ state: "visible", timeout: 8_000 });
  return otherCards.first();
}

async function clickExact(scope, label, description = label) {
  const matches = scope.getByText(label, { exact: true });
  const count = await matches.count();
  for (let index = 0; index < count; index += 1) {
    if (await matches.nth(index).isVisible()) {
      await matches.nth(index).click({ force: true });
      return;
    }
  }
  throw new Error(`找不到可点击的${description}`);
}

async function cardsByPrefix(dayScope, prefix) {
  const cards = dayScope.locator('[class*="td-day-card--"]');
  const texts = await cards.allTextContents();
  return texts.flatMap((text, index) =>
    text.trim().startsWith(prefix) ? [cards.nth(index)] : [],
  );
}

async function clickLabelExact(scope, label, description = label) {
  const labels = scope.locator("label").filter({ hasText: label });
  for (let index = 0; index < (await labels.count()); index += 1) {
    const text = (await labels.nth(index).allTextContents()).join("").trim();
    if (text === label && (await labels.nth(index).isVisible())) {
      await labels.nth(index).click({ force: true });
      return;
    }
  }
  throw new Error(`找不到${description}标签`);
}

async function ensureCheckboxChecked(checkbox) {
  const parentClass = (await checkbox.locator("xpath=..").getAttribute("class")) ?? "";
  if (!parentClass.includes("ant-checkbox-checked")) {
    await checkbox.click({ force: true });
  }
}

async function fillMealCards(dayScope, day) {
  const mealCards = await cardsByPrefix(dayScope, "餐饮");
  if (mealCards.length !== 3) {
    throw new Error(`第 ${day.day} 天餐饮节点数量异常：期望 3，实际 ${mealCards.length}`);
  }
  const types = ["早餐", "午餐", "晚餐"];
  const descriptions = day.mealDescriptions ?? [day.meals, day.meals, day.meals];

  for (let index = 0; index < 3; index += 1) {
    const card = mealCards[index];
    await clickExact(card, "不限", `第 ${day.day} 天${types[index]}时间`);
    await clickExact(card, types[index], `第 ${day.day} 天餐饮类型`);
    const selfPay = card.getByText("费用自理", { exact: true });
    await assertCount(selfPay, 2, `第 ${day.day} 天${types[index]}费用自理选项`);
    await selfPay.nth(0).click({ force: true });
    await selfPay.nth(1).click({ force: true });
    const supplement = card.locator('textarea[placeholder="请输入补充说明"]');
    if (await supplement.count()) await supplement.first().fill(descriptions[index]);
  }
}

async function fillHotelCard(page, dayScope, day, operations) {
  if (!day.hotel) return;
  const hotelCards = await cardsByPrefix(dayScope, "酒店");
  if (hotelCards.length !== 1) {
    throw new Error(`第 ${day.day} 天酒店节点数量异常：期望 1，实际 ${hotelCards.length}`);
  }
  const hotelCard = hotelCards[0];
  await clickExact(hotelCard, "不限", `第 ${day.day} 天酒店时间`);
  await clickExact(hotelCard, "不使用携程平台酒店", "非平台酒店来源");
  await delay(300);
  const combos = hotelCard.getByRole("combobox");
  if (!(await combos.count())) throw new Error(`第 ${day.day} 天酒店名称选择器缺失`);
  await combos.last().click();
  await delay(300);
  await selectVisibleOption(page, operations.hotelTier);
  const supplement = hotelCard.locator('textarea[placeholder="请输入补充说明"]');
  if (await supplement.count()) {
    await supplement.first().fill(day.hotelDescription || day.hotel);
  }
}

async function selectStationAddress(page, card, city) {
  const addressInput = card.locator('input.ant-input[placeholder="请选择"]');
  if (!(await addressInput.count())) throw new Error("接送站地址输入框缺失");
  await addressInput.first().click();
  await delay(300);
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: 5_000 });
  const inputs = dialog.locator("input");
  if ((await inputs.count()) < 2) throw new Error("接送站弹窗结构异常");
  await inputs.nth(1).click();
  await inputs.nth(1).fill("").catch(() => {});
  await inputs.nth(1).type(city, { delay: 80 });
  await delay(500);
  await dialog.getByText(city, { exact: true }).click();
  await delay(300);
  const confirm = dialog.getByRole("button", { name: "确定", exact: true });
  await confirm.click({ force: true });
  await delay(500);
  if (await dialog.isVisible().catch(() => false)) {
    await confirm.click({ force: true });
    await delay(500);
  }
  if (await dialog.isVisible().catch(() => false)) {
    throw new Error("接送站设置弹窗未关闭");
  }
}

async function fillPickupAndDropoff(page, dayScope, index, totalDays, operations) {
  if (index === 0) {
    const cards = await cardsByPrefix(dayScope, "集合");
    if (cards.length !== 1) throw new Error("首日集合节点结构异常");
    const modes = cards[0].getByRole("checkbox");
    if ((await modes.count()) < 3) throw new Error("首日集合方式控件结构异常");
    await ensureCheckboxChecked(modes.nth(2));
    await delay(300);
    const address = cards[0].locator('input.ant-input[placeholder="请选择"]');
    if ((await address.count()) && !(await address.first().getAttribute("value"))) {
      await selectStationAddress(page, cards[0], operations.pickupCity);
    }
  }
  if (index === totalDays - 1) {
    const cards = await cardsByPrefix(dayScope, "解散");
    if (cards.length !== 1) throw new Error("末日解散节点结构异常");
    let modes = cards[0].getByRole("checkbox");
    if ((await modes.count()) < 2) throw new Error("末日解散方式控件结构异常");
    await ensureCheckboxChecked(modes.nth(1));
    await delay(300);
    modes = cards[0].getByRole("checkbox");
    let reused = false;
    if (operations.reusePickupForDropoff) {
      if ((await modes.count()) >= 3) {
        await ensureCheckboxChecked(modes.nth(2));
        reused = true;
      }
    }
    const address = cards[0].locator('input.ant-input[placeholder="请选择"]');
    if ((await address.count()) && !(await address.first().getAttribute("value"))) {
      await selectStationAddress(page, cards[0], operations.pickupCity);
    }
  }
}

export async function fillItineraryDraft(page, product) {
  let titleInputs = page.locator('textarea[placeholder^="请输入标题"]');
  if ((await titleInputs.count()) !== product.itinerary.length) {
    await clickSection(page, "行程描述");
    titleInputs = page.locator('textarea[placeholder^="请输入标题"]');
  }
  await assertCount(titleInputs, product.itinerary.length, "每日标题输入框");

  for (let index = 0; index < product.itinerary.length; index += 1) {
    const day = product.itinerary[index];
    const titleInput = titleInputs.nth(index);
    await titleInput.fill(day.title);
    const scope = dayScopeFor(titleInput);
    await assertCount(scope, 1, `第 ${day.day} 天行程区域`);
    if (product.operations?.transport === "charter") {
      await clickExact(scope, "包车", `第 ${day.day} 天包车选项`);
    }
    await fillPickupAndDropoff(
      page,
      scope,
      index,
      product.itinerary.length,
      product.operations ?? {
        reusePickupForDropoff: true,
      },
    );
    await fillMealCards(scope, day);
    if (product.operations) {
      await fillHotelCard(page, scope, day, product.operations);
    }
    const otherCard = await ensureOtherCard(page, scope, {
      afterFirstCard: index === 0,
    });
    const unlimited = otherCard.getByText("不限", { exact: true });
    if (await unlimited.count()) await unlimited.first().click();
    const description = otherCard.locator('textarea[placeholder="请输入补充说明"]');
    if (!(await description.count())) {
      throw new Error(`第 ${day.day} 天“其他”节点缺少补充说明`);
    }
    await description.first().fill(day.description);
  }

  const savedWith = await clickSafeSave(page, ["存为草稿"]);
  return { savedWith, days: product.itinerary.length };
}

async function chooseRadioValue(page, groupId, value, description) {
  const group = page.locator(`[id="${groupId}"]`);
  await assertCount(group, 1, description);
  const radio = group.locator(`input[type="radio"][value="${value}"]`);
  await assertCount(radio, 1, description);
  const parentClass = (await radio.locator("xpath=..").getAttribute("class")) ?? "";
  if (!parentClass.includes("ant-radio-checked")) {
    await radio.click({ force: true });
  }
}

export async function fillAndSavePackage(page, product) {
  if (!product.commercial) throw new Error("缺少 commercial 套餐配置");
  await clickSection(page, "套餐管理").catch(() => {});
  const existing = page.getByText(product.commercial.packageName, { exact: true });
  if (await existing.count()) return { skipped: "套餐已存在", packageName: product.commercial.packageName };
  await page
    .getByText("新增套餐", { exact: true })
    .waitFor({ state: "visible", timeout: 30_000 });
  const code = page.locator('[id="NewPackage_vendorResourceCode"]');
  await assertCount(code, 1, "供应商套餐编号");
  await code.fill(product.basicInfo.supplierProductCode);
  const description = page.locator('[id="NewPackage_description"]');
  await assertCount(description, 1, "套餐介绍");
  await description.fill(
    `${product.commercial.packageName}。${product.presentation?.recommendation ?? product.basicInfo.subtitle}`,
  );
  await chooseRadioValue(page, "NewPackage_isHotelResource", "T", "是否含酒店");
  await chooseRadioValue(page, "NewPackage_priceInputType", "1", "按人报价");
  await chooseRadioValue(page, "NewPackage_isHotelShareRoom", "F", "酒店拼房");
  await chooseRadioValue(page, "NewPackage_isContainBedFee", "F", "儿童占床");
  await chooseRadioValue(page, "NewPackage_needShuttle", "F", "接送备注");
  await chooseRadioValue(page, "NewPackage_isSmsVBKNotice", "T", "订单短信通知");
  const savedWith = await clickSafeSave(page, ["保存"]);
  return { savedWith, packageName: product.commercial.packageName };
}

function dateTitle(date) {
  const [year, month, day] = date.split("-").map(Number);
  return `${year}年${month}月${day}日`;
}

async function pickCalendarDate(page, input, date) {
  const title = dateTitle(date);
  await input.click();
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const target = page.locator(`td[title="${title}"]`);
    for (let index = 0; index < (await target.count()); index += 1) {
      if (await target.nth(index).isVisible()) {
        await target.nth(index).click();
        return;
      }
    }
    const next = page.locator('[title*="下个月"]');
    let advanced = false;
    for (let index = (await next.count()) - 1; index >= 0; index -= 1) {
      if (await next.nth(index).isVisible()) {
        await next.nth(index).click();
        advanced = true;
        break;
      }
    }
    if (!advanced) break;
  }
  throw new Error(`日期选择器无法定位 ${date}`);
}

async function fillVisibleInputs(locator, values, description) {
  const visible = [];
  for (let index = 0; index < (await locator.count()); index += 1) {
    if (await locator.nth(index).isVisible()) visible.push(locator.nth(index));
  }
  if (visible.length < values.length) {
    throw new Error(`${description}输入框不足：期望 ${values.length}，实际 ${visible.length}`);
  }
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== undefined) await visible[index].fill(String(values[index]));
  }
}

export async function fillAndSubmitPricingInventory(page, product, productId) {
  if (!product.commercial) throw new Error("缺少 commercial 价格库存配置");
  const { pricing, inventory } = product.commercial;
  await page.goto(productSectionUrl(productId, "pricingInventory"), {
    waitUntil: "domcontentloaded",
  });
  await clickExact(page, "套餐价格库存");
  await clickExact(page, "设置价格/库存");
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: 15_000 });

  const rangeInputs = dialog.locator('input[readonly]');
  if ((await rangeInputs.count()) < 2) throw new Error("价格库存日期范围控件缺失");
  await pickCalendarDate(page, rangeInputs.nth(0), inventory.startDate);
  await pickCalendarDate(page, rangeInputs.nth(1), inventory.endDate);

  const allWeekdays = dialog.locator('input[type="checkbox"][value="all"]');
  if (await allWeekdays.count()) await ensureCheckboxChecked(allWeekdays.first());
  const limitStock = dialog.locator(
    'input[type="radio"][value="isLimit"], input[type="radio"][value="T"]',
  );
  if (await limitStock.count()) await limitStock.last().click({ force: true });

  const cost = pricing.cost ?? {
    adult: pricing.adult,
    child: pricing.child,
    singleSupplement: 0,
    childBed: 0,
  };
  const adultActual = dialog.locator("#adultActual");
  if (await adultActual.count()) {
    // 新版表单只允许维护底价；系统卖价由佣金规则自动计算。
    await adultActual.fill(String(cost.adult));
    await dialog.locator("#childActual").fill(String(cost.child));
    await dialog.locator("#diffActual").fill(String(cost.singleSupplement));
    await dialog.locator("#childOccupationBedActual").fill(String(cost.childBed));
    const quotaInputs = dialog.locator('input[type="number"]:not([id]):not([disabled])');
    await fillVisibleInputs(quotaInputs, [inventory.dailyQuota], "库存");
  } else {
    const numbers = dialog.locator('input[type="text"]:not([readonly]):not([disabled])');
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

export async function fillAndSaveTerms(page, product) {
  if (!product.commercial) throw new Error("缺少 commercial 条款配置");
  await clickSection(page, "条款维护");
  const terms = product.commercial.terms;
  const textareas = page.locator("textarea");
  const values = [terms.inclusions, terms.exclusions, terms.bookingNotes, terms.refundPolicy];
  await fillVisibleInputs(textareas, values, "条款");
  return clickSafeSave(page, ["保存", "保存并下一步"]);
}

export async function ensureVehicleResource(page, product, productId) {
  const vehicle = product.operations?.vehicleResource;
  if (product.sales.productForm !== "privateTour") return { skipped: "非私家团" };
  if (!vehicle) throw new Error("私家团缺少 operations.vehicleResource 配置");
  await page.goto(productSectionUrl(productId, "vehicleResource"), {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("资源配置", { exact: true }).waitFor({ timeout: 30_000 });
  const edit = page.getByRole("button", { name: "编 辑" });
  if (await edit.count()) {
    await edit.click();
    await delay(500);
  }

  const groupId = String(vehicle.resourceGroupId);
  const segmentResource = page.getByText(/^(可添加：)?附加资源$/, { exact: true }).first();
  await segmentResource.click();
  await delay(500);

  const existing = page.getByRole("row").filter({ hasText: groupId });
  if (!(await existing.count())) {
    // 用车组会直接影响客端价格，不能按城市或名称模糊猜测；只复用数据中
    // 明确指定、有效且已经过价格审查的现有资源组。
    const currentGroupRows = page
      .getByRole("row")
      .filter({ hasText: "度假可选项/用车" });
    for (let index = (await currentGroupRows.count()) - 1; index >= 0; index -= 1) {
      const remove = currentGroupRows.nth(index).getByText("删除", { exact: true });
      if (await remove.count()) await remove.click();
    }

    await page.getByRole("button", { name: /添加资源组/ }).click();
    const dialog = page.getByRole("dialog", { name: "选择资源组" });
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    await dialog.getByRole("textbox").nth(0).fill(groupId);
    await dialog.getByRole("button", { name: "查 询" }).click();
    await delay(700);
    const row = dialog.getByRole("row").filter({ hasText: groupId });
    if (!(await row.count())) throw new Error(`未找到现有用车资源组：${groupId}`);
    const rowText = (await row.innerText()).replace(/\s+/g, " ");
    if (!rowText.includes("有效")) throw new Error(`用车资源组不是有效状态：${rowText}`);
    if (!rowText.includes(vehicle.resourceGroupName)) {
      throw new Error(`用车资源组名称与产品数据不一致：${rowText}`);
    }
    await row.getByRole("radio").click();
    await dialog.getByRole("button", { name: "确 定" }).click();
  }

  await page.getByRole("button", { name: "提 交" }).click();
  await delay(700);
  await page.goto(productSectionUrl(productId, "vehicleResource"), {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("button", { name: "提交审核" }).click();
  const validation = page.getByRole("dialog", { name: "校验" });
  await validation.waitFor({ state: "visible", timeout: 10_000 });
  await validation.getByText(/校验结束/).waitFor({ timeout: 15_000 });
  const validationText = await validation.innerText();
  if (!validationText.includes("校验通过")) throw new Error(validationText);
  await validation.getByRole("button", { name: "确 定" }).click();
  return { resourceGroupId: vehicle.resourceGroupId, audited: true };
}

export async function runProductPreflight(page, product, productId) {
  if (!product.commercial) throw new Error("缺少 commercial 配置");
  const { startDate, endDate, dailyQuota } = product.commercial.inventory;
  if (new Date(startDate) > new Date(endDate)) throw new Error("库存开始日期晚于结束日期");
  if (dailyQuota < product.commercial.pricing.minimumTravelers) {
    throw new Error("每日库存小于最低成团人数");
  }
  if (product.sales.productForm === "privateTour") {
    const groupId = product.operations?.vehicleResource?.resourceGroupId;
    if (!groupId) throw new Error("私家团未配置现有用车资源组 ID");
  }
  await page.goto(productEditorUrl(productId), { waitUntil: "domcontentloaded" });
  const body = await page.locator("body").innerText();
  if (!body.includes(String(productId))) throw new Error("产品详情页未加载目标产品");
  return { productId: String(productId), commercialData: "ok" };
}

export async function submitProductReview(page, product) {
  if (!product.commercial?.release.submitReview) return { skipped: "数据配置为不提审" };
  const button = page.getByRole("button", { name: "提交审核", exact: true });
  if (!(await button.count())) {
    return { submitted: true, mode: "各模块已在对应阶段提交审核" };
  }
  await button.waitFor({ state: "visible", timeout: 30_000 });
  await button.click();
  await delay(1_500);
  return { submitted: true };
}

async function findProductRow(page, productId) {
  const row = page.locator("tbody tr").filter({ hasText: String(productId) });
  await row.first().waitFor({ state: "visible", timeout: 30_000 });
  return row.first();
}

async function queryProductRow(page, productId) {
  await page.goto(URLS.list, { waitUntil: "domcontentloaded" });
  const allTab = page.getByText("全部", { exact: true }).first();
  if (await allTab.count()) await allTab.click();
  const idSearch = page.getByRole("textbox", { name: "多个用英文逗号分隔" });
  await idSearch.fill(String(productId));
  await page.getByRole("button", { name: "查 询" }).click();
  await delay(700);
  return findProductRow(page, productId);
}

async function acknowledgeResult(page, expectedText) {
  const dialog = page.getByRole("dialog").filter({ hasText: expectedText });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const text = await dialog.innerText();
  if (!text.includes(expectedText)) throw new Error(text);
  await dialog.getByRole("button", { name: "知道了" }).click();
}

export async function publishProduct(page, product, productId) {
  if (!product.commercial?.release.publishAfterApproval) return { skipped: "数据配置为不上线" };
  let row = await queryProductRow(page, productId);
  const makeValid = row.getByText("设为有效", { exact: true });
  if (await makeValid.count()) {
    await makeValid.click();
    await acknowledgeResult(page, "操作成功");
    row = await queryProductRow(page, productId);
  }

  let status = (await row.innerText()).replace(/\s+/g, " ");
  if (!status.includes("上线")) {
    await ensureCheckboxChecked(row.getByRole("checkbox"));
    await page.getByRole("button", { name: "批量上线" }).click();
    await acknowledgeResult(page, "批量上线处理成功");
    row = await queryProductRow(page, productId);
    status = (await row.innerText()).replace(/\s+/g, " ");
  }
  if (!status.includes("有效") || !status.includes("上线")) {
    throw new Error(`发布状态未达到“有效/上线”：${status}`);
  }
  return { published: true, status: "有效/上线" };
}

export async function auditPublishedProduct(page, product, productId) {
  const row = await queryProductRow(page, productId);
  const status = (await row.innerText()).replace(/\s+/g, " ");
  if (!status.includes("有效") || !status.includes("上线")) {
    throw new Error(`上线后检查失败：${status}`);
  }
  await page.goto(productSectionUrl(productId, "pricingInventory"), {
    waitUntil: "domcontentloaded",
  });
  const pricingText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const cost = product.commercial.pricing.cost;
  const expected = [
    `${product.commercial.pricing.adult}/${cost?.adult}`,
    `${product.commercial.pricing.child}/${cost?.child}`,
    `0/${product.commercial.inventory.dailyQuota}`,
  ];
  for (const value of expected) {
    if (!pricingText.includes(String(value))) throw new Error(`上线后未核验到价格/库存值：${value}`);
  }

  const publicUrl = `https://vacations.ctrip.com/travel/detail/p${productId}/`;
  const ceiling = product.commercial.release.publicPriceCeiling;
  const retries = product.commercial.release.publicAuditRetries;
  let repaired = false;
  let publicPrices = [];
  let publicText = "";
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    await page.goto(`${publicUrl}?vbkAudit=${Date.now()}`, { waitUntil: "domcontentloaded" });
    await delay(1_200);
    publicText = await page.locator("body").innerText();
    publicPrices = [...publicText.matchAll(/(?:¥|￥)?(\d+)起/g)].map((match) => Number(match[1]));
    const outliers = publicPrices.filter((price) => price > ceiling);
    if (
      publicText.includes(String(productId)) &&
      publicPrices.length > 0 &&
      outliers.length === 0
    ) {
      return {
        productId: String(productId),
        status: "有效/上线",
        priceInventory: "verified",
        publicUrl,
        publicPrices: [...new Set(publicPrices)],
        repaired,
      };
    }
    if (!repaired && outliers.length) {
      // 资源组变更后，携程的逐日聚合价偶尔保留旧缓存。重发同一组
      // 价格库存可触发全部班期重新聚合，之后再做客端检查。
      await fillAndSubmitPricingInventory(page, product, productId);
      repaired = true;
    }
    await delay(5_000);
  }
  throw new Error(
    `上线后客端价格检查失败：上限 ${ceiling}，检测价格 ${publicPrices.join("、") || "无"}`,
  );
}

export async function fillBasicInfo(page, product) {
  const info = product.basicInfo;
  await page.getByText("基本信息", { exact: true }).waitFor();

  const numberInputs = page.locator("input.ant-input-number-input");
  const numberInputCount = await numberInputs.count();
  if (numberInputCount < 2) {
    throw new Error(`天/晚输入框结构异常：仅找到 ${numberInputCount} 个数字输入框`);
  }
  await numberInputs.nth(0).fill(String(info.days));
  await numberInputs.nth(1).fill(String(info.nights));

  await fillById(page, "baseInfo.subName", info.subtitle, "副标题输入框");
  await fillById(
    page,
    "baseInfo.providerProductName",
    info.supplierProductName,
    "供应商产品名称输入框",
  );
  await fillById(
    page,
    "baseInfo.vendorProductCode",
    info.supplierProductCode,
    "供应商产品编号输入框",
  );
  await fillById(
    page,
    "baseInfo.operationNote",
    info.operationNotes,
    "操作说明输入框",
  );

  await fillCitySelect(page, "baseInfo.masterDepartureCityId", info.meetingCity);
  await fillCitySelect(page, "baseInfo.destinationCityID", info.destinationCity);
}

export async function saveScreenshot(page, prefix, productId = "preview") {
  const artifactDir = path.resolve(ARTIFACTS_DIR);
  await fs.mkdir(artifactDir, { recursive: true });
  const filename = `${prefix}-${productId}-${Date.now()}.png`;
  const target = path.join(artifactDir, filename);
  await page.screenshot({ path: target, fullPage: false });
  return target;
}
