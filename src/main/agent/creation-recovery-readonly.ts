import { getVbkRequestPage } from "../infrastructure/vbk-request-page.js";
import { randomUUID } from "node:crypto";

import type { AutomationRun, ProductDetail } from "../../shared/contracts.js";
import type { TrafficLineEndpointPlan, TrafficLineVariant } from "../../shared/contracts-traffic-line.js";
import { normaliseTrafficLineConfig, normaliseTrafficLineVariant, trafficLineLabel } from "../../shared/contracts-traffic-line.js";
import { draftPhasesFor } from "../automation/automation.main/automation.main.phases.js";
import { runProductReadOnlyPreflightApi } from "../automation/ctrip/preflight-readonly.js";
import { verifyTrafficLineChild, type TrafficLineChildReadback } from "../automation/ctrip/traffic-line/readback.js";
import { readTrafficLineChildren } from "../automation/ctrip/traffic-line/relationships.js";
import type { TrafficLineExistingChild } from "../automation/ctrip/traffic-line/types.js";
import type { ProductWorkflowCoordinator } from "../application/product-workflow-coordinator.js";
import type { VbkBrowser } from "../infrastructure/vbk-browser.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import type { AgentTool } from "./types.js";

type CreationVariant = "draft" | "formal" | "audit" | "preview" | "unknown";
type RecoveryScope = "all" | "parent-only";

export interface CreationVariantReadback {
  /** The exact Ctrip representation used for this read; recovery accepts draft only. */
  variant: CreationVariant;
  /** Set only by the dedicated reader after explicit draft or unsubmitted-main guards. */
  unsubmittedDraftVerified: boolean;
  draftSource?: "independent" | "unsubmitted-main";
  ids: Partial<Record<Exclude<CreationVariant, "unknown">, string>>;
  poi85862?: { suffixName?: string; description?: string };
}

export interface CreationRecoveryReadOnlyDependencies {
  db: Pick<VbkDatabase, "getProduct" | "writeAutomationWithProductStatus">;
  browser: Pick<VbkBrowser, "page">;
  productWorkflows: Pick<ProductWorkflowCoordinator, "runExclusive" | "runVbkPageExclusive">;
  /** Includes the current BrowserView login and remote product binding check. */
  accountFor(localProductId: string): Promise<{ accountKey: string; productVersion: string }>;
  readCreationVariant(page: unknown, productId: string): Promise<CreationVariantReadback>;
  readPreflight?: typeof runProductReadOnlyPreflightApi;
  readTrafficChildren?: typeof readTrafficLineChildren;
  verifyTrafficChild?: typeof verifyTrafficLineChild;
  now?: () => string;
  id?: () => string;
  emitProduct?(product: ProductDetail): void;
}

interface RecoveryTarget {
  variant: TrafficLineVariant;
  child: TrafficLineExistingChild;
  readback: TrafficLineChildReadback;
}

interface RecoveryInput {
  product: ProductDetail;
  productId: string;
  productJsonVersion: number;
  productJsonSnapshot: string;
  workflowSnapshot: string;
  endpointPlan?: TrafficLineEndpointPlan;
  variants: TrafficLineVariant[];
}

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
  const id = deps.id ?? randomUUID;

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

function parseRecoveryScope(args: Record<string, unknown>): RecoveryScope {
  const value = args.scope;
  if (value === undefined || value === "all") return "all";
  if (value === "parent-only") return "parent-only";
  throw new Error("scope 只能是 all 或 parent-only。");
}

function requireProduct(deps: CreationRecoveryReadOnlyDependencies, localProductId: string): ProductDetail {
  const product = deps.db.getProduct(localProductId);
  if (!product) throw new Error("产品不存在，无法执行只读恢复。");
  return product;
}

function recoveryInput(product: ProductDetail, scope: RecoveryScope): RecoveryInput {
  const productId = product.productId?.trim();
  if (!productId) throw new Error("当前产品没有已保存的 VBK productId；不能安全恢复，也不会创建产品。");
  const traffic = normaliseTrafficLineConfig((product.product.operations as Record<string, unknown> | undefined)?.trafficLine);
  const availability = traffic?.availability;
  const variants = uniqueVariants(traffic?.variants ?? [], "产品交通计划");
  // An explicitly disabled traffic plan has no traffic child to verify. It is
  // safe to recover the complete parent draft without inventing endpoints or
  // forcing a parent-only recovery solely because a historical run had one.
  const requiresTrafficReadback = scope === "all" && traffic?.enabled === true;
  if (requiresTrafficReadback) {
    if (!traffic?.enabled || !variants.length || !availability?.endpointPlan) {
      throw new Error("缺少当前会话已核验的大交通端点计划；不能把历史交通阶段恢复为完成。");
    }
    const available = uniqueVariants(availability.availableVariants, "交通可用方式");
    if (variants.length !== available.length || variants.some((variant) => !available.includes(variant))) {
      throw new Error("交通计划与当前会话已核验的可用方式不一致，不能混合历史结果恢复。");
    }
    for (const variant of variants) {
      if (variant === "flightRoundTrip" && !availability.endpointPlan.flight) {
        throw new Error("飞机往返缺少已核验端点计划，不能恢复。");
      }
      if (variant === "trainRoundTrip" && !availability.endpointPlan.train) {
        throw new Error("火车往返缺少已核验端点计划，不能恢复。");
      }
    }
  }
  return {
    product,
    productId,
    productJsonVersion: product.productJsonVersion ?? 0,
    productJsonSnapshot: productJsonSnapshot(product),
    workflowSnapshot: workflowSnapshot(product),
    ...(availability?.endpointPlan ? { endpointPlan: availability.endpointPlan } : {}),
    variants,
  };
}

function uniqueVariants(values: readonly TrafficLineVariant[], label: string): TrafficLineVariant[] {
  const unique = [...new Set(values)];
  if (unique.length !== values.length) throw new Error(`${label}存在重复方式，不能安全恢复。`);
  return unique;
}

function assertUnsubmittedDraft(readback: CreationVariantReadback): string {
  if (readback.variant !== "draft" || readback.unsubmittedDraftVerified !== true) {
    throw new Error("未读取到已确认的未提审草稿 variant；不会把 formal、audit 或 preview 结果混作草稿完成证据。");
  }
  const draftId = readback.ids.draft?.trim();
  if (!draftId) throw new Error("未提审草稿回读缺少 draft ID，不能安全恢复。");
  return draftId;
}

async function verifyTrafficTargets(args: {
  children: TrafficLineExistingChild[];
  input: RecoveryInput;
  page: unknown;
  verifyTrafficChild: typeof verifyTrafficLineChild;
}): Promise<RecoveryTarget[]> {
  const byVariant = new Map<TrafficLineVariant, TrafficLineExistingChild[]>();
  for (const child of args.children) {
    const variant = normaliseTrafficLineVariant(child.lineDescription);
    if (!variant) throw new Error(`母产品交通子产品存在无法识别的方式「${child.lineDescription}」，不能安全恢复。`);
    const list = byVariant.get(variant) ?? [];
    list.push(child);
    byVariant.set(variant, list);
  }
  for (const variant of args.input.variants) {
    const matches = byVariant.get(variant) ?? [];
    if (matches.length !== 1) {
      throw new Error(`${trafficLineLabel(variant)}子产品回读数量为 ${matches.length}，无法唯一确认母子关系。`);
    }
  }
  const extras = [...byVariant.keys()].filter((variant) => !args.input.variants.includes(variant));
  if (extras.length) throw new Error(`母产品出现未在本次已核验交通计划中的子产品：${extras.map(trafficLineLabel).join("、")}。`);

  const targets: RecoveryTarget[] = [];
  if (!args.input.endpointPlan) throw new Error("缺少当前会话已核验的大交通端点计划，不能回读交通子产品。");
  for (const variant of args.input.variants) {
    const child = byVariant.get(variant)![0]!;
    const readback = await args.verifyTrafficChild(args.page as never, args.input.productId, child.productId, variant, args.input.endpointPlan);
    targets.push({ variant, child, readback });
  }
  return targets;
}

function assertUnchanged(deps: CreationRecoveryReadOnlyDependencies, localProductId: string, initial: RecoveryInput): void {
  const current = requireProduct(deps, localProductId);
  const changes: string[] = [];
  if (current.productId?.trim() !== initial.productId) changes.push("productId");
  if (productJsonSnapshot(current) !== initial.productJsonSnapshot) changes.push("productJson");
  if (workflowSnapshot(current) !== initial.workflowSnapshot) changes.push("status/automation/trafficLine");
  if (changes.length) {
    throw new Error(`恢复读取期间产品或自动化流程版本已变化（变化字段：${changes.join("、")}），未写入本地完成状态。`);
  }
}

function productJsonSnapshot(product: ProductDetail): string {
  const data = structuredClone(product.product) as Record<string, unknown>;
  delete data.diagnostics;
  return JSON.stringify(canonical(data));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

function workflowSnapshot(product: ProductDetail): string {
  return JSON.stringify({ status: product.status, automation: product.automation, trafficLine: (product.product.operations as Record<string, unknown> | undefined)?.trafficLine });
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

function projectCreationVariant(value: CreationVariantReadback) {
  return {
    variant: value.variant,
    unsubmittedDraftVerified: value.unsubmittedDraftVerified,
    ...(value.draftSource ? { draftSource: value.draftSource } : {}),
    ids: value.ids,
    ...(value.poi85862 ? { poi85862: value.poi85862 } : {}),
  };
}

function projectPreflight(value: unknown): Record<string, unknown> {
  const evidence = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    productId: evidence.productId,
    verifiedWith: evidence.verifiedWith,
    basic: evidence.basic,
    presentation: evidence.presentation,
    itinerary: evidence.itinerary,
    package: evidence.package,
    pricingInventory: evidence.pricingInventory,
    clauses: evidence.clauses,
    resources: evidence.resources,
  };
}

function projectTrafficTarget(target: RecoveryTarget) {
  return {
    variant: target.variant,
    productId: target.child.productId,
    lineDescription: target.child.lineDescription,
    packageId: target.child.packageId,
    active: target.child.active,
    finalReadback: {
      tourInfoId: target.readback.tourInfoId,
      segmentCount: target.readback.segmentCount,
      departureCityCount: target.readback.departureCityCount,
      transportNodes: target.readback.transportNodes,
      clauseCount: target.readback.clauseCount,
      presentationVerified: target.readback.presentationVerified,
    },
  };
}
