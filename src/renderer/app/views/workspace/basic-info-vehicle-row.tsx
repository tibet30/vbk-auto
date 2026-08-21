/**
 * 「用车资源组」行：operations.vehicleResource.{resourceGroupId, resourceGroupName,
 * requestedTotalCost}。
 *
 * 行为契约（与用户验收门对齐）：
 *  - 父组件在私家团或已有 vehicleResource 时稳定挂载本行，让新产品也能
 *    直接进入「输入全程用车总成本 → 搜索 VBK 资源组」流程。
 *  - 默认展示：
 *    * 资源组名称 + ID；
 *    * 全程预计用车总成本单独一行；未填写时提示先输入总成本并搜索 VBK。
 *  - 编辑态：原位展开单个 number input（全程总成本）；资源组 ID / 名称
 *    严格只读（来自 VBK 资源库匹配，UI 禁止自由输入）。
 *  - 「清空」按钮清除本地保存的全程总成本，不允许手动清写资源组 ID / 名称。
 */
import { useEffect, useRef, useState } from "react";
import { Eraser, LoaderCircle, Pencil, Sparkles, Truck, X } from "lucide-react";
import shared from "../shared.module.less";
import { BasicInfoRowShell } from "./basic-info-row-shell";
import { parseRequestedTotalCostDraft } from "./review-summary-basic-info.helpers";
import styles from "./review-summary-basic-info.module.less";

export interface BasicInfoVehicleRowProps {
  resourceGroupId: number | null;
  resourceGroupName: string | null;
  requestedTotalCost: number | null;
  draft: string;
  saving: boolean;
  error: string | undefined;
  onDraftChange: (value: string) => void;
  onSave: (value: number) => void;
  onClear: () => void;
  onClearError: () => void;
}

export function BasicInfoVehicleRow({
  resourceGroupId,
  resourceGroupName,
  requestedTotalCost,
  draft,
  saving,
  error,
  onDraftChange,
  onSave,
  onClear,
  onClearError,
}: BasicInfoVehicleRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const submittedRef = useRef(false);
  const persisted = requestedTotalCost === null ? "" : String(requestedTotalCost);
  const parsed = parseRequestedTotalCostDraft(draft);
  const canSave = parsed !== "invalid";
  const hasMatchedResource = resourceGroupId !== null && resourceGroupName !== null && resourceGroupName.trim().length > 0;

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
    if (parsed === "invalid") return;
    submittedRef.current = true;
    onSave(parsed);
  };

  return (
    <BasicInfoRowShell
      rowId="vehicle"
      labelTitle="用车资源组"
      error={error}
      actions={
        isEditing ? (
          <>
            {saving ? <LoaderCircle size={12} className={styles.spin} aria-label="保存中" /> : null}
            <button
              type="button"
              className={`${shared.btn} ${shared.btnSm}`}
              onClick={cancel}
              disabled={saving}
              aria-label="取消编辑全程用车总成本"
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
              搜索资源组
            </button>
            <button
              type="button"
              className={`${shared.btn} ${shared.btnSm}`}
              onClick={onClear}
              disabled={saving}
              aria-label="清除全程用车总成本"
              title="清除已保存的全程用车总成本"
            >
              <Eraser size={12} aria-hidden="true" />清空
            </button>
          </>
        ) : (
          <button
            type="button"
            className={`${shared.btn} ${shared.btnSm}`}
            data-variant="ghost"
            onClick={startEdit}
            aria-label="编辑全程用车总成本"
            disabled={saving}
          >
            <Pencil size={12} aria-hidden="true" />编辑
          </button>
        )
      }
    >
      <div className={styles.resourceRow}>
        {hasMatchedResource ? (
          <div className={styles.resourceName}>
            <Truck size={12} aria-hidden="true" />
            <strong>{resourceGroupName}</strong>
            <span className={styles.resourceId}>ID {resourceGroupId}</span>
          </div>
        ) : (
          <div className={styles.resourceName}>
            <Truck size={12} aria-hidden="true" />
            <strong>资源组待匹配</strong>
            <span className={styles.tag}>输入总成本后搜索 VBK</span>
          </div>
        )}

        {isEditing ? (
          <input
            className={styles.input}
            type="number"
            min={0}
            step={1}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); save(); }
              else if (event.key === "Escape") { event.preventDefault(); cancel(); }
            }}
            placeholder="输入全程用车总成本"
            aria-label="输入全程用车总成本"
            data-state={error ? "error" : undefined}
            disabled={saving}
            autoFocus
          />
        ) : (
          <div className={styles.rowDisplay}>
            <Sparkles size={12} aria-hidden="true" />
            {requestedTotalCost !== null ? (
              <strong>全程 ¥ {requestedTotalCost.toLocaleString("zh-CN")}</strong>
            ) : (
              <strong>待输入全程总成本并搜索 VBK</strong>
            )}
            <span className={styles.tag} data-tone="ai">手动可改 · 待核查</span>
          </div>
        )}
      </div>
    </BasicInfoRowShell>
  );
}
