import type { ProductExecutionClock } from "../../operations/product-execution-clock.js";

/** Start the clock only after product ownership is acquired; always release it. */
export async function runAutomationExclusive<T>(args: {
  localProductId: string;
  running: Set<string>;
  cancellationRequested: Set<string>;
  clock?: ProductExecutionClock;
  work: () => Promise<T>;
}): Promise<T> {
  const { localProductId: id, running, cancellationRequested, clock, work } = args;
  if (running.has(id)) throw new Error("该产品的自动录入正在进行中，请等待本轮结束。");
  running.add(id);
  cancellationRequested.delete(id);
  clock?.setEnabled(id, true, "automation");
  try { return await (clock ? clock.track(id, work) : work()); }
  finally { running.delete(id); cancellationRequested.delete(id); }
}
