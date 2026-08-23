/**
 * 「基础信息 / AI 副标题」行：展示 + 手工编辑 + AI 重新生成四种状态。
 *
 * 行为契约：
 *  - 默认只展示信息（persisted 文本或「尚未填写」提示）；
 *  - 「编辑」把展示 div 原位切到 input（max 80 字符），失焦 / Enter 触发保存；
 *  - 「AI 重新生成」进入 generating 态：只显示 spinner，**禁止编辑**；
 *  - 生成后进入 preview 态：展示候选，可「重新生成」继续换、「确定」写入、
 *    「取消」丢弃；
 *  - 「确定」把候选作为显式值交给 onSave → 写入 basicInfo.subtitle 并进入规划；
 *  - 生成失败时返回 display 态，错误经 errors.subtitle 贴回行内。
 */
import { useEffect, useRef, useState } from "react";
import { Check, FileText, LoaderCircle, Pencil, RefreshCw, Sparkles, X } from "lucide-react";
import type { BasicInfoSnapshot } from "./review-summary-basic-info.helpers";
import shared from "../shared.module.less";
import { BasicInfoRowShell } from "./basic-info-row-shell";
import styles from "./review-summary-basic-info.module.less";

export interface BasicInfoSubtitleRowProps {
  snapshot: BasicInfoSnapshot;
  draft: string;
  saving: boolean;
  error: string | undefined;
  onDraftChange: (value: string) => void;
  /** 保存：不传值时读手工草稿；传值时为 AI 候选确认写入。 */
  onSave: (value?: string) => void;
  onClearError: () => void;
  /** AI 重新生成：返回候选副标题（失败返回 null，错误由调用方贴回）。 */
  onRegenerate: () => Promise<string | null>;
}

const MAX_LEN = 80;

type SubtitleMode = "display" | "editing" | "generating" | "preview";

export function BasicInfoSubtitleRow({
  snapshot,
  draft,
  saving,
  error,
  onDraftChange,
  onSave,
  onClearError,
  onRegenerate,
}: BasicInfoSubtitleRowProps) {
  const [mode, setMode] = useState<SubtitleMode>("display");
  const [candidate, setCandidate] = useState<string | null>(null);
  const submittedRef = useRef(false);
  // 取消信号：用户点击「取消」后，input 的 onBlur（事件顺序先于 onClick）
  // 会再调一次 save()，需要提前阻止这个二次保存。
  const cancelledRef = useRef(false);
  // AI 重新生成的并发锁：React state 要等下一帧才禁用按钮，用 ref 补双击窗口。
  const regenerateInFlightRef = useRef(false);
  const persisted = snapshot.subtitle ?? "";
  const displayValue = persisted.trim() || "尚未填写 — AI 生成或人工补全后会显示在此";
  const dirty = draft.trim() !== persisted.trim();

  // 仅当提交过保存后，saving 结束且无错误 → 自动退出编辑态。
  useEffect(() => {
    if (mode !== "editing") return;
    if (!submittedRef.current) return;
    if (saving) return;
    if (error) return;
    setMode("display");
    submittedRef.current = false;
  }, [mode, saving, error]);

  const startEdit = () => {
    cancelledRef.current = false;
    submittedRef.current = false;
    onDraftChange(persisted);
    onClearError();
    setMode("editing");
  };
  const cancelEdit = () => {
    cancelledRef.current = true;
    submittedRef.current = false;
    onDraftChange(persisted);
    onClearError();
    setMode("display");
  };
  const saveEdit = () => {
    if (cancelledRef.current) return;
    if (!dirty) {
      setMode("display");
      return;
    }
    submittedRef.current = true;
    onSave();
  };

  const runRegenerate = async () => {
    if (regenerateInFlightRef.current) return;
    regenerateInFlightRef.current = true;
    setMode("generating");
    onClearError();
    try {
      const result = await onRegenerate();
      if (result && result.trim().length >= 2) {
        setCandidate(result.trim());
        setMode("preview");
      } else {
        // 生成失败（错误已由 action 贴回 errors.subtitle）回到 display。
        setMode("display");
      }
    } finally {
      regenerateInFlightRef.current = false;
    }
  };

  const confirmCandidate = () => {
    const value = candidate?.trim();
    if (!value) return;
    setCandidate(null);
    setMode("display");
    onSave(value);
  };

  const cancelPreview = () => {
    setCandidate(null);
    onClearError();
    setMode("display");
  };

  if (mode === "editing") {
    return (
      <BasicInfoRowShell
        rowId="subtitle"
        labelTitle="AI 副标题"
        labelHint="方案首屏"
        error={error}
        className={styles.rowCenter}
        actions={
          <>
            {saving ? <LoaderCircle size={14} className={styles.spin} aria-label="保存中" /> : null}
            <button
              type="button"
              className={`${shared.btn} ${shared.btnSm}`}
              onClick={cancelEdit}
              disabled={saving}
              title="放弃修改"
            >
              <X size={12} aria-hidden="true" /> 取消
            </button>
            <button
              type="button"
              className={`${shared.btn} ${shared.btnSm}`}
              data-variant={dirty ? "primary" : "ghost"}
              onClick={saveEdit}
              disabled={saving || !dirty || draft.trim().length < 2 || draft.trim().length > MAX_LEN}
            >
              保存
            </button>
          </>
        }
      >
        <input
          className={styles.input}
          type="text"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveEdit(); } }}
          onBlur={() => { if (dirty && !cancelledRef.current) saveEdit(); }}
          placeholder="例如：太原精品两日私家团"
          aria-label="AI 副标题"
          title={`${draft.trim().length}/${MAX_LEN} 字`}
          maxLength={MAX_LEN}
          data-state={error ? "error" : undefined}
          disabled={saving}
          autoFocus
        />
      </BasicInfoRowShell>
    );
  }

  if (mode === "generating") {
    return (
      <BasicInfoRowShell
        rowId="subtitle"
        labelTitle="AI 副标题"
        labelHint="AI 生成中"
        error={error}
        className={styles.rowCenter}
        actions={
          <span className={styles.hint} aria-label="生成中">
            <LoaderCircle size={13} className={styles.spin} aria-hidden="true" />
          </span>
        }
      >
        <div className={styles.subtitleDisplay} data-state="empty">
          <LoaderCircle size={12} className={styles.spin} aria-hidden="true" />
          <strong>AI 正在生成副标题…</strong>
        </div>
        <span className={styles.hint}>生成期间无法编辑，请稍候。</span>
      </BasicInfoRowShell>
    );
  }

  if (mode === "preview") {
    return (
      <BasicInfoRowShell
        rowId="subtitle"
        labelTitle="AI 副标题"
        labelHint="AI 生成候选"
        error={error}
        className={styles.rowCenter}
        actions={
          <>
            <button
              type="button"
              className={`${shared.btn} ${shared.btnSm}`}
              onClick={cancelPreview}
              title="放弃候选"
            >
              <X size={12} aria-hidden="true" /> 取消
            </button>
            <button
              type="button"
              className={`${shared.btn} ${shared.btnSm}`}
              data-variant="secondary"
              onClick={() => { void runRegenerate(); }}
              title="换一个候选"
            >
              <RefreshCw size={12} aria-hidden="true" /> 重新生成
            </button>
            <button
              type="button"
              className={`${shared.btn} ${shared.btnSm}`}
              data-variant="primary"
              onClick={confirmCandidate}
              title="采用该副标题"
            >
              <Check size={12} aria-hidden="true" /> 确定
            </button>
          </>
        }
      >
        <div className={styles.subtitleCandidate} data-testid="subtitle-ai-candidate">
          <Sparkles size={12} aria-hidden="true" />
          <strong title={candidate ?? undefined}>{candidate}</strong>
        </div>
        <span className={styles.hint}>确定后写入 basicInfo.subtitle 并进入规划。</span>
      </BasicInfoRowShell>
    );
  }

  return (
    <BasicInfoRowShell
      rowId="subtitle"
      labelTitle="AI 副标题"
      error={error}
      className={styles.rowCenter}
      actions={
        <>
          <button
            type="button"
            className={`${shared.btn} ${shared.btnSm}`}
            data-variant="ghost"
            onClick={startEdit}
            title="编辑 AI 副标题"
            aria-label="编辑 AI 副标题"
          >
            <Pencil size={13} aria-hidden="true" /> 编辑
          </button>
          <button
            type="button"
            className={`${shared.btn} ${shared.btnSm}`}
            data-variant="ghost"
            onClick={() => { void runRegenerate(); }}
            title="让 AI 重新生成副标题"
            aria-label="AI 重新生成副标题"
          >
            <Sparkles size={13} aria-hidden="true" /> AI 重新生成
          </button>
        </>
      }
    >
      <div className={styles.subtitleDisplay} data-state={persisted ? "ok" : "empty"}>
        <FileText size={12} aria-hidden="true" />
        <strong>{displayValue}</strong>
      </div>
    </BasicInfoRowShell>
  );
}
