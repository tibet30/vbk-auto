/**
 * Contract shared by the VBK retry button, AgentCore, and deterministic
 * execution. Only these saved wizard stages have a separately verified
 * official “下一步” API.
 */

export type WizardStageRetryPhase = "basic" | "presentation";

const WIZARD_STAGE_LABELS: Record<WizardStageRetryPhase, string> = {
  basic: "基础信息",
  presentation: "产品图文",
};

const STAGE_BY_LABEL = new Map(Object.entries(WIZARD_STAGE_LABELS)
  .map(([phase, label]) => [label, phase as WizardStageRetryPhase]));

export function wizardStageRetryPhaseLabel(phase: WizardStageRetryPhase): string {
  return WIZARD_STAGE_LABELS[phase];
}

/** The retry button emits this exact command; free-form messages stay conversational. */
export function formatWizardStageRetryInstruction(phase: WizardStageRetryPhase): string {
  return `请检查并修复${wizardStageRetryPhaseLabel(phase)}阶段，先展示修复后的方案并请求最终确认，再继续录入。`;
}

export function parseWizardStageRetryInstruction(content: string): WizardStageRetryPhase | undefined {
  const text = content.trim().replace(/\s+/gu, "");
  const match = /^请检查并修复(基础信息|产品图文)阶段，先展示修复后的方案并请求最终确认，再继续录入。?$/u.exec(text);
  return match ? STAGE_BY_LABEL.get(match[1]!) : undefined;
}
