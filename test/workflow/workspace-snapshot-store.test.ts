import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceSnapshotStore } from '../../src/renderer/app/state/workspace-snapshot-store.js';
import type { ProductWorkspaceSnapshot } from '../../src/shared/contracts-product-architecture.js';

const snapshot = (revision: number, id = 'A', owner = 1) => ({ localProductId: id, ownerUserId: owner,
  viewRevision: revision, product: { id, name: `revision-${revision}` } } as ProductWorkspaceSnapshot);

test('first read and events share a persistent revision gate; stale and duplicate responses are ignored', async () => {
  const store = new WorkspaceSnapshotStore(); store.changeOwner(1);
  let resolve!: (value: ProductWorkspaceSnapshot) => void;
  const read = store.read({ workspace: { get: () => new Promise(done => { resolve = done; }) } } as never, 'A');
  store.accept(snapshot(3)); resolve(snapshot(2));
  assert.equal((await read).viewRevision, 3);
  assert.equal(store.accept(snapshot(3)), false);
  assert.equal(store.accept(snapshot(1)), false);
});

test('products are isolated and account changes clear cached facts and invalidate in-flight reads', async () => {
  const store = new WorkspaceSnapshotStore(); store.changeOwner(1);
  store.accept(snapshot(2, 'A')); store.accept(snapshot(1, 'B'));
  assert.equal(store.get('A')!.viewRevision, 2); assert.equal(store.get('B')!.viewRevision, 1);
  let resolve!: (value: ProductWorkspaceSnapshot) => void;
  const read = store.read({ workspace: { get: () => new Promise(done => { resolve = done; }) } } as never, 'A');
  store.changeOwner(2); resolve(snapshot(4));
  await assert.rejects(read, /账号已切换/);
  assert.equal(store.get('A'), undefined); assert.equal(store.accept(snapshot(5)), false);
  assert.equal(store.accept(snapshot(1, 'A', 2)), true);
  store.clearOwner(1); assert.equal(store.get('A')!.ownerUserId, 2);
});
