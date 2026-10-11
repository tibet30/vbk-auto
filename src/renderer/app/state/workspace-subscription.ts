import type { VbkApi } from '../../../shared/contracts.js';
import { workspaceSnapshots } from './workspace-snapshot-store.js';

/** Shared snapshot transport; first reads and events use the same revision gate. */
export function subscribeWorkspaceTransport(events: VbkApi["events"]): () => void {
  return events.onWorkspaceUpdated(snapshot => { workspaceSnapshots.accept(snapshot); });
}
