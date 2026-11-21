import { MiniMaxService } from "../minimax/minimax.js";
import type {
  AiConnectionTestInput,
  AiModelListInput,
  OperationLogQuery,
  RuntimeLogCaptureInput,
  Settings,
} from "../../shared/contracts.js";
import { isAiProvider } from "../../shared/contracts.js";
import {
  assertSafeAiServiceUrl,
  resolveAiConnectionInput,
  successfulAiConnectionTest,
} from "../infrastructure/ai-settings.js";
import { fetchAiModelList } from "../infrastructure/ai-models.js";
import { describeTibetServiceToken } from "../infrastructure/tibet-service-token-status.js";
import { assertTrustedSender } from "../infrastructure/ipc-sender.js";
import { secureIpcMain as ipcMain } from "../infrastructure/ipc-sender.js";
import { captureRuntimeLog, loadOperationLog } from "../operations/operation-log-store.js";
import { exportOperationLog, openOperationLogFile } from "../operations/operation-log-export.js";
import { openSystemNotificationSettings, showSystemNotification } from "../infrastructure/system-notifications.js";
import { APP_NAME } from "../../shared/brand.js";
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
    if (input.systemNotificationsEnabled !== undefined && typeof input.systemNotificationsEnabled !== "boolean") {
      throw new Error("系统通知开关值无效。");
    }

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
    const rawDeepSeekKey = input.deepseekApiKey;
    const deepseekKey = typeof rawDeepSeekKey === "string" && rawDeepSeekKey.trim() ? rawDeepSeekKey.trim() : null;
    // AI API keys live in the local 0600 JSON store, no longer routed
    // through Electron Keychain encryption. We intentionally do NOT
    // gate this IPC on any encryption-availability check anymore — the
    // old "macOS cannot encrypt" prompt is gone.
    if (!aiKeyStore) throw new Error("AI 密钥存储尚未就绪，请稍后重试。");
    // 托管渠道下 MiniMax 走服务端网关登录态，本机不再保存或校验订阅密钥。
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
      // MiniMax 走网关登录态，遗留的 SQLite 密文行清掉，避免数据库继续假装配了密钥。
      if (provider === "minimax") safeRemoveLegacyCiphertext(db, "minimaxApiKey");
      if (deepseekBaseUrl !== undefined) db.setSetting("deepseekBaseUrl", deepseekBaseUrl);
      if (deepseekModel !== undefined) db.setSetting("deepseekModel", deepseekModel);
      if (deepseekKey) {
        aiKeyStore.setKey("deepseek", deepseekKey);
        safeRemoveLegacyCiphertext(db, "deepseekApiKey");
      }
      // 当前模型最后切换，避免前面任一字段校验失败时留下半切换状态。
      if (provider !== undefined) db.setSetting("aiProvider", provider);
      if (input.systemNotificationsEnabled !== undefined) {
        db.setSetting("systemNotificationsEnabled", String(input.systemNotificationsEnabled));
      }
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
  ipcMain.handle("settings:testNotification", async (event) => {
    assertTrustedSender(event, "settings:testNotification");
    if (!getSettings().systemNotificationsEnabled) {
      return { shown: false, message: "请先开启系统通知。" };
    }
    return await showSystemNotification({
      title: `${APP_NAME} · 系统通知测试`,
      body: "通知已开启。之后 AI 等待回复、等待确认或执行失败时，会在这里提醒你。",
    });
  });
  ipcMain.handle("settings:openNotificationSettings", async (event) => {
    assertTrustedSender(event, "settings:openNotificationSettings");
    await openSystemNotificationSettings();
  });

  // ---- 三人同游服务令牌（本地 0600 文件；明文永不回到 renderer） ----
  const requireTokenStore = () => {
    const store = context.tibetServiceTokens;
    if (!store) throw new Error("服务令牌存储尚未就绪，请稍后重试。");
    return store;
  };
  ipcMain.handle("settings:tibetServiceToken", async () => describeTibetServiceToken(requireTokenStore()));
  ipcMain.handle("settings:saveTibetServiceToken", async (event, token: unknown) => {
    assertTrustedSender(event, "settings:saveTibetServiceToken");
    if (typeof token !== "string") throw new Error("服务令牌必须是字符串。");
    const store = requireTokenStore();
    store.save(token);
    // 保存后立刻自检：把「存了但无效」当场暴露，而不是等智能体调用时才失败。
    return describeTibetServiceToken(store, { verify: true });
  });
  ipcMain.handle("settings:clearTibetServiceToken", async (event) => {
    assertTrustedSender(event, "settings:clearTibetServiceToken");
    const store = requireTokenStore();
    store.clear();
    return describeTibetServiceToken(store);
  });
  ipcMain.handle("settings:verifyTibetServiceToken", async (event) => {
    assertTrustedSender(event, "settings:verifyTibetServiceToken");
    return describeTibetServiceToken(requireTokenStore(), { verify: true });
  });
  // 读取自动化操作历史。早期版本返回内存样例，等真实写入路径就绪后再
  // 改读持久化文件；查询语义保持一致以免上层调用方重写。
  ipcMain.handle("operationLog:load", (event, query?: OperationLogQuery) => {
    assertTrustedSender(event, "operationLog:load");
    return loadOperationLog(query);
  });
  ipcMain.handle("operationLog:capture", (event, input: RuntimeLogCaptureInput) => {
    assertTrustedSender(event, "operationLog:capture");
    captureRuntimeLog(input);
  });
  ipcMain.handle("operationLog:export", (event, query?: OperationLogQuery) => {
    assertTrustedSender(event, "operationLog:export");
    return exportOperationLog(query);
  });
  ipcMain.handle("operationLog:open", (event, path?: unknown) => {
    assertTrustedSender(event, "operationLog:open");
    return openOperationLogFile(path);
  });

  // 规划子系统接线：preflight + runPlan + 产品状态同步。所有 plan 层逻辑
}
