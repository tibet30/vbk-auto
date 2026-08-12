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
 * 纯函数：根据「住宿段证据 items」判定是否可走套餐承载住宿路径。
 *   - items[i] = { title: string, nights: number, hasEnabledPackage: boolean }
 *   - 正住宿段：nights > 0
 *   - 无任何正住宿段 → { ok: false, reason: "no-lodging" }
 *   - 任一正住宿段缺可用套餐入口 → { ok: false, reason: "missing-package", missing: [...] }
 *   - 否则 → { ok: true, segments: items }
 *
 * 设计要点：把 DOM 扫描结果固化成稳定输入，纯函数只判断语义、不接触浏览器，
 * 便于单测覆盖 ok / no-lodging / missing-package 三条分支。
 */
export function classifyPackageManagedSegments(items) {
  const list = Array.isArray(items) ? items : [];
  const positive = list.filter((seg) => Number(seg?.nights) > 0);
  if (positive.length === 0) {
    return { ok: false, reason: "no-lodging" };
  }
  const missing = positive.filter((seg) => seg?.hasEnabledPackage !== true);
  if (missing.length > 0) {
    return { ok: false, reason: "missing-package", missing };
  }
  return { ok: true, segments: list };
}

/** 等待 .ResourceConfig-content-card 含「住宿晚数」段出现的默认超时（毫秒）。 */
const DEFAULT_HOTEL_RESOURCE_CARD_TIMEOUT_MS = 12_000;
/** 等待「附加资源」入口异步渲染的默认超时（毫秒）。 */
const DEFAULT_VEHICLE_RESOURCE_ENTRY_TIMEOUT_MS = 12_000;

/**
 * 酒店资源阶段：
 *   - 当行程含住宿时，根据 operations.hotelTier 转 diamond；
 *   - 若酒店资源表中已配置同钻级现成资源则跳过；
 *   - 否则打开「添加酒店」弹窗，按「酒店」触发 VBK 候选下拉，挑出与本地钻级一致的候选，
 *     选中并提交保存，最后回读配置表确认新资源已经落库。
 *
 *   - 当酒店入口数为 0（典型：行程含住宿但本页按套餐承载住宿、由 package 资源承载），
 *     扫描 .ResourceConfig-content-card：每个住宿晚数>0 的段都必须有非 disacitve 的
 *     span.item「套餐」入口；满足则返回 skipped + packageManaged，不写伪 hotelResource。
 *
 *   - 第 4 个可选参数 options.cardTimeoutMs（毫秒，默认 12_000）控制
 *     「资源卡异步重渲染」的等待窗口；测试可通过它注入短 timeout，避免被默认值拖慢。
 *     全部调用方按 3 参调用保持不变。
 */
export async function ensureHotelResource(
  page,
  product,
  productId,
  options = {},
) {
  const cardTimeoutMs =
    Number.isFinite(Number(options?.cardTimeoutMs)) &&
    Number(options.cardTimeoutMs) >= 0
      ? Number(options.cardTimeoutMs)
      : DEFAULT_HOTEL_RESOURCE_CARD_TIMEOUT_MS;
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
  if (hotelEntryCount === 0) {
    // 套餐资源承载住宿、无独立酒店入口：扫描 .ResourceConfig-content-card 证据，
    // 每个住宿晚数>0 的段都必须有非 disacitve 的 span.item「套餐」入口；
    // 满足则跳过本阶段（不写伪 hotelResource），不满足则明确失败。
    //
    // 实机节奏：点击「编辑」后页面只 delay 500ms，资源卡属异步重渲染。
    // 立即 page.evaluate 时 .ResourceConfig-content-card 尚未出现或内容为空，
    // segments 数组为空会被「无任何正住宿段」分支误判为 no-lodging。必须先等：
    //   - 至少一个 .ResourceConfig-content-card 可见；
    //   - 至少一张卡片文本含「住宿晚数」。
    // 超时明确抛「资源卡未加载」错误，不得静默跳过。
    const timeoutMs = cardTimeoutMs;
    try {
      await page
        .locator(".ResourceConfig-content-card")
        .first()
        .waitFor({ state: "visible", timeout: timeoutMs });
      await page.waitForFunction(
        () => {
          const cards = Array.from(
            document.querySelectorAll(".ResourceConfig-content-card"),
          );
          return cards.some((c) => /住宿晚数/.test(c.textContent || ""));
        },
        undefined,
        { timeout: timeoutMs, polling: 200 },
      );
    } catch (err) {
      const raw = err && typeof err === "object" ? err : { message: String(err) };
      const msg = typeof raw.message === "string" ? raw.message : "";
      const name = typeof raw.name === "string" ? raw.name : "";
      const isTimeout =
        name === "TimeoutError" || /timeout|timed out/i.test(msg);
      if (isTimeout) {
        throw new Error(
          `资源卡未加载：等待 .ResourceConfig-content-card 出现并含「住宿晚数」超时 ${timeoutMs}ms`,
        );
      }
      throw err;
    }
    const items = await page
      .locator(".ResourceConfig-content-card")
      .evaluateAll((nodes) =>
        nodes.map((card) => {
          const fullText = (card.textContent || "");
          const firstLine =
            fullText
              .split(/\r?\n/)
              .map((s) => s.trim())
              .find((s) => s.length > 0) || "";
          const stayMatch = fullText.match(/住宿晚数\s*(\d+)/);
          const stayNights = stayMatch ? Number(stayMatch[1]) : 0;
          const itemSpans = Array.from(card.querySelectorAll("span.item"));
          const packageSpans = itemSpans.filter(
            (s) => (s.textContent || "").trim() === "套餐",
          );
          const packageItemCount = packageSpans.length;
          const enabledPackageCount = packageSpans.filter(
            (s) => !(s.className || "").includes("disacitve"),
          ).length;
          return {
            title: firstLine,
            stayNights,
            packageItemCount,
            enabledPackageCount,
          };
        }),
      );
    // 纯函数契约用 nights/hasEnabledPackage；公开 segments 用 stayNights/... 字段。
    const pureItems = items.map((seg) => ({
      title: seg.title,
      nights: seg.stayNights,
      hasEnabledPackage: seg.enabledPackageCount > 0,
    }));
    const verdict = classifyPackageManagedSegments(pureItems);
    if (!verdict.ok) {
      if (verdict.reason === "no-lodging") {
        throw new Error(
          "车辆资源页未发现任何「住宿晚数>0」的 .ResourceConfig-content-card：行程含住宿但本页无可承载住宿段",
        );
      }
      const labels = verdict.missing
        .map(
          (seg) =>
            `${seg.title}（住宿晚数${seg.nights}）`,
        )
        .join("、");
      throw new Error(`正住宿段缺少可用「套餐」入口：${labels}`);
    }
    const positiveSegmentCount = items.filter(
      (seg) => seg.stayNights > 0,
    ).length;
    return {
      skipped: "套餐资源承载住宿，无独立酒店入口",
      packageManaged: true,
      segments: items,
      positiveSegmentCount,
    };
  }
  if (hotelEntryCount > 1) {
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
export async function ensureVehicleResource(page, product, productId, options = {}) {
  const entryTimeoutMs =
    Number.isFinite(Number(options?.entryTimeoutMs)) &&
    Number(options.entryTimeoutMs) >= 0
      ? Number(options.entryTimeoutMs)
      : DEFAULT_VEHICLE_RESOURCE_ENTRY_TIMEOUT_MS;
  const vehicle = product.operations?.vehicleResource;
  if (product.sales.productForm !== "privateTour") return { skipped: "非私家团" };
  if (!vehicle || !vehicle.resourceGroupId || !vehicle.resourceGroupName) {
    return { skipped: "未配置 operations.vehicleResource（需人工预置后补跑本阶段）" };
  }

  await page.goto(productSectionUrl(productId, "vehicleResource"), {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("资源配置", { exact: true }).waitFor({ timeout: 30_000 });

  try {
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("span.item")).some(
          (span) =>
            (span.textContent || "").trim() === "附加资源" &&
            !!(span as HTMLElement).offsetParent,
        ),
      undefined,
      { timeout: entryTimeoutMs, polling: 100 },
    );
  } catch (err) {
    const raw = err && typeof err === "object" ? err : { message: String(err) };
    const msg = typeof raw.message === "string" ? raw.message : "";
    const name = typeof raw.name === "string" ? raw.name : "";
    if (name === "TimeoutError" || /timeout|timed out/i.test(msg)) {
      throw new Error(`资源入口未加载：等待可见 exact「附加资源」入口超时 ${entryTimeoutMs}ms`);
    }
    throw err;
  }

  const segmentResourceInfo = await page.locator("span.item").evaluateAll((spans) => {
    const found = spans.filter((span) => (span.textContent || "").trim() === "附加资源");
    const enabled = found.filter((span) => !String(span.className || "").includes("disacitve"));
    return { count: found.length, allDisabled: found.every((span) => String(span.className || "").includes("disacitve")), enabledCount: enabled.length };
  });
  if (segmentResourceInfo.count > 0 && segmentResourceInfo.allDisabled) {
    // 文案只描述观察到的现象（附加资源入口全部 disabled），不揣测套餐是否已保存。
    // 实机节奏：套餐已保存也可能在某些行程段因平台未开放/资源未就绪呈现 disabled，
    // 不能用「套餐未保存」作结论性理由误导上游决策。
    return { skipped: "当前行程段附加资源入口 disabled" };
  }
  if (segmentResourceInfo.enabledCount !== 1) {
    throw new Error(`可用「附加资源」入口数量异常：期望 1，实际 ${segmentResourceInfo.enabledCount}`);
  }

  const edit = page.getByRole("button", { name: "编 辑" });
  if (await edit.count()) {
    await edit.click();
    await delay(500);
  }

  const groupId = String(vehicle.resourceGroupId);
  const segmentResource = page.locator("span.item:not(.disacitve)").filter({ hasText: /^附加资源$/ });
  if (await segmentResource.count() !== 1) {
    throw new Error(`可用「附加资源」入口数量异常：期望 1，实际 ${await segmentResource.count()}`);
  }
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