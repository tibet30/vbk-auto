import type Database from "better-sqlite3";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ProductExecutionTime } from "../../shared/product-execution-time.js";
import { historicalExecutionTime } from "./product-execution-history.js";

interface ClockRow { elapsed_ms: number; active_since: number | null; historical_incomplete: number }
interface Activity { count: number; disabled: Set<string>; since?: number }
interface Scope { suspend(): void; resume(): void }
const scopes = new AsyncLocalStorage<Scope[]>();

export function ensureProductExecutionTime(db: Database.Database, id: string): void {
  if (db.prepare("SELECT 1 FROM product_execution_time WHERE local_product_id=?").get(id)) return;
  const baseline = historicalExecutionTime(db, id);
  db.prepare("INSERT INTO product_execution_time(local_product_id,elapsed_ms,historical_incomplete) VALUES(?,?,?)")
    .run(id, baseline.elapsedMs, baseline.historicalIncomplete ? 1 : 0);
}

export function readProductExecutionTime(db: Database.Database, id: string, now = Date.now()): ProductExecutionTime {
  const row = db.prepare("SELECT * FROM product_execution_time WHERE local_product_id=?").get(id) as ClockRow | undefined;
  if (!row) return historicalExecutionTime(db, id);
  return {
    elapsedMs: row.elapsed_ms + (row.active_since === null ? 0 : Math.max(0, Math.min(now - row.active_since, 2500))),
    running: row.active_since !== null && now - row.active_since <= 2500,
    historicalIncomplete: Boolean(row.historical_incomplete),
  };
}

/** Reference-counted union clock; checkpoints bound loss on process interruption. */
export class ProductExecutionClock {
  private activities = new Map<string, Activity>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private db: Database.Database, private now = Date.now) {
    // Never extend an interrupted interval through app downtime.
    db.prepare("UPDATE product_execution_time SET active_since=NULL WHERE active_since IS NOT NULL").run();
  }

  read(id: string): ProductExecutionTime {
    if (this.db.prepare("SELECT 1 FROM products WHERE id=?").get(id)) this.ensure(id);
    return readProductExecutionTime(this.db, id, this.now());
  }

  readIfKnown(id: string): ProductExecutionTime | undefined {
    return this.db.prepare("SELECT 1 FROM products WHERE id=?").get(id) ? this.read(id) : undefined;
  }

  begin(id: string): () => void {
    this.ensure(id);
    const activity = this.activities.get(id) ?? { count: 0, disabled: new Set<string>() };
    this.activities.set(id, activity);
    activity.count++;
    this.sync(id, activity);
    if (!this.timer) {
      this.timer = setInterval(() => this.checkpoint(), 1000);
      this.timer.unref();
    }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      activity.count--;
      this.sync(id, activity);
      if (![...this.activities.values()].some((value) => value.count > 0)) {
        clearInterval(this.timer); this.timer = undefined;
      }
    };
  }

  async track<T>(id: string, work: () => Promise<T>): Promise<T> {
    let end = this.begin(id);
    let suspended = 0;
    let finished = false;
    const scope: Scope = {
      suspend: () => { if (!finished && suspended++ === 0) end(); },
      resume: () => { if (!finished && --suspended === 0) end = this.begin(id); },
    };
    try { return await scopes.run([...(scopes.getStore() ?? []), scope], work); }
    finally { finished = true; end(); }
  }

  setEnabled(id: string, enabled: boolean, source = "agent"): void {
    const activity = this.activities.get(id) ?? { count: 0, disabled: new Set<string>() };
    this.activities.set(id, activity);
    if (enabled) activity.disabled.delete(source); else activity.disabled.add(source);
    this.sync(id, activity);
  }

  checkpoint(): void {
    for (const [id, activity] of this.activities) if (activity.since !== undefined) this.sync(id, activity);
  }

  dispose(): void {
    for (const [id, activity] of this.activities) {
      activity.disabled.add("shutdown"); this.sync(id, activity);
    }
    clearInterval(this.timer); this.timer = undefined;
  }

  ensure(id: string): void {
    ensureProductExecutionTime(this.db, id);
  }

  private sync(id: string, activity: Activity): void {
    const at = this.now();
    const delta = activity.since === undefined ? 0 : Math.max(0, at - activity.since);
    activity.since = activity.count > 0 && activity.disabled.size === 0 ? at : undefined;
    if (delta || activity.since !== undefined) this.ensure(id);
    this.db.prepare("UPDATE product_execution_time SET elapsed_ms=elapsed_ms+?,active_since=? WHERE local_product_id=?")
      .run(delta, activity.since ?? null, id);
  }
}

let currentClock: ProductExecutionClock | undefined;
process.once("exit", () => currentClock?.dispose());
export function setProductExecutionClock(clock: ProductExecutionClock | undefined): void { currentClock = clock; }
export function clearProductExecutionClock(clock: ProductExecutionClock): void {
  if (currentClock === clock) currentClock = undefined;
}
export function trackProductExecution<T>(id: string | undefined, work: () => Promise<T>): Promise<T> {
  return id && currentClock ? currentClock.track(id, work) : work();
}

/** Suspend just this async call chain; other parallel work keeps counting. */
export async function waitWithoutExecutionTime<T>(wait: () => Promise<T>): Promise<T> {
  const active = scopes.getStore() ?? [];
  active.forEach((scope) => scope.suspend());
  try { return await wait(); } finally { active.forEach((scope) => scope.resume()); }
}
