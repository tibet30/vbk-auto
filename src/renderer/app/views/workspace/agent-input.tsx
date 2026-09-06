import { useState } from "react";
import type { AgentInputRequest, AgentInputResponse } from "../../../../shared/contracts-agent";
import shared from "../shared.module.less";
import styles from "./agent-conversation.module.less";

export function validateAgentAnswers(request: AgentInputRequest, answers: AgentInputResponse["answers"]): string[] {
  return request.questions.filter((question) => {
    const answer = answers[question.id];
    if (question.required && (!answer || (Array.isArray(answer) ? !answer.length : !answer.trim()))) return true;
    if (!answer || question.kind === "text") return false;
    const choices = question.options ?? (question.kind === "confirm" ? [{ id: "confirm", label: "确定" }, { id: "cancel", label: "取消" }] : []);
    return (Array.isArray(answer) ? answer : [answer]).some((id) => !choices.some((option) => option.id === id));
  }).map((question) => question.id);
}

export function AgentInput({ request, busy, onSubmit }: {
  request: AgentInputRequest;
  busy: boolean;
  onSubmit(response: AgentInputResponse): Promise<void>;
}) {
  const storageKey = `agent-input:${request.id}`;
  const [answers, setAnswers] = useState<AgentInputResponse["answers"]>(() => {
    try { return JSON.parse(sessionStorage.getItem(storageKey) ?? "{}"); } catch { return {}; }
  });
  const [invalid, setInvalid] = useState<string[]>([]);
  const change = (id: string, value: string | string[]) => {
    const next = { ...answers, [id]: value };
    setAnswers(next);
    setInvalid((items) => items.filter((item) => item !== id));
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Storage is optional. */ }
  };
  return <form className={styles.inputRequest} onSubmit={async (event) => {
    event.preventDefault();
    const errors = validateAgentAnswers(request, answers);
    setInvalid(errors);
    if (errors.length || busy) return;
    await onSubmit({ requestId: request.id, answers });
  }}>
    <strong>需要你补充</strong>
    {request.questions.map((question, index) => <fieldset key={question.id} disabled={busy}>
      <legend>{index + 1}. {question.label}{question.required ? <span> · 必答</span> : <span> · 选填</span>}</legend>
      {question.kind === "text" ? <textarea
        aria-label={question.label} aria-invalid={invalid.includes(question.id)} rows={3}
        value={typeof answers[question.id] === "string" ? answers[question.id] as string : ""}
        placeholder={question.placeholder ?? "填写你的想法或文案"}
        onChange={(event) => change(question.id, event.target.value)}
      /> : <div className={styles.choices}>
        {(question.options ?? (question.kind === "confirm" ? [{ id: "confirm", label: "确定" }, { id: "cancel", label: "取消" }] : [])).map((option) => {
          const value = answers[question.id];
          const selected = Array.isArray(value) ? value.includes(option.id) : value === option.id;
          return <button key={option.id} type="button" aria-pressed={selected} onClick={() => {
            const previous = Array.isArray(value) ? value : [];
            change(question.id, question.kind === "multiple"
              ? (selected ? previous.filter((id) => id !== option.id) : [...previous, option.id]) : option.id);
          }}>{option.label}</button>;
        })}
      </div>}
      {invalid.includes(question.id) && <small role="alert">请完成这道题，或选择有效选项。</small>}
    </fieldset>)}
    <button className={shared.btn} data-variant="primary" disabled={busy} type="submit">{busy ? "正在提交…" : "提交回答并继续"}</button>
  </form>;
}
