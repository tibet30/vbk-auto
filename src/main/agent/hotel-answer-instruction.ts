import type { AgentEvent } from "../../shared/contracts.js";

type Json = Record<string, unknown>;
const record = (value: unknown): value is Json => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Resolve arbitrary question IDs through their original request, never through model summaries. */
export function hotelAnswerInstruction(events: readonly AgentEvent[]): string {
  const requests = new Map<string, Json[]>();
  const instructions: string[] = [];
  for (const event of events) {
    const request = event.data?.request;
    if (event.type === "input_request" && record(request) && typeof request.id === "string" && Array.isArray(request.questions)) {
      requests.set(request.id, request.questions.filter(record));
    }
    const automatic = (event.type === "tool_result" || event.type === "status") && event.data?.automaticProductInput === true;
    if (event.type !== "user" && !automatic) continue;
    const resolved = event.data?.resolvedAnswers;
    instructions.push(record(resolved) ? JSON.stringify(resolved) : event.content);
    const requestId = event.data?.requestId;
    const questions = automatic && Array.isArray(event.data?.questions)
      ? event.data.questions.filter(record) : typeof requestId === "string" ? requests.get(requestId) : undefined;
    if (!questions || !record(resolved)) continue;
    const canonical: Json = {};
    for (const question of questions) {
      if (typeof question.id !== "string" || typeof question.label !== "string" || !Object.hasOwn(resolved, question.id)) continue;
      if (!/酒店|住宿/.test(question.label)) continue;
      const days = [...question.label.matchAll(/(?:第\s*(\d+)\s*天|\bD\s*(\d+)\b)/gi)].map(match => Number(match[1] ?? match[2]));
      if (days.length !== 1 || !Number.isInteger(days[0]) || days[0]! < 1) continue;
      const answer = resolved[question.id];
      // Invalid/multiple answers mask older permission rather than resurrecting it.
      canonical[`hotel${days[0]}`] = (question.kind === "single" || question.kind === "text") && (typeof answer === "string" || Array.isArray(answer) && answer.length === 1 && typeof answer[0] === "string") ? answer : null;
    }
    if (Object.keys(canonical).length) instructions.push(JSON.stringify(canonical));
  }
  return instructions.join("\n");
}
