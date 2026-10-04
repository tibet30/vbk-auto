/** Upload a manual or bundled draft cover through the supplier's own cover upload form. */
import { uploadNewManualCoverViaApi } from "./manual-cover-api.js";
import { delay } from "../utils.js";
import { basename } from "node:path";
import { bindCtripLibraryCoverViaApi, readBoundCoverByFileNameViaApi, readBoundCoverImageIdsViaApi } from "./cover-bind.js";

export type CoverUploadFile = string | { name: string; mimeType: "image/png"; buffer: Buffer };

const IMAGE_PAGE = "https://vbooking.ctrip.com/product/input/productImageText";
const COVER_SECTION = ".image-category-container:has(> h3.image-category-title > .required-asterisk):visible:not(#lingjie-skeleton *)";

export function activeManualCoverSection(page: any): any {
  return page.locator(COVER_SECTION).first();
}

export function activeManualCoverDialog(page: any): any {
  return page.locator(".ant-modal.uploadpic-modal:visible:not(#lingjie-skeleton *)")
    .filter({ hasText: "上传图片资源" }).first();
}

export async function submitManualCoverUpload(page: any, dialog: any): Promise<void> {
  await dialog.getByRole("button", { name: "同意并上传" }).click();
  const confirmation = page.locator(".ant-popover.ant-popconfirm:visible").first();
  if (await confirmation.waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false)) {
    const confirmText = await confirmation.innerText();
    if (!/图片|封面|头图/.test(confirmText)) throw new Error(`供应商上传确认内容异常：${confirmText}`);
    await confirmation.getByRole("button", { name: /确\s*定/ }).click();
  }
}

/** The supplier requires a city tag for a cover; this is not a POI/image-ID match. */
export async function selectManualCoverCity(page: any, dialog: any, city: string): Promise<void> {
  const name = city.trim();
  if (!name) throw new Error("手动封面上传缺少产品城市，无法填写供应商必填的景区/城市字段。");
  const input = dialog.locator("#District");
  const option = page.locator(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option",
  ).filter({ has: page.locator(`.Name[title=${JSON.stringify(name)}]`) });
  // The modal can retain the previous search text after a failed attempt.
  // Clear it to trigger Ant Select's remote suggestion request anew. Its exact
  // query can intermittently close before results render, so retry a prefix.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await input.fill("");
    await input.fill(attempt === 0 ? name : name.slice(0, -1) || name);
    try {
      await option.first().waitFor({ state: "visible", timeout: 5_000 });
      break;
    } catch (error) {
      if (attempt === 1) throw new Error(`供应商未返回产品城市 ${name} 的景区/城市选项：${String(error)}`);
    }
  }
  // Ant Select renders its menu in a portal that may sit outside BrowserView's viewport.
  await option.first().evaluate((element: HTMLElement) => element.click());
  const selected = await dialog.locator("#District").evaluate(
    (element: HTMLElement) => element.closest(".ant-select")?.querySelector(".ant-select-selection-item")?.textContent?.trim(),
  );
  if (selected !== name) throw new Error(`供应商景区/城市未选中产品城市 ${name}（当前：${selected || "空"}）。`);
}

export function uploadedImageId(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const body = (payload as { body?: unknown }).body;
  if (!Array.isArray(body) || body.length !== 1) return null;
  const item = body[0] as { success?: unknown; imageId?: unknown };
  const id = Number(item.imageId);
  return item.success === true && Number.isInteger(id) && id > 0 ? id : null;
}

/** Navigation recovery is limited to file preparation, before any upload submission. */
export async function prepareManualCoverUpload(
  page: any, productId: number, file: CoverUploadFile, city: string,
  beforeWrite?: () => Promise<void>,
): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.goto(`${IMAGE_PAGE}?productId=${productId}&pattern=4&from=vbk`, {
        waitUntil: "domcontentloaded", timeout: 30_000,
      });
      const coverSection = activeManualCoverSection(page);
      await coverSection.waitFor({ state: "visible", timeout: 20_000 });
      const title = (await coverSection.locator("h3.image-category-title").innerText()).trim();
      if (title !== "*封面") throw new Error(`供应商封面区域标题异常：${title}`);
      // VBK keeps a hidden skeleton dialog during transitions; bind only the live modal.
      const dialog = activeManualCoverDialog(page);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const uploadEntry = coverSection.getByText("上传图片", { exact: true });
        if (await coverSection.getByText("替换封面", { exact: true }).count()) {
          await coverSection.getByText("替换封面", { exact: true }).first()
            .locator("..").evaluate((element: HTMLElement) => element.click());
        } else if (!(await uploadEntry.first().isVisible())) {
          const add = coverSection.getByText("添加图片", { exact: true });
          // The text itself belongs to a hover menu; its wrapper is the hit target.
          if (await add.count()) await add.first().locator("..").hover({ timeout: 5_000 });
        }
        await uploadEntry.first().waitFor({ state: "visible", timeout: 5_000 });
        // BrowserView may be detached while a task runs in the background.
        // Invoke the visible menu wrapper instead of moving the desktop pointer,
        // which also hides this hover menu before its click can be delivered.
        await uploadEntry.first().locator("..").evaluate((element: HTMLElement) => element.click());
        try {
          await dialog.waitFor({ state: "visible", timeout: 3_000 });
          break;
        } catch (error) {
          if (attempt === 2) {
            throw new Error(`供应商封面上传弹窗未打开（page=${page.url()}）：${String(error)}`);
          }
          await delay(400);
        }
      }
      const selectedType = await dialog.locator("#imageType").evaluate(
        (input: HTMLElement) => input.closest(".ant-select")?.querySelector(".ant-select-selection-item")?.textContent?.trim(),
      );
      if (selectedType !== "封面") throw new Error(`供应商上传弹窗的图片类型不是封面（当前：${selectedType || "空"}）。`);
      await selectManualCoverCity(page, dialog, city);
      const agreement = dialog.locator("#knowlicense");
      if (!(await agreement.isChecked())) throw new Error("供应商图片授权协议尚未确认，请在平台核查授权。");

      await beforeWrite?.();
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 5_000 }),
        dialog.locator(".uploadpic-modal-addpic").evaluate((element: HTMLElement) => element.click()),
      ]);
      await chooser.setFiles(file);
      await dialog.locator(".uploadpic-modal-picitem img").first().waitFor({ state: "visible", timeout: 10_000 });
      return dialog;
    } catch (error) {
      if (attempt === 1 || !/Execution context was destroyed|most likely because of a navigation/i.test(String(error))) throw error;
      // Reopen the correct product page and acquire a fresh file chooser.
      // Authorization, city and license checks are all repeated on the live dialog.
    }
  }
  throw new Error("封面文件准备未完成。");
}

export async function uploadManualCoverViaSupplierPage(
  page: any,
  productId: number,
  file: CoverUploadFile,
  city: string,
  previousRemoteImageId?: number,
  onUploaded?: (imageId: number) => Promise<void> | void,
  beforeWrite?: () => Promise<void>,
): Promise<{ imageId: number; reused: boolean }> {
  if (!Number.isInteger(productId) || productId <= 0) throw new Error("手动封面上传缺少 VBK 产品 ID。");
  const fileName = typeof file === "string" ? basename(file) : file.name;
  if (previousRemoteImageId && Number.isInteger(previousRemoteImageId)) {
    const bound = await readBoundCoverImageIdsViaApi(page, productId);
    if (bound.includes(previousRemoteImageId)) return { imageId: previousRemoteImageId, reused: true };
    await bindCtripLibraryCoverViaApi(page, previousRemoteImageId, productId, { beforeWrite });
    return { imageId: previousRemoteImageId, reused: true };
  }

  const existingSameFile = await readBoundCoverByFileNameViaApi(page, productId, fileName);
  if (existingSameFile) {
    await onUploaded?.(existingSameFile);
    return { imageId: existingSameFile, reused: true };
  }

  const before = await readBoundCoverImageIdsViaApi(page, productId);
  if (before.length > 1) throw new Error("远端存在多个封面，无法安全上传新封面。");
  if (page.nativeOnly) {
    return uploadNewManualCoverViaApi(page, productId, file, city, onUploaded, beforeWrite);
  }
  // Compatibility path for standalone page-based runners.
  if (page.acquireInteractivePage) page = await page.acquireInteractivePage();
  const dialog = await prepareManualCoverUpload(page, productId, file, city, beforeWrite);

  const uploadResponse = page.waitForResponse(
    (response: any) => /\/20698\/uploadImage\.json/.test(response.url()),
    { timeout: 30_000 },
  );
  await beforeWrite?.();
  await submitManualCoverUpload(page, dialog);
  let response: any;
  try {
    response = await uploadResponse;
  } catch (error) {
    const recovered = await readBoundCoverByFileNameViaApi(page, productId, fileName);
    if (recovered) {
      await onUploaded?.(recovered);
      return { imageId: recovered, reused: false };
    }
    const errors = await dialog.locator(".ant-form-item-explain-error").allTextContents().catch(() => []);
    const detail = errors.map((text: string) => text.trim()).filter(Boolean).join("；");
    throw new Error(detail
      ? `手动封面未发起上传：${detail}`
      : `手动封面未收到供应商上传响应，远端也未确认新封面：${String(error)}`);
  }
  const imageId = uploadedImageId(await response.json());
  if (!imageId) throw new Error("供应商上传接口未返回唯一、成功的图片 ID；请核查远端图片后重试。");
  await onUploaded?.(imageId);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const bound = await readBoundCoverImageIdsViaApi(page, productId);
    if (bound.includes(imageId) && bound.length === 1) return { imageId, reused: false };
    if (attempt < 9) await delay(500);
  }
  throw new Error(`手动图片已上传（imageId=${imageId}），但远端回读未确认其为唯一封面，请人工核查。`);
}
