/**
 * 「基础信息 / 管家联系人」行：product.operations.bookingControls.butler。
 *
 * 行为契约：
 *  - 默认展示态只显示 displayName + 「已绑定」chip；内部 contactCardId / providerId
 *    不暴露在 UI（产品基础信息只关心姓名，ID 是 IPC / 自动化层使用的）；
 *  - 已写入 product → 「清除」按钮；未写入但账号已配 → 「使用账号默认」按钮；
 *    账号未登录 / 未配置 → 「去账号设置」按钮；
 *  - 编辑态：原位展开三个动作按钮 + 保存/取消按钮。保存成功（saving 解除 + 持久化回流）
 *    或取消立即回到展示态；
 *  - 严禁自由文本输入 —— 联系人必须来自 AccountFixedInfo 或 VBK 联系人选择器。
 */
import { useEffect, useRef, useState } from "react";
import {
  CircleCheck,
  Eraser,
  LoaderCircle,
  Pencil,
  Settings,
  UserSquare2,
  X,
} from "lucide-react";
import type { ContactCardSelection } from "../../../../shared/contracts-types.js";
import shared from "../shared.module.less";
import { BasicInfoRowShell } from "./basic-info-row-shell";
import styles from "./review-summary-basic-info.module.less";

export interface BasicInfoButlerRowProps {
  /** product.operations.bookingControls.butler 的快照（null 表示产品尚未写入）。 */
  snapshotButler: ContactCardSelection | null;
  /** 当前账号 AccountFixedInfo.butlerName 默认值（账号未登录 / 未配置时为 null）。 */
  accountButlerDefault: ContactCardSelection | null;
  /** 当前账号名（未登录时为 null）。 */
  currentAccountName: string | null;
  saving: boolean;
  error: string | undefined;
  /** 把账号默认联系人写入 product.operations.bookingControls.butler。 */
  onUseAccountButler: (selection: ContactCardSelection) => void;
  /** 清空 product.operations.bookingControls.butler（让自动化阶段走 VBK 默认逻辑）。 */
  onClearButler: () => void;
  /** 引导用户去账号设置选联系人。 */
  onOpenAccountEditor: () => void;
}

export function BasicInfoButlerRow({
  snapshotButler,
  accountButlerDefault,
  currentAccountName,
  saving,
  error,
  onUseAccountButler,
  onClearButler,
  onOpenAccountEditor,
}: BasicInfoButlerRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const submittedRef = useRef(false);
  const isWritten = snapshotButler !== null;

  // 仅当提交过保存/清除后，saving 结束且无错误 → 自动退出编辑态。
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
    setIsEditing(true);
  };
  const cancel = () => {
    submittedRef.current = false;
    setIsEditing(false);
  };
  const useAccount = () => {
    if (!accountButlerDefault) return;
    submittedRef.current = true;
    onUseAccountButler(accountButlerDefault);
  };
  const clear = () => {
    submittedRef.current = true;
    onClearButler();
  };

  if (!isEditing) {
    return (
      <BasicInfoRowShell
        rowId="butler"
        labelTitle="管家联系人"
        actions={
          <button
            type="button"
            className={`${shared.btn} ${shared.btnSm}`}
            data-variant="ghost"
            onClick={startEdit}
            title={isWritten ? "编辑管家联系人" : "设置管家联系人"}
            aria-label="编辑管家联系人"
          >
            <Pencil size={13} aria-hidden="true" /> 编辑
          </button>
        }
      >
        {isWritten && snapshotButler
          ? (
            <>
              <div className={styles.rowDisplay}>
                <UserSquare2 size={12} aria-hidden="true" />
                <strong>{snapshotButler.displayName}</strong>
                <span className={styles.tag} data-tone="ok">已绑定</span>
              </div>
            </>
          )
          : accountButlerDefault
            ? (
              <>
                <div className={styles.rowDisplay} data-state="warn">
                  <AlertTriangleShim />
                  <span>账号已选：{accountButlerDefault.displayName}</span>
                </div>
              </>
            )
            : currentAccountName
              ? (
                <>
                  <div className={styles.rowDisplay} data-state="empty">未设置</div>
                  <span className={styles.hint}>
                    当前账号 <strong>{currentAccountName}</strong> 尚未配置管家联系人，点击「编辑」去账号设置中选择。
                  </span>
                </>
              )
              : (
                <>
                  <div className={styles.rowDisplay} data-state="empty">未设置</div>
                  <span className={styles.hint}>先登录 VBK 后再到账号设置里选择联系人。</span>
                </>
              )}
      </BasicInfoRowShell>
    );
  }

  return (
    <BasicInfoRowShell
      rowId="butler"
      labelTitle="管家联系人"
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
          {isWritten
            ? (
              <button
                type="button"
                className={`${shared.btn} ${shared.btnSm}`}
                data-variant="ghost"
                onClick={clear}
                disabled={saving}
                title="清空产品方案的管家联系人（让自动化阶段走 VBK 默认逻辑）"
              >
                <Eraser size={13} aria-hidden="true" /> 清除
              </button>
            )
            : accountButlerDefault
              ? (
                <button
                  type="button"
                  className={`${shared.btn} ${shared.btnSm}`}
                  data-variant="primary"
                  onClick={useAccount}
                  disabled={saving}
                  title="把当前账号已配置的管家联系人写入产品方案"
                >
                  <CircleCheck size={13} aria-hidden="true" /> 使用账号默认
                </button>
              )
              : (
                <button
                  type="button"
                  className={`${shared.btn} ${shared.btnSm}`}
                  onClick={onOpenAccountEditor}
                  disabled={!currentAccountName}
                  title={currentAccountName ? "去账号设置里选一个管家联系人" : "请先登录 VBK"}
                >
                  <Settings size={13} aria-hidden="true" /> 去账号设置
                </button>
              )}
        </>
      }
    >
      <div className={styles.rowDisplay} data-state={isWritten ? "ok" : accountButlerDefault ? "warn" : "empty"}>
        {isWritten && snapshotButler
          ? <><UserSquare2 size={12} aria-hidden="true" /><strong>{snapshotButler.displayName}</strong><span className={styles.tag} data-tone="ok">已选择</span></>
          : accountButlerDefault
            ? <><AlertTriangleShim /><span>待写入：{accountButlerDefault.displayName}</span></>
            : <span>待设置</span>}
      </div>
      <span className={styles.hint}>
        {isWritten
          ? "编辑中：可清除当前管家（让自动化阶段走 VBK 默认逻辑），或取消返回。"
          : accountButlerDefault
            ? "编辑中：点击「使用账号默认」将当前账号的联系人写入产品方案。"
            : currentAccountName
              ? "编辑中：去账号设置里选择一个 VBK 联系人。"
              : "请先登录 VBK，再到账号设置里选一个联系人。"}
      </span>
    </BasicInfoRowShell>
  );
}

function AlertTriangleShim() {
  // 保留一个内联小图标，避免重复 lucide 引入；视觉与 lucide AlertTriangle 12px 一致。
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
