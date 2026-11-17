/**
 * 迁移执行器：汇总各迁移组并按顺序应用。
 *
 * 历史声明（0001–0018）在 `migration-registry-baseline.ts`；各领域迁移放在自己的文件里，
 * 这里只做汇总与顺序编排，避免这个文件随迁移数量无限增长。
 */

import type Database from "better-sqlite3";
import { applyMigrations } from "./migrations.js";
import { legacyMigrations } from "./migration-registry-baseline.js";
import { prepareArchitectureMigration, productArchitectureMigration } from "./product-architecture-migration.js";
import { itineraryReviewUnlockMigration } from "./itinerary-review-unlock-migration.js";
import { itinerarySpotIdMigration } from "./itinerary-spot-id-migration.js";
import {
  agentReceiptArtifactMigration,
  agentRuntimeMigration,
  agentThreadSkillsMigration,
} from "./agent-runtime-migration.js";

export { legacyMigrations };

/** 在 VbkDatabase 启动时调用一次：按顺序应用 migrations。 */
export function runDatabaseMigrations(db: Database.Database): void {
  prepareArchitectureMigration(db);
  applyMigrations(db, [...legacyMigrations, productArchitectureMigration, itineraryReviewUnlockMigration,
    itinerarySpotIdMigration, agentRuntimeMigration, agentReceiptArtifactMigration,
    agentThreadSkillsMigration]);
}
