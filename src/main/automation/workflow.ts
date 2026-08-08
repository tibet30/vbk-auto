// @ts-nocheck
/**
 * 自动化阶段调度 + 断点持久化：
 *   - PHASES 枚举业务执行顺序（basic → preflight）；
 *   - buildAutomationPlan 按 from/through 截取子阶段并打 safety 标签；
 *   - CheckpointStore 把每个 product 的 completed / failures / lastError 写到 ARTIFACTS_DIR；
 *   - runResumableWorkflow 串行执行，断点未 force 时跳过已完成阶段，任一阶段失败会保存断点并抛出。
 *
 * 头部带 `// @ts-nocheck`，page 与 handler 的类型较松散。
 */

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

/**
 * 把「从 from 跑到 through（含）」的一段阶段构造成 plan：
 *   - 校验 from/through 是已知阶段，且 first ≤ last；
 *   - safety 标签里固定 draftOnly / commercialDataRequired / pricingAndInventory，由调用方按需用；
 *   - 返回 { productId, supplierProductCode, phases, safety }。
 */
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

/**
 * 单个 product 的断点存储：本质是一个 JSON 文件，内容包括 completed（每阶段完成时间）、
 * failures（失败列表）、lastPhase / lastError。checkpoint 文件路径在
 * `${ARTIFACTS_DIR}/checkpoints/product-${productId}.json`。
 */
export class CheckpointStore {
  constructor(productId, artifactDir = ARTIFACTS_DIR) {
    this.productId = String(productId);
    this.file = path.resolve(artifactDir, "checkpoints", `product-${productId}.json`);
  }

  /**
   * 从文件读断点 JSON；文件不存在则返回一份带 productId 的空壳结构。
   */
  async load() {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { productId: this.productId, completed: {}, failures: [] };
    }
  }

  /**
   * 把整个 checkpoint 对象写回文件，2-space JSON。
   */
  async save(checkpoint) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, `${JSON.stringify(checkpoint, null, 2)}\n`);
  }

  /**
   * 标记 phase 完成：写入完成时间、清掉 lastError，落盘。
   */
  async complete(phase) {
    const checkpoint = await this.load();
    checkpoint.completed[phase] = new Date().toISOString();
    checkpoint.lastPhase = phase;
    delete checkpoint.lastError;
    await this.save(checkpoint);
  }

  /**
   * 记录 phase 失败：追加 failures、刷新 lastPhase / lastError（若提供 screenshot 也一起存）。
   */
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

/**
 * 主调度器：
 *   - 用 buildAutomationPlan 生成阶段列表；
 *   - 默认非 force 跳过已完成阶段（断点续跑）；
 *   - 任一阶段失败：先写断点 fail(phase,error)，再抛「阶段 X 失败，已保存断点」让上层走 advisor。
 *   - 返回 { plan, executed, skipped, checkpointFile } 用于日志 / UI 展示。
 */
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