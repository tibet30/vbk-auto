/**
 * 三人同游平台参考的 IPC（只读）。
 *
 * 用途：产品审查面板里的「平台在售参考」卡片——按本地产品标题与城市，在平台在售目录里
 * 找可能对应的服务并给出起价对比。
 *
 * 边界：
 *  - 只读：不写产品、不改状态机，结果不参与程序检查与运营确认；
 *  - 输入只有 `productId`，产品事实从本机产品库读取，渲染进程不能顺手指定任意查询；
 *  - 失败按类型如实返回（未配置 / 预检拒绝 / 网络故障），由界面显示，不静默成空列表。
 */

import { assertTrustedSender, secureIpcMain as ipcMain } from "../infrastructure/ipc-sender.js";
import { createTibetServiceClient } from "../infrastructure/tibet-service-client.js";
import { buildPlatformReference } from "../infrastructure/tibet-platform-reference.js";
import { platformReferenceInputOf } from "../agent-workspace/tibet-adapter.js";
import type { MainIpcContext } from "./context.js";

export function registerTibetIpc(context: MainIpcContext): void {
  ipcMain.handle("tibet:platformReference", async (event, productId: unknown) => {
    assertTrustedSender(event, "tibet:platformReference");
    if (typeof productId !== "string" || !productId.trim()) throw new Error("缺少产品 id。");
    const record = context.db.getProduct(productId.trim());
    if (!record) throw new Error(`本地产品不存在：${productId}`);
    const client = createTibetServiceClient({
      token: () => context.tibetServiceTokens?.get() ?? null,
    });
    const result = await buildPlatformReference(client, platformReferenceInputOf(record));
    return {
      configured: result.configured,
      query: result.query,
      matches: result.matches,
      message: result.message,
    };
  });

  /** 面板用的轻量状态：只读本地与身份，不发网络请求。 */
  ipcMain.handle("tibet:status", async (event) => {
    assertTrustedSender(event, "tibet:status");
    const store = context.tibetServiceTokens;
    if (!store) return { configured: false, source: null, maskedToken: null, message: "服务令牌存储尚未就绪。" };
    const state = store.state();
    return {
      configured: state.configured,
      source: state.source,
      maskedToken: state.maskedToken,
      message: state.configured ? "已配置服务令牌。" : "未配置服务令牌，平台参考不可用。",
    };
  });
}
