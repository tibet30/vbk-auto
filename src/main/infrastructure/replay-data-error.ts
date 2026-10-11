/** Incomplete fixed replay is a contract failure, never a recoverable provider outage. */
export class ReplayDataMissingError extends Error {
  readonly code = 'replay_data_missing';
}

/** SDK transport errors retain the original failure through their cause chain. */
export function isReplayDataMissing(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    if (error instanceof ReplayDataMissingError) return true;
    error = (error as { cause?: unknown }).cause;
  }
  return false;
}
