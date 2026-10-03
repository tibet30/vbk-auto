import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { ProductExecutionTime } from "../../../shared/product-execution-time.js";
import { ProductExecutionClock, setProductExecutionClock, clearProductExecutionClock } from "../../operations/product-execution-clock.js";
import { runDatabaseMigrations } from "./parts/migration-registry.js";

/** Own the connection and local telemetry for the application lifetime. */
export class ProductExecutionDatabase {
  protected db: Database.Database;
  readonly executionClock: ProductExecutionClock;

  constructor(dataPath: string, now = Date.now) {
    fs.mkdirSync(dataPath, { recursive: true });
    this.db = new Database(path.join(dataPath, "vbk-desktop.sqlite"));
    this.db.pragma("journal_mode = WAL");
    runDatabaseMigrations(this.db);
    this.executionClock = new ProductExecutionClock(this.db, now);
    setProductExecutionClock(this.executionClock);
  }

  getProductExecutionTimes(ids: readonly string[]): Record<string, ProductExecutionTime> {
    return Object.fromEntries([...new Set(ids)].flatMap(id => {
      const time = this.executionClock.readIfKnown(id);
      return time ? [[id, time]] : [];
    }));
  }

  close(): void {
    if (!this.db.open) return;
    this.executionClock.dispose();
    clearProductExecutionClock(this.executionClock);
    this.db.close();
  }
}
