// @ts-nocheck
/**
 * 资源配置阶段：酒店资源与用车资源组的自动化填充。
 *   - ensureHotelResource：按 operations.hotelTier + 行程中是否含住宿，进入「酒店」配置面板
 *     添加符合当地钻级的酒店，跳过已存在的同钻级资源；
 *   - ensureVehicleResource：仅私家团 + 已预置 resourceGroupId 时往「附加资源」段添加资源组，
 *     最后过一道「校验」弹窗。
 * 源码头部带 `// @ts-nocheck`，DOM 选择器对外部页面变化敏感。
 */


import { delay } from "./utils.js";
import { productSectionUrl } from "../constants.js";
import { hotelCandidateMatchesTier, hotelDiamondFromTier } from "../../../shared/hotel-tiers.js";

/**
 * 酒店资源阶段：
 *   - 当行程含住宿时，根据 operations.hotelTier 转 diamond；
 *   - 若酒店资源表中已配置同钻级现成资源则跳过；
 *   - 否则打开「添加酒店」弹窗，按「酒店」触发 VBK 候选下拉，挑出与本地钻级一致的候选，
 *     选中并提交保存，最后回读配置表确认新资源已经落库。
 */
export async function ensureHotelResource(page, product, productId) {
  const hotelTier = product.operations?.hotelTier;
  const diamond = hotelDiamondFromTier(hotelTier);
  const needsHotel = product.itinerary?.some((day) => Boolean(day.hotel));
  if (!needsHotel) return { skipped: "行程不含住宿" };
  if (!diamond) throw new Error(`酒店等级配置无效：${String(hotelTier || "未配置")}`);

  await page.goto(productSectionUrl(productId, "vehicleResource"), {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("资源配置", { exact: true }).waitFor({ timeout: 30_000 });

  const edit = page.getByRole("button", { name: "编 辑" });
  if (await edit.count()) {
    await edit.click();
    await delay(500);
  }

  const hotelEntries = page.getByText(/^(可添加：)?酒店$/, { exact: true });
  const hotelEntryCount = await hotelEntries.count();
  if (hotelEntryCount !== 1) {
    throw new Error(`可配置酒店的住宿行程段数量异常：期望 1，实际 ${hotelEntryCount}`);
  }
  await hotelEntries.first().click();
  await page.waitForURL(/\/newResourceRuleEdit\?.*resourcetype=hotel/i, { timeout: 15_000 });

  const specifiedHeader = page.getByRole("columnheader", { name: "排序分(由大到小排序)" });
  await specifiedHeader.waitFor({ state: "visible", timeout: 15_000 });
  const specifiedTable = page.locator("table").filter({ has: specifiedHeader });
  const configuredRows = specifiedTable.getByRole("row").filter({ hasNotText: "资源类型" }).filter({ hasNotText: "暂无内容" });
  const configuredTexts = (await configuredRows.allTextContents()).map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean);
  const existingHotel = product.operations?.hotelResource;
  const existingHotelId = existingHotel?.resourceId ? String(existingHotel.resourceId) : "";
  if (existingHotelId && existingHotel?.hotelTier === hotelTier && configuredTexts.some((text) => text.includes(existingHotelId))) {
    return { skipped: `已配置当地${diamond}钻酒店`, diamond, hotelTier };
  }
  if (configuredTexts.length) {
    throw new Error(`资源配置已有酒店，但与行程的当地${diamond}钻不一致：${configuredTexts.join("；")}`);
  }

  const addHotelButtons = page.getByRole("button", { name: /添加酒店/ });
  const addHotelButtonCount = await addHotelButtons.count();
  if (addHotelButtonCount !== 2) throw new Error(`“添加酒店”按钮数量异常：期望 2，实际 ${addHotelButtonCount}`);
  await addHotelButtons.first().click();
  const dialog = page.getByRole("dialog", { name: "添加酒店" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });

  const combos = dialog.getByRole("combobox");
  const comboCount = await combos.count();
  if (comboCount !== 2) throw new Error(`酒店查询下拉框数量异常：期望 2，实际 ${comboCount}`);
  const hotelNameInput = combos.nth(1);
  await hotelNameInput.fill("");
  await hotelNameInput.type("酒店", { delay: 80 });

  const candidates = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content");
  await candidates.first().waitFor({ state: "visible", timeout: 10_000 });
  const candidateTexts = (await candidates.allTextContents()).map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean);
  const selectedText = candidateTexts.find((text) => hotelCandidateMatchesTier(text, hotelTier));
  if (!selectedText) {
    throw new Error(`getSegmentHotelQueryList 未返回当地${diamond}钻酒店；已拒绝改选其它钻级。`);
  }
  const selectedOption = page.getByText(selectedText, { exact: true });
  const selectedOptionCount = await selectedOption.count();
  if (selectedOptionCount !== 1) throw new Error(`同钻级酒店候选无法唯一定位：${selectedText}`);
  await selectedOption.click();

  const query = dialog.getByRole("button", { name: "查 询" });
  await query.click();
  await delay(700);
  const resultRows = dialog.getByRole("row").filter({ hasText: selectedText.split(" ")[0] });
  const resultRowCount = await resultRows.count();
  if (resultRowCount !== 1) throw new Error(`酒店查询结果数量异常：期望 1，实际 ${resultRowCount}`);
  const resultRow = resultRows.first();
  const resultText = (await resultRow.innerText()).replace(/\s+/g, " ").trim();
  if (!hotelCandidateMatchesTier(resultText, hotelTier)) {
    throw new Error(`酒店查询结果钻级不一致：行程为当地${diamond}钻，结果为 ${resultText}`);
  }
  const hotelId = resultText.match(/\b\d{4,}\b/)?.[0];
  if (!hotelId) throw new Error(`酒店查询结果缺少酒店 ID：${resultText}`);
  const checkbox = resultRow.getByRole("checkbox");
  await checkbox.check();
  const confirm = dialog.getByRole("button", { name: "确 定" });
  await confirm.click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });

  const configured = specifiedTable.getByRole("row").filter({ hasText: hotelId });
  await configured.first().waitFor({ state: "visible", timeout: 10_000 });
  const configuredText = (await configured.first().innerText()).replace(/\s+/g, " ").trim();
  if (!configuredText.includes(hotelId)) throw new Error(`保存前复核失败：指定酒店 ID ${hotelId} 未进入配置表。`);
  const submit = page.getByRole("button", { name: "提 交", exact: true });
  await submit.click();
  return { source: "vbk", resourceId: Number(hotelId), resourceName: selectedText, diamond, hotelTier };
}

/**
 * 用车资源组阶段（仅私家团）：
 *   - 当 operations.vehicleResource 已配置 resourceGroupId/Name 时，在车辆资源页的「附加资源」
 *     段添加该资源组；若已存在则跳过添加，先清掉历史遗留项再加新项；
 *   - 提报后等「校验」弹窗出现并通过；
 *   - 非私家团 / 未预置资源都走 skipped 路径，不在自动化阶段里改 operations。
 */
export async function ensureVehicleResource(page, product, productId) {
  const vehicle = product.operations?.vehicleResource;
  if (product.sales.productForm !== "privateTour") return { skipped: "非私家团" };
  if (!vehicle || !vehicle.resourceGroupId || !vehicle.resourceGroupName) {
    return { skipped: "未配置 operations.vehicleResource（需人工预置后补跑本阶段）" };
  }

  await page.goto(productSectionUrl(productId, "vehicleResource"), {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("资源配置", { exact: true }).waitFor({ timeout: 30_000 });
  const segmentResourceInfo = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll("span.item"));
    const found = spans.filter((s) => s.textContent?.trim() === "附加资源" || s.textContent?.includes("附加资源"));
    return {
      count: found.length,
      allDisabled: found.length > 0 && found.every((s) => s.className.includes("disacitve")),
      classes: found.map((s) => s.className),
    };
  });
  if (segmentResourceInfo.count > 0 && segmentResourceInfo.allDisabled) {
    return { skipped: "套餐未保存，车辆资源入口 disabled" };
  }
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