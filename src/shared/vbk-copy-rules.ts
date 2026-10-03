import { z } from "zod";

export const remoteCopyRuleSchema = z.object({
  key: z.string().min(1).max(100), term: z.string().min(1).max(120),
  module: z.enum(["all", "presentation", "itinerary"]),
  source: z.enum(["builtin", "platform_feedback"]), matchKind: z.enum(["literal", "builtin_policy"]),
  reason: z.string().min(1).max(500), alternatives: z.array(z.string().max(200)).max(10),
  identityProtected: z.literal(true), enabled: z.boolean(),
}).strict();
export const remoteCopySnapshotSchema = z.object({
  version: z.string().regex(/^[a-f0-9]{64}$/), rules: z.array(remoteCopyRuleSchema).max(10000),
}).strict();
export type RemoteCopySnapshot = z.infer<typeof remoteCopySnapshotSchema>;
export type RemoteCopyRule = z.infer<typeof remoteCopyRuleSchema>;
export type CopyRuleUpload = Omit<RemoteCopyRule, "enabled">;
export const copyRuleCacheKey = (userId: number) => `vbk-copy-rules:${userId}`;

export function cachedPresentationWords(raw?: string): string[] {
  if (!raw) return [];
  try {
    const snapshot = remoteCopySnapshotSchema.parse(JSON.parse(raw));
    return snapshot.rules.filter(rule => rule.enabled && rule.matchKind === "literal"
      && (rule.module === "all" || rule.module === "presentation")).map(rule => rule.term);
  } catch { return []; }
}
