/**
 * 全部业务阶段成功后的 best-effort 截图。失败写 warning、把 run.screenshot
 * 置为 undefined（避免 stale 路径被误用），绝不抛错 —— 让外层 try/catch
 * 看不到这个错误，业务成功状态（succeeded / draft_saved）不被覆盖。
 *
 * 历史 bug：以前内联 `run.screenshot = await saveScreenshot(...)`，当 page
 * width=0 / page 已 detach 时抛错进 catch，把整条 run 误标为 failed/blocked。
 */

import type { AutomationRun } from "../../../shared/contracts.js";

export async function finalizeRunWithScreenshot(
  run: AutomationRun,
  saveScreenshot: (page: unknown, prefix: string, productId: string) => Promise<string>,
  productId: string,
  page: unknown,
  log: (message: string, level?: "info" | "warning" | "error") => void,
): Promise<void> {
  try {
    run.screenshot = await saveScreenshot(page, "desktop-draft", productId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`收尾截图失败：${message}（业务已完成，run 状态不受影响）`, "warning");
    run.screenshot = undefined;
  }
}
