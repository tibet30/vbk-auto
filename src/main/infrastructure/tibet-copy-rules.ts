import { createHash } from "node:crypto";
import type { AppAuthStore } from "./app-auth-store.js";
import { resolveTibetApiBaseUrl } from "./tibet-auth.js";
import { VBK_COPY_BAD_CASES } from "../planning/vbk-copy-policy.js";
import { copyRuleCacheKey, remoteCopySnapshotSchema, type CopyRuleUpload } from "../../shared/vbk-copy-rules.js";

interface CopyRuleStore {
  listLocalRejectedPresentationWords(): string[];
  setSetting(key: string, value: string): void;
}
export function exportLocalCopyRules(words: readonly string[]): CopyRuleUpload[] {
  const rules: CopyRuleUpload[] = VBK_COPY_BAD_CASES.map(rule => ({
    key: `builtin:${createHash("sha256").update(rule.term).digest("hex")}`,
    term: rule.term, module: "all", source: "builtin",
    matchKind: rule.pattern.source === rule.term ? "literal" : "builtin_policy",
    reason: rule.reason, alternatives: [...rule.alternatives], identityProtected: true,
  }));
  for (const term of new Set(words)) {
    if (rules.some(rule => rule.term === term && rule.matchKind === "literal")) continue;
    rules.push({ key: `feedback:presentation:${createHash("sha256").update(term).digest("hex")}`,
      term, module: "presentation", source: "platform_feedback", matchKind: "literal",
      reason: "平台曾拒绝产品图文中的此词，请使用中性描述并以平台校验为准。",
      alternatives: [], identityProtected: true });
  }
  return rules;
}

export function createTibetCopyRuleSync(
  auth: AppAuthStore, db: CopyRuleStore,
  options: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
) {
  const endpoint = `${resolveTibetApiBaseUrl(options.baseUrl)}/api/extension/desktop-copy-rules`;
  const fetchImpl = options.fetchImpl ?? fetch;
  let active: Promise<{ userId: number; version: string; count: number }> | undefined;
  const sync = async () => {
    const session = auth.get();
    if (!session) throw new Error("词库同步需要登录应用账号。");
    const userId = session.user.id;
    const request = async (method: "GET" | "POST", body?: object) => {
      const response = await fetchImpl(endpoint, { method, signal: AbortSignal.timeout(15000),
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new Error(`词库同步失败（HTTP ${response.status}），继续使用本地词库。`);
      const payload = await response.json() as { code?: number; data?: unknown };
      if (payload.code !== 200) throw new Error("远端词库同步响应异常，继续使用本地词库。");
      return remoteCopySnapshotSchema.parse(payload.data);
    };
    const rules = exportLocalCopyRules(db.listLocalRejectedPresentationWords());
    for (let index = 0; index < rules.length; index += 500) {
      await request("POST", { rules: rules.slice(index, index + 500) });
    }
    const snapshot = await request("GET");
    if (auth.get()?.user.id !== userId) throw new Error("应用账号已切换，未应用旧账号词库。");
    // 上传后独立回读，防止把只发送成功当作完成；共享端新词通过合并保留。
    if (!rules.every(rule => snapshot.rules.some(saved => saved.key === rule.key && saved.term === rule.term))) {
      throw new Error("远端回读缺少上传词条，保留本地有效缓存。");
    }
    db.setSetting(copyRuleCacheKey(userId), JSON.stringify(snapshot));
    return { userId, version: snapshot.version, count: snapshot.rules.length };
  };
  return { sync() {
    if (!active) active = sync().finally(() => { active = undefined; });
    return active;
  } };
}
