/**
 * DraftAutomation lifecycle 守卫：
 *   - canRestartPreWriteAuthorizationFailure：write guard 前配置失败时允许
 *     从 saleControl 重跑；其它失败状态仍走权威核查。
 *   - canRestartPreWriteShellFailure：创建产品壳的写请求根本没发出时，允许
 *     重新创建；一旦发出过创建请求，就必须先核查远端，禁止自动重复创建。
 *
 * 把这条独立工具从主类文件里抽出来，避免类文件被夹塞零碎决策逻辑。
 */

import type { AutomationRun } from "../../../../shared/contracts.js";

const PRE_WRITE_AUTHORIZATION_FAILURES = new Set([
  "当前任务未处于可录入状态。",
  "方案、意图或账号已变化，请重新确认后录入。",
]);

/** 写请求发出前落盘的意图标记；存在即代表“远端可能已经创建”。 */
export const SALE_CONTROL_CREATE_INTENT = "已发出 VBK 销售控制创建请求（未取得产品编号前不能重复创建）";
/**
 * 本版本开始创建前写入的起点标记。只有带这个标记的记录才会在发出请求前落
 * SALE_CONTROL_CREATE_INTENT；升级前的旧记录没有它，缺少意图标记不代表请求未发出。
 */
export const SALE_CONTROL_CREATE_TRACKED = "正在创建 VBK 产品草稿（已启用创建请求追踪）…";

export function canRestartPreWriteAuthorizationFailure(
  run: AutomationRun | undefined,
  productId: string | null | undefined,
): boolean {
  return Boolean(
    run?.status === "failed"
      && !productId
      && run.currentPhase === "saleControl"
      && run.phases.every((phase: { status: string }) => phase.status === "pending")
      && run.logs.some((entry: { message: string }) => PRE_WRITE_AUTHORIZATION_FAILURES.has(entry.message)),
  );
}

/**
 * 创建调用之前的失败（业务线查询、合同匹配、品牌解析等）没有远端副作用，
 * 必须能直接重跑；只有创建请求发出后失联才需要人工核查草稿编号。
 */
export function canRestartPreWriteShellFailure(
  run: AutomationRun | undefined,
  productId: string | null | undefined,
): boolean {
  return Boolean(
    run?.status === "failed"
      && !productId
      && run.currentPhase === "saleControl"
      && run.phases.every((phase: { status: string }) => phase.status === "pending")
      // 旧记录无法证明请求未发出，必须继续走权威核查，不能据此重复创建。
      && run.logs.some((entry: { message: string }) => entry.message === SALE_CONTROL_CREATE_TRACKED)
      && !run.logs.some((entry: { message: string }) => entry.message === SALE_CONTROL_CREATE_INTENT),
  );
}
