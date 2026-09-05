export interface StableReadbackActions<T, R> {
  key: (item: T) => string;
  verify: (item: T) => Promise<R>;
  signature: (item: T, readback: R) => string;
  canRepair: (error: unknown) => boolean;
  repair: (item: T, error: unknown) => Promise<void>;
}

export interface StableReadbackOptions {
  intervalMs?: number;
  requiredConsecutive?: number;
  maxSamples?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * 激活后的平台重算可能晚于首次成功回读。只有整组结果连续稳定，才允许外层
 * 持久化 finalReadback；明确的业务缺失可按 item 有界修复一次，会话/协议错误
 * 不会进入修复分支。
 */
export async function waitForStableReadbackGroup<T, R>(
  items: readonly T[],
  actions: StableReadbackActions<T, R>,
  options: StableReadbackOptions = {},
): Promise<R[]> {
  if (!items.length) return [];
  const intervalMs = Math.max(0, options.intervalMs ?? 30_000);
  const requiredConsecutive = Math.max(2, options.requiredConsecutive ?? 3);
  const maxSamples = Math.max(requiredConsecutive, options.maxSamples ?? items.length * 2 + requiredConsecutive + 2);
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const repaired = new Set<string>();
  let previousSignature = "";
  let consecutive = 0;

  for (let sample = 1; sample <= maxSamples; sample += 1) {
    await sleep(intervalMs);
    const results: R[] = [];
    let repairedThisSample = false;
    for (const item of items) {
      try {
        results.push(await actions.verify(item));
      } catch (error) {
        const key = actions.key(item);
        if (!repaired.has(key) && actions.canRepair(error)) {
          repaired.add(key);
          await actions.repair(item, error);
          repairedThisSample = true;
          break;
        }
        throw error;
      }
    }
    if (repairedThisSample) {
      previousSignature = "";
      consecutive = 0;
      continue;
    }
    const signature = results.map((result, index) =>
      actions.signature(items[index]!, result)).join("\n");
    consecutive = signature === previousSignature ? consecutive + 1 : 1;
    previousSignature = signature;
    if (consecutive >= requiredConsecutive) return results;
  }
  throw new Error(`子产品激活后在 ${maxSamples} 次整组回读中未达到连续稳定门。`);
}
