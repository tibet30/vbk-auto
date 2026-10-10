/** Only precise authoritative readback mismatches can reopen a completed module. */
export function preflightRepairPhase(error: string): 'presentation' | 'hotelResource' | undefined {
  if (/^产品图文预检推荐理由不一致：缺少「.+」/u.test(error)) return 'presentation';
  // A zero lodging-segment readback is equally authoritative: the existing
  // candidates were never materialized remotely, so retrying preflight would
  // only repeat the same read-only check.
  if (/^酒店资源只读回读住宿段数量不一致：期望 \d+，实际 \d+$/u.test(error)) return 'hotelResource';
  if (/^酒店资源只读回读第 \d+ 段候选 ID 集合不一致：期望=[\d,]+，实际=/u.test(error)) return 'hotelResource';
  return undefined;
}
