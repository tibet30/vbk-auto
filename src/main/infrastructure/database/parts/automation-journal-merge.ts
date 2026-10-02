/**
 * Local automation is an operational journal, not a remote product field.
 * A Tibet ProductDetail currently carries at most one run, so importing it
 * must never clear runs that only exist in this local journal.
 */

export interface StoredAutomationRun {
  id: string;
  localProductId: string;
  payloadJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteAutomationRun {
  id: string;
  updatedAt?: unknown;
}

export type AutomationJournalImport =
  | { action: "keep" }
  | { action: "insert"; run: RemoteAutomationRun; updatedAt: string }
  | { action: "replace"; run: RemoteAutomationRun; updatedAt: string };

function validTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function parseRun(payloadJson: string): RemoteAutomationRun | null {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return typeof record.id === "string" && record.id ? record as unknown as RemoteAutomationRun : null;
  } catch {
    return null;
  }
}

function latestTimestamp(values: unknown[]): string | null {
  const timestamps = values
    .map(validTimestamp)
    .filter((value): value is string => value !== null);
  if (!timestamps.length) return null;
  return timestamps.reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest);
}

/**
 * AutomationRun predates a root updatedAt field. For historical payloads the
 * only run-owned clock is its log and recovery-attempt timestamps. Never use
 * ProductDetail.updatedAt here: that is a different business snapshot clock.
 */
function runUpdatedAt(run: RemoteAutomationRun | null): string | null {
  if (!run) return null;
  const explicit = validTimestamp(run.updatedAt);
  if (explicit) return explicit;
  const record = run as unknown as Record<string, unknown>;
  const logs = Array.isArray(record.logs) ? record.logs : [];
  const recovery = record.recovery && typeof record.recovery === "object" && !Array.isArray(record.recovery)
    ? record.recovery as Record<string, unknown>
    : undefined;
  const phases = recovery?.phases && typeof recovery.phases === "object" && !Array.isArray(recovery.phases)
    ? Object.values(recovery.phases as Record<string, unknown>)
    : [];
  const attempts = phases.flatMap((phase) => {
    if (!phase || typeof phase !== "object" || Array.isArray(phase)) return [];
    const item = phase as Record<string, unknown>;
    return [
      ...(Array.isArray(item.attempts) ? item.attempts : []),
      ...(Array.isArray(item.attemptsHistory) ? item.attemptsHistory : []),
    ];
  });
  return latestTimestamp([
    ...logs.map((log) => log && typeof log === "object" ? (log as Record<string, unknown>).at : undefined),
    ...attempts.map((attempt) => attempt && typeof attempt === "object" ? (attempt as Record<string, unknown>).at : undefined),
  ]);
}

/**
 * Decide the one permitted replacement: same product + same run id + a
 * strictly newer, valid run timestamp from Tibet. Invalid and equal values
 * deliberately preserve the local entry.
 */
export function automationJournalImport(
  localRuns: StoredAutomationRun[],
  remoteRun: RemoteAutomationRun | undefined,
  fallbackUpdatedAt: string,
  foreignRunIdExists: boolean,
): AutomationJournalImport {
  if (!remoteRun?.id) return { action: "keep" };
  const local = localRuns.find((run) => run.id === remoteRun.id);
  const remoteUpdatedAt = runUpdatedAt(remoteRun);
  if (!local) {
    // `id` is globally primary-keyed. A collision owned by another product
    // must never be reassigned by this import.
    if (foreignRunIdExists) return { action: "keep" };
    return { action: "insert", run: remoteRun, updatedAt: remoteUpdatedAt ?? fallbackUpdatedAt };
  }
  // SQLite's row timestamp records the local save itself, so it protects a
  // freshly persisted local run even when older payloads lack log timestamps.
  const localUpdatedAt = latestTimestamp([runUpdatedAt(parseRun(local.payloadJson)), local.updatedAt]);
  if (!remoteUpdatedAt || !localUpdatedAt || Date.parse(remoteUpdatedAt) <= Date.parse(localUpdatedAt)) {
    return { action: "keep" };
  }
  return { action: "replace", run: remoteRun, updatedAt: remoteUpdatedAt };
}
