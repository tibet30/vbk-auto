/**
 * creation-recovery-readonly 入口（barrel + createVbkCreationRecoveryTools）：
 *   - types.ts：所有 interface / type（CreationVariant / RecoveryScope /
 *     CreationVariantReadback / CreationRecoveryReadOnlyDependencies /
 *     RecoveryTarget / RecoveryInput）；
 *   - snapshots.ts：productJsonSnapshot / canonical / workflowSnapshot / assertUnchanged；
 *   - recovery-run.ts：parseRecoveryScope / requireProduct / recoveryInput /
 *     uniqueVariants / assertUnsubmittedDraft；
 *   - recovery-input.ts：verifyTrafficTargets；
 *   - project.ts：projectCreationVariant / projectPreflight / projectTrafficTarget；
 *
 * createVbkCreationRecoveryTools 是 read_vbk_creation_recovery 工具工厂，
 *   全程只读 VBK，不会创建 / 保存 / 启用 / 提交 / 发布任何 VBK 产品。
 *   写入必须在 all 远端读回 + 第二次本地版本守卫通过之后。
 */

import { randomUUID } from "node:crypto";
import { getVbkRequestPage } from "../infrastructure/vbk-request-page.js";
import { runProductReadOnlyPreflightApi } from "../automation/ctrip/preflight-readonly.js";
import { verifyTrafficLineChild } from "../automation/ctrip/traffic-line/readback.js";
import { readTrafficLineChildren } from "../automation/ctrip/traffic-line/relationships.js";
import { draftPhasesFor } from "../automation/automation.main/automation.main.phases.js";
import type { AutomationRun } from "../../shared/contracts.js";
import type { AgentTool } from "./types.js";
import { assertUnsubmittedDraft, parseRecoveryScope, recoveryInput, requireProduct, uniqueVariants } from "./creation-recovery-readonly/recovery-run.js";
import { verifyTrafficTargets } from "./creation-recovery-readonly/recovery-input.js";
import { assertUnchanged } from "./creation-recovery-readonly/snapshots.js";
import { projectCreationVariant, projectPreflight, projectTrafficTarget } from "./creation-recovery-readonly/project.js";
import type { CreationRecoveryReadOnlyDependencies, RecoveryInput, RecoveryScope, RecoveryTarget } from "./creation-recovery-readonly/types.js";

export type { CreationVariant, RecoveryScope, CreationVariantReadback, CreationRecoveryReadOnlyDependencies, RecoveryTarget, RecoveryInput } from "./creation-recovery-readonly/types.js";
export { parseRecoveryScope, requireProduct, recoveryInput, uniqueVariants, assertUnsubmittedDraft } from "./creation-recovery-readonly/recovery-run.js";
export { assertUnchanged, canonical, productJsonSnapshot, workflowSnapshot } from "./creation-recovery-readonly/snapshots.js";
export { verifyTrafficTargets } from "./creation-recovery-readonly/recovery-input.js";
export { projectCreationVariant, projectPreflight, projectTrafficTarget } from "./creation-recovery-readonly/project.js";

/**
 * Read-only reconciliation for a product that was already saved by VBK while
 * its older local automation run stopped as failed. It deliberately exposes no
 * create/save/activate/submit operation. A new local run is appended only after
 * every remote readback and the second local-version guard pass.
 */
export function createVbkCreationRecoveryTools(deps: CreationRecoveryReadOnlyDependencies): AgentTool[] {
  const readPreflight = deps.readPreflight ?? runProductReadOnlyPreflightApi;
  const readTrafficChildren = deps.readTrafficChildren ?? readTrafficLineChildren;
  const verifyTrafficChild = deps.verifyTrafficChild ?? verifyTrafficLineChild;
  const now = deps.now ?? (() => new Date().toISOString());
  const id = deps.id ?? (() => randomUUID());

  return [{
    name: "read_vbk_creation_recovery",
    write: true,
    requiresApproval: false,
    description: "只读核对已存在的 VBK 未提审草稿、母产品和交通子产品；全部远端证据和版本守卫通过后，才追加本地恢复检查点。不会创建、保存、启用、提交或发布任何 VBK 产品。scope=parent-only 仅在用户明确授权时核对母产品并延后交通子产品，默认 all 仍要求全部交通子产品回读。",
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["all", "parent-only"],
          description: "默认 all。仅用户明确授权母产品范围时使用 parent-only；它不读取或标记交通子产品完成，并保留交通阶段供后续 backfill。",
        },
      },
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const scope = parseRecoveryScope(args);
      return deps.productWorkflows.runExclusive(ctx.localProductId, "resource", () =>
        deps.productWorkflows.runVbkPageExclusive(async () => {
          const input = recoveryInput(requireProduct(deps, ctx.localProductId), scope);
          const beforeAccount = await deps.accountFor(ctx.localProductId);
          const page = await getVbkRequestPage(deps.browser);
          const draft = await deps.readCreationVariant(page, input.productId);
          const draftTourInfoId = assertUnsubmittedDraft(draft);

          const preflight = await readPreflight(page, input.product.product, input.productId, { itineraryTourInfoId: draftTourInfoId });
          const targets = scope === "all" && input.variants.length > 0
            ? await verifyTrafficTargets({
              children: await readTrafficChildren(page, input.productId),
              input,
              page,
              verifyTrafficChild,
            })
            : [];

          const afterAccount = await deps.accountFor(ctx.localProductId);
          if (afterAccount.accountKey !== beforeAccount.accountKey || afterAccount.productVersion !== beforeAccount.productVersion) {
            throw new Error("恢复读取期间当前 VBK 账号或产品版本已变化，未写入本地完成状态。");
          }
          // accountFor is the final await before persistence. Re-read immediately
          // so a concurrent workflow cannot create a stale completion run.
          assertUnchanged(deps, ctx.localProductId, input);

          const run = completedRecoveryRun(input, targets, scope, now(), id());
          const verifiedTraffic = scope === "all" && input.variants.length > 0;
          deps.db.writeAutomationWithProductStatus(ctx.localProductId, run, "draft_saved");
          const saved = requireProduct(deps, ctx.localProductId);
          deps.emitProduct?.(saved);
          return {
            content: scope === "all" && verifiedTraffic
              ? "只读恢复已完成：VBK 草稿、母产品预检和全部交通子产品均已回读确认；已追加新的本地恢复检查点，未重复创建、保存、启用或提审。"
              : scope === "all"
                ? "只读恢复已完成：VBK 草稿和母产品预检均已回读确认；产品明确不录入大交通，未创建、保存、启用或提审。"
              : "只读母产品恢复已完成：VBK 草稿和母产品预检均已回读确认；交通子产品保持历史状态并延后 backfill，未重复创建、保存、启用或提审。",
            terminal: true,
            data: {
              productId: input.productId,
              productJsonVersionAtRead: input.productJsonVersion,
              accountKey: beforeAccount.accountKey,
              creationVariant: projectCreationVariant(draft),
              preflight: projectPreflight(preflight),
              trafficLine: scope === "all"
                ? targets.map(projectTrafficTarget)
                : { scope, deferred: true, variants: input.variants },
              automation: {
                id: run.id,
                status: run.status,
                finalReadbackVerified: scope === "all",
                motherReadbackVerified: true,
                recoveryMode: "readonly",
                scope,
              },
            },
          };
        }),
      );
    },
  }];
}

function completedRecoveryRun(input: RecoveryInput, targets: RecoveryTarget[], scope: RecoveryScope, at: string, runId: string): AutomationRun {
  const phaseNames = draftPhasesFor(input.product.product as Parameters<typeof draftPhasesFor>[0]);
  const hasTrafficPhase = phaseNames.includes("trafficLine");
  if (scope === "all" && phaseNames.includes("trafficLine") && !input.endpointPlan) {
    throw new Error("当前产品交通阶段缺少端点计划，拒绝写入交通恢复检查点。");
  }
  const motherPhaseNames = scope === "parent-only"
    ? phaseNames.filter((phase) => phase !== "trafficLine")
    : phaseNames;
  const preservedTrafficLine = input.product.automation?.trafficLine;
  const preservedParentTrafficLine = preservedTrafficLine
    ? (() => {
      const { verifiedAt: _verifiedAt, ...history } = structuredClone(preservedTrafficLine);
      return history;
    })()
    : undefined;
  return {
    id: `readonly-recovery:${runId}`,
    status: "succeeded",
    phases: motherPhaseNames.map((phase) => ({ phase, status: "completed" as const })),
    logs: [{
      at,
      level: "info",
      message: scope === "all" && hasTrafficPhase
        ? "只读恢复：已完成母产品预检、未提审草稿和交通子产品最终回读；未调用任何 VBK 写入。"
        : scope === "all"
          ? "只读恢复：已完成母产品预检和未提审草稿回读；产品明确不录入大交通，未调用任何 VBK 写入。"
        : "只读母产品恢复：已完成母产品预检和未提审草稿回读；保留交通子产品历史并延后 backfill；未调用任何 VBK 写入。",
    }],
    ...(scope === "all" && hasTrafficPhase
      ? {
        trafficLine: {
          endpointPlan: input.endpointPlan,
          verifiedAt: at,
          children: targets.map(({ variant, child }) => ({
            variant,
            lineDescription: child.lineDescription,
            childProductId: child.productId,
            completedStages: ["planned", "stationsResolved", "childCreated", "presentationCopied", "resourcesSaved", "itinerarySaved", "clausesSaved", "activated", "finalReadback"],
            verified: true,
          })),
        },
      }
      : preservedParentTrafficLine ? { trafficLine: preservedParentTrafficLine } : {}),
  };
}