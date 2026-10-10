import type { AgentInputRequest, AgentQuestion } from "../../shared/contracts.js";
import { AgentSnapshotManager, type TurnToken } from "./core-snapshot.js";
import { parseQuestions } from "./core-validation.js";
import { asksForCommercialPricing, asksForPrematureApproval, automaticPreparationAnswer } from "./preparation-question-defaults.js";
import { automaticRepairFlowAnswer, mustKeepRepairQuestionVisible } from "./core-preparation.js";
import { isHotelRecoveryQuestion } from "./core-preparation-hotel-input.js";
import { answerProductQuestionsWithAi, canAutomaticallyAnswerProductQuestion, isAutomaticProductInputRun } from "./automatic-product-input.js";
import { resolveSelectedAnswers } from "./selected-input-answers.js";
import type { AgentCoreDependencies, AgentToolCall } from "./types.js";
import type { CallOutcome } from "./core-tools.js";

function defaultAnswerForQuestion(question: AgentQuestion): string | string[] | undefined {
  return automaticPreparationAnswer(question);
}

function splitDefaultQuestions(
  questions: AgentQuestion[],
  deps: AgentCoreDependencies,
  snapshot: import("../../shared/contracts.js").AgentSnapshot,
) {
  const visible: AgentQuestion[] = [];
  const defaultAnswers: Record<string, string | string[]> = {};
  for (const question of questions) {
    const answer = isHotelRecoveryQuestion(question) || mustKeepRepairQuestionVisible(deps, snapshot, question)
      ? undefined
      : defaultAnswerForQuestion(question) ?? automaticRepairFlowAnswer(deps, snapshot, question);
    if (answer === undefined) visible.push(question);
    else defaultAnswers[question.id] = answer;
  }
  return { visible, defaultAnswers };
}

function normaliseQuestion(question: AgentQuestion): AgentQuestion {
  if (isHotelRecoveryQuestion(question)) return question;
  const label = question.label.replace(/\s+/g, "");
  if (question.kind === "single" && /酒店/.test(label) && /候选|备选|选择|资源/.test(label)) {
    return { ...question, kind: "multiple" };
  }
  return question;
}

export async function handleAgentInputRequest(deps: AgentCoreDependencies, snapshots: AgentSnapshotManager, now: () => Date, newId: () => string, id: string, call: AgentToolCall, token: TurnToken): Promise<CallOutcome> {
    const snapshot = snapshots.load(id);
    const questions = parseQuestions(call.arguments.questions);
    if (!questions) {
      snapshots.result(snapshot, call.id, "问题格式无效。", { executionRejected: true }, token.runId);
      snapshots.save(snapshot);
      return "continue";
    }
    if (!snapshots.current(snapshot, token)) return "stale";
    const normalised = questions.map((question) => {
      const item = normaliseQuestion(question);
      if (!/封面|cover/i.test(`${item.id} ${item.label}`)
        || !/规格|尺寸|像素|高清|原图|resize|quality/i.test(`${item.id} ${item.label}`)) return item;
      const options = item.options?.filter((option) =>
        !/提交后|先提交|跳过.*(?:规格|尺寸)|post_vbk|after_submit/i.test(`${option.id} ${option.label}`));
      return options?.length ? { ...item, options } : item;
    });
    const resolved = deps.resolvedPendingQuestions?.(id, normalised) ?? [];
    const resolvedIds = new Set(resolved.map((item) => item.id));
    const unresolved = normalised.filter((question) => !resolvedIds.has(question.id));
    const deferredApprovalQuestions = unresolved.filter(asksForPrematureApproval);
    const { visible, defaultAnswers } = splitDefaultQuestions(
      unresolved.filter((question) => !asksForPrematureApproval(question)), deps, snapshot,
    );
    for (const item of resolved) defaultAnswers[item.id] = item.answer ?? "已在当前产品中保存";
    for (const question of deferredApprovalQuestions) {
      defaultAnswers[question.id] = question.kind === "multiple" ? [] : "deferred_until_final_approval";
    }
    if (visible.some(asksForCommercialPricing)) {
      snapshots.result(snapshot, call.id,
        "商业定价必须依据已保存的行程自动生成本地审核指导价，不能向运营索要成人价、儿童价、起订人数或成本。请调用 generate_product_module({stage:\"commercial\"}) 补齐；运营如有需要可在生成后手动调整。",
        { automaticCommercialPricing: true }, token.runId);
      snapshots.event(snapshot, "status", "已拒绝人工定价输入：将依据行程生成本地审核指导价。", {
        automaticCommercialPricing: true,
        toolCallId: call.id,
      }, token.runId);
      snapshots.save(snapshot);
      return "continue";
    }
    const automaticRun = isAutomaticProductInputRun(deps, snapshot);
    const automatic = automaticRun ? visible.filter(canAutomaticallyAnswerProductQuestion) : [];
    if (automatic.length) {
      try {
        const answers = await answerProductQuestionsWithAi(deps, id, automatic);
        if (!snapshots.current(snapshots.load(id), token)) return "stale";
        Object.assign(defaultAnswers, answers);
        for (const question of automatic) visible.splice(visible.indexOf(question), 1);
        if (visible.length) snapshots.event(snapshot, "status", "普通资料已由 AI 自动回答；其余访问条件仍需满足。", {
          automaticProductInput: true, questions: automatic, answers,
          resolvedAnswers: resolveSelectedAnswers({ id: call.id, createdAt: now().toISOString(), questions: automatic }, answers).answers,
        }, token.runId);
      } catch (error) {
        if (!snapshots.current(snapshots.load(id), token)) return "stale";
        snapshots.result(snapshot, call.id, `自动资料问答失败：${error instanceof Error ? error.message : String(error)}。请自行补齐资料或换策略，不要向运营重复提问。`, { executionRejected: true }, token.runId);
        snapshots.save(snapshot);
        return "continue";
      }
    }
    if (!visible.length) {
      const resolvedMessage = resolved.map((item) => item.message).join("；");
      snapshots.result(snapshot, call.id, `${JSON.stringify(defaultAnswers)}${resolvedMessage ? `\n当前产品核对：${resolvedMessage}。` : ""}`, {
        defaultAnswers,
        ...(automatic.length ? {
          automaticProductInput: true, questions: automatic,
          answers: Object.fromEntries(automatic.map(question => [question.id, defaultAnswers[question.id]])),
          resolvedAnswers: resolveSelectedAnswers({ id: call.id, createdAt: now().toISOString(), questions: automatic }, defaultAnswers).answers,
        } : {}),
        ...(resolved.length ? { reconciledQuestions: [...resolvedIds] } : {}),
        ...(deferredApprovalQuestions.length
          ? { deferredApprovalQuestions: deferredApprovalQuestions.map((question) => question.id) }
          : {}),
      }, token.runId);
      if (resolved.some((item) => item.pause && !(automaticRun && normalised.some(question => question.id === item.id && canAutomaticallyAnswerProductQuestion(question))))) {
        snapshots.pause(snapshot, `${resolvedMessage}。已停止重复索要图片 ID；请检查当前封面规格。`);
        snapshots.save(snapshot);
        return "waiting";
      }
      snapshots.event(snapshot, "status", deferredApprovalQuestions.length
        ? "已采用可推导的安全默认；VBK 写入授权已延后到资料准备完成后的最终确认。"
        : resolvedMessage || "已采用可推导的系统默认，继续自动准备。", {
        defaultAnswers,
        toolCallId: call.id,
      }, token.runId);
      snapshots.save(snapshot);
      return "continue";
    }
    const request: AgentInputRequest = {
      id: newId(),
      questions: visible,
      createdAt: now().toISOString(),
      ...(Object.keys(defaultAnswers).length ? { defaultAnswers } : {}),
    };
    if (resolved.length) snapshots.event(snapshot, "status", resolved.map((item) => item.message).join("；"), {
      reconciledQuestions: [...resolvedIds], toolCallId: call.id,
    }, token.runId);
    snapshot.pendingInput = request;
    const stageSummary = typeof call.arguments.summary === "string" ? call.arguments.summary.trim() : undefined;
    snapshots.event(snapshot, "input_request", "需要用户补充信息", { toolCallId: call.id, request, ...(stageSummary ? { stageSummary } : {}) }, token.runId);
    snapshots.waiting(snapshot, "waiting_input");
    snapshots.save(snapshot);
    return "waiting";
}
