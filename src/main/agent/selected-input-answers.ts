import type { AgentInputRequest } from "../../shared/contracts.js";

/** Call only after validating the response against the current pending request.
 * IDs, question prompts, unselected options and defaults never imply a repair. */
export function resolveSelectedAnswers(
  request: AgentInputRequest,
  answers: Record<string, string | string[]>,
): {
  answers: Record<string, string | string[]>;
  selectedLabels: string[];
  selectedQuestions: Array<{ id: string; label: string; selectedLabel: string }>;
  instruction: string;
} {
  const resolved: Record<string, string | string[]> = {};
  const selectedLabels: string[] = [];
  const selectedQuestions: Array<{ id: string; label: string; selectedLabel: string }> = [];
  const instructions: string[] = [];
  for (const question of request.questions) {
    const answer = answers[question.id];
    if (answer === undefined) continue;
    if (question.options?.length) {
      const labels = (Array.isArray(answer) ? answer : [answer]).map((id) => question.options!.find((option) => option.id === id)!.label);
      selectedLabels.push(...labels);
      selectedQuestions.push(...labels.map((selectedLabel) => ({
        id: question.id,
        label: question.label,
        selectedLabel,
      })));
      resolved[question.id] = Array.isArray(answer) ? labels : labels[0]!;
    } else {
      resolved[question.id] = answer;
      // Only user-authored text, never the question label, is a free-form instruction.
      if (question.kind === "text") instructions.push(...(Array.isArray(answer) ? answer : [answer]));
    }
  }
  return { answers: resolved, selectedLabels, selectedQuestions, instruction: instructions.join("\n") };
}
