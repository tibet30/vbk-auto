/**
 * 单阶段重试启动前的产品数据门槛。
 *
 * 这类确定性 JSON 缺口不应进入 Playwright/recovery 循环，否则 UI 只会看到
 * “已停止，等待处理”，而真正需要补的字段被埋在 recovery attempt 里。
 */

import { parseProduct } from "../schema/schema.js";

type Product = ReturnType<typeof parseProduct>;

export function assertSinglePhaseRetryPrerequisites(product: Product, phase: string) {
  if (phase !== "pricingInventory") return;

  const missing: string[] = [];
  if (!product.commercial?.pricing) missing.push("commercial.pricing（套餐定价）");
  if (!product.commercial?.inventory) missing.push("commercial.inventory（班期库存）");
  if (!missing.length) return;

  throw new Error(
    `价格库存班期缺少 ${missing.join("、")}，请先在审查面板填写${
      missing.some((item) => item.includes("pricing")) ? "「套餐定价」" : ""
    }${
      missing.length === 2 ? "和" : ""
    }${
      missing.some((item) => item.includes("inventory")) ? "「班期库存」的开始日期、结束日期、每日配额" : ""
    }后再重试。`,
  );
}
