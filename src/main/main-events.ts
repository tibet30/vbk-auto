/**
 * main 进程向 renderer 广播的事件：
 *   - product:updated
 *   - planning:updated
 *   - workflow-task:updated
 *   - agent:updated
 *
 * 通过 `createMainEventBroadcasters(deps)` 工厂构造，让 main.ts 不必直接
 * 暴露这一堆 emit 函数；deps 用 getter 反映 main.ts 模块级延迟初始化的
 * db / browser / window / getSettings() 等。
 */

import type { BrowserWindow } from "electron";
import { withAgentUsage } from "./agent/integration-usage.js";
import type { ProductWorkflowCoordinator } from "./application/product-workflow-coordinator.js";
import { safeRendererSend } from "./infrastructure/renderer-send.js";
import { workflowAttentionNotification } from "./infrastructure/workflow-attention-notification.js";
import { agentAttentionNotification } from "./infrastructure/agent-attention-notification.js";
import { createAttentionNotificationDelivery } from "./infrastructure/attention-notification-delivery.js";
import { showSystemNotification, systemNotificationsSupported } from "./infrastructure/system-notifications.js";
import { createProductStorage } from "./application/product-storage.js";
import { APP_NAME } from "../shared/brand.js";
import type {
  AgentSnapshot,
  PlanningGenerationState,
  ProductDetail,
  ProductWorkflowTask,
  Settings,
} from "../shared/contracts.js";
import { agentDisplaySnapshot } from "../shared/agent-display.js";
import type { VbkDatabase } from "./infrastructure/database/database.js";
import { logWarn } from "../shared/log-timestamp.js";
import { readProductWorkspaceSnapshot } from './application/product-workspace-snapshot.js';
import { evaluateMainReadiness } from './main-runtime.js';

export interface MainEventDeps {
  getWindow: () => BrowserWindow | null;
  getDb: () => VbkDatabase | null;
  getSettings: () => Settings;
  getProductStorage: () => ReturnType<typeof createProductStorage> | null;
  getProductWorkflows: () => ProductWorkflowCoordinator | null;
}

/**
 * 构造 4 个 emit 函数 + 1 个 broadcastProduct + 1 个 emitProduct 转发器：
 *   - broadcastProduct / emitProduct：产品更新广播
 *   - emitPlanningState：规划状态广播
 *   - emitWorkflowTask：workflow 任务广播（含系统通知）
 *   - emitAgentSnapshot：agent snapshot 广播（含系统通知 + product 更新）
 *
 * `installProductEmitter()` 保留 bootstrap 兼容入口，广播只读持久化投影。
 */
export function createMainEventBroadcasters(deps: MainEventDeps) {
  const emitWorkspace = (id: string) => {
    const db = deps.getDb();
    if (!db?.readLocalProductState(id)?.ownerUserId) return;
    safeRendererSend(deps.getWindow() ?? undefined, 'workspace:updated',
      readProductWorkspaceSnapshot(db, id, productId => evaluateMainReadiness(db, productId)));
  };
  const deliverAgentAttention = createAttentionNotificationDelivery({
    supported: systemNotificationsSupported,
    show: showSystemNotification,
    onFailure: (message) => logWarn("[agent] system notification failed", { message }),
  });
  const deliverWorkflowAttention = createAttentionNotificationDelivery({
    supported: systemNotificationsSupported,
    show: showSystemNotification,
    onFailure: (message) => logWarn("[workflow] system notification failed", { message }),
  });

  const broadcastProduct = (product: ProductDetail) => {
    const db = deps.getDb();
    const window = deps.getWindow() ?? undefined;
    product = withAgentUsage(product, db?.getAgentSnapshot(product.id));
    // 兼容事件携带同一持久化任务投影；查询与广播不修改执行事实。
    const workflowTask = product.status === "draft_saved" && product.productId
      ? db?.latestWorkflowTaskForProduct(product.id)
      : undefined;
    const nextProduct = workflowTask ? { ...product, workflowTask } : product;
    safeRendererSend(window, "product:updated", nextProduct);
    emitWorkspace(product.id);
  };

  let productEmitter: (product: ProductDetail) => void = broadcastProduct;
  const emitProduct = (product: ProductDetail) => productEmitter(product);

  const emitPlanningState = (state: PlanningGenerationState) => {
    // 状态已落库；renderer 重建期间由 planning:state 读取路径补偿。
    const window = deps.getWindow() ?? undefined;
    safeRendererSend(window, "planning:updated", state.localProductId, state);
    emitWorkspace(state.localProductId);
  };

  const emitWorkflowTask = (task: ProductWorkflowTask, notify = true) => {
    const window = deps.getWindow() ?? undefined;
    const attention = notify ? workflowAttentionNotification(task) : null;
    if (deps.getSettings().systemNotificationsEnabled && attention) {
      void deliverWorkflowAttention(task.id, { ...attention, title: `${APP_NAME} · ${attention.title}` });
    }
    // 任务已持久化；窗口恢复后 workflowTasks:list 会补偿事件丢失。
    safeRendererSend(window, "workflow-task:updated", task);
    emitWorkspace(task.localProductId);
  };

  const emitAgentSnapshot = (snapshot: AgentSnapshot) => {
    const db = deps.getDb();
    const window = deps.getWindow() ?? undefined;
    const productName = db?.getProduct(snapshot.localProductId)?.name ?? "方案";
    const attention = agentAttentionNotification(snapshot, productName);
    if (deps.getSettings().systemNotificationsEnabled && attention) {
      void deliverAgentAttention(snapshot.localProductId, { ...attention, title: `${APP_NAME} · ${attention.title}` });
    }
    if (snapshot.run) {
      const task = db?.latestWorkflowTaskForProduct(snapshot.localProductId);
      if (task) emitWorkflowTask(task, false);
      const latestProduct = db?.getProduct(snapshot.localProductId);
      if (latestProduct) emitProduct(latestProduct);
    }
    safeRendererSend(window, "agent:updated", agentDisplaySnapshot(snapshot));
    emitWorkspace(snapshot.localProductId);
  };

  /**
   * bootstrap 完成后安装兼容转发器；观察与写入发生在提交边界。
   */
  function installProductEmitter(): void {
    productEmitter = broadcastProduct;
  }

  function emitProductIfKnown(_accountName: string, _info: unknown): void {
    // Reserved for future account-fixed-info renderer notifications.
  }

  return {
    broadcastProduct,
    emitProduct,
    emitPlanningState,
    emitWorkflowTask,
    emitAgentSnapshot,
    emitProductIfKnown,
    installProductEmitter,
  };
}
