import { cachedPresentationWords, copyRuleCacheKey } from "../../../../shared/vbk-copy-rules.js";
import type Database from "better-sqlite3";
import type { VbkCopyFeedback, VbkCopyRecovery } from "../../../planning/vbk-copy-feedback.js";

export function recordCopyFeedback(db: Database.Database, entry: VbkCopyFeedback): void {
  const word = entry.word.trim();
  if (!word || word.length > 120) return;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO vbk_copy_feedback (word,module,paths_json,source,detail,first_seen_at,last_seen_at,hits)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(word,module) DO UPDATE SET paths_json=excluded.paths_json,source=excluded.source,
    detail=excluded.detail,last_seen_at=excluded.last_seen_at,hits=hits+1`).run(
      word, entry.module, JSON.stringify(entry.paths), entry.source, entry.detail.slice(0, 800), now, now,
    );
}

export function listRejectedPresentationWords(db: Database.Database, userId?: number | null): string[] {
  const local = (db.prepare("SELECT word FROM vbk_copy_feedback WHERE module='presentation' ORDER BY word").all() as Array<{ word: string }>).map(row => row.word);
  const cache = userId ? db.prepare("SELECT value FROM settings WHERE key=?").get(copyRuleCacheKey(userId)) as { value: string } | undefined : undefined;
  return [...new Set([...local, ...cachedPresentationWords(cache?.value)])];
}

export function getPresentationCopyRecovery(db: Database.Database, localProductId: string): VbkCopyRecovery | undefined {
  const row = db.prepare("SELECT payload_json FROM vbk_copy_recovery WHERE local_product_id=?").get(localProductId) as { payload_json: string } | undefined;
  return row ? JSON.parse(row.payload_json) as VbkCopyRecovery : undefined;
}

export function savePresentationCopyRecovery(db: Database.Database, localProductId: string, recovery: VbkCopyRecovery): void {
  db.prepare(`INSERT INTO vbk_copy_recovery (local_product_id,payload_json,updated_at) VALUES (?,?,?)
    ON CONFLICT(local_product_id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
    .run(localProductId, JSON.stringify(recovery), new Date().toISOString());
}
