import type Database from "better-sqlite3";
import type { AgentSnapshot } from "../../../../shared/contracts.js";
import { sanitizeAgentSnapshot } from "../../../../shared/agent-snapshot-sanitize.js";
import { hydrateAgentStages } from "../../../../shared/agent-stage-lifecycle.js";

export function getAgentSnapshot(db: Database.Database, localProductId: string): AgentSnapshot | undefined {
  const row = db.prepare("SELECT snapshot_json FROM agent_snapshots WHERE local_product_id = ?").get(localProductId) as { snapshot_json: string } | undefined;
  if (!row) return undefined;
  const snapshot = JSON.parse(row.snapshot_json) as AgentSnapshot;
  hydrateAgentStages(snapshot);
  return snapshot;
}

export function saveAgentSnapshot(db: Database.Database, snapshot: AgentSnapshot): void {
  hydrateAgentStages(snapshot);
  const safe = sanitizeAgentSnapshot(snapshot);
  db.prepare(`INSERT INTO agent_snapshots(local_product_id, snapshot_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(local_product_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at`)
    .run(safe.localProductId, JSON.stringify(safe), new Date().toISOString());
}
