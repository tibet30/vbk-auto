import type { ProductDetail, ProductSummary } from "../../shared/contracts.js";

/** Legacy name retained for callers; the application now injects only the local SQLite implementation. */
export interface TibetProductService {
  storage?: "local";
  list(): Promise<ProductSummary[]>;
  upsert(product: ProductDetail): Promise<ProductDetail>;
  update(product: ProductDetail, expectedRevision: number): Promise<ProductDetail>;
  get(id: string): Promise<ProductDetail>;
  delete(id: string): Promise<void>;
}

export class TibetProductConflictError extends Error {
  constructor(public readonly latest: ProductDetail, message = "产品已在其他位置更新，请刷新后重试。") {
    super(message);
    this.name = "TibetProductConflictError";
  }
}
