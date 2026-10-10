/**
 * automation_runs + 关联产品状态写入：
 *   - saveAutomation：保存/替换某产品的 automation run（同 run.id 多次保存会覆盖）；
 *   - writeAutomationWithProductStatus：事务化"产品状态 + 自动化运行"原子写入；
 *   - recoverOrphanAutomationRuns：启动时清理 automation.status=running 的孤儿 run；
 *     标记为 failed，把 recovery.phases 里仍处于 running / advising / retrying 的记录
 *     强制改成 needs_user，并补一条 warning log；返回受影响的产品 ID 列表。
 *
 * 业务一致性：product.status="automating" 与 automation run payload 是一致单元，
 * 因此 writeAutomationWithProductStatus 必须事务化。
 */

import type Database from "better-sqlite3";
import type { AutomationRun, ProductSummary } from "../../../../../shared/contracts.js";
import { now } from "../types.js";

export function saveAutomation(db: Database.Database, localProductId: string, run: AutomationRun) {
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO automation_runs(id,local_product_id,payload_json,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at")
      .run(run.id, localProductId, JSON.stringify(run), now(), now());
  });
  tx();
}

/**
 * 一次性事务写：产品状态 + 自动化运行 要么全成、要么全失败。
 * 业务上 product.status="automating" 与 automation run payload 是一致单元。
 */
export function writeAutomationWithProductStatus(db: Database.Database, localProductId: string, run: AutomationRun, status: ProductSummary["status"]): void {
  const tx = db.transaction(() => {
    db.prepare("UPDATE products SET status=?, updated_at=? WHERE id=?").run(status, now(), localProductId);
    db.prepare("INSERT INTO automation_runs(id,local_product_id,payload_json,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at")
      .run(run.id, localProductId, JSON.stringify(run), now(), now());
  });
  tx();
}

/**
 * 重启时清理 automation.status=running 的孤儿 run：标记为 failed，
 * 把 recovery.phases 里仍处于 running / advising / retrying 的记录强制
 * 改成 needs_user，并补一条 warning log。返回受影响的产品 ID 列表。
 */
export function recoverOrphanAutomationRuns(db: Database.Database): string[] {
  const orphans = db.prepare(`
    SELECT local_product_id, payload_json FROM automation_runs
    WHERE payload_json LIKE '%"status":"running"%'
  `).all() as Array<{ local_product_id: string; payload_json: string }>;
  const touchedProducts: string[] = [];
  const updateRun = db.prepare("UPDATE automation_runs SET payload_json=?, updated_at=? WHERE local_product_id=? AND payload_json LIKE '%\"status\":\"running\"%'");
  const updateProduct = db.prepare("UPDATE products SET status=?, updated_at=? WHERE id=?");
  const tx = db.transaction(() => {
    for (const row of orphans) {
      try {
        const run = JSON.parse(row.payload_json) as AutomationRun;
        if (run.status !== "running") continue;
        run.status = "failed";
        run.recovery ??= { phases: {} };
        const markInterrupted = (phase: string) => {
          const current = run.recovery!.phases[phase];
          run.recovery!.phases[phase] = {
            ...current,
            phase,
            state: "needs_user",
            attempts: current?.attempts ?? [],
            finalError: "应用重启导致自动录入被中断",
            userInstruction: current?.userInstruction || "应用已保留完成阶段，将从当前阶段重新执行。",
          };
        };
        let markedCurrentPhase = false;
        for (const phase of run.phases) {
          if (phase.status === "running") {
            phase.status = "failed";
            markInterrupted(phase.phase);
            markedCurrentPhase ||= phase.phase === run.currentPhase;
          }
        }
        for (const rec of Object.values(run.recovery.phases)) {
          if (rec.state === "running" || rec.state === "advising" || rec.state === "retrying") {
            markInterrupted(rec.phase);
            markedCurrentPhase ||= rec.phase === run.currentPhase;
          }
        }
        if (!markedCurrentPhase && run.currentPhase) markInterrupted(run.currentPhase);
        run.logs.push({ at: new Date().toISOString(), message: "应用重启，已保留完成阶段并准备从断点继续", level: "warning" });
        updateRun.run(JSON.stringify(run), now(), row.local_product_id);
        const product = db.prepare("SELECT status FROM products WHERE id=?").get(row.local_product_id) as { status: string } | undefined;
        if (product && product.status !== "draft_saved" && product.status !== "blocked") {
          updateProduct.run("blocked", now(), row.local_product_id);
        }
        touchedProducts.push(row.local_product_id);
      } catch { /* leave unreadable legacy payload untouched */ }
    }
  });
  tx();
  return touchedProducts;
}