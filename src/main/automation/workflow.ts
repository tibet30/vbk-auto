// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";
import { ARTIFACTS_DIR } from "./constants.js";

export const PHASES = [
  "basic",
  "presentation",
  "itinerary",
  "package",
  "pricingInventory",
  "terms",
  "vehicleResource",
  "preflight",
];

export function buildAutomationPlan(
  product,
  { productId, from = "basic", through = "preflight" } = {},
) {
  const first = PHASES.indexOf(from);
  const last = PHASES.indexOf(through);
  if (first < 0) throw new Error(`未知起始阶段：${from}`);
  if (last < 0) throw new Error(`未知执行阶段：${through}`);
  if (first > last) throw new Error("起始阶段不能晚于结束阶段");
  return {
    productId: String(productId),
    supplierProductCode: product.basicInfo.supplierProductCode,
    phases: PHASES.slice(first, last + 1),
    safety: {
      commercialDataRequired: true,
      draftOnly: true,
      pricingAndInventory: true,
    },
  };
}

export class CheckpointStore {
  constructor(productId, artifactDir = ARTIFACTS_DIR) {
    this.productId = String(productId);
    this.file = path.resolve(artifactDir, "checkpoints", `product-${productId}.json`);
  }

  async load() {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { productId: this.productId, completed: {}, failures: [] };
    }
  }

  async save(checkpoint) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, `${JSON.stringify(checkpoint, null, 2)}\n`);
  }

  async complete(phase) {
    const checkpoint = await this.load();
    checkpoint.completed[phase] = new Date().toISOString();
    checkpoint.lastPhase = phase;
    delete checkpoint.lastError;
    await this.save(checkpoint);
  }

  async fail(phase, error, screenshot) {
    const checkpoint = await this.load();
    const failure = {
      phase,
      at: new Date().toISOString(),
      message: error.message,
      ...(screenshot ? { screenshot } : {}),
    };
    checkpoint.failures.push(failure);
    checkpoint.lastPhase = phase;
    checkpoint.lastError = failure;
    await this.save(checkpoint);
  }
}

export async function runResumableWorkflow({
  product,
  productId,
  from = "basic",
  through = "preflight",
  handlers,
  checkpointStore = new CheckpointStore(productId),
  force = false,
}) {
  const plan = buildAutomationPlan(product, { productId, from, through });
  const checkpoint = await checkpointStore.load();
  const executed = [];
  const skipped = [];

  for (const phase of plan.phases) {
    if (!force && checkpoint.completed[phase]) {
      skipped.push(phase);
      continue;
    }
    const handler = handlers[phase];
    if (!handler) throw new Error(`缺少阶段处理器：${phase}`);
    try {
      await handler();
      await checkpointStore.complete(phase);
      executed.push(phase);
    } catch (error) {
      await checkpointStore.fail(phase, error);
      throw new Error(`阶段 ${phase} 失败，已保存断点：${error.message}`, {
        cause: error,
      });
    }
  }
  return { plan, executed, skipped, checkpointFile: checkpointStore.file };
}
