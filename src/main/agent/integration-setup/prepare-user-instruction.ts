import type { MainIpcContext } from "../../ipc/context.js";
import type { AgentCoreDependencies } from "../types.js";
import { productNotFound } from "../../infrastructure/db-errors.js";
import { refreshSatisfiedResearchTasks } from "../../operations/research-refresh.js";
import { repairProductForExplicitInstruction } from "../user-instruction-repair.js";
import { isPreparationInstruction } from "../preparation-run.js";
import { preparationItineraryRecovery } from "../preparation-itinerary-recovery.js";
import { removeConfirmedDomesticShortPoiRisk } from "../domestic-short-poi-removal.js";
import { automationBlockedByPoiRisk, reopenAutomationAfterPoiRemoval } from "../../automation/automation.main/poi-removal-reopen.js";
import { restoreExplicitOperatorDeletion, restoreExplicitAlternativeSlots } from "./restore.js";

type Selection = Parameters<NonNullable<AgentCoreDependencies["prepareUserInstruction"]>>[2];

/** Apply an explicit operator instruction to the saved product before the Agent resumes. */
export function prepareUserInstruction(
  context: MainIpcContext, localProductId: string, content: string, selection: Selection,
): boolean | undefined {
  const { db, emitProduct } = context;
    let current = db.getProduct(localProductId);
    if (!current) throw productNotFound(localProductId);
    let preparationRecovered = false;
    const receiptProduct = structuredClone(current.product);
    if (restoreExplicitOperatorDeletion(receiptProduct, content)) {
      current = context.productMutations.commands.mergeChanges(localProductId, current, receiptProduct, 'user', {
        status: current.status, expectedVersion: current.productJsonVersion,
        allowItineraryRemovalRestore: true,
      });
      preparationRecovered = true;
    }
    const riskRemoval = removeConfirmedDomesticShortPoiRisk(current, selection?.selectedQuestions ?? []);
    if (riskRemoval?.removed) {
      current = context.productMutations.commands.mergeChanges(localProductId, current, riskRemoval.product, "user", {
        status: current.status, expectedVersion: current.productJsonVersion, allowItineraryRemovalRestore: true,
      });
      // 远端基本信息主标题、国家景区与图文同样引用该 POI，需从基本信息起重录。
      const reopened = reopenAutomationAfterPoiRemoval(current.automation, riskRemoval.poiName);
      if (reopened) {
        db.saveAutomation(localProductId, reopened);
        current = db.getProduct(localProductId) ?? current;
      }
      emitProduct(current);
      preparationRecovered = true;
    } else if (riskRemoval && automationBlockedByPoiRisk(current.automation, riskRemoval.poiName)) {
      // 本地早已剔除、远端仍引用：同样从基本信息起重录，不再原地暂停。
      const reopened = reopenAutomationAfterPoiRemoval(current.automation, riskRemoval.poiName);
      if (reopened) {
        db.saveAutomation(localProductId, reopened);
        current = db.getProduct(localProductId) ?? current;
        emitProduct(current);
        preparationRecovered = true;
      }
    }
    const restored = restoreExplicitAlternativeSlots(current, content);
    if (restored) {
      current = context.productMutations.commands.mergeChanges(localProductId, current, restored, 'user', {
        status: current.status, expectedVersion: current.productJsonVersion,
      });
      preparationRecovered = true;
    }
    if (isPreparationInstruction(content)) {
      const recovery = preparationItineraryRecovery(current);
      if (recovery) {
        current = context.productMutations.commands.mergeChanges(localProductId, current, recovery.product, 'resource', {
          status: current.status, expectedVersion: current.productJsonVersion,
        });
        db.markResearchTasksSatisfied(localProductId, recovery.taskIds);
        refreshSatisfiedResearchTasks(db, localProductId);
        preparationRecovered = true;
      }
    }
    const repair = repairProductForExplicitInstruction(
      current,
      content,
      selection?.selectedLabels,
      selection?.selectedQuestions,
    );
    if (!repair) {
      if (preparationRecovered) emitProduct(db.getProduct(localProductId)!);
      return preparationRecovered || undefined;
    }
    const saved = context.productMutations.commands.mergeChanges(localProductId, current, repair.product, 'resource', { status: current.status });
    emitProduct(saved);
    return true;
}
