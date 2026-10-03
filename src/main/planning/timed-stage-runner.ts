import { runSingleStage as runStage, type RunSingleStageArgs } from "./single-stage-runner.js";
import { trackProductExecution } from "../operations/product-execution-clock.js";
export type { SingleStageResult } from "./single-stage-runner.js";

export function runSingleStage(args: RunSingleStageArgs) {
  return trackProductExecution(args.state.localProductId, () => runStage(args));
}
