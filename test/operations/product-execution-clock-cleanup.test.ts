import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { runDatabaseMigrations } from "../../src/main/infrastructure/database/parts/migration-registry.js";
import { ProductExecutionClock, waitWithoutExecutionTime } from "../../src/main/operations/product-execution-clock.js";

type ActivityMap = Map<string, unknown>;

function fixture(t: test.TestContext) {
  const db = new Database(":memory:");
  runDatabaseMigrations(db);
  let now = Date.now();
  const clock = new ProductExecutionClock(db, () => now);
  t.after(() => { clock.dispose(); db.close(); });
  return {
    db,
    clock,
    advance: (ms: number) => { now += ms; },
    activities: () => (clock as unknown as { activities: ActivityMap }).activities,
  };
}

test("completed products are removed from the in-memory activity map", (t) => {
  const { clock, activities } = fixture(t);

  for (let i = 0; i < 500; i++) {
    const end = clock.begin(`product-${i}`);
    end();
  }

  assert.equal(activities().size, 0);
});

test("a disabled activity is retained until every gate is re-enabled", (t) => {
  const { clock, advance, activities } = fixture(t);
  const end = clock.begin("paused");
  advance(1000);
  clock.setEnabled("paused", false, "agent");
  end();

  assert.equal(activities().size, 1);
  advance(60_000);
  clock.setEnabled("paused", true, "agent");
  assert.equal(activities().size, 0);
  assert.equal(clock.read("paused").elapsedMs, 1000);
});

test("nested queue waits preserve elapsed time and clean up after resume", async (t) => {
  const { clock, advance, activities } = fixture(t);

  await clock.track("nested", async () => {
    advance(1000);
    await clock.track("nested", async () => {
      await waitWithoutExecutionTime(async () => { advance(60_000); });
      advance(1000);
    });
  });

  assert.equal(clock.read("nested").elapsedMs, 2000);
  assert.equal(activities().size, 0);
});
