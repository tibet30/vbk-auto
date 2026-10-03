import type { ProductDetail } from "../../../shared/contracts.js";
import type { ProductTelemetryReport } from "../../../shared/product-usage-report.js";
import { ProductExecutionDatabase } from "./execution-database.js";
import * as state from "./parts/local-product-state.js";

export class LocalProductDatabase extends ProductExecutionDatabase {
  readLocalProductState(id: string) { return state.readLocalProductState(this.db, id); }
  attachLocalProductState(product: ProductDetail, owner: number, revision: number) {
    state.attachLocalProductState(this.db, product, owner, revision);
  }
  saveLocalProductState(product: ProductDetail, owner: number, revision: number) {
    return state.saveLocalProductState(this.db, product, owner, revision);
  }
  ownedLocalProductIds(owner: number) { return state.ownedLocalProductIds(this.db, owner); }
  listOwnedLocalProductSummaries(owner: number) { return state.listOwnedLocalProductSummaries(this.db, owner); }
  enqueueDiagnostic(owner: number, eventId: string, report: ProductTelemetryReport) {
    state.enqueueDiagnostic(this.db, owner, eventId, report);
  }
  pendingDiagnostics(owner: number) { return state.pendingDiagnostics(this.db, owner); }
  markDiagnosticSent(owner: number, eventId: string) { state.markDiagnosticSent(this.db, owner, eventId); }
}
