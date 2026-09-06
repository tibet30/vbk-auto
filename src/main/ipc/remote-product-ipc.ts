import { logInfo } from "../../shared/log-timestamp.js";
import type { CreateProductInput } from "../../shared/contracts.js";
import {
  createRemoteProduct,
  deleteRemoteProduct,
  getProductForRead,
  listRemoteProducts,
} from "../application/remote-product-workflows.js";
import { productNotFound } from "../infrastructure/db-errors.js";
import { secureIpcMain as ipcMain } from "../infrastructure/ipc-sender.js";
import { assertCreatePreconditions } from "../operations/product-create-guard.js";
import { withAgentUsage } from "../agent/integration-usage.js";
import type { MainIpcContext } from "./context.js";

export function registerRemoteProductIpc(context: MainIpcContext): void {
  const { db, broadcastProduct, remoteProducts } = context;
  ipcMain.handle("products:list", async () => (await listRemoteProducts(remoteProducts)).map((product) => {
    db.completeWorkflowTaskForProduct(product);
    const workflowTask = db.latestWorkflowTaskForProduct(product.id);
    return {
      ...product,
      ...(workflowTask ? {
        workflowTask,
        updatedAt: Date.parse(workflowTask.updatedAt) > Date.parse(product.updatedAt)
          ? workflowTask.updatedAt
          : product.updatedAt,
      } : {}),
    };
  }));
  ipcMain.handle("workflowTasks:list", () => {
    db.completeSavedProductWorkflowTasks();
    return db.listWorkflowTasks();
  });
  ipcMain.handle("workflowTasks:get", (_event, id: string) => {
    let task = db.getWorkflowTask(id);
    if (!task) throw new Error(`后台任务不存在：${id}`);
    const product = db.getProduct(task.localProductId);
    if (product) {
      db.completeWorkflowTaskForProduct(product);
      task = db.getWorkflowTask(id)!;
    }
    return task;
  });
  ipcMain.handle("workflowTasks:abandon", async (_event, id: string) => {
    if (!context.abandonProductTask) throw new Error("后台任务服务尚未就绪，请重启应用后重试。");
    const task = db.getWorkflowTask(id);
    if (!task) throw new Error(`后台任务不存在：${id}`);
    const abandoned = await context.abandonProductTask(id);
    await context.agentCore?.abandon(task.localProductId);
    return abandoned;
  });
  ipcMain.handle("workflowTasks:resume", async (_event, id: string, mode: "from_error" | "from_start") => {
    const task = db.getWorkflowTask(id);
    if (!task) throw new Error("后台任务不存在。");
    if (task.status === "abandoned") throw new Error("已永久废弃的任务不能重新执行。");
    if (task.status !== "needs_attention" && task.status !== "failed") {
      throw new Error("只有需要处理或执行失败的任务可以重新执行。");
    }
    const product = db.getProduct(task.localProductId);
    if (mode === "from_start" && product?.productId) {
      throw new Error("产品已进入 VBK 录入，不能从头重新规划；请从当前录入阶段继续，或另建新产品。");
    }
    // One-click scheduler planning callbacks are retired. All recovery goes
    // through the durable Agent loop (resume active run, or send a continue /
    // restart intent when no active run remains).
    if (!context.agentCore) throw new Error("Agent 服务尚未就绪，请重启应用后重试。");
    const agentSnapshot = await context.agentCore.get(task.localProductId);
    if (agentSnapshot.run && !["completed", "abandoned"].includes(agentSnapshot.run.status)) {
      if (mode === "from_start") {
        throw new Error("当前产品由 Agent 管理，请在对话中明确要求从头重新规划；不能通过旧任务入口重置。");
      }
      const resumed = await context.agentCore.resume(task.localProductId);
      context.emitAgentSnapshot?.(resumed);
      return context.db.getWorkflowTask(id) ?? task;
    }
    if (mode === "from_start") {
      const restarted = await context.agentCore.send(
        task.localProductId,
        "请基于当前产品从头重新规划。先读取产品和必要资源；有写入前请求明确审批。",
      );
      context.emitAgentSnapshot?.(restarted);
      return context.db.getWorkflowTask(id) ?? task;
    }
    const continued = await context.agentCore.send(
      task.localProductId,
      "请继续当前产品规划与录入。先读取已有状态，不要重置或重复已验证内容。",
    );
    context.emitAgentSnapshot?.(continued);
    return context.db.getWorkflowTask(id) ?? task;
  });
  ipcMain.handle("products:create", async (_event, input: CreateProductInput) => {
    const login = await context.productWorkflows.runVbkPageExclusive(() => context.browser.status(true));
    if (!login.loggedIn) {
      throw new Error(login.message || "无法创建产品：请先登录 VBK。");
    }
    const accountName = login.accountName?.trim() || login.loginAccount?.trim() || null;
    const vbkAccount = login.loginAccount?.trim() || accountName;
    if (!accountName) throw new Error("无法创建产品：未能识别当前 VBK 账号，请重新登录后再试。");
    // 账号设置的固定信息按真实 vbk_* 登录账号分区保存；accountName 可能只是页面展示名。
    // 创建前置校验必须使用同一个 canonical key，否则设置页显示已配置、创建却会读到空分区。
    assertCreatePreconditions(db, vbkAccount);
    db.setSetting("vbkAccountName", accountName);
    const created = await createRemoteProduct(db, remoteProducts, input, vbkAccount, vbkAccount);
    if (created.injected) {
      logInfo("[createProduct] auto-injected butler from current account", {
        localProductId: created.product.id,
        accountName,
      });
    } else if (created.injectReason) {
      logInfo("[createProduct] butler not auto-injected", {
        localProductId: created.product.id,
        reason: created.injectReason,
      });
    }
    const initialProduct = db.getProduct(created.product.id) ?? created.product;
    // Every product starts one durable Agent run. The task-center record must be
    // created first so the first Agent snapshot can advance that same task.
    db.createWorkflowTask(initialProduct.id, initialProduct.name);
    if (!context.agentCore) throw new Error("Agent 服务尚未就绪，请重启应用后重试。");
    const snapshot = await context.agentCore.send(initialProduct.id,
      "请读取刚创建的产品和用户要求，完成本地规划与资源核验；任何 VBK 写入都必须先请求明确审批。");
    context.emitAgentSnapshot?.(snapshot);
    broadcastProduct(initialProduct);
    return { ...initialProduct, workflowTask: db.latestWorkflowTaskForProduct(initialProduct.id) };
  });
  ipcMain.handle("products:get", async (_event, id: string) => {
    const agent = await context.agentCore?.get(id);
    const agentOwnsLocalWorkingSet = Boolean(agent?.run && !["completed", "abandoned"].includes(agent.run.status));
    const product = withAgentUsage(await getProductForRead(
      db,
      remoteProducts,
      id,
      agentOwnsLocalWorkingSet ? "planning" : context.productWorkflows.activeWorkflow(id),
    ), agent);
    db.completeWorkflowTaskForProduct(product);
    return {
      ...product,
      workflowTask: db.latestWorkflowTaskForProduct(id),
    };
  });
  ipcMain.handle("products:delete", async (_event, id: string) => {
    const removed = await deleteRemoteProduct(db, remoteProducts, id);
    if (!removed) throw productNotFound(id);
    return { deleted: true };
  });
}
