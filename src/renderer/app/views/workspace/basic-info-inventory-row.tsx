/**
 * 「班期库存」行：commercial.inventory.startDate / endDate / dailyQuota。
 *
 * 行为契约：
 *  - 基础信息模块始终挂载本行，缺失时显示「待设置班期库存」；
 *  - 编辑态原位展开两个 date input 与一个 number input；
 *  - 校验复用 helpers.parseInventoryDraft：日期 YYYY-MM-DD、开始不晚于结束、
 *    每日配额为正整数。
 */
import { useEffect, useRef, useState } from "react";
import { CalendarDays, LoaderCircle, Pencil, X } from "lucide-react";
import shared from "../shared.module.less";
import { BasicInfoRowShell } from "./basic-info-row-shell";
import { parseInventoryDraft } from "./review-summary-basic-info.helpers";
import styles from "./review-summary-basic-info.module.less";

export interface BasicInfoInventoryRowProps {
  startDate: string | null;
  endDate: string | null;
  dailyQuota: number | null;
  draft: { startDate: string; endDate: string; dailyQuota: string };
  saving: boolean;
  error: string | undefined;
  onDraftChange: (next: { startDate: string; endDate: string; dailyQuota: string }) => void;
  onSave: (parsed: { startDate: string; endDate: string; dailyQuota: number }) => void;
  onClearError: () => void;
}

function toDraftString(value: string | number | null): string {
  return value === null ? "" : String(value);
}

export function BasicInfoInventoryRow({
  startDate,
  endDate,
  dailyQuota,
  draft,
  saving,
  error,
  onDraftChange,
  onSave,
  onClearError,
}: BasicInfoInventoryRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const submittedRef = useRef(false);
  const persisted = {
    startDate: toDraftString(startDate),
    endDate: toDraftString(endDate),
    dailyQuota: toDraftString(dailyQuota),
  };
  const parsed = parseInventoryDraft(draft.startDate, draft.endDate, draft.dailyQuota);
  const canSave = parsed !== null;
  const hasValue = startDate !== null && endDate !== null && dailyQuota !== null;

  useEffect(() => {
    if (!isEditing) return;
    if (!submittedRef.current) return;
    if (saving) return;
    if (error) return;
    setIsEditing(false);
    submittedRef.current = false;
  }, [isEditing, saving, error]);

  const startEdit = () => {
    submittedRef.current = false;
    onDraftChange(persisted);
    onClearError();
    setIsEditing(true);
  };
  const cancel = () => {
    submittedRef.current = false;
    onDraftChange(persisted);
    onClearError();
    setIsEditing(false);
  };
  const save = () => {
    if (!parsed) return;
    submittedRef.current = true;
    onSave(parsed);
  };

  if (!isEditing) {
    return (
      <BasicInfoRowShell
        rowId="inventory"
        labelTitle="班期库存"
        actions={
          <button
            type="button"
            className={`${shared.btn} ${shared.btnSm}`}
            data-variant={hasValue ? "ghost" : "primary"}
            onClick={startEdit}
            aria-label={hasValue ? "编辑班期库存" : "设置班期库存"}
            disabled={saving}
          >
            <Pencil size={12} aria-hidden="true" />{hasValue ? "编辑" : "去设置"}
          </button>
        }
      >
        {hasValue && startDate !== null && endDate !== null && dailyQuota !== null ? (
          <div className={styles.rowDisplay}>
            <CalendarDays size={12} aria-hidden="true" />
            <strong>{startDate} 至 {endDate}</strong>
            <span className={styles.priceSeparator} aria-hidden="true">·</span>
            <strong>每日 {dailyQuota.toLocaleString("zh-CN")} 位</strong>
          </div>
        ) : (
          <>
            <div className={styles.rowDisplay} data-state="empty">
              <CalendarDays size={12} aria-hidden="true" />
              <strong>待设置班期库存</strong>
              <span className={styles.tag} data-tone="warn">待补充</span>
            </div>
            <span className={styles.hint}>
              点击「去设置」填入班期起止日期与每日配额，保存后将写入 commercial.inventory。
            </span>
          </>
        )}
      </BasicInfoRowShell>
    );
  }

  return (
    <BasicInfoRowShell
      rowId="inventory"
      labelTitle="班期库存"
      error={error}
      actions={
        <>
          {saving ? <LoaderCircle size={12} className={styles.spin} aria-label="保存中" /> : null}
          <button
            type="button"
            className={`${shared.btn} ${shared.btnSm}`}
            onClick={cancel}
            disabled={saving}
            aria-label="取消编辑班期库存"
          >
            <X size={12} aria-hidden="true" />取消
          </button>
          <button
            type="button"
            className={`${shared.btn} ${shared.btnSm}`}
            data-variant={canSave ? "primary" : "ghost"}
            onClick={save}
            disabled={saving || !canSave}
          >
            保存
          </button>
        </>
      }
    >
      <div className={styles.inputGroup}>
        <label className={styles.priceLabel}>
          <span className={styles.priceLabelText}>开始日期</span>
          <input
            className={styles.input}
            type="date"
            value={draft.startDate}
            onChange={(event) => onDraftChange({ ...draft, startDate: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); save(); }
              else if (event.key === "Escape") { event.preventDefault(); cancel(); }
            }}
            aria-label="班期开始日期"
            data-state={error ? "error" : undefined}
            disabled={saving}
            autoFocus
          />
        </label>
        <label className={styles.priceLabel}>
          <span className={styles.priceLabelText}>结束日期</span>
          <input
            className={styles.input}
            type="date"
            value={draft.endDate}
            onChange={(event) => onDraftChange({ ...draft, endDate: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); save(); }
              else if (event.key === "Escape") { event.preventDefault(); cancel(); }
            }}
            aria-label="班期结束日期"
            data-state={error ? "error" : undefined}
            disabled={saving}
          />
        </label>
        <label className={styles.priceLabel}>
          <span className={styles.priceLabelText}>每日配额</span>
          <input
            className={styles.input}
            type="number"
            min={1}
            step={1}
            value={draft.dailyQuota}
            onChange={(event) => onDraftChange({ ...draft, dailyQuota: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); save(); }
              else if (event.key === "Escape") { event.preventDefault(); cancel(); }
            }}
            placeholder="正整数"
            aria-label="每日配额"
            data-state={error ? "error" : undefined}
            disabled={saving}
          />
        </label>
      </div>
      <span className={styles.hint}>
        校验：日期必须为 YYYY-MM-DD，开始日期不能晚于结束日期，每日配额必须为正整数。
      </span>
    </BasicInfoRowShell>
  );
}
