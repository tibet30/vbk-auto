/**
 * Chromium profile 脏库清理
 * ==========================
 *
 * 背景：跨 Electron 大版本升级后，Chromium 在 partition 下写入的 ServiceWorker
 * （LevelDB）+ QuotaManager（SQLite）库容易出现 schema 不兼容；启动期 storage
 * service 会刷：
 *   - "Failed to delete the database"        （service_worker_storage.cc）
 *   - "Could not open the quota database, resetting."（quota_database.cc）
 *
 * 本文件只动这两个 DB 的具体路径：
 *   <userData>/Partitions/<partition>/Service Worker/{Database,ScriptCache,CacheStorage}
 *   <userData>/Partitions/<partition>/WebStorage/QuotaManager{,-journal,-wal,-shm}
 *
 * 业务数据（vbk-desktop.sqlite / ai-secrets.json / vbk-cookie-sessions.json /
 * app-auth-session.json 等）位于 userData 根目录，与 Partitions 子目录平级，绝不被动。
 *
 * renderer 不依赖 ServiceWorker / IndexedDB / Cache API（仅用 localStorage），
 * 因此这两类 DB 被清后 Chromium 重建出来的产物也是空的或可忽略；QuotaManager 仅记
 * 录各 partition 的磁盘配额水位，被清后 Chromium 会在启动期重新计算，不影响业务。
 */
import fs from "node:fs";
import path from "node:path";

import { logLog, logWarn } from "../../shared/log-timestamp.js";

/**
 * QuotaManager SQLite 周边文件名匹配：精确只动这一族文件，
 * 不碰同目录下的其它 storage（例如 IndexedDB / WebSQL / CacheStorage 等）。
 */
const QUOTA_MANAGER_FILE_PATTERN = /^QuotaManager(-journal|-wal|-shm)?$/;

function safeRemove(target: string, options: { recursive: boolean }): void {
  try {
    if (!fs.existsSync(target)) return;
    fs.rmSync(target, { recursive: options.recursive, force: true });
  } catch (error) {
    logWarn("[startup] failed to clear stale chromium profile db", {
      path: target,
      message: (error as { message?: string })?.message ?? "unknown",
    });
  }
}

/**
 * 清理单个 partition 下的 ServiceWorker 与 QuotaManager 脏库。
 * 任何一步失败仅 warn、不抛出，避免阻塞主进程 bootstrap。
 */
function cleanPartition(partition: string, partitionRoot: string): void {
  const swDir = path.join(partitionRoot, "Service Worker");
  if (fs.existsSync(swDir)) {
    safeRemove(swDir, { recursive: true });
    logLog("[startup] cleared stale Service Worker db", { partition });
  }

  const webStorage = path.join(partitionRoot, "WebStorage");
  if (!fs.existsSync(webStorage)) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(webStorage);
  } catch (error) {
    logWarn("[startup] failed to enumerate WebStorage", {
      partition,
      message: (error as { message?: string })?.message ?? "unknown",
    });
    return;
  }
  let cleared = false;
  for (const name of entries) {
    if (!QUOTA_MANAGER_FILE_PATTERN.test(name)) continue;
    safeRemove(path.join(webStorage, name), { recursive: false });
    cleared = true;
  }
  if (cleared) logLog("[startup] cleared stale QuotaManager db", { partition });
}

/**
 * 启动期清理入口。必须在 BrowserWindow 创建之前调用，避免 storage service
 * 已经尝试打开这些库。
 */
export function cleanStaleChromiumProfileDb(userData: string): void {
  const partitionsDir = path.join(userData, "Partitions");
  let entries: string[];
  try {
    if (!fs.existsSync(partitionsDir)) return;
    entries = fs.readdirSync(partitionsDir);
  } catch (error) {
    logWarn("[startup] failed to enumerate Partitions dir", {
      path: partitionsDir,
      message: (error as { message?: string })?.message ?? "unknown",
    });
    return;
  }
  for (const partition of entries) {
    const partitionRoot = path.join(partitionsDir, partition);
    try {
      if (!fs.statSync(partitionRoot).isDirectory()) continue;
    } catch {
      continue;
    }
    cleanPartition(partition, partitionRoot);
  }
}