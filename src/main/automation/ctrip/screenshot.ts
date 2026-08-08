// @ts-nocheck
/**
 * 阶段失败 / 调试留档用的截图助手：saveScreenshot 把当前 page 拍到 ARTIFACTS_DIR，
 * 文件名 `${prefix}-${productId}-${timestamp}.png`。源码头部带 `// @ts-nocheck`，
 * 因为页面对象在阶段层是动态传入的。
 */


import fs from "node:fs/promises";
import path from "node:path";
import { ARTIFACTS_DIR } from "../constants.js";

/**
 * 把当前 page 截图为 PNG 并保存到 ARTIFACTS_DIR，文件名形如 `${prefix}-${productId}-${timestamp}.png`。
 * 用于在阶段失败 / 调试时留档，调用方拿到的是落盘后的绝对路径。
 */
export async function saveScreenshot(page, prefix, productId = "preview") {
  const artifactDir = path.resolve(ARTIFACTS_DIR);
  await fs.mkdir(artifactDir, { recursive: true });
  const filename = `${prefix}-${productId}-${Date.now()}.png`;
  const target = path.join(artifactDir, filename);
  await page.screenshot({ path: target, fullPage: false });
  return target;
}