/**
 * 通用智能体运行时内部契约。
 *
 * 设计要点：
 *  - Skill 只声明「受 Schema 约束的动作」，不暴露任意代码执行能力；
 *  - 每个动作必须能解析出精确的 `AgentActionTarget`（动作名、绝对目标、账号、风险），
 *    权限策略只依据这个结构判定，不读模型自然语言；
 *  - 写动作必须提供 `preview`，审批卡展示的目标与实际执行目标来自同一次解析。
 */

import type { AgentActionKind, AgentActionRisk, AgentArtifact } from "../../shared/contracts-agent-runtime.js";
import type { AgentToolDefinition } from "../agent/types.js";

/** 动作的真实目标：策略、审批与收据都以此为准。 */
export interface AgentActionTarget {
  /** 形如 `file.write`，与授权粒度一致。 */
  action: string;
  /** 解析后的绝对目标键（文件 realpath 或目录 realpath）。 */
  targetKey: string;
  /** 后台账号或本地设施键；同键写操作串行。 */
  accountKey: string;
  risk: AgentActionRisk;
  /** 动作所在的授权目录（真实路径），用于审批卡展示。 */
  directory?: string;
}

export interface AgentActionResult {
  /** 回给模型的工具结果正文。 */
  content: string;
  /** 运营可读的收据摘要。 */
  summary: string;
  /** 动作前的事实（修改/覆盖/删除必须提供）。 */
  before?: string;
  /** 动作后的实际结果（收据正文）。 */
  result: string;
  detail?: string;
  /** 结构化产物：写入类动作必须登记，面板据此展示文件树与预览入口。 */
  artifact?: AgentArtifact;
}

export interface AgentActionPreview {
  summary: string;
  diff?: string;
}

export interface AgentSkillContext {
  ownerUserId: number;
  threadId: string;
  runId: string;
  /** 任务级授权目录；未选择的会话不允许任何文件动作。 */
  workingDirectory?: string;
}

export interface AgentSkillAction extends AgentToolDefinition {
  kind: AgentActionKind;
  /** 审批卡上的动作名，例如「覆盖文件」。 */
  label: string;
  risk: AgentActionRisk;
  /** 解析真实目标；越界或参数非法一律抛错，禁止静默降级为默认路径。 */
  target(args: Record<string, unknown>, context: AgentSkillContext): Promise<AgentActionTarget>;
  /** 参数前置校验；返回字符串表示不可执行的原因。 */
  validate?(args: Record<string, unknown>): string | undefined;
  preview?(args: Record<string, unknown>, context: AgentSkillContext): Promise<AgentActionPreview>;
  execute(args: Record<string, unknown>, context: AgentSkillContext): Promise<AgentActionResult>;
  /** 结果不确定时的回读核查：只读判断动作是否已落地。 */
  reconcile?(args: Record<string, unknown>, context: AgentSkillContext): Promise<{ landed: boolean; detail: string }>;
}

export interface AgentSkill {
  id: string;
  label: string;
  description: string;
  actions: AgentSkillAction[];
}

/** 写入可能已经到达外部系统，但没有可确认结果：必须核查，禁止盲目重试。 */
export class AgentUncertainActionError extends Error {
  readonly uncertain = true;
  constructor(message = "动作结果不确定，需回读核查后才能重试。") {
    super(message);
    this.name = "AgentUncertainActionError";
  }
}

export function actionToolName(skillId: string, action: string): string {
  return `${skillId}.${action}`;
}
