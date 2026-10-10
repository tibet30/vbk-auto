/**
 * 当前任务的核查 / 资源组匹配 footer。
 * - 备注输入 + 提交（提交按钮依赖备注非空）；
 * - 对车辆类资源组任务：渲染"估算并匹配资源组"二级按钮，未登录时回退到"先登录 VBK"。
 */

import { LoaderCircle, ShieldCheck, Truck } from "lucide-react";
import type { ResearchTask } from "../../../../../shared/contracts-types.js";
import { fieldStateLabel, isVehicleResourceTask } from "../../../helpers";
import shared from "../../shared.module.less";
import styles from "../review-summary.module.less";

interface ActiveTaskFooterProps {
  activeTask: ResearchTask;
  verificationNote: string;
  setVerificationNote: (value: string) => void;
  loading: boolean;
  vbkLoggedIn: boolean;
  resolvingVehicleTaskId: string | null;
  onConfirm: () => void;
  onResolveVehicle: () => void;
}

export function ActiveTaskFooter({
  activeTask,
  verificationNote,
  setVerificationNote,
  loading,
  vbkLoggedIn,
  resolvingVehicleTaskId,
  onConfirm,
  onResolveVehicle,
}: ActiveTaskFooterProps) {
  return (
    <footer className={styles.taskDetail} aria-label="当前任务详情">
      <header className={styles.taskDetailHead}>
        <span className={shared.state} data-state={activeTask.state}>{fieldStateLabel(activeTask.state)}</span>
        <strong className={styles.taskDetailTitle}>{activeTask.label}</strong>
      </header>
      <p className={styles.taskDetailText}>{activeTask.detail || "请在 VBK 或公开来源核查后回填结果。"}</p>
      <textarea
        className={styles.taskDetailInput}
        value={verificationNote}
        onChange={(event) => setVerificationNote(event.target.value)}
        placeholder="填写已在 VBK 手工确认的结果，例如 POI 名称与 ID、资源组或链接…"
        aria-label="核查结果"
      />
      <div className={styles.taskDetailActions}>
        {isVehicleResourceTask(activeTask) && (
          <button
            className={`${shared.btn} ${shared.btnSm}`}
            type="button"
            data-variant="secondary"
            disabled={!vbkLoggedIn || resolvingVehicleTaskId === activeTask.id}
            onClick={onResolveVehicle}
          >
            {resolvingVehicleTaskId === activeTask.id ? <LoaderCircle size={14} aria-hidden="true" /> : <Truck size={14} aria-hidden="true" />}
            {vbkLoggedIn ? "估算并匹配资源组" : "先登录 VBK"}
          </button>
        )}
        <button
          className={shared.btn}
          data-variant="primary"
          onClick={onConfirm}
          disabled={loading || !verificationNote.trim()}
        >
          {loading ? <LoaderCircle size={15} aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />}
          确认已处理
        </button>
      </div>
    </footer>
  );
}