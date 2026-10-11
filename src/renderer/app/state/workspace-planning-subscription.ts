import { useEffect } from 'react';
import type { PlanningGenerationState } from '../../../shared/contracts-planning.js';
import { api } from '../helpers/index.js';
import { workspaceSnapshots } from './workspace-snapshot-store.js';

export function useWorkspacePlanning(id: string | undefined, setState: (state: PlanningGenerationState | null) => void): void {
  useEffect(() => {
    const client = api();
    if (!id || !client) return;
    let alive = true;
    if (client.workspace) {
      const unsubscribe = workspaceSnapshots.subscribe(snapshot => {
        if (alive && snapshot.localProductId === id) setState(snapshot.planning ?? null);
      });
      const apply = () => {
        const snapshot = workspaceSnapshots.get(id);
        if (alive && snapshot) setState(snapshot.planning ?? null);
      };
      apply();
      const refresh = () => { void workspaceSnapshots.read(client, id).then(apply).catch(() => undefined); };
      refresh();
      window.addEventListener('focus', refresh);
      return () => { alive = false; unsubscribe(); window.removeEventListener('focus', refresh); };
    }
    let eventVersion = 0;
    const unsubscribe = client.events.onPlanningStateUpdated((productId, state) => {
      if (productId !== id || !alive) return;
      eventVersion++; setState(state);
    });
    void client.planning.state(id).then(state => { if (alive && !eventVersion && state) setState(state); }).catch(() => undefined);
    return () => { alive = false; unsubscribe(); };
  }, [id, setState]);
}
