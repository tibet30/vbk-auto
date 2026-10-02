const MAX_RENDERER_RECOVERY_ATTEMPTS = 1;

export function rendererRecoveryDelay(attempt: number): number {
  return 500 * Math.max(1, attempt);
}

export function shouldRecoverRenderer(reason: string, attempts: number): boolean {
  return attempts < MAX_RENDERER_RECOVERY_ATTEMPTS && (reason === "crashed" || reason === "oom");
}
