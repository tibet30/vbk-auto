import { useEffect, useRef, useState } from "react";
import type { ProductSummary } from "../../../shared/contracts-types.js";
import type { ProductExecutionTime } from "../../../shared/product-execution-time.js";

/** Poll only local telemetry; no remote product fetch or business-state write. */
export function useProductExecutionTimes(products: readonly ProductSummary[]) {
  const key = JSON.stringify(products.map((product) => product.id));
  const [times, setTimes] = useState<Record<string, ProductExecutionTime>>({});
  const fallback = useRef(products);
  fallback.current = products;
  useEffect(() => {
    const ids = JSON.parse(key) as string[];
    const api = window.vbk?.products;
    const readTimes = api?.executionTimes?.bind(api);
    if (!ids.length || !readTimes) return;
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await readTimes(ids);
        if (!disposed) setTimes(next);
      } catch {
        // Preserve the last persisted sample if the main process is unavailable.
      } finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [key]);
  return Object.fromEntries(fallback.current.map((product) => [product.id, times[product.id] ?? product.executionTime]));
}
