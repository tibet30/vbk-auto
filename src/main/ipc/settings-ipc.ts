import { MiniMaxService } from "../minimax/minimax.js";
import type {
  AiConnectionTestInput,
  AiModelListInput,
  OperationLogQuery,
  Settings,
} from "../../shared/contracts.js";
import { isAiProvider } from "../../shared/contracts.js";
import {
  assertSafeAiServiceUrl,
  resolveAiConnectionInput,
  successfulAiConnectionTest,
} from "../infrastructure/ai-settings.js";
import { fetchAiModelList } from "../infrastructure/ai-models.js";
import { assertTrustedSender } from "../infrastructure/ipc-sender.js";
import { secureIpcMain as ipcMain } from "../infrastructure/ipc-sender.js";
import { loadOperationLog } from "../operations/operation-log-store.js";
import type { MainIpcContext } from "./context.js";

export function registerSettingsIpc(context: MainIpcContext): void {
  const { db, aiKeyStore, getSettings, apiKey, safeRemoveLegacyCiphertext } = context;
  ipcMain.handle("settings:get", () => getSettings());
  // settings:getApiKey 在新版本中是**故意的禁止**点：API Key 一旦写入
  // 永远不回到 renderer，UI 通过 getSettings().hasKey / hasDeepSeekKey
  // 感知到状态。如需走 AI，调用方应该走 settings:listModels / settings:test
  // 等受限入口。仍然保留 IPC 名称以让旧 renderer 抛错而不是白屏。
  ipcMain.handle("settings:getApiKey", (_event, provider: unknown) => {
    if (!isAiProvider(provider)) throw new Error("不支持的 AI 提供商。");
    throw new Error("API Key 不可从 renderer 读回，请通过 settings:save 覆盖或 settings:test 验证");
  });
  ipcMain.handle("settings:listModels", (event, input: AiModelListInput) => {
    assertTrustedSender(event, "settings:listModels");
    return fetchAiModelList(input, (provider) => apiKey(provider));
  });
  ipcMain.handle("settings:save", async (event, input: Partial<Settings> & { apiKey?: string; deepseekApiKey?: string }) => {
    assertTrustedSender(event, "settings:save");
    const provider = input.aiProvider;
    if (provider !== undefined && !isAiProvider(provider)) throw new Error("不支持的 AI 提供商。");

    const minimaxBaseUrl = input.minimaxBaseUrl?.trim();
    if (minimaxBaseUrl !== undefined) assertSafeAiServiceUrl(minimaxBaseUrl);
    const minimaxModel = input.minimaxModel?.trim();
    if (minimaxModel !== undefined && !minimaxModel) throw new Error("请填写 MiniMax 模型名。");
    const deepseekBaseUrl = input.deepseekBaseUrl?.trim();
    if (deepseekBaseUrl !== undefined) assertSafeAiServiceUrl(deepseekBaseUrl);
    const deepseekModel = input.deepseekModel?.trim();
    if (deepseekModel !== undefined && !deepseekModel) throw new Error("请选择 Evolink 模型。");

    // 「空值不覆盖」：trim 后是空字符串 / null / undefined 的字段一律不动。
    // 之前 `input.apiKey ?? ""` 把 undefined 视为空串，这与 {"apiKey":null}
    // 表现一样 —— 不会触发任何写入。
    const rawMiniMaxKey = input.apiKey;
    const rawDeepSeekKey = input.deepseekApiKey;
    const minimaxKey = typeof rawMiniMaxKey === "string" && rawMiniMaxKey.trim() ? rawMiniMaxKey.trim() : null;
    const deepseekKey = typeof rawDeepSeekKey === "string" && rawDeepSeekKey.trim() ? rawDeepSeekKey.trim() : null;
    // AI API keys live in the local 0600 JSON store, no longer routed
    // through Electron Keychain encryption. We intentionally do NOT
    // gate this IPC on any encryption-availability check anymore — the
    // old "macOS cannot encrypt" prompt is gone.
    if (!aiKeyStore) throw new Error("AI 密钥存储尚未就绪，请稍后重试。");
    if (provider === "minimax" && !minimaxKey && !aiKeyStore.hasKey("minimax")) throw new Error("请填写 MiniMax API Key。");
    if (provider === "deepseek" && !deepseekKey && !aiKeyStore.hasKey("deepseek")) throw new Error("请填写 Evolink API Key。");

    // 写库：SQLite 与本地 JSON 文件跨介质，不能在事务里原子提交。
    // 写入顺序为 baseUrl/model/provider（旧 → 新）→ aiKeyStore.setKey
    // （temp+rename）→ safeRemoveLegacyCiphertext。任一步骤抛错都会
    // 直接重抛给 IPC 层，使 renderer 看到失败并可重试；由于 aiProvider
    // 字段最后写，前面任一字段校验失败时不会留下半切换状态。
    // 已知不一致窗口：db.setSetting("minimaxBaseUrl", ...) 已成功但
    // aiKeyStore.setKey 抛错（磁盘满等）时，SQLite 与 JSON 处于不一致
    // 态。但 AI 调用方先读 JSON、再读 SQLite ，不会出现"已配 hasKey 但
    // 请求 baseUrl 还没更新"的危险中间态；恢复路径是用户再次保存。
    try {
      if (minimaxBaseUrl !== undefined) db.setSetting("minimaxBaseUrl", minimaxBaseUrl);
      if (minimaxModel !== undefined) db.setSetting("minimaxModel", minimaxModel);
      if (minimaxKey) {
        aiKeyStore.setKey("minimax", minimaxKey);
        // Legacy SQLite ciphertext is now meaningless and must NEVER be
        // read again (it can't be decrypted after the old encryption row
        // was lost). Remove that provider's row in the settings table so
        // the DB stops pretending it has a configured key.
        safeRemoveLegacyCiphertext(db, "minimaxApiKey");
      }
      if (deepseekBaseUrl !== undefined) db.setSetting("deepseekBaseUrl", deepseekBaseUrl);
      if (deepseekModel !== undefined) db.setSetting("deepseekModel", deepseekModel);
      if (deepseekKey) {
        aiKeyStore.setKey("deepseek", deepseekKey);
        safeRemoveLegacyCiphertext(db, "deepseekApiKey");
      }
      // 当前模型最后切换，避免前面任一字段校验失败时留下半切换状态。
      if (provider !== undefined) db.setSetting("aiProvider", provider);
    } catch (error) {
      // 任意字段失败时不能向前返回半截 settings；直接重抛给 IPC 层。
      throw error;
    }
    return getSettings();
  });
  ipcMain.handle("settings:test", async (_event, input: AiConnectionTestInput) => {
    const resolved = await resolveAiConnectionInput(input, (provider) => apiKey(provider));
    await new MiniMaxService(resolved).testConnection();
    return successfulAiConnectionTest(resolved);
  });
  // 读取自动化操作历史。早期版本返回内存样例，等真实写入路径就绪后再
  // 改读持久化文件；查询语义保持一致以免上层调用方重写。
  ipcMain.handle("operationLog:load", (event, query?: OperationLogQuery) => {
    assertTrustedSender(event, "operationLog:load");
    return loadOperationLog(query);
  });

  // 规划子系统接线：preflight + runPlan + 产品状态同步。所有 plan 层逻辑
}
