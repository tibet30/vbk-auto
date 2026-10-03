import { AsyncLocalStorage } from "node:async_hooks";
import type { Page } from "playwright";
import type { AutomationSession } from "./vbk-automation-session.js";

/** Async scope is product-local even when async callbacks from different runs interleave. */
export class VbkAutomationSessions {
  private readonly scope = new AsyncLocalStorage<AutomationSession>();
  private readonly active = new Set<AutomationSession>();
  ownsPage(page: Page) { return [...this.active].some(worker => worker.page === page); }
  current() { return this.scope.getStore(); }
  async run<T>(create: () => Promise<AutomationSession>, task: () => Promise<T>): Promise<T> {
    const worker = await create();
    this.active.add(worker);
    try { return await this.scope.run(worker, task); }
    finally { this.active.delete(worker); await worker.close(); }
  }
  async dispose() { await Promise.all([...this.active].map(worker => worker.close())); }
}

