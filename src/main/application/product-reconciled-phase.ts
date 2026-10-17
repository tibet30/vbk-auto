import type { AutomationRun, ProductDetail } from '../../shared/contracts.js';
import type { ProductResourceEvidence } from '../../shared/contracts-product-architecture.js';
import { stampCompletedEntryPhase } from './product-entry-phase-fingerprint.js';

interface ReconciliationStore {
  runProductTransaction<T>(task: () => T): T;
  getProduct(id: string): ProductDetail | undefined;
  setBasicInfoSaved(id: string, saved: boolean): void;
  saveAutomation(id: string, run: AutomationRun): void;
  recordResourceObservation?(id: string, observation: NonNullable<ProductResourceEvidence['observations']>[number]): void;
}

export function settleReconciledDispatches(db: ReconciliationStore, id: string, phase: string): void {
  const observations = db.getProduct(id)?.resourceEvidence?.observations ?? [];
  const completed = new Set(observations.filter(item => item.status !== 'write_dispatched').map(item => item.id));
  for (const item of observations) if (item.status === 'write_dispatched'
    && item.capability === `write_phase:${phase}` && !completed.has(item.id)) {
    db.recordResourceObservation?.(id, { ...item, status: 'write_checked', verifiedAt: new Date().toISOString() });
  }
}

/** Readback proof and the next checkpoint are committed together. */
export function persistReconciledPhase(db: ReconciliationStore, id: string, phase: string): void {
  db.runProductTransaction(() => {
    settleReconciledDispatches(db, id, phase);
    const product = db.getProduct(id);
    if (!product?.automation) return;
    const run = product.automation;
    const existing = run.phases.find(item => item.phase === phase);
    if (existing) existing.status = 'completed';
    else run.phases.push({ phase, status: 'completed' });
    stampCompletedEntryPhase(run, product.product, phase);
    if (run.recovery?.phases[phase]) {
      run.recovery.phases[phase]!.state = 'completed';
      run.recovery.phases[phase]!.finalError = undefined;
    }
    run.currentPhase = run.phases.find(item => item.status === 'failed')?.phase
      ?? run.phases.find(item => item.status === 'pending')?.phase;
    run.status = run.phases.some(item => item.status === 'failed') ? 'failed'
      : run.phases.every(item => item.status === 'completed') ? 'succeeded' : 'queued';
    if (phase === 'basic') db.setBasicInfoSaved(id, true);
    db.saveAutomation(id, run);
  });
}
