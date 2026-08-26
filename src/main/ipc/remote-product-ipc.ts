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
  ipcMain.handle("products:list", () => listRemoteProducts(remoteProducts));
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
    broadcastProduct(created.product);
    return created.product;
  });
  ipcMain.handle("products:get", (_event, id: string) => getProductForRead(
    db,
    remoteProducts,
    id,
    context.productWorkflows.activeWorkflow(id),
  ));
  ipcMain.handle("products:delete", async (_event, id: string) => {
    const removed = await deleteRemoteProduct(db, remoteProducts, id);
    if (!removed) throw productNotFound(id);
    return { deleted: true };
  });
}
