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
import { waitForSaveButtonReady, waitForSubmitButtonReady } from "./resources.helpers.js";

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

  await page.goto(productSectionUrl(productId, "vehicleResource"), {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("资源配置", { exact: true }).waitFor({ timeout: 30_000 });

  await waitForAttachedResourceEntry(page, entryTimeoutMs);

  const segmentResourceInfo = await page.locator("span.item").evaluateAll((spans) => {
    const found = spans.filter((span) => (span.textContent || "").trim() === "附加资源");
    const enabled = found.filter((span) => !String(span.className || "").includes("disacitve"));
    return {
      count: found.length,
      allDisabled: found.every((span) => String(span.className || "").includes("disacitve")),
      enabledCount: enabled.length,
    };
  });
  if (segmentResourceInfo.count > 0 && segmentResourceInfo.allDisabled) {
    // 文案只描述观察到的现象（附加资源入口全部 disabled），不揣测套餐是否已保存。
    return { skipped: "当前行程段附加资源入口 disabled" };
  }
  if (segmentResourceInfo.enabledCount !== 1) {
    throw new Error(`可用「附加资源」入口数量异常：期望 1，实际 ${segmentResourceInfo.enabledCount}`);
  }

  const edit = page.getByRole("button", { name: "编 辑" });
  if (await edit.count()) {
    await edit.click();
    await waitForSaveButtonReady(page, editTimeoutMs);
  }

  const groupId = String(vehicle.resourceGroupId);
  const segmentResource = page.locator("span.item:not(.disacitve)").filter({ hasText: /^附加资源$/ });
  if (await segmentResource.count() !== 1) {
    throw new Error(`可用「附加资源」入口数量异常：期望 1，实际 ${await segmentResource.count()}`);
  }
  await segmentResource.click();
  // 点开资源段面板后等「提交」按钮可见且 enabled，作为面板就绪的证据。
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
    // 等查询结果行含 groupId；明确超时而非固定 delay。
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

  // 「提交」点击后必须证明前向进度：等资源组行重新出现在「度假可选项/用车」
  // 列表里，作为本次保存落库的唯一信号。
  await page.getByRole("button", { name: "提 交" }).click();
  await waitForVehicleResourceCommitted(page, groupId, submitTimeoutMs);
  // 行可见后再点「提交审核」，避免按钮在异步保存完成前就已存在但被 disabled。
  const submitReview = page.getByRole("button", { name: "提交审核" });
  await submitReview.waitFor({ state: "visible", timeout: submitTimeoutMs });
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
          (span) =>
            (span.textContent || "").trim() === "附加资源" &&
            !!(span as HTMLElement).offsetParent,
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