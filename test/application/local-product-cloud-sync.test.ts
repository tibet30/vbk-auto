import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import { createAppAuthStore } from '../../src/main/infrastructure/app-auth-store.js';
import { createLocalProductService } from '../../src/main/infrastructure/local-product-service.js';
import { createLocalProductCloudSync, sameCloudProduct } from '../../src/main/application/local-product-cloud-sync.js';
import { TibetProductConflictError, TibetProductNotFoundError, type TibetProductService } from '../../src/main/infrastructure/tibet-products.js';
import type { ProductDetail } from '../../src/shared/contracts.js';

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vbk-cloud-sync-'));
  let db = new VbkDatabase(root);
  const store = createAppAuthStore(path.join(root, 'session.json'));
  const login = (id: number) => store.set({ token: `test-${id}`, expiresAt: '2099-01-01',
    user: { id, name: '测试', phone: 'test', status: 'active', expiresAt: '2099-01-01' } });
  login(1);
  let cloud: ProductDetail | undefined;
  let writes = 0;
  let reads = 0;
  let timestamp = 0;
  let offline = false;
  let conflict = false;
  let onGet: (() => Promise<void>) | undefined;
  let onPost: (() => Promise<void>) | undefined;
  const remote: TibetProductService = {
    async list() { return []; }, async delete() {},
    async upsert(product) {
      if (offline) throw new Error('offline');
      writes++;
      cloud ??= structuredClone({ ...product, revision: 1 });
      await onPost?.();
      return structuredClone(cloud);
    },
    async update(product, revision) {
      if (conflict) { conflict = false; throw new TibetProductConflictError(cloud!); }
      assert.equal(revision, cloud!.revision);
      writes++;
      cloud = structuredClone({ ...product, revision: revision + 1 });
      return structuredClone(cloud);
    },
    async get() {
      reads++;
      if (offline) throw new Error('offline');
      const snapshot = cloud && structuredClone(cloud);
      await onGet?.();
      if (!snapshot) throw new TibetProductNotFoundError();
      return snapshot;
    },
  };
  const local = () => createLocalProductService({ db, store, capture() {} });
  const sync = () => createLocalProductCloudSync({ db, store, remote, now: () => timestamp });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { get db() { return db; }, local, sync, login, remote,
    get cloud() { return cloud; }, get writes() { return writes; }, get reads() { return reads; },
    advance(ms = 60_000) { timestamp += ms; },
    set onGet(value: () => Promise<void>) { onGet = value; },
    set offline(value: boolean) { offline = value; }, set conflict(value: boolean) { conflict = value; },
    set onPost(value: () => Promise<void>) { onPost = value; },
    restart() { db.close(); db = new VbkDatabase(root); } };
}

async function create(f: ReturnType<typeof fixture>) {
  return f.local().upsert(f.db.buildProductSnapshot({ destination: '成都', days: 2, productForm: 'privateTour' }));
}

test('完整产品新增、后续修改同步，确认后重启不重复发送，本机数据保留', async t => {
  const f = fixture(t);
  const p = await create(f);
  await f.sync().flush();
  assert.deepEqual(f.cloud!.product, p.product);
  f.db.updateProduct(p.id, { ...p.product, customNote: '后续修改' }, 'review', p.productJsonVersion);
  f.db.addMessage(p.id, 'user', '追加要求');
  await f.sync().flush();
  assert.equal(f.cloud!.product.customNote, '后续修改');
  assert.equal(f.cloud!.messages.at(-1)?.content, '追加要求');
  const writes = f.writes;
  f.restart();
  await f.sync().flush();
  assert.equal(f.writes, writes);
  assert.equal(f.db.getProduct(p.id)!.product.customNote, '后续修改');
});

test('离线本机保存成功，重启恢复连接后补传；冲突不丢失本机修改', async t => {
  const f = fixture(t);
  f.offline = true;
  const p = await create(f);
  await f.sync().flush();
  assert.equal(f.cloud, undefined);
  f.restart();
  f.offline = false;
  await f.sync().flush();
  f.db.updateProduct(p.id, { ...p.product, customNote: '冲突后保留' }, 'review', f.db.getProduct(p.id)!.productJsonVersion);
  f.conflict = true;
  await f.sync().flush();
  assert.equal(f.cloud!.product.customNote, undefined);
  f.advance();
  await f.sync().flush();
  assert.equal(f.cloud!.product.customNote, '冲突后保留');
});

test('上传期间连续修改最终同步最新快照', async t => {
  const f = fixture(t);
  const p = await create(f);
  const sync = f.sync();
  let changed = false;
  f.onPost = async () => {
    if (changed) return;
    changed = true;
    f.db.updateProduct(p.id, { ...p.product, customNote: '最新' }, 'review', p.productJsonVersion);
    void sync.flush();
  };
  await sync.flush();
  assert.equal(f.cloud!.product.customNote, '最新');
});

test('切换账号后不继续上传上一账号的产品', async t => {
  const f = fixture(t);
  await create(f);
  f.onPost = async () => { f.login(2); };
  await f.sync().flush();
  assert.equal(f.writes, 1);
  await f.sync().flush();
  assert.equal(f.writes, 1);
});

test('服务端诊断压缩不影响业务回读；业务字段缺失仍拒绝确认', () => {
  const local = { id: 'test', name: '测试', status: 'planning', updatedAt: '2026-10-12',
    product: { itinerary: { days: [1, 2] }, diagnostics: { runtime: { lastToolFailure: {} } } },
    messages: [], researchTasks: [] } as unknown as ProductDetail;
  const remote = { ...local, product: { itinerary: { days: [1, 2] } } };
  assert.equal(sameCloudProduct(local, remote), true);
  assert.equal(sameCloudProduct(local, { ...remote, product: {} }), false);
});

test('已有产品修改直接使用读取版本 PATCH，创建接口不能绕过版本校验', async t => {
  const f = fixture(t);
  const p = await create(f);
  const sync = f.sync();
  await sync.flush();
  let posts = 0;
  f.onPost = async () => { posts++; };
  f.db.updateProduct(p.id, { ...p.product, customNote: '修改' }, 'review', p.productJsonVersion);
  await sync.flush();
  assert.equal(posts, 0);
  assert.equal(f.cloud!.revision, 2);
});

test('读取失败不调用创建，频繁保存遵守退避，恢复后同步最新本机快照', async t => {
  const f = fixture(t);
  const p = await create(f);
  const sync = f.sync();
  f.offline = true;
  await sync.flush();
  for (let i = 0; i < 5; i++) await sync.flush();
  assert.equal(f.reads, 1);
  assert.equal(f.writes, 0);
  f.db.updateProduct(p.id, { ...p.product, customNote: '离线最新' }, 'review', p.productJsonVersion);
  f.offline = false;
  f.advance();
  await sync.flush();
  assert.equal(f.cloud!.product.customNote, '离线最新');
});

test('时间戳和诊断变化不重复上传；读取期间修改使用最新快照', async t => {
  const f = fixture(t);
  const p = await create(f);
  const sync = f.sync();
  await sync.flush();
  const saved = await f.local().get(p.id);
  await f.local().update({ ...saved, product: { ...saved.product,
    diagnostics: { runtime: { message: '本机运行诊断' } } } }, saved.revision!);
  await sync.flush();
  assert.equal(f.writes, 1);
  f.db.updateProduct(p.id, { ...p.product, customNote: '旧' }, 'review', f.db.getProduct(p.id)!.productJsonVersion);
  let changed = false;
  f.onGet = async () => {
    if (changed) return;
    changed = true;
    const current = f.db.getProduct(p.id)!;
    f.db.updateProduct(p.id, { ...current.product, customNote: '最新' }, 'review', current.productJsonVersion);
  };
  await sync.flush();
  assert.equal(f.cloud!.product.customNote, '最新');
  assert.equal(f.writes, 2);
});

test('服务端回读丢失业务字段不能确认，下一次重试修复', async t => {
  const f = fixture(t);
  const p = await create(f);
  const sync = f.sync();
  f.onPost = async () => { f.cloud!.messages = []; f.cloud!.product = {}; };
  f.conflict = true;
  await sync.flush();
  assert.equal(f.db.getSetting(`productCloudSync:1:${p.id}`), undefined);
  f.advance();
  await sync.flush();
  assert.deepEqual(f.cloud!.product, p.product);
  assert.ok(f.db.getSetting(`productCloudSync:1:${p.id}`));
});

test('独立回读不一致时不写确认记录，恢复后自动补传', async t => {
  const f = fixture(t);
  const p = await create(f);
  const sync = f.sync();
  const get = f.remote.get;
  let corrupt = true;
  f.remote.get = async id => {
    const saved = await get(id);
    return corrupt ? { ...saved, product: {} } : saved;
  };
  await sync.flush();
  assert.equal(f.db.getSetting(`productCloudSync:1:${p.id}`), undefined);
  corrupt = false;
  f.advance();
  await sync.flush();
  assert.ok(f.db.getSetting(`productCloudSync:1:${p.id}`));
});

test('服务端读取期间切换账号不发送 PATCH，写入期间关闭不回读数据库', async t => {
  const f = fixture(t);
  const p = await create(f);
  const sync = f.sync();
  await sync.flush();
  f.db.updateProduct(p.id, { ...p.product, customNote: '待同步' }, 'review', p.productJsonVersion);
  f.onGet = async () => { f.login(2); };
  await sync.flush();
  assert.equal(f.writes, 1);
  assert.equal(f.cloud!.product.customNote, undefined);
  f.login(1);
  f.onGet = async () => {};
  const update = f.remote.update;
  f.remote.update = async (product, revision) => {
    const saved = await update(product, revision);
    sync.dispose();
    return saved;
  };
  await sync.flush();
  const reads = f.reads;
  await sync.flush();
  assert.equal(f.reads, reads);
});

test('AI 费用末位浮点差异不误判；真实金额、Token 和产品价格差异仍拒绝', () => {
  const local = { id: 'test', name: '测试', status: 'planning', updatedAt: '2026-10-12',
    product: { price: 0.20229999999999998 }, messages: [], researchTasks: [],
    aiUsage: { byStage: [{ stage: 'planning', totals: { estimatedCostCny: 0.20229999999999998,
      totalTokens: 100 } }] } } as unknown as ProductDetail;
  const remote = structuredClone(local);
  remote.aiUsage!.byStage[0].totals.estimatedCostCny = 0.2023;
  assert.equal(sameCloudProduct(local, remote), true);
  remote.aiUsage!.byStage[0].totals.estimatedCostCny = 0.203;
  assert.equal(sameCloudProduct(local, remote), false);
  remote.aiUsage!.byStage[0].totals.estimatedCostCny = 0.2023;
  remote.aiUsage!.byStage[0].totals.totalTokens = 101;
  assert.equal(sameCloudProduct(local, remote), false);
  remote.aiUsage!.byStage[0].totals.totalTokens = 100;
  remote.product.price = 0.2023;
  assert.equal(sameCloudProduct(local, remote), false);
});
