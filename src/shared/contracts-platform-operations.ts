export type PlatformFailureKind = 'login_required' | 'network_failure' | 'protocol_failure' | 'business_rejection';
export interface PlatformEvidence {
  id: string;
  source: 'vbk' | 'ctrip';
  capability: string;
  accountKey?: string;
  queryFingerprint: string;
  observedAt: string;
  verifiedAt?: string;
}
export type PlatformQueryResult<T> =
  | { status: 'found' | 'empty'; value: T; evidence: PlatformEvidence }
  | { status: PlatformFailureKind; error: Error; evidence: PlatformEvidence };
