/** 只读查询去重：同一 run 内相同工具+参数命中则复用，避免模型空转重查。 */

const CACHEABLE = new Set(["query_poi", "query_station"]);

export function isCacheableReadQuery(name: string): boolean {
  return CACHEABLE.has(name);
}

export function readQueryCacheKey(args: {
  localProductId: string;
  runId: string;
  name: string;
  arguments: Record<string, unknown>;
}): string {
  return `${args.localProductId}|${args.runId}|${args.name}|${stableArgs(args.arguments)}`;
}

export class ReadQueryCache {
  private readonly values = new Map<string, string>();

  get(key: string): string | undefined {
    return this.values.get(key);
  }

  set(key: string, content: string): void {
    this.values.set(key, content);
  }

  clearRun(localProductId: string, runId: string): void {
    const prefix = `${localProductId}|${runId}|`;
    for (const key of this.values.keys()) {
      if (key.startsWith(prefix)) this.values.delete(key);
    }
  }
}

function stableArgs(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  const normalized: Record<string, unknown> = {};
  for (const key of keys) {
    const item = value[key];
    normalized[key] = typeof item === "string" ? item.trim() : item;
  }
  return JSON.stringify(normalized);
}
