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
import { agentWorkflowPatch } from "./agent/integration-workflow.js";
import { mergeAgentDiagnostics } from "./application/product-diagnostics.js";
import { createRemoteProductMirror } from "./application/remote-product-mirror.js";
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
 * 返回的 `installProductEmitter(replacement)` 让 main.ts bootstrap 把
 * productEmitter 替换成 mirrorProduct 链（mirror 远端 + 本地 observer）。
 */
export function createMainEventBroadcasters(deps: MainEventDeps) {
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
    const completedTask = db?.completeWorkflowTaskForProduct(product);
    if (completedTask) emitWorkflowTask(completedTask);
    // 任务可能已被 products:get / workflowTasks:list 等读取路径提前收敛为成功，
    // 此时 completedTask 会是 undefined，不能再依赖单独的 task event 刷新详情页。
    // 对已保存草稿，把本机权威任务快照原子地附在 product:updated 上，避免详情页
    // 因事件先后或订阅时机继续显示旧的失败 / 等待状态。
    const workflowTask = product.status === "draft_saved" && product.productId
      ? db?.latestWorkflowTaskForProduct(product.id)
      : undefined;
    const nextProduct = workflowTask ? { ...product, workflowTask } : product;
    safeRendererSend(window, "product:updated", nextProduct);
  };

  let productEmitter: (product: ProductDetail) => void = broadcastProduct;
  const emitProduct = (product: ProductDetail) => productEmitter(product);

  const emitPlanningState = (state: PlanningGenerationState) => {
    // 状态已落库；renderer 重建期间由 planning:state 读取路径补偿。
    const window = deps.getWindow() ?? undefined;
    safeRendererSend(window, "planning:updated", state.localProductId, state);
  };

  const emitWorkflowTask = (task: ProductWorkflowTask, notify = true) => {
    const window = deps.getWindow() ?? undefined;
    const attention = notify ? workflowAttentionNotification(task) : null;
    if (deps.getSettings().systemNotificationsEnabled && attention) {
      void deliverWorkflowAttention(task.id, { ...attention, title: `${APP_NAME} · ${attention.title}` });
    }
    // 任务已持久化；窗口恢复后 workflowTasks:list 会补偿事件丢失。
    safeRendererSend(window, "workflow-task:updated", task);
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
      let task = db?.latestWorkflowTaskForProduct(snapshot.localProductId);
      const product = db?.getProduct(snapshot.localProductId);
      if (product && (!task || (['abandoned', 'succeeded', 'failed', 'cancelled'].includes(task.status)
        && snapshot.run.createdAt > task.updatedAt))) {
        if (!db) return;
        task = db.createWorkflowTask(product.id, product.name);
      }
      if (task && (task.status !== "abandoned" || snapshot.run.status === "abandoned") && db && product) {
        emitWorkflowTask(db.updateWorkflowTask(task.id, agentWorkflowPatch(snapshot, product)), false);
      }
      const latestProduct = db?.getProduct(snapshot.localProductId);
      if (latestProduct && db) {
        db.updateProduct(
          latestProduct.id,
          mergeAgentDiagnostics(latestProduct, snapshot),
          latestProduct.status,
          latestProduct.productJsonVersion,
        );
        const saved = db.getProduct(latestProduct.id);
        if (saved) emitProduct(saved);
      }
    }
    safeRendererSend(window, "agent:updated", agentDisplaySnapshot(snapshot));
  };

  /**
   * bootstrap 完成后调用：把 productEmitter 替换成 productStorage.observe + remoteMirror。
   * 注意：必须在 productStorage / browser / db 全部就绪后再调用。
   */
  function installProductEmitter(): void {
    const db = deps.getDb();
    const productStorage = deps.getProductStorage();
    const productWorkflows = deps.getProductWorkflows();
    const browser = (deps as unknown as { getBrowser?: () => unknown }).getBrowser?.();
    if (!db || !productStorage || !productWorkflows) return;
    const mirror = createRemoteProductMirror({
      remote: productStorage.products,
      broadcast: broadcastProduct,
      isWorkflowActive: (productId) => Boolean(productWorkflows.activeWorkflow(productId)),
      shouldBroadcastWhileActive: (productId) =>
        productWorkflows.activeWorkflow(productId) === "automation"
        || Boolean(db.getAgentSnapshot(productId)?.run),
    }).emit;
    productEmitter = (product) => {
      productStorage.observe(product);
      mirror(product);
    };
    void browser;
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
