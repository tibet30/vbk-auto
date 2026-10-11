import { useEffect, useRef } from 'react';
import type { AppStateBase } from './base.js';
import { api } from '../helpers/index.js';
import { simulateRecoveryEffectTick } from './recovery-policy.js';
import { workspaceSnapshots } from './workspace-snapshot-store.js';

/** A user navigation consumes startup recovery; old reads cannot navigate them back. */
export function useRecentProductRecovery(state: AppStateBase): void {
  const { product, view, activeLocalProductId, setProduct, setActiveLocalProductId } = state;
  const attempted = useRef(false);
  const scope = useRef({ view, activeLocalProductId });
  scope.current = { view, activeLocalProductId };
  useEffect(() => {
    const client = api();
    const decision = simulateRecoveryEffectTick({ hasApi: Boolean(client), view, hasProduct: Boolean(product),
      hasActiveLocalProductId: Boolean(activeLocalProductId), hasAttempted: attempted.current });
    attempted.current = decision.nextHasAttempted;
    if (!decision.shouldRequest || !client) return;
    const targetId = activeLocalProductId!;
    let cancelled = false;
    const current = () => !cancelled && scope.current.view === 'workspace' && scope.current.activeLocalProductId === targetId;
    const request = client.workspace ? workspaceSnapshots.read(client, targetId).then(snapshot => snapshot.product) : client.products.get(targetId);
    void request.then(detail => { if (current()) setProduct(detail); }).catch(() => {
      if (!current()) return;
      try { localStorage.removeItem('vbk:activeLocalProductId'); } catch { /* storage unavailable */ }
      setActiveLocalProductId(null);
    });
    return () => { cancelled = true; };
  }, [activeLocalProductId, product?.id, view]);
}
