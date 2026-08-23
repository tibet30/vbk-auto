/**
 * 「套餐定价」行：commercial.pricing.adult / child / minimumTravelers（CNY）。
 *
 * 行为契约：
 *  - 父组件不再按 adult 非空来挂载本行 —— 只要进入基础信息模块，定价行就
 *    始终可见；任一字段缺失时显示「待设置套餐定价」紧凑空状态 + 编辑按钮；
 *  - 默认展示态：
 *      * adult 非空 → 「成人 ¥xxx · 儿童 ¥xxx · 起订 N 人」
 *        （child / minimumTravelers 缺失时整体视为「待设置」，不进入展示态）；
 *      * adult 为空 → 「待设置套餐定价」+ 「待补充」chip，提示用户进入编辑；
 *  - 编辑态：原位展开三个 number input；保存成功 / 取消立即回到展示态；
 *  - 货币固定为 CNY（schema 限定），不在 UI 暴露货币选择；
 *  - 校验复用 helpers.parsePricingDraft：成人 > 0、儿童 ≥ 0、起订人数正整数；
 *  - 编辑初始 draft：null / missing 走空字符串，保存校验仍是 成人 > 0、
 *    儿童 ≥ 0、起订人数正整数；起订人数**绝不**默认填值，缺则提示错误；
 *  - 不在 null / undefined 上调用 toLocaleString：缺失态完全跳过数值格式化。
 */
import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Pencil, Wallet, X } from "lucide-react";
import shared from "../shared.module.less";
import { BasicInfoRowShell } from "./basic-info-row-shell";
import { parsePricingDraft } from "./review-summary-basic-info.helpers";
import styles from "./review-summary-basic-info.module.less";

export interface BasicInfoPricingRowProps {
  /** product.commercial.pricing.adult；null 表示产品尚未设置（显示空状态）。 */
  adult: number | null;
  /** product.commercial.pricing.child；null 表示产品尚未设置（与 adult 任一缺失即整体隐藏 child 渲染）。 */
  child: number | null;
  /** product.commercial.pricing.minimumTravelers；null 表示产品尚未设置起订人数。 */
  minimumTravelers: number | null;
  draft: { adult: string; child: string; minimumTravelers: string };
  saving: boolean;
  error: string | undefined;
  onDraftChange: (next: { adult: string; child: string; minimumTravelers: string }) => void;
  onSave: (parsed: { adult: number; child: number; minimumTravelers: number }) => void;
  onClearError: () => void;
}

/** 把 number|null 安全转换成 draft 字符串：null → ""。 */
function toDraftString(value: number | null): string {
  return value === null ? "" : String(value);
}

export function BasicInfoPricingRow({
  adult,
  child,
  minimumTravelers,
  draft,
  saving,
  error,
  onDraftChange,
  onSave,
  onClearError,
}: BasicInfoPricingRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const submittedRef = useRef(false);
  // 编辑 draft 初值：null 走空串，number 走 String(value)。避免在 null 上调 toLocaleString。
  const persisted = {
    adult: toDraftString(adult),
    child: toDraftString(child),
    minimumTravelers: toDraftString(minimumTravelers),
  };
  const parsed = parsePricingDraft(draft.adult, draft.child, draft.minimumTravelers);
  const canSave = parsed !== null;
  // 展示态要求三字段同时具备；任一缺失即走空状态，不强行把 minimumTravelers 默认成 1。
  const hasValue = adult !== null && child !== null && minimumTravelers !== null;

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
            data-variant={hasValue ? "ghost" : "primary"}
            onClick={startEdit}
            aria-label={hasValue ? "编辑套餐定价" : "设置套餐定价"}
            disabled={saving}
          >
            <Pencil size={12} aria-hidden="true" />{hasValue ? "编辑" : "去设置"}
          </button>
        }
      >
        {hasValue && adult !== null && child !== null && minimumTravelers !== null ? (
          <div className={styles.rowDisplay}>
            <Wallet size={12} aria-hidden="true" />
            <strong>成人 ¥ {adult.toLocaleString("zh-CN")}</strong>
            <span className={styles.priceSeparator} aria-hidden="true">·</span>
            <strong>儿童 ¥ {child.toLocaleString("zh-CN")}</strong>
            <span className={styles.priceSeparator} aria-hidden="true">·</span>
            <strong>起订 {minimumTravelers.toLocaleString("zh-CN")} 人</strong>
          </div>
        ) : (
          <>
            <div className={styles.rowDisplay} data-state="empty">
              <Wallet size={12} aria-hidden="true" />
              <strong>待设置套餐定价</strong>
              <span className={styles.tag} data-tone="warn">待补充</span>
            </div>
            <span className={styles.hint}>
              点击「去设置」填入成人价 / 儿童价 / 起订人数（CNY），保存后将写入 commercial.pricing。
            </span>
          </>
        )}
      </BasicInfoRowShell>
    );
  }

  return (
    <BasicInfoRowShell
      rowId="pricing"
      labelTitle="套餐定价"
      error={error}
      className={styles.rowCenter}
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
        <label className={styles.priceLabel}>
          <span className={styles.priceLabelText}>起订人数</span>
          <input
            className={styles.input}
            type="number"
            min={1}
            step={1}
            value={draft.minimumTravelers}
            onChange={(event) => onDraftChange({ ...draft, minimumTravelers: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); save(); }
              else if (event.key === "Escape") { event.preventDefault(); cancel(); }
            }}
            placeholder="正整数"
            aria-label="起订人数"
            data-state={error ? "error" : undefined}
            disabled={saving}
          />
        </label>
      </div>
    </BasicInfoRowShell>
  );
}
