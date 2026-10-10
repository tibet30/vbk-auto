import type { TrafficLineChildProgress } from "../../../../shared/contracts-traffic-line.js";
import { trafficLinePendingSubmitNeedsOneRecoveryRetry } from "./helpers.js";

/** One persisted recovery retry for a verified stalled async job, within the same run. */
export async function submitWithOnePendingRecovery(args: {
  submit(recoveryRetry: boolean): Promise<unknown>;
  progress(): TrafficLineChildProgress;
  readState(): Promise<{ status: string }>;
  now?: Date;
  onRecovery?(): void;
}): Promise<void> {
  try {
    await args.submit(false);
  } catch (error) {
    if (!/子产品资源提交仍在 VBK 异步核验/.test(String(error))
      || !trafficLinePendingSubmitNeedsOneRecoveryRetry(args.progress(), args.now)) throw error;
    if ((await args.readState()).status !== "pending") throw error;
    args.onRecovery?.();
    await args.submit(true);
  }
}
