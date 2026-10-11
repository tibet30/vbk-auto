import type Database from 'better-sqlite3';
import { ProductExecutionService } from '../../../application/product-execution-service.js';
import { mergeAgentDiagnostics } from '../../../application/product-diagnostics.js';
import { getProduct } from './products/import.js';
import { getAgentSnapshot } from './agent.js';
import { createWorkflowTask, latestWorkflowTaskForProduct, updateWorkflowTask, listWorkflowTasks } from './workflow-tasks.js';
import { record } from '../../../../shared/product-storage-projection.js';

export function synchronizeProductExecution(db: Database.Database, id: string) {
  return db.transaction(() => {
    const service = executionService(db);
    const task = service.reconcile(id);
    const product = getProduct(db, id);
    const snapshot = getAgentSnapshot(db, id);
    if (product && snapshot) {
      const diagnostics = record(mergeAgentDiagnostics(product, snapshot).diagnostics);
      delete diagnostics.routeAdministrativeNodes;
      db.prepare(`INSERT INTO product_runtime_diagnostics VALUES(?,?) ON CONFLICT(local_product_id)
        DO UPDATE SET payload_json=excluded.payload_json`).run(id, JSON.stringify(diagnostics));
    }
    return task;
  })();
}

function executionService(db: Database.Database): ProductExecutionService {
  return new ProductExecutionService({
    listWorkflowTasks: () => listWorkflowTasks(db),
    getProduct: key => getProduct(db, key), getAgentSnapshot: key => getAgentSnapshot(db, key),
    latestWorkflowTaskForProduct: key => latestWorkflowTaskForProduct(db, key),
    createWorkflowTask: (key, name) => createWorkflowTask(db, key, name),
    updateWorkflowTask: (key, patch) => updateWorkflowTask(db, key, patch, true),
  });
}
export function recoverProductExecution(db: Database.Database) {
  return db.transaction(() => executionService(db).recoverInterrupted())();
}
