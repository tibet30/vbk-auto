import type { AgentQuestion, AgentSnapshot } from "../../shared/contracts.js";
import type { AgentCoreDependencies } from "./types.js";
import { isPreparationRun } from "./preparation-run.js";
import { decidePreparationAction, type PreparationDirectedAction } from "./preparation-director.js";
import { evaluatePreparationCompletion } from "../planning/preparation-completion.js";
import { manualPoiInput, unmatchedCanonicalPoiSlots, type ManualPoiSlot } from "./core-preparation-poi-input.js";

export type PreparationLoopDecision =
  | { kind: "execute"; action: PreparationDirectedAction }
  | { kind: "askPoiInput"; action: PreparationDirectedAction; input: NonNullable<ReturnType<typeof manualPoiInput>> }
  | { kind: "model"; action?: PreparationDirectedAction; modelRepairWindow?: true; manualPoiModelWindow?: true; poiSlotKey?: string; manualPoiAnswerSlotKey?: string }
  | { kind: "pause"; reason: string; manualPoiBlocked?: true; poiSlotKey?: string; manualPoiAnswerSlotKey?: string };

export function nextPreparationLoopDecision(
  deps: AgentCoreDependencies,
  snapshot: AgentSnapshot,
): PreparationLoopDecision {
  if (snapshot.run?.status !== "running" || snapshot.uncertainWrite || snapshot.pendingInput || snapshot.pendingApproval
    || hasActiveApproval(snapshot) || !isPreparationRun(snapshot)) {
    return { kind: "model" };
  }
  const product = deps.preparationProduct?.(snapshot.localProductId);
  if (!product) return { kind: "model" };
  const action = decidePreparationAction(product, snapshot);
  if (!action) return { kind: "model" };
  const events = eventsSinceLatestUser(snapshot);
  const runEvents = snapshot.events.filter((event) => event.runId === snapshot.run?.id);
  const manualInput = action.node === "poiResolution" ? manualPoiInput(unmatchedCanonicalPoiSlots(product)) : undefined;
  if (manualInput) {
    const answer = answeredManualPoiInput(runEvents, manualInput);
    if (answer) {
      const modelAttempts = runEvents.filter((event) => event.type === "status" && event.data?.manualPoiModelWindow === true
        && (event.data?.manualPoiAnswerSlotKey === answer.originKey
          || (event.data?.manualPoiAnswerSlotKey === undefined && event.data?.poiSlotKey === answer.originKey))).length;
      const limit = Math.max(3, Math.min(12, answer.originSlots * 2));
      if (modelAttempts < limit) return {
        kind: "model", action, manualPoiModelWindow: true, poiSlotKey: manualInput.key, manualPoiAnswerSlotKey: answer.originKey,
      };
      return { kind: "pause", manualPoiBlocked: true, poiSlotKey: manualInput.key, manualPoiAnswerSlotKey: answer.originKey,
        reason: `未找到真实 POI 的人工确认已尝试查询绑定 ${modelAttempts} 次仍未完成。请前往产品审查→每日行程→待手动配置 POI 搜索并保存：${manualInput.question.label}` };
    }
  }
  const attempts = events.filter((event) => event.runId === snapshot.run?.id
    && event.type === "tool_call"
    && event.data?.deterministicPreparation === true
    && event.data?.name === action.name
    && event.data?.progressKey === action.progressKey).length;
  const modelRepairSeen = events.some((event) => event.runId === snapshot.run?.id
    && event.type === "status"
    && event.data?.deterministicPreparationModelRepair === true
    && event.data?.progressKey === action.progressKey
    && event.data?.name === action.name);
  if (attempts < 2) return { kind: "execute", action };
  if (manualInput) return { kind: "askPoiInput", action, input: manualInput };
  if (!modelRepairSeen) return { kind: "model", action, modelRepairWindow: true };
  const evaluation = evaluatePreparationCompletion(product, snapshot);
  const missing = evaluation.missing.filter((item) => /itinerary|每日行程|POI|景点|酒店候选|人工确认|手动录入|suggestPoi/i.test(item));
  const repairStart = events.findIndex((event) => event.type === "status"
    && event.data?.deterministicPreparationModelRepair === true
    && event.data?.progressKey === action.progressKey && event.data?.name === action.name);
  const repairEvents = repairStart < 0 ? [] : events.slice(repairStart + 1);
  const repairOutcome = [...repairEvents].reverse().find((event) => event.runId === snapshot.run?.id && event.type === "tool_result" && event.data?.toolCallId
    && repairEvents.some((call) => call.type === "tool_call" && call.data?.toolCallId === event.data?.toolCallId
      && !isReadOnlyTool(call.data?.name)));
  const automaticOutcome = [...events].reverse().find((event) => event.type === "tool_result" && event.data?.toolCallId
    && events.some((call) => call.type === "tool_call" && call.data?.toolCallId === event.data?.toolCallId
      && call.data?.deterministicPreparation === true && call.data?.progressKey === action.progressKey));
  const detail = (repairOutcome ?? automaticOutcome)?.content.replace(/\s+/g, " ").slice(0, 240) || "自动动作未返回可验证的产品进展";
  return { kind: "pause", reason: `本地准备在 ${action.node} 已自动尝试 ${attempts} 次且模型修复一次后仍无业务进展。当前缺项：${missing.join("、") || "见最新产品核验"}。最近结果：${detail}` };
}

function eventsSinceLatestUser(snapshot: AgentSnapshot) {
  const events = snapshot.events.filter((event) => event.type !== "user" || event.data?.readOnlyStatusQuery !== true);
  const index = events.map((event) => event.type).lastIndexOf("user");
  return index < 0 ? events : events.slice(index + 1);
}

function isReadOnlyTool(name: unknown): boolean {
  return typeof name === "string" && /^(?:read|query)_/.test(name);
}

function hasActiveApproval(snapshot: AgentSnapshot): boolean {
  if (snapshot.pendingApproval?.status === "pending") return true;
  const approved = snapshot.events
    .filter((event) => event.runId === snapshot.run?.id && event.type === "approval")
    .map((event) => event.data?.approval as { status?: string; intentVersion?: string } | undefined)
    .reverse()
    .find((approval) => approval?.status === "approved");
  return Boolean(approved && approved.intentVersion === snapshot.run?.intentVersion);
}

/**
 * A one-time model repair may ask whether to continue its own repair loop.
 * Answer only a pure control question; product choices remain visible.
 */
export function automaticRepairFlowAnswer(
  deps: AgentCoreDependencies,
  snapshot: AgentSnapshot,
  question: AgentQuestion,
): string | string[] | undefined {
  if (!hasActiveRepairWindow(deps, snapshot)) return undefined;
  const text = `${question.id} ${question.label} ${question.options?.map((option) => `${option.id} ${option.label}`).join(" ") ?? ""}`
    .replace(/\s+/g, "");
  if (/城市|目的地|天数|日期|POI|景点|点名|酒店|住宿|车辆|用车|包车|客群|风格|授权|VBK|录入|资源|原行程|价格|报价|交通|删除|移除|替换/.test(text)) return undefined;
  if (question.kind === "confirm" && !question.options?.length
    && /^(?:是否)?(?:继续|下一步|重试|重新生成|恢复|自动推进|continue|next|retry|regenerate|resume)/i.test(question.label.trim())) return "true";
  if (!question.options?.length) return undefined;
  const controlOption = /^(?:继续|继续修复|继续重试|下一步|重试|重新生成|恢复|自动推进|暂停|停止|取消|continue|next|retry|regenerate|resume|stop|cancel)$/i;
  if (!/^(?:是否)?(?:继续|下一步|重试|重新生成|恢复|自动推进|continue|next|retry|regenerate|resume)/i.test(question.label.trim())
    || !question.options.every((option) => controlOption.test(`${option.id}`) || controlOption.test(`${option.label}`))) return undefined;
  const answer = question.options.find((option) => /继续|下一步|重试|重新生成|恢复|自动推进|continue|next|retry|regenerate|resume/i.test(`${option.id} ${option.label}`));
  if (!answer) return undefined;
  return question.kind === "multiple" ? [answer.id] : answer.id;
}

/** Keep business-changing alternatives visible even when an older generic default matches “retry”. */
export function mustKeepRepairQuestionVisible(
  deps: AgentCoreDependencies,
  snapshot: AgentSnapshot,
  question: AgentQuestion,
): boolean {
  if (!hasActiveRepairWindow(deps, snapshot)) return false;
  const text = `${question.id} ${question.label} ${question.options?.map((option) => `${option.id} ${option.label}`).join(" ") ?? ""}`
    .replace(/\s+/g, "");
  return /降低|升档|改为|调整|替换|删除|更换|另选|改变.*(?:城市|天数)|(?:城市|天数).*(?:改变|改为|调整)|钻级/.test(text);
}

function hasActiveRepairWindow(deps: AgentCoreDependencies, snapshot: AgentSnapshot): boolean {
  if (snapshot.run?.status !== "running" || snapshot.uncertainWrite || snapshot.pendingInput || snapshot.pendingApproval
    || hasActiveApproval(snapshot) || !isPreparationRun(snapshot)) return false;
  const product = deps.preparationProduct?.(snapshot.localProductId);
  const action = product ? decidePreparationAction(product, snapshot) : undefined;
  if (!action) return false;
  const repair = [...snapshot.events].reverse().find((event) => event.runId === snapshot.run?.id
    && event.type === "status" && event.data?.deterministicPreparationModelRepair === true);
  if (!repair || repair.data?.progressKey !== action.progressKey || repair.data?.name !== action.name) return false;
  return !snapshot.events.slice(snapshot.events.indexOf(repair) + 1)
    .some((event) => event.type === "input_request" || (event.type === "user" && event.data?.readOnlyStatusQuery !== true));
}

function answeredManualPoiInput(events: AgentSnapshot["events"], current: NonNullable<ReturnType<typeof manualPoiInput>>) {
  for (const event of [...events].reverse()) {
    if (event.type !== "tool_call" || event.data?.manualPoiInput !== true) continue;
    const questionId = manualQuestionId(event);
    if (!questionId || !hasManualPoiAnswer(events, event.data?.toolCallId, questionId)) continue;
    const slots = manualPoiSlots(event.data?.poiSlots);
    if (slots.length && isSlotSubset(current.slots, slots)) return { originKey: String(event.data?.poiSlotKey), originSlots: slots.length };
    // Older snapshots did not persist slots: retain exact-key compatibility only.
    if (!slots.length && event.data?.poiSlotKey === current.key) return { originKey: current.key, originSlots: current.slots.length };
  }
  return undefined;
}

function manualQuestionId(event: AgentSnapshot["events"][number]): string | undefined {
  const questions = event.data?.arguments && typeof event.data.arguments === "object"
    ? (event.data.arguments as { questions?: unknown }).questions : undefined;
  const question = Array.isArray(questions) ? questions[0] : undefined;
  return question && typeof question === "object" && typeof (question as { id?: unknown }).id === "string"
    ? (question as { id: string }).id : undefined;
}

function manualPoiSlots(value: unknown): ManualPoiSlot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((slot) => slot && typeof slot === "object"
    && Number.isInteger((slot as { day?: unknown }).day) && typeof (slot as { name?: unknown }).name === "string"
    ? [{ day: Number((slot as { day: number }).day), name: (slot as { name: string }).name }] : []);
}

function isSlotSubset(current: readonly ManualPoiSlot[], origin: readonly ManualPoiSlot[]): boolean {
  return current.length > 0 && current.every((slot) => origin.some((item) => item.day === slot.day && item.name === slot.name));
}

function hasManualPoiAnswer(events: AgentSnapshot["events"], toolCallId: unknown, questionId: string): boolean {
  if (typeof toolCallId !== "string") return false;
  const request = events.find((event) => event.type === "input_request" && event.data?.toolCallId === toolCallId);
  const questions = request?.data?.request && typeof request.data.request === "object"
    ? (request.data.request as { questions?: unknown }).questions : undefined;
  if (!Array.isArray(questions) || !questions.some((question) => question && typeof question === "object" && (question as { id?: unknown }).id === questionId)) return false;
  return events.some((event) => event.type === "tool_result" && event.data?.toolCallId === toolCallId
    && (hasQuestionAnswer(event.data?.answers, questionId) || hasQuestionAnswer(event.data?.resolvedAnswers, questionId)));
}

function hasQuestionAnswer(value: unknown, questionId: string): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, questionId));
}
