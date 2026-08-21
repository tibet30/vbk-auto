import { logInfo } from "../../shared/log-timestamp.js";
import type { CreateProductInput } from "../../shared/contracts.js";
import {
  createRemoteProduct,
  deleteRemoteProduct,
  getRemoteProduct,
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
    const login = await context.browser.status(true);
    if (!login.loggedIn) {
      throw new Error(login.message || "无法创建产品：请先登录 VBK。");
    }
    const accountName = login.accountName?.trim() || login.loginAccount?.trim() || null;
    if (!accountName) throw new Error("无法创建产品：未能识别当前 VBK 账号，请重新登录后再试。");
    assertCreatePreconditions(db, accountName);
    db.setSetting("vbkAccountName", accountName);
    const created = await createRemoteProduct(db, remoteProducts, input, accountName);
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
  ipcMain.handle("products:get", (_event, id: string) => getRemoteProduct(db, remoteProducts, id));
  ipcMain.handle("products:delete", async (_event, id: string) => {
    const removed = await deleteRemoteProduct(db, remoteProducts, id);
    if (!removed) throw productNotFound(id);
    return { deleted: true };
  });
}
