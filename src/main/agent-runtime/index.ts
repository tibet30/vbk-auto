/**
 * 通用智能体运行时装配入口。
 *
 * 三个可替换边界：Skill 注册表（能力）、ActionExecutor（写锁与收据）、
 * AgentRunService（运行事实）。IPC 层只依赖这个装配结果。
 */

import type { VbkDatabase } from "../infrastructure/database/database.js";
import { ActionExecutor } from "./action-executor.js";
import { AgentRunService } from "./run-service.js";
import { AgentSkillRegistry } from "./skill-registry.js";
import { localFileSkill } from "./skills/local-file/index.js";
import { deckSkill } from "./skills/deck/index.js";
import { webSkill } from "./skills/web/index.js";
import { createProductReadSkill, type ProductReadPort } from "./skills/product-readonly/index.js";
import { createAccountReadSkill, type AccountReadPort } from "./skills/account-readonly/index.js";
import { createVbkReadSkill, type VbkReadPort } from "./skills/vbk-readonly/index.js";
import { createVbkWriteSkill, type VbkWritePort } from "./skills/vbk-write/index.js";
import { assertBackendWritesAreVerifiable } from "./skills/backend-write-guard.js";
import type { AgentSkill } from "./types.js";

export * from "./types.js";
export { ActionExecutor } from "./action-executor.js";
export { AgentRunService } from "./run-service.js";
export { AgentSkillRegistry } from "./skill-registry.js";
export { registryForScope, scopeSkills } from "./skill-scope.js";
export {
  assertBackendWritesAreVerifiable,
  findBackendWriteViolations,
  isBackendSkill,
} from "./skills/backend-write-guard.js";
export { evaluatePermission, grantCoversAction } from "./permission-policy.js";
export { AgentPathScopeError, isPathInside, requireScopedPath, resolveScopedPath } from "./path-scope.js";
export { buildArtifactPreview, resolveArtifactForOpen } from "./artifacts.js";
export type { ArtifactPreview, ResolvedArtifact } from "./artifacts.js";
export { localFileSkill } from "./skills/local-file/index.js";
export { deckSkill } from "./skills/deck/index.js";
export { webSkill } from "./skills/web/index.js";
export { parseWebPlan, webPlanSchema, webOutline } from "./skills/web/plan.js";
export { deckOutline, parseDeckPlan, deckPlanSchema } from "./skills/deck/plan.js";
export {
  assertProductActionsReadOnly,
  createProductReadSkill,
  PRODUCT_READ_ACCOUNT,
  resolveProduct,
  statusLabel,
} from "./skills/product-readonly/index.js";
export type { ProductReadPort, ProductReadRecord } from "./skills/product-readonly/index.js";
export { createAccountReadSkill, ACCOUNT_READ_ACCOUNT } from "./skills/account-readonly/index.js";
export { createVbkReadSkill, VBK_READ_ACCOUNT } from "./skills/vbk-readonly/index.js";
export type { VbkReadPort, VbkStatusSnapshot } from "./skills/vbk-readonly/index.js";
export { createVbkWriteSkill } from "./skills/vbk-write/index.js";
export type { VbkProductBasicInfo, VbkWriteGateResult, VbkWritePort } from "./skills/vbk-write/index.js";
export type { AccountReadPort, AccountReadRecord } from "./skills/account-readonly/index.js";
export { McpServerConnection, McpTimeoutError, toolFingerprint } from "./mcp/client.js";
export type { McpConnectionDiagnostics, McpConnectionState, McpServerConfig, McpToolDescriptor } from "./mcp/client.js";
export { createMcpActions, createMcpSkill } from "./mcp/skill.js";
export { createMcpSkillSource } from "./mcp/source.js";
export type { McpDiscoveryDiagnostic, McpSkillSource } from "./mcp/source.js";

export interface AgentRuntime {
  registry: AgentSkillRegistry;
  executor: ActionExecutor;
  runs: AgentRunService;
}

export function createAgentRuntime(
  db: VbkDatabase,
  options: {
    skills?: readonly AgentSkill[];
    products?: ProductReadPort;
    accounts?: AccountReadPort;
    vbk?: VbkReadPort;
    vbkWrite?: VbkWritePort;
    /** 外部 MCP Skill：由 `createMcpSkillSource().discover()` 提供，仍然走同一套审批与收据。 */
    extraSkills?: readonly AgentSkill[];
  } = {},
): AgentRuntime {
  const skills: AgentSkill[] = [...(options.skills ?? [localFileSkill, deckSkill, webSkill])];
  // 只读查询 Skill 只在主进程提供端口时才注册：不注册任何写动作，不会替代业务门禁。
  if (options.accounts) skills.unshift(createAccountReadSkill(options.accounts));
  if (options.vbk) skills.unshift(createVbkReadSkill(options.vbk));
  if (options.vbkWrite) skills.unshift(createVbkWriteSkill(options.vbkWrite));
  if (options.extraSkills?.length) skills.push(...options.extraSkills);
  if (options.products) skills.unshift(createProductReadSkill(options.products));
  // 装配即准入：后台域写动作必须能预览、能回读，否则拒绝装配。
  assertBackendWritesAreVerifiable(skills);
  const registry = new AgentSkillRegistry(skills);
  const executor = new ActionExecutor(db, registry);
  const runs = new AgentRunService({ db, registry, executor });
  return { registry, executor, runs };
}
