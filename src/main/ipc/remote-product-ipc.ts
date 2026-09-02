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
  ipcMain.handle("workflowTasks:abandon", (_event, id: string) => {
    if (!context.abandonProductTask) throw new Error("后台任务服务尚未就绪，请重启应用后重试。");
    return context.abandonProductTask(id);
  });
  ipcMain.handle("workflowTasks:resume", (_event, id: string, mode: "from_error" | "from_start") => {
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
    if (input.autoConfirm) {
      if (!context.enqueueProductTask) throw new Error("后台任务服务尚未就绪，请重启应用后重试。");
      const workflowTask = context.enqueueProductTask(initialProduct);
      // 创建接口只返回已落库的产品和任务，不再等待规划与携程录入。
      broadcastProduct(initialProduct);
      return { ...initialProduct, workflowTask };
    }
    broadcastProduct(initialProduct);
    return initialProduct;
  });
  ipcMain.handle("products:get", async (_event, id: string) => {
    const product = await getProductForRead(
      db,
      remoteProducts,
      id,
      context.productWorkflows.activeWorkflow(id),
    );
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
