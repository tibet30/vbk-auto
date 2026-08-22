import { useEffect, useRef, useState, type RefObject } from "react";
import shared from "../shared.module.less";
import styles from "./planning-rerun-confirm-dialog.module.less";

export type PlanningRerunStage = {
  id: "foundation" | "itinerary" | "completion";
  label: string;
  description: string;
  invalidates: string;
};

type PlanningRerunConfirmDialogProps = {
  stage: PlanningRerunStage | null;
  onCancel(): void;
  onConfirm(): void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
};

const TITLE_ID = "planning-rerun-confirm-title";
const DESCRIPTION_ID = "planning-rerun-confirm-description";

export function PlanningRerunConfirmDialog({
  stage,
  onCancel,
  onConfirm,
  returnFocusRef,
}: PlanningRerunConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmingRef = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const wasOpen = useRef(false);
  const open = Boolean(stage);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
      wasOpen.current = true;
      requestAnimationFrame(() => cancelRef.current?.focus());
      return;
    }
    if (dialog.open) dialog.close();
    if (wasOpen.current) {
      wasOpen.current = false;
      returnFocusRef.current?.focus();
    }
  }, [open, stage?.id, returnFocusRef]);

  useEffect(() => {
    if (!open) {
      confirmingRef.current = false;
      setConfirming(false);
    }
  }, [open]);

  const cancel = () => {
    if (confirming) return;
    onCancel();
  };

  const confirm = () => {
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    setConfirming(true);
    onConfirm();
  };

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-modal="true"
      aria-labelledby={TITLE_ID}
      aria-describedby={DESCRIPTION_ID}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      {stage && (
        <div className={styles.panel}>
          <div className={styles.content}>
            <p className={styles.eyebrow}>阶段操作确认</p>
            <h2 id={TITLE_ID}>重做“{stage.label}”</h2>
            <p id={DESCRIPTION_ID} className={styles.description}>
              这会清除当前阶段及后续的{stage.invalidates}。
            </p>
            <p className={styles.retained}>
              将保留产品 UUID、目的地、天数、形态、供应商编号和账号固定信息。
            </p>
          </div>
          <div className={styles.actions}>
            <button ref={cancelRef} className={`${shared.btn} ${shared.btnSm}`} type="button" onClick={cancel} disabled={confirming}>
              取消
            </button>
            <button className={`${shared.btn} ${shared.btnSm}`} data-variant="primary" type="button" onClick={confirm} disabled={confirming}>
              {confirming ? "正在启动…" : "确认重做"}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
