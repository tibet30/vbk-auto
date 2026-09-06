import type Database from "better-sqlite3";
import type { AgentSnapshot } from "../../../../shared/contracts.js";

export function getAgentSnapshot(db: Database.Database, localProductId: string): AgentSnapshot | undefined {
  const row = db.prepare("SELECT snapshot_json FROM agent_snapshots WHERE local_product_id = ?").get(localProductId) as { snapshot_json: string } | undefined;
  return row ? JSON.parse(row.snapshot_json) as AgentSnapshot : undefined;
}

export function saveAgentSnapshot(db: Database.Database, snapshot: AgentSnapshot): void {
  db.prepare(`INSERT INTO agent_snapshots(local_product_id, snapshot_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(local_product_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at`)
    .run(snapshot.localProductId, JSON.stringify(snapshot), new Date().toISOString());
}
