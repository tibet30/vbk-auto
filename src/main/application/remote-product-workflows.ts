import type { CreateProductInput, ProductDetail, ProductSummary } from "../../shared/contracts.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import type { TibetProductService } from "../infrastructure/tibet-products.js";
import type { ProductWorkflow } from "./product-workflow-coordinator.js";
import { productNotFound } from "../infrastructure/db-errors.js";
import { prepareProductWithAccountButler } from "../operations/account-butler-inject.js";

export async function listRemoteProducts(
  remoteProducts: TibetProductService,
): Promise<ProductSummary[]> {
  return remoteProducts.list();
}

export async function createRemoteProduct(
  db: VbkDatabase,
  remoteProducts: TibetProductService,
  input: CreateProductInput,
  accountName: string | null,
  vbkAccount: string | null = null,
): Promise<{ product: ProductDetail; injectReason?: string; injected: boolean }> {
  // 创建阶段只保存运营输入的原始目的地；标准省市由第一阶段 AI 生成。
  // 这里不能提前调用任何目的地解析接口，否则新产品无法在未部署该接口的
  // Tibet 环境中创建，也会把“输入目的地”和“标准城市”混为一谈。
  const draft = db.buildProductSnapshot(input);
  const { product: preparedProduct, injectResult } = prepareProductWithAccountButler(db, draft, accountName);
  const product: ProductDetail = {
    ...preparedProduct,
    ...(vbkAccount ? { vbkAccount } : {}),
  };
  const saved = await remoteProducts.upsert(product);
  const cached = db.importProductSnapshot(saved);
  return { product: cached, injectReason: injectResult.reason, injected: injectResult.written };
}

export async function getRemoteProduct(
  db: VbkDatabase,
  remoteProducts: TibetProductService,
  id: string,
): Promise<ProductDetail> {
  const remote = await remoteProducts.get(id);
  return db.importProductSnapshot(remote);
}

/**
 * products:get 的一致性边界：长流程期间本地快照是当前写入者的工作集，
 * 不能被远端较旧的整包快照覆盖；空闲时仍以 Tibet 为权威并刷新本地缓存。
 */
export async function getProductForRead(
  db: VbkDatabase,
  remoteProducts: TibetProductService,
  id: string,
  activeWorkflow?: ProductWorkflow,
): Promise<ProductDetail> {
  if (activeWorkflow) {
    const local = db.getProduct(id);
    if (!local) throw productNotFound(id);
    return local;
  }
  return getRemoteProduct(db, remoteProducts, id);
}

export async function deleteRemoteProduct(
  db: VbkDatabase,
  remoteProducts: TibetProductService,
  id: string,
): Promise<boolean> {
  const local = db.getProduct(id);
  const snapshot = local ?? await remoteProducts.get(id);
  await remoteProducts.delete(id);
  if (!local) return true;
  try {
    return db.deleteProduct(id);
  } catch (error) {
    await remoteProducts.upsert(snapshot);
    throw error;
  }
}
