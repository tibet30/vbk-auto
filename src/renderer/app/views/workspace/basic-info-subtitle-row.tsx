/**
 * 「基础信息 / AI 副标题」行：默认展示，点击「编辑」后变成 input + 保存 / 取消。
 *
 * 行为契约（与用户验收门对齐）：
 *  - 默认**只展示**信息（persisted 文本或「尚未填写」提示），不画任何 input / 控件；
 *  - 「编辑」按钮把展示 div 原位切到 input，max 80 字符与 schema subtitle 上限对齐；
 *  - 失焦或按 Enter 触发保存；保存中显示 spinner；保存失败保留 draft + 红字错误；
 *  - 持久化回流（draft 与 snapshot.subtitle 一致 + 不在保存中）→ 自动退出编辑态；
 *  - 取消 = 退出编辑模式、丢弃草稿，回到展示态；不写库。
 */
import { useEffect, useRef, useState } from "react";
import { FileText, LoaderCircle, Pencil, X } from "lucide-react";
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
  onSave: () => void;
  onClearError: () => void;
}

const MAX_LEN = 80;

export function BasicInfoSubtitleRow({
  snapshot,
  draft,
  saving,
  error,
  onDraftChange,
  onSave,
  onClearError,
}: BasicInfoSubtitleRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const submittedRef = useRef(false);
  // 取消信号：用户点击「取消」后，input 的 onBlur（事件顺序先于 onClick）
  // 会再调一次 save()，需要提前阻止这个二次保存。
  const cancelledRef = useRef(false);
  const persisted = snapshot.subtitle ?? "";
  const displayValue = persisted.trim() || "尚未填写 — AI 生成或人工补全后会显示在此";
  const dirty = draft.trim() !== persisted.trim();

  // 仅当提交过保存后，saving 结束且无错误 → 自动退出编辑态。
  useEffect(() => {
    if (!isEditing) return;
    if (!submittedRef.current) return;
    if (saving) return;
    if (error) return;
    setIsEditing(false);
    submittedRef.current = false;
  }, [isEditing, saving, error]);

  const startEdit = () => {
    cancelledRef.current = false;
    submittedRef.current = false;
    onDraftChange(persisted);
    onClearError();
    setIsEditing(true);
  };
  const cancel = () => {
    cancelledRef.current = true;
    submittedRef.current = false;
    onDraftChange(persisted);
    onClearError();
    setIsEditing(false);
  };
  const save = () => {
    if (cancelledRef.current) return;
    if (!dirty) {
      setIsEditing(false);
      return;
    }
    submittedRef.current = true;
    onSave();
  };

  if (!isEditing) {
    return (
      <BasicInfoRowShell
        rowId="subtitle"
        labelTitle="AI 副标题"
        actions={
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
        }
      >
        <div className={styles.rowDisplay} data-state={persisted ? "ok" : "empty"}>
          <FileText size={12} aria-hidden="true" />
          <strong>{displayValue}</strong>
        </div>
      </BasicInfoRowShell>
    );
  }

  return (
    <BasicInfoRowShell
      rowId="subtitle"
      labelTitle="AI 副标题"
      labelHint="方案首屏"
      error={error}
      actions={
        <>
          {saving ? <LoaderCircle size={14} className={styles.spin} aria-label="保存中" /> : null}
          <button
            type="button"
            className={`${shared.btn} ${shared.btnSm}`}
            onClick={cancel}
            disabled={saving}
            title="放弃修改"
          >
            <X size={12} aria-hidden="true" /> 取消
          </button>
          <button
            type="button"
            className={`${shared.btn} ${shared.btnSm}`}
            data-variant={dirty ? "primary" : "ghost"}
            onClick={save}
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
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); save(); } }}
        onBlur={() => { if (dirty && !cancelledRef.current) save(); }}
        placeholder="例如：太原精品两日私家团"
        aria-label="AI 副标题"
        maxLength={MAX_LEN}
        data-state={error ? "error" : undefined}
        disabled={saving}
        autoFocus
      />
      <span className={styles.hint}>
        {draft.trim().length}/{MAX_LEN} · 写入 basicInfo.subtitle。
      </span>
    </BasicInfoRowShell>
  );
}
