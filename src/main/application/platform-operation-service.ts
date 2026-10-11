import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../../shared/product-storage-projection.js';
import type { PlatformEvidence, PlatformFailureKind, PlatformQueryResult } from '../../shared/contracts-platform-operations.js';

export class PlatformOperationError extends Error {
  readonly uncertainWrite: boolean;
  constructor(message: string, readonly kind: PlatformFailureKind | 'write_uncertain', options?: ErrorOptions) {
    super(message, options); this.uncertainWrite = kind === 'write_uncertain';
  }
}
export interface PlatformOperationContext {
  capability: string;
  source: PlatformEvidence['source'];
  accountKey?: string;
  query: unknown;
}

/** One business call per invocation. Retry decisions belong to the execution layer. */
export class PlatformOperationService {
  constructor(private readonly capture?: (evidence: PlatformEvidence, outcome: string) => void) {}
  async query<T>(context: PlatformOperationContext, execute: () => Promise<T>, isEmpty: (value: T) => boolean): Promise<PlatformQueryResult<T>> {
    const evidence = this.evidence(context);
    let result: PlatformQueryResult<T>;
    try {
      const value = await execute();
      evidence.verifiedAt = new Date().toISOString();
      result = { status: isEmpty(value) ? 'empty' : 'found', value, evidence };
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      result = { status: classifyPlatformFailure(error), error, evidence };
    }
    this.capture?.(evidence, result.status);
    return result;
  }
  async queryValue<T>(context: PlatformOperationContext, execute: () => Promise<T>, isEmpty: (value: T) => boolean = value => value == null): Promise<T> {
    const result = await this.query(context, execute, isEmpty);
    if ('value' in result) return result.value;
    if ((result.error as Error & { retryable?: boolean }).retryable) throw result.error;
    throw new PlatformOperationError(result.error.message, result.status, { cause: result.error });
  }
  async write<T>(context: PlatformOperationContext, authorize: () => Promise<void>, execute: () => Promise<T>): Promise<T> {
    await authorize();
    const evidence = this.evidence(context);
    this.capture?.(evidence, 'write_dispatched');
    try {
      const value = await execute();
      try { this.capture?.(evidence, 'write_returned'); }
      catch (cause) { throw new PlatformOperationError('平台调用已返回，但结果记录未能持久化，请先核查。', 'write_uncertain', { cause }); }
      return value; // Completion still requires the phase's authoritative readback.
    } catch (cause) {
      if ((cause as { authorizationDenied?: boolean; uncertainWrite?: boolean })?.authorizationDenied
        || (cause as { uncertainWrite?: boolean })?.uncertainWrite) throw cause;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const kind = classifyPlatformFailure(error);
      const uncertain = kind === 'network_failure' || kind === 'protocol_failure';
      this.capture?.(evidence, uncertain ? 'write_uncertain' : kind);
      throw new PlatformOperationError(error.message, uncertain ? 'write_uncertain' : kind, { cause: error });
    }
  }
  private evidence(context: PlatformOperationContext): PlatformEvidence {
    return { id: randomUUID(), source: context.source, capability: context.capability,
      accountKey: context.accountKey, queryFingerprint: createHash('sha256').update(canonicalJson(context.query) ?? '').digest('hex'),
      observedAt: new Date().toISOString() };
  }
}

export function classifyPlatformFailure(error: Error): PlatformFailureKind {
  if (error instanceof PlatformOperationError && error.kind !== 'write_uncertain') return error.kind;
  const message = error.message;
  if (/401|403|40010001|未登录|登录.*(?:失效|过期)|没有当前资源的权限/.test(message)) return 'login_required';
  if (/timeout|timed out|超时|ECONN|ENOTFOUND|fetch failed|网络|连接中断|closed|disconnected|HTTP (?:408|429|5\d\d)/i.test(message)) return 'network_failure';
  if (/Ack=缺失|解析|JSON|响应不是|协议|字段缺失/.test(message)) return 'protocol_failure';
  return 'business_rejection';
}
