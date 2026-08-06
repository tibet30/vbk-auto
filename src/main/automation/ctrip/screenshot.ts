// @ts-nocheck

import fs from "node:fs/promises";
import path from "node:path";
import { ARTIFACTS_DIR } from "../constants.js";

export async function saveScreenshot(page, prefix, productId = "preview") {
  const artifactDir = path.resolve(ARTIFACTS_DIR);
  await fs.mkdir(artifactDir, { recursive: true });
  const filename = `${prefix}-${productId}-${Date.now()}.png`;
  const target = path.join(artifactDir, filename);
  await page.screenshot({ path: target, fullPage: false });
  return target;
}

