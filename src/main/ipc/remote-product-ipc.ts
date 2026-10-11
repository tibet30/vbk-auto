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
import { readProductWorkspaceSnapshot } from '../application/product-workspace-snapshot.js';

export function registerRemoteProductIpc(context: MainIpcContext): void {
  const { db, broadcastProduct, remoteProducts } = context;
  ipcMain.handle('workspace:get', (_event, id: string) => {
    const owner = context.getExtensionUserId();
    if (!owner || db.readLocalProductState(id)?.ownerUserId !== owner) throw productNotFound(id);
    const snapshot = readProductWorkspaceSnapshot(db, id, context.readiness);
    return snapshot;
  });
  ipcMain.handle("products:list", async () => {
    const products = await listRemoteProducts(remoteProducts);
    const workflowTasks = products.map((product) => {
      return db.latestWorkflowTaskForProduct(product.id);
    });
    const executionTimes = db.getProductExecutionTimes(products.map((product) => product.id));
    return products.map((product, index) => {
      const workflowTask = workflowTasks[index];
      return {
        ...product,
        executionTime: executionTimes[product.id],
        ...(workflowTask ? {
          workflowTask,
          updatedAt: Date.parse(workflowTask.updatedAt) > Date.parse(product.updatedAt)
            ? workflowTask.updatedAt
            : product.updatedAt,
        } : {}),
      };
    });
  });
  ipcMain.handle("products:executionTimes", (_event, ids: string[]) => {
    if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== "string" || !id.trim())) {
      throw new Error("耗时查询必须提供不超过 100 个产品 ID。");
    }
    return db.getProductExecutionTimes(ids);
  });
  ipcMain.handle("workflowTasks:list", () => {
    return db.listWorkflowTasks();
  });
  ipcMain.handle("workflowTasks:get", (_event, id: string) => {
    const task = db.getWorkflowTask(id);
    if (!task) throw new Error(`后台任务不存在：${id}`);
    return task;
  });
  ipcMain.handle("workflowTasks:abandon", async (_event, id: string) => {
    if (!context.abandonProductTask) throw new Error("后台任务服务尚未就绪，请重启应用后重试。");
    const task = db.getWorkflowTask(id);
    if (!task) throw new Error(`后台任务不存在：${id}`);
    const abandoned = await context.abandonProductTask(id);
    return abandoned;
  });
  ipcMain.handle("workflowTasks:resume", async (_event, id: string, mode: "from_error" | "from_start") => {
    if (!context.resumeProductTask) throw new Error("后台任务服务尚未就绪，请重启应用后重试。");
    return context.resumeProductTask(id, mode);
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
    const agent = db.getAgentSnapshot(id);
    const agentOwnsLocalWorkingSet = Boolean(agent?.run && !["completed", "abandoned"].includes(agent.run.status));
    const product = withAgentUsage(await getProductForRead(
      db,
      remoteProducts,
      id,
      agentOwnsLocalWorkingSet ? "planning" : context.productWorkflows.activeWorkflow(id),
    ), agent);
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
