/**
 * creation-recovery-readonly 类型与依赖接口：
 *   - CreationVariant：VBK 草稿 / 正式 / 审核 / 预览 / 未知；
 *   - RecoveryScope：all（默认，要求全部交通子产品回读）/ parent-only（仅母产品）；
 *   - CreationVariantReadback：VBK 草稿读回的精确形态，recovery 仅接受 draft；
 *   - CreationRecoveryReadOnlyDependencies：所有依赖注入；
 *   - RecoveryTarget / RecoveryInput：内部目标 + 输入。
 */

import type { ProductDetail } from "../../../shared/contracts.js";
import type { TrafficLineEndpointPlan, TrafficLineVariant } from "../../../shared/contracts-traffic-line.js";
import type { TrafficLineChildReadback } from "../../automation/ctrip/traffic-line/readback.js";
import type { TrafficLineExistingChild } from "../../automation/ctrip/traffic-line/types.js";
import type { ProductWorkflowCoordinator } from "../../application/product-workflow-coordinator.js";
import type { VbkBrowser } from "../../infrastructure/vbk-browser.js";
import type { VbkDatabase } from "../../infrastructure/database/database.js";
import type { AgentTool } from "../types.js";

export type CreationVariant = "draft" | "formal" | "audit" | "preview" | "unknown";
export type RecoveryScope = "all" | "parent-only";

export interface CreationVariantReadback {
  /** The exact Ctrip representation used for this read; recovery accepts draft only. */
  variant: CreationVariant;
  /** Set only by the dedicated reader after explicit draft or unsubmitted-main guards. */
  unsubmittedDraftVerified: boolean;
  draftSource?: "independent" | "unsubmitted-main";
  ids: Partial<Record<Exclude<CreationVariant, "unknown">, string>>;
  poi85862?: { suffixName?: string; description?: string };
}

export interface CreationRecoveryReadOnlyDependencies {
  db: Pick<VbkDatabase, "getProduct" | "writeAutomationWithProductStatus">;
  browser: Pick<VbkBrowser, "page">;
  productWorkflows: Pick<ProductWorkflowCoordinator, "runExclusive" | "runVbkPageExclusive">;
  /** Includes the current BrowserView login and remote product binding check. */
  accountFor(localProductId: string): Promise<{ accountKey: string; productVersion: string }>;
  readCreationVariant(page: unknown, productId: string): Promise<CreationVariantReadback>;
  readPreflight?: typeof import("../../automation/ctrip/preflight-readonly.js").runProductReadOnlyPreflightApi;
  readTrafficChildren?: typeof import("../../automation/ctrip/traffic-line/relationships.js").readTrafficLineChildren;
  verifyTrafficChild?: typeof import("../../automation/ctrip/traffic-line/readback.js").verifyTrafficLineChild;
  now?: () => string;
  id?: () => string;
  emitProduct?(product: ProductDetail): void;
}

export interface RecoveryTarget {
  variant: TrafficLineVariant;
  child: TrafficLineExistingChild;
  readback: TrafficLineChildReadback;
}

export interface RecoveryInput {
  product: ProductDetail;
  productId: string;
  productJsonVersion: number;
  productJsonSnapshot: string;
  workflowSnapshot: string;
  endpointPlan?: TrafficLineEndpointPlan;
  variants: TrafficLineVariant[];
}