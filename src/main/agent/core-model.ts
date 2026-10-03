import type { AgentModel, AgentModelInput, AgentModelResult } from "./types.js";

import { isTransientModelError } from "./transient-error.js";
export { isTransientModelError } from "./transient-error.js";

/** One initial attempt plus two bounded retries for transient transport/provider failures. */
export async function completeWithRetries(
  model: AgentModel,
  input: AgentModelInput,
  productId?: string,
): Promise<AgentModelResult> {
  const { trackProductExecution } = await import("../operations/product-execution-clock.js");
  return trackProductExecution(productId, async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await model.complete(input);
      } catch (error) {
        if (attempt >= 2 || !isTransientModelError(error)) throw error;
        await input.onContent?.("");
      }
    }
  });
}
