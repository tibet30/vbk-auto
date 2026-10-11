import type { ProductWorkspaceSnapshot } from '../../../shared/contracts-product-architecture.js';
import type { VbkApi } from '../../../shared/contracts.js';

export class WorkspaceSnapshotStore {
  private owner: number | null = null;
  private generation = 0;
  private readonly snapshots = new Map<string, ProductWorkspaceSnapshot>();
  private readonly listeners = new Set<(snapshot: ProductWorkspaceSnapshot) => void>();
  changeOwner(id: number | null): void {
    if (this.owner === id) return;
    this.owner = id; this.generation++; this.snapshots.clear();
  }
  clear(): void { this.changeOwner(null); }
  clearOwner(id: number): void { if (this.owner === id) this.clear(); }
  get(id: string): ProductWorkspaceSnapshot | undefined { return this.snapshots.get(id); }
  accept(snapshot: ProductWorkspaceSnapshot): boolean {
    if (snapshot.ownerUserId !== this.owner || !Number.isSafeInteger(snapshot.viewRevision)) return false;
    const old = this.snapshots.get(snapshot.localProductId);
    if (old && snapshot.viewRevision <= old.viewRevision) return false;
    this.snapshots.set(snapshot.localProductId, snapshot);
    for (const listener of this.listeners) listener(snapshot);
    return true;
  }
  subscribe(listener: (snapshot: ProductWorkspaceSnapshot) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  async read(client: VbkApi, id: string): Promise<ProductWorkspaceSnapshot> {
    const generation = this.generation;
    const snapshot = await client.workspace.get(id);
    if (snapshot.localProductId !== id) throw new Error('产品快照与请求不一致。');
    if (generation !== this.generation || snapshot.ownerUserId !== this.owner) throw new Error('账号已切换，请重新打开产品。');
    this.accept(snapshot);
    return this.snapshots.get(id)!;
  }
}

export const workspaceSnapshots = new WorkspaceSnapshotStore();
