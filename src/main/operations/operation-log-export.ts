import fs from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";
import type { OperationLogExportResult, OperationLogQuery } from "../../shared/contracts.js";
import { loadOperationLog } from "./operation-log-store.js";
import { buildOperationLogCsv } from "./operation-log-csv.js";

export async function exportOperationLog(query: OperationLogQuery = {}): Promise<OperationLogExportResult> {
  const page = loadOperationLog({ ...query, limit: 10_000 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const focused = BrowserWindow.getFocusedWindow();
  const options = {
    title: "导出运行日志",
    defaultPath: path.join(app.getPath("downloads"), `VBK-Desktop-运行日志-${stamp}.csv`),
    filters: [{ name: "CSV 表格", extensions: ["csv"] }],
  };
  const result = focused ? await dialog.showSaveDialog(focused, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { canceled: true, count: 0 };
  await fs.writeFile(result.filePath, buildOperationLogCsv(page.entries), { encoding: "utf8", mode: 0o600 });
  await fs.chmod(result.filePath, 0o600);
  return { canceled: false, count: page.entries.length, path: result.filePath };
}

/**
 * 用系统默认应用打开刚导出的 CSV 日志文件（renderer 点击文件名时调用）。
 * - 只接受非空绝对路径，避免把任意字符串喂给 shell.openPath；
 * - shell.openPath 成功时 resolve 空串，失败时返回错误描述，这里转成抛错
 *   让 renderer 的 notice 直接展示本地化文案。
 */
export async function openOperationLogFile(filePath: unknown): Promise<void> {
  if (typeof filePath !== "string" || !filePath.trim() || !path.isAbsolute(filePath)) {
    throw new Error("没有可打开的日志文件。");
  }
  const errorMessage = await shell.openPath(filePath);
  if (errorMessage) throw new Error(errorMessage);
}
