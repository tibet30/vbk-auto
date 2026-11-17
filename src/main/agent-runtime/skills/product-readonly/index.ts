/**
 * 产品只读查询 Skill。
 *
 * 边界写进代码而不是只写进文档：本 Skill 只注册 `read` 动作。
 * 产品业务的唯一状态流转仍是「行程规划 → 程序检查 → 运营确认 → 行程录入」，
 * 通用智能体的授权（`once`/`thread`）与操作收据都不能替代其中任何一道门禁；
 * 所以这里既不提供确认动作，也不提供录入动作，模型最多只能读出门禁结论。
 */

import type { ProductReadiness } from "../../../../shared/contracts.js";
import type { AgentSkill, AgentSkillAction } from "../../types.js";

/** 产品域账号键：与本地文件设施分开，便于将来独立限流与串行。 */
export const PRODUCT_READ_ACCOUNT = "product-read";

export interface ProductReadRecord {
  id: string;
  name: string;
  status: string;
  productId?: string;
  planVersion?: number;
  basicInfoSaved?: boolean;
  updatedAt?: string;
}

/** 只读端口：由主进程装配，Skill 不直接接触数据库或产品服务实现。 */
export interface ProductReadPort {
  list(): ProductReadRecord[];
  get(id: string): ProductReadRecord | undefined;
  readiness(id: string): ProductReadiness | undefined;
}

const LIST_LIMIT = 30;
const PREFIX_MIN_LENGTH = 4;

export function statusLabel(status: string): string {
  switch (status) {
    case "planning": return "行程规划中";
    case "review": return "待审查";
    case "automating": return "自动录入中";
    case "draft_saved": return "草稿已保存";
    case "blocked": return "阻塞";
    default: return status;
  }
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** 允许用唯一前缀指定产品；前缀过短或命中多个必须报错，不允许猜。 */
export function resolveProduct(port: ProductReadPort, input: string): ProductReadRecord {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("缺少产品 id。");
  const exact = port.get(trimmed);
  if (exact) return exact;
  if (trimmed.length < PREFIX_MIN_LENGTH) throw new Error(`产品 id 前缀至少需要 ${PREFIX_MIN_LENGTH} 位。`);
  const matches = port.list().filter((record) => record.id.startsWith(trimmed));
  if (!matches.length) throw new Error(`未找到匹配的产品：${trimmed}`);
  if (matches.length > 1) {
    throw new Error(`前缀命中 ${matches.length} 个产品（${matches.map((record) => shortId(record.id)).join("、")}），请给出更长前缀。`);
  }
  return matches[0];
}

function productIdArg(args: Record<string, unknown>): string {
  const value = args.productId;
  if (typeof value !== "string" || !value.trim()) throw new Error("缺少必填参数 productId。");
  return value.trim();
}

function targetKey(id: string): string {
  return `product:${id}`;
}

/**
 * 决策已定（2026-11-17，运营选 A）：通用智能体的批准**不能**顶替产品的「运营确认」。
 * 产品域只暴露只读能力；这里做一次防御性断言，防止后续有人顺手加写动作。
 */
/** 防御性守卫：产品域一旦出现非只读动作立即抛错（决策 A 的代码化）。 */
export function assertProductActionsReadOnly(actions: readonly AgentSkillAction[]): void {
  const writable = actions.filter((action) => action.kind !== "read");
  if (writable.length) {
    throw new Error(`产品域只允许只读 Skill（决策 A）：${writable.map((action) => action.name).join("、")}`);
  }
}

export function createProductReadSkill(port: ProductReadPort): AgentSkill {
  const listAction: AgentSkillAction = {
    name: "product.list",
    kind: "read",
    label: "查询产品列表",
    risk: "low",
    description: `列出本地产品及其状态，最多返回 ${LIST_LIMIT} 个；返回的 id 可直接用于 product.status。`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async target() {
      return { action: "product.list", targetKey: "product:list", accountKey: PRODUCT_READ_ACCOUNT, risk: "low" };
    },
    async execute() {
      const records = port.list().slice(0, LIST_LIMIT);
      if (!records.length) {
        return { content: "本地还没有产品。", summary: "查询产品列表：0 个", result: "产品列表为空" };
      }
      const lines = records.map((record) => {
        const flags = [
          record.productId ? `VBK ${record.productId}` : "未回填 VBK 产品 id",
          record.planVersion !== undefined ? `方案版本 v${record.planVersion}` : "",
          record.basicInfoSaved ? "基本信息已保存" : "基本信息未保存",
        ].filter(Boolean);
        return `- ${record.name}｜${statusLabel(record.status)}｜id ${shortId(record.id)}｜${flags.join("，")}`;
      });
      return {
        content: `本地产品（${records.length} 个，展示 id 为前缀，需要详情请用 product.status）：\n${lines.join("\n")}`,
        summary: `查询产品列表：${records.length} 个`,
        result: `返回 ${records.length} 个产品`,
      };
    },
  };

  const statusAction: AgentSkillAction = {
    name: "product.status",
    kind: "read",
    label: "查询产品状态与门禁结论",
    risk: "low",
    description: "按产品 id（或唯一前缀）读取产品状态、方案版本与就绪结论；只读，不改变任何门禁状态。",
    parameters: {
      type: "object",
      properties: { productId: { type: "string", description: "产品本地 id，或其唯一前缀（至少 4 位）" } },
      required: ["productId"],
      additionalProperties: false,
    },
    async target(args) {
      return {
        action: "product.status",
        targetKey: targetKey(productIdArg(args)),
        accountKey: PRODUCT_READ_ACCOUNT,
        risk: "low",
      };
    },
    async execute(args) {
      const record = resolveProduct(port, productIdArg(args));
      const readiness = port.readiness(record.id);
      const facts = [
        `名称：${record.name}`,
        `状态：${statusLabel(record.status)}（${record.status}）`,
        `id：${record.id}`,
        `VBK 产品 id：${record.productId ?? "未回填"}`,
        `方案版本：${record.planVersion !== undefined ? `v${record.planVersion}` : "无"}`,
        `基本信息保存：${record.basicInfoSaved ? "已保存" : "未保存"}`,
      ];
      const blockers = readiness
        ? [
          `程序检查结论：${readiness.ready ? "已通过" : "未通过"}（完成度 ${Math.round(readiness.completion)}%）`,
          ...(readiness.issues.length
            ? [`阻塞项（${readiness.issues.length}）：`, ...readiness.issues.map((issue) => `- ${issue.label}：${issue.detail}`)]
            : ["阻塞项：无"]),
        ]
        : ["程序检查结论：无法读取（产品不存在或检查服务不可用）"];
      return {
        content: [...facts, ...blockers].join("\n"),
        summary: `查询产品 ${record.name}：${readiness?.ready ? "已就绪" : "未就绪"}`,
        result: `读取产品 ${record.id}`,
      };
    },
  };

  const actions = [listAction, statusAction];
  assertProductActionsReadOnly(actions);
  return {
    id: "product-read",
    label: "产品只读查询",
    description: "查询本地产品列表、状态与就绪结论；只读，不能替代程序检查、运营确认或录入授权。",
    actions,
  };
}
