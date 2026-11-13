import type { AiResponse, ManualReviewFieldInput, ProductDetail } from '../../shared/contracts.js';
import type { ProductMutationOptions } from './product-mutation-service.js';
import { canonicalJson, composeProduct, record } from '../../shared/product-storage-projection.js';
import { applyManualReviewField } from '../operations/manual-review-field.js';
import { attachManualPoiReceipt, verifiedMappingForManualPoi } from '../operations/manual-review-poi-selection.js';
import type { VerifiedPoiMapping } from '../planning/types.js';
import { applyProductPatchSafe } from '../operations/product-patch.js';

export type ProductCommandSource = 'user' | 'ai' | 'resource' | 'automation' | 'import';
export interface ProductCommandContext {
  localProductId: string;
  source: ProductCommandSource;
  expectedVersion: number;
}
export interface ResourceResultGuard {
  queryPath: string[];
  queryFingerprint: string;
  targetPath: string[];
  targetFingerprint: string;
}
export class ProductCommandConflict extends Error {
  readonly retryable = true;
  constructor(message: string, readonly fieldPath?: readonly string[]) {
    super(fieldPath ? `${message}（冲突字段：${fieldPath.join('.')}）` : message);
  }
}
interface Store {
  getProduct(id: string): ProductDetail | undefined;
  replace(id: string, product: Record<string, unknown>, options: ProductMutationOptions): ProductDetail;
  transaction<T>(task: () => T): T;
  notify(product: ProductDetail): void;
  satisfyResearch?(id: string, product: Record<string, unknown>): { taskIds: string[] };
  reopenResearch?(id: string, product: Record<string, unknown>): void;
  /** 受控 POI 凭证是决策门 task 的唯一结清依据（自动谓词刻意不认同名绑定）。 */
  confirmPoiResearch?(id: string, mappings: readonly VerifiedPoiMapping[]): { taskIds: string[] };
}
interface Change { path: string[]; before: unknown; after: unknown; remove: boolean; }
/** commit 的可选行为：satisfy 是自动谓词，settle 是受控凭证回写（两者互不替代）。 */
interface CommitBehavior {
  satisfy?: boolean;
  preserveExtensions?: boolean;
  settle?: (product: ProductDetail) => void;
}

/** Commands re-read facts at commit, apply only their fields, then publish the saved value. */
export class ProductCommandService {
  constructor(private readonly store: Store) {}
  manualField(context: ProductCommandContext, input: ManualReviewFieldInput, options: ProductMutationOptions = {}) {
    if (context.source !== 'user') throw new Error('人工字段命令必须来自运营操作。');
    return this.commit(context, current => {
      const proposed = applyManualReviewField(current.product, input);
      return input.field === 'itinerarySpotPoi' ? attachManualPoiReceipt(proposed, input) : proposed;
    }, { ...options, allowItineraryRemovalRestore: true }, {
      satisfy: true,
      // 凭证在 build 阶段已与绑定同写；落库后按持久化事实取证并结清同名决策门。
      // 收在命令里，任何新的人工选点入口都不会再漏掉这一步。
      settle: saved => {
        if (input.field !== 'itinerarySpotPoi') return;
        const mapping = verifiedMappingForManualPoi(saved.product, input);
        if (mapping) this.store.confirmPoiResearch?.(saved.id, [mapping]);
      },
    });
  }
  aiPatch(context: ProductCommandContext, patch: NonNullable<AiResponse['patch']>) {
    if (context.source !== 'ai') throw new Error('AI patch 来源不匹配。');
    return this.commit(context, current => {
      const result = applyProductPatchSafe(current.product, patch);
      if (!result.applied) throw new Error('AI 写入路径或内容不合法。');
      return result.product;
    });
  }
  replaceFull(context: ProductCommandContext, product: Record<string, unknown>, options: ProductMutationOptions = {}) {
    if (context.source !== 'user' && context.source !== 'import') throw new Error('整包替换仅允许完整人工编辑或历史导入。');
    return this.commit(context, () => product, options, { preserveExtensions: false });
  }
  /** Changed fields are compared with the captured baseline, not an entire stale product. */
  mergeChanges(id: string, baseline: ProductDetail, next: Record<string, unknown>, source: ProductCommandSource,
    options: ProductMutationOptions = {}, guard?: ResourceResultGuard): ProductDetail {
    const proposedChanges = diff(baseline.product, next);
    const current = this.requireProduct(id);
    if (guard && (canonicalJson(at(current.product, guard.queryPath)) !== guard.queryFingerprint
      || canonicalJson(at(current.product, guard.targetPath)) !== guard.targetFingerprint)) {
      throw new ProductCommandConflict('资源核验条件或目标字段已变化，请按最新方案重试。');
    }
    // A checkpoint may already have persisted the proposed value (including
    // execution diagnostics). Keep that value without treating it as a conflict.
    // Different concurrent values must still reject the whole command.
    const changes = proposedChanges.filter(change =>
      canonicalJson(at(current.product, change.path)) !== canonicalJson(change.after));
    for (const change of changes) if (canonicalJson(at(current.product, change.path)) !== canonicalJson(change.before)) {
      throw new ProductCommandConflict('产品目标字段已变更，请刷新后重试。', change.path);
    }
    return this.commit({ localProductId: id, source, expectedVersion: current.productJsonVersion ?? 0 }, latest => {
      const product = structuredClone(latest.product);
      for (const change of changes) put(product, change);
      return product;
    }, options);
  }
  resourceResult(context: ProductCommandContext, path: string[], value: unknown, guard: ResourceResultGuard) {
    const current = this.requireProduct(context.localProductId);
    if (canonicalJson(at(current.product, guard.queryPath)) !== guard.queryFingerprint
      || canonicalJson(at(current.product, guard.targetPath)) !== guard.targetFingerprint) {
      throw new ProductCommandConflict('资源核验条件或目标字段已变化，请按最新方案重试。');
    }
    return this.commit(context, latest => {
      const product = structuredClone(latest.product);
      put(product, { path, before: at(product, path), after: value, remove: false });
      return product;
    });
  }
  private commit(context: ProductCommandContext, build: (product: ProductDetail) => Record<string, unknown>,
    options: ProductMutationOptions = {}, behavior: CommitBehavior = {}): ProductDetail {
    const { satisfy = false, preserveExtensions = true } = behavior;
    if (context.source !== 'user' && (options.allowMeetingCityCorrection || options.allowItineraryRemovalRestore)) {
      throw new Error('撤销人工约束必须由运营明确操作。');
    }
    const saved = this.store.transaction(() => {
      const current = this.requireProduct(context.localProductId);
      if (current.productJsonVersion !== undefined && current.productJsonVersion !== context.expectedVersion) {
        throw new ProductCommandConflict('产品内容已变更，请刷新后重试。');
      }
      const proposed = build(current);
      // The compatibility read normalizes a few legacy fields. Apply scoped
      // changes to the raw composition so unrelated extensions are not erased.
      const next = preserveExtensions && current.plan && current.resourceEvidence
        ? composeProduct(current.plan, current.resourceEvidence, record(current.product.diagnostics)) : proposed;
      if (next !== proposed) for (const change of diff(current.product, proposed)) put(next, change);
      const result = this.store.replace(context.localProductId, next, {
        ...options, source: context.source, notify: false, expectedVersion: current.productJsonVersion,
      });
      if (satisfy || context.source === 'resource' || context.source === 'ai') {
        this.store.reopenResearch?.(result.id, result.product);
        this.store.satisfyResearch?.(result.id, result.product);
      }
      // 受控凭证回写与本次写入同一事务：结清失败不能让绑定单独落库。
      behavior.settle?.(this.requireProduct(context.localProductId));
      return this.requireProduct(context.localProductId);
    });
    if (options.notify !== false) this.store.notify(saved);
    return saved;
  }
  private requireProduct(id: string): ProductDetail {
    const product = this.store.getProduct(id);
    if (!product) throw new Error('产品不存在');
    return product;
  }
}

function at(object: unknown, path: string[]): unknown {
  let value = object;
  for (const key of path) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return value;
}
function put(object: Record<string, unknown>, change: Change): void {
  if (!change.path.length || change.path.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('不合法的字段路径');
  let target = object;
  for (const key of change.path.slice(0, -1)) {
    if (!target[key] || typeof target[key] !== 'object') target[key] = {};
    target = target[key] as Record<string, unknown>;
  }
  const key = change.path[change.path.length - 1]!;
  if (change.remove) delete target[key];
  else target[key] = structuredClone(change.after);
}
function diff(before: Record<string, unknown>, after: Record<string, unknown>, path: string[] = []): Change[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => {
    const a = before[key]; const b = after[key];
    if (canonicalJson(a) === canonicalJson(b)) return [];
    const nested = a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b);
    return nested ? diff(record(a), record(b), [...path, key])
      : [{ path: [...path, key], before: a, after: b, remove: !Object.hasOwn(after, key) }];
  });
}
