// @ts-nocheck
/**
 * 用车资源组阶段（仅私家团）：
 *   - 当 operations.vehicleResource 已配置 resourceGroupId/Name 时，在车辆资源页的「附加资源」
 *     段添加该资源组；若已存在则跳过添加，先清掉历史遗留项再加新项；
 *   - 提报后等「校验」弹窗出现并通过；
 *   - 非私家团 / 未预置资源都走 skipped 路径，不在自动化阶段里改 operations。
 *
 * 顶部带 `// @ts-nocheck`，DOM 选择器对外部页面变化敏感。
 *
 * 关键「前向进度」约束（优化目标，避免自动化卡死）：
 *   - 点完「提交」后必须等目标资源行在「度假可选项/用车」列表重新出现，作为
 *     本次保存落库的唯一信号；不允许「点完提交 + 固定 delay + goto 重进」绕开。
 *   - 行可见后再点「提交审核」，避免按钮在异步保存完成前就已存在但被 disabled。
 *   - 任何 wait 都有显式超时与可读错误：超时 → 抛错，由外层 recovery 决策。
 */

import { productSectionUrl } from "../constants.js";
import {
  DEFAULT_RESOURCE_EDIT_TIMEOUT_MS,
  DEFAULT_RESOURCE_QUERY_TIMEOUT_MS,
  DEFAULT_VALIDATION_DIALOG_TIMEOUT_MS,
  DEFAULT_VALIDATION_RESULT_TIMEOUT_MS,
  DEFAULT_VEHICLE_RESOURCE_ENTRY_TIMEOUT_MS,
  DEFAULT_VEHICLE_SUBMIT_TIMEOUT_MS,
} from "./resources.constants.js";
import { waitForSubmitButtonReady } from "./resources.helpers.js";
import { ensureVehicleResourceBinding } from "./vehicle-resource-api.js";

/**
 * 用车资源阶段入口；options 字段允许测试注入短 timeout。
 *   - entryTimeoutMs：等「附加资源」入口可见（默认 12_000ms）
 *   - editTimeoutMs：等「编辑」后「保存/提交」按钮就绪（默认 4_000ms）
 *   - queryTimeoutMs：「选择资源组」弹窗内 groupId 查询行可见（默认 6_000ms）
 *   - submitTimeoutMs：点完「提交」等资源行重新可见（默认 8_000ms）
 *   - validationDialogTimeoutMs：点完「提交审核」等校验弹窗（默认 10_000ms）
 *   - validationResultTimeoutMs：等「校验结束」文案（默认 15_000ms）
 */
export async function ensureVehicleResource(page, product, productId, options = {}) {
  const entryTimeoutMs = numberOrDefault(options?.entryTimeoutMs, DEFAULT_VEHICLE_RESOURCE_ENTRY_TIMEOUT_MS);
  const editTimeoutMs = numberOrDefault(options?.editTimeoutMs, DEFAULT_RESOURCE_EDIT_TIMEOUT_MS);
  const queryTimeoutMs = numberOrDefault(options?.queryTimeoutMs, DEFAULT_RESOURCE_QUERY_TIMEOUT_MS);
  const submitTimeoutMs = numberOrDefault(options?.submitTimeoutMs, DEFAULT_VEHICLE_SUBMIT_TIMEOUT_MS);
  const validationDialogTimeoutMs = numberOrDefault(
    options?.validationDialogTimeoutMs,
    DEFAULT_VALIDATION_DIALOG_TIMEOUT_MS,
  );
  const validationResultTimeoutMs = numberOrDefault(
    options?.validationResultTimeoutMs,
    DEFAULT_VALIDATION_RESULT_TIMEOUT_MS,
  );

  const vehicle = product.operations?.vehicleResource;
  if (product.sales.productForm !== "privateTour") return { skipped: "非私家团" };
  if (!vehicle || !vehicle.resourceGroupId || !vehicle.resourceGroupName) {
    return { skipped: "未配置 operations.vehicleResource（需人工预置后补跑本阶段）" };
  }

  // 真实 VBK 会话直接复用 Tour Helper 后端协议。file:/about:blank 等本地页面
  // 继续走下方 DOM 契约，既保留离线测试能力，也避免在无 cookie origin 上
  // 读取 document.cookie 触发 SecurityError。
  const pageUrl = await page.url();
  if (/^https:\/\/vbooking\.ctrip\.com\//i.test(pageUrl)) {
    return ensureVehicleResourceBinding(
      page,
      productId,
      vehicle.resourceGroupId,
      vehicle.resourceGroupName,
    );
  }

  await page.goto(productSectionUrl(productId, "vehicleResource"), {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("资源配置", { exact: true }).waitFor({ timeout: 30_000 });

  // VBK 车辆资源页有「只读态」与「编辑态」两种入口文案：
  //   - 只读态：span.item 文本 == "附加资源"，带 disacitve class。
  //   - 编辑态：span.item 文本 == "可添加：附加资源"，className 可能仍残留
  //     旧 disacitve（页面异步把文案换掉，但没清 class），必须以编辑态文案为准。
  // 自动化必须先点 "编 辑" 把页面切到编辑态；该页面编辑态底部只有「提交审核」
  // 等按钮，没有稳定的「保存」按钮，因此以后续「可添加：附加资源」文案作为
  // 异步编辑态的可观察证据。
  const edit = page.getByRole("button", { name: "编 辑" });
  if (await edit.count()) {
    await edit.click();
  }

  await waitForAttachedResourceEntry(page, entryTimeoutMs);
  const segmentResourceInfo = await page.locator("span.item").evaluateAll((spans) => {
    const found = spans.filter((span) => {
      const text = (span.textContent || "").trim();
      return /^(可添加：)?附加资源$/.test(text);
    });
    // 编辑态文案「可添加：附加资源」一定可点击；
    // 只读态「附加资源」只有在不带 disacitve class 时才视为可点击入口。
    const addable = found.filter((span) => {
      const text = (span.textContent || "").trim();
      return text === "可添加：附加资源"
        || !String(span.className || "").includes("disacitve");
    });
    return {
      count: found.length,
      addableCount: addable.length,
    };
  });
  if (segmentResourceInfo.count > 0 && segmentResourceInfo.addableCount === 0) {
    return { skipped: "当前行程段附加资源入口 disabled" };
  }
  if (segmentResourceInfo.addableCount === 0) {
    throw new Error("未找到可用「附加资源」入口");
  }
  const groupId = String(vehicle.resourceGroupId);
  const addableEntries = page
    .locator("span.item")
    .filter({ hasText: /^可添加：附加资源$/ })
    .or(page.locator("span.item:not(.disacitve)").filter({ hasText: /^附加资源$/ }));
  const segmentCards = page.locator(".ResourceConfig-content-card");
  const segmentCount = (await segmentCards.count()) > 0
    ? await segmentCards.filter({ has: page.locator("span.item").filter({ hasText: /^(可添加：)?附加资源$/ }) }).count()
    : await addableEntries.count();

  // 携程产品级校验要求每个可配置的私家团行程段都关联用车组，不能只处理首段。
  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const card = segmentCards.filter({ has: page.locator("span.item").filter({ hasText: /^(可添加：)?附加资源$/ }) }).nth(segmentIndex);
    const segmentResource = (await segmentCards.count()) > 0
      ? card.locator("span.item").filter({ hasText: /^(可添加：)?附加资源$/ }).first()
      : addableEntries.nth(segmentIndex);
    await segmentResource.click();
    await waitForSubmitButtonReady(page, editTimeoutMs);

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
      const queryRow = dialog.getByRole("row").filter({ hasText: groupId });
      try {
        await queryRow.first().waitFor({ state: "visible", timeout: queryTimeoutMs });
      } catch (err) {
        const raw = err && typeof err === "object" ? err : { message: String(err) };
        const name = typeof raw.name === "string" ? raw.name : "";
        const msg = typeof raw.message === "string" ? raw.message : "";
        if (name === "TimeoutError" || /timeout|timed out/i.test(msg)) {
          throw new Error(
            `资源组查询超时 ${queryTimeoutMs}ms：未在「选择资源组」弹窗内找到 groupId=${groupId} 的有效记录`,
          );
        }
        throw new Error(`资源组查询失败：${msg}`);
      }
      const rowText = (await queryRow.first().innerText()).replace(/\s+/g, " ");
      if (!rowText.includes("有效")) throw new Error(`用车资源组不是有效状态：${rowText}`);
      if (!rowText.includes(vehicle.resourceGroupName)) {
        throw new Error(`用车资源组名称与产品数据不一致：${rowText}`);
      }
      await queryRow.first().getByRole("radio").click();
      await dialog.getByRole("button", { name: "确 定" }).click();
    }

    await page.getByRole("button", { name: "提 交" }).click();
    await waitForVehicleResourceCommitted(page, groupId, submitTimeoutMs);
    if ((await page.url()).includes("newResourceRuleEdit")) {
      await page.waitForURL(/\/product\/input\/newResourceRule\?/i, { timeout: submitTimeoutMs });
    }
    await waitForAttachedResourceEntry(page, entryTimeoutMs);
  }

  // 资源段逐一落库后回到资源配置主页面，必须等主页面的提审按钮真正可用再点击。
  const submitReview = page.locator("button[data-testid='submit-draft']").or(page.getByRole("button", { name: "提交审核" })).first();
  await submitReview.waitFor({ state: "visible", timeout: submitTimeoutMs });
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll("button")).some((button) =>
      (button.textContent || "").trim() === "提交审核" &&
      !(button as HTMLButtonElement).disabled &&
      button.getAttribute("aria-disabled") !== "true" &&
      !!(button as HTMLElement).offsetParent),
    undefined,
    { timeout: submitTimeoutMs, polling: 100 },
  );
  await submitReview.click();
  const validation = page.getByRole("dialog", { name: "校验" });
  await validation.waitFor({ state: "visible", timeout: validationDialogTimeoutMs });
  await validation.getByText(/校验结束/).waitFor({ timeout: validationResultTimeoutMs });
  const validationText = await validation.innerText();
  if (!validationText.includes("校验通过")) throw new Error(validationText);
  await validation.getByRole("button", { name: "确 定" }).click();
  return { resourceGroupId: vehicle.resourceGroupId, audited: true };
}

/**
 * 等待「附加资源」入口可见 + enabled，作为「车辆资源页核心异步元素已渲染」的信号；
 * 超时抛错，避免依赖固定 delay 赌异步加载。
 */
async function waitForAttachedResourceEntry(page, timeoutMs) {
  try {
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("span.item")).some(
          (span) => {
            const text = (span.textContent || "").trim();
            return /^(可添加：)?附加资源$/.test(text) && !!(span as HTMLElement).offsetParent;
          },
        ),
      undefined,
      { timeout: timeoutMs, polling: 100 },
    );
  } catch (err) {
    const raw = err && typeof err === "object" ? err : { message: String(err) };
    const msg = typeof raw.message === "string" ? raw.message : "";
    const name = typeof raw.name === "string" ? raw.name : "";
    if (name === "TimeoutError" || /timeout|timed out/i.test(msg)) {
      throw new Error(`资源入口未加载：等待可见 exact「附加资源」入口超时 ${timeoutMs}ms`);
    }
    throw err;
  }
}

/**
 * 「提交」按钮被点击后，必须等到 groupId 对应行再次出现在「度假可选项/用车」列表中，
 * 才认为本次保存真正落库。等待窗口分两阶段：
 *   - 前半段（提交后）轮询同一列表 DOM；
 *   - 行可见即返回；超时抛错。
 */
async function waitForVehicleResourceCommitted(page, groupId, timeoutMs) {
  const rows = page
    .getByRole("row")
    .filter({ hasText: "度假可选项/用车" })
    .filter({ hasText: groupId });
  try {
    await rows.first().waitFor({ state: "visible", timeout: timeoutMs });
  } catch (err) {
    const raw = err && typeof err === "object" ? err : { message: String(err) };
    const name = typeof raw.name === "string" ? raw.name : "";
    const msg = typeof raw.message === "string" ? raw.message : "";
    if (name === "TimeoutError" || /timeout|timed out/i.test(msg)) {
      throw new Error(
        `提交未落地：点击「提交」后 ${timeoutMs}ms 内未在「度假可选项/用车」列表看到 groupId=${groupId} 行（未证明前向进度）`,
      );
    }
    throw new Error(`提交后等待资源行失败：${msg}`);
  }
}

/** 解析 options.timeoutMs：合法数字（非负有限）才采用，否则退回默认值。 */
function numberOrDefault(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
