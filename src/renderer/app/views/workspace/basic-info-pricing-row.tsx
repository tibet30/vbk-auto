/**
 * 「套餐定价」行：commercial.pricing.adult / child（CNY）。
 *
 * 行为契约：
 *  - 仅在 adult 非空（即 pricing 已设）时本行才被父组件挂载；
 *  - 默认展示态只显示「成人 ¥xxx · 儿童 ¥xxx」，不显示货币长提示、单位说明；
 *  - 编辑态：原位展开两个 number input；保存成功 / 取消立即回到展示态；
 *  - 货币固定为 CNY（schema 限定），不在 UI 暴露货币选择；
 *  - 校验复用 helpers.parsePricingDraft：成人 > 0 / 儿童 ≥ 0。
 */
import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Pencil, Wallet, X } from "lucide-react";
import shared from "../shared.module.less";
import { BasicInfoRowShell } from "./basic-info-row-shell";
import { parsePricingDraft } from "./review-summary-basic-info.helpers";
import styles from "./review-summary-basic-info.module.less";

export interface BasicInfoPricingRowProps {
  adult: number;
  child: number;
  draft: { adult: string; child: string };
  saving: boolean;
  error: string | undefined;
  onDraftChange: (next: { adult: string; child: string }) => void;
  onSave: (parsed: { adult: number; child: number }) => void;
  onClearError: () => void;
}

export function BasicInfoPricingRow({
  adult,
  child,
  draft,
  saving,
  error,
  onDraftChange,
  onSave,
  onClearError,
}: BasicInfoPricingRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const submittedRef = useRef(false);
  const persisted = { adult: String(adult), child: String(child) };
  const parsed = parsePricingDraft(draft.adult, draft.child);
  const canSave = parsed !== null;

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
        rowId="pricing"
        labelTitle="套餐定价"
        actions={
          <button
            type="button"
            className={`${shared.btn} ${shared.btnSm}`}
            data-variant="ghost"
            onClick={startEdit}
            aria-label="编辑套餐定价"
            disabled={saving}
          >
            <Pencil size={12} aria-hidden="true" />编辑
          </button>
        }
      >
        <div className={styles.rowDisplay}>
          <Wallet size={12} aria-hidden="true" />
          <strong>成人 ¥ {adult.toLocaleString("zh-CN")}</strong>
          <span className={styles.priceSeparator} aria-hidden="true">·</span>
          <strong>儿童 ¥ {child.toLocaleString("zh-CN")}</strong>
        </div>
      </BasicInfoRowShell>
    );
  }

  return (
    <BasicInfoRowShell
      rowId="pricing"
      labelTitle="套餐定价"
      error={error}
      actions={
        <>
          {saving ? <LoaderCircle size={12} className={styles.spin} aria-label="保存中" /> : null}
          <button
            type="button"
            className={`${shared.btn} ${shared.btnSm}`}
            onClick={cancel}
            disabled={saving}
            aria-label="取消编辑套餐定价"
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
          <span className={styles.priceLabelText}>成人</span>
          <input
            className={styles.input}
            type="number"
            min={0}
            step={1}
            value={draft.adult}
            onChange={(event) => onDraftChange({ ...draft, adult: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); save(); }
              else if (event.key === "Escape") { event.preventDefault(); cancel(); }
            }}
            placeholder="成人价"
            aria-label="成人价"
            data-state={error ? "error" : undefined}
            disabled={saving}
            autoFocus
          />
        </label>
        <label className={styles.priceLabel}>
          <span className={styles.priceLabelText}>儿童</span>
          <input
            className={styles.input}
            type="number"
            min={0}
            step={1}
            value={draft.child}
            onChange={(event) => onDraftChange({ ...draft, child: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); save(); }
              else if (event.key === "Escape") { event.preventDefault(); cancel(); }
            }}
            placeholder="儿童价"
            aria-label="儿童价"
            data-state={error ? "error" : undefined}
            disabled={saving}
          />
        </label>
      </div>
    </BasicInfoRowShell>
  );
}
