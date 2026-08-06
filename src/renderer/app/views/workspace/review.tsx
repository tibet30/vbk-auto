import {
  CalendarDays,
  CheckCircle2,
  CircleHelp,
  LoaderCircle,
  MessageCircleMore,
  RefreshCw,
  Send,
  ShieldCheck,
  Truck,
} from "lucide-react";
import type { AppModel } from "../../app.main.model";
import shared from "../shared.module.less";
import { fieldStateLabel, formatIssueGuidance, isVehicleResourceTask } from "../../helpers";
import chat from "./review.chat.module.less";
import layout from "./layout.module.less";
import styles from "./review.module.less";

function issueText(issue: { label: string; detail: string }) {
  return formatIssueGuidance(issue).guidance;
}

export function AppWorkspaceReview({ model }: { model: AppModel }) {
  const {
    project,
    input,
    setInput,
    loading,
    send,
    setBrowserUrl,
    setBrowserOpen,
    splitStyle,
    readiness,
    reviewStepStatus,
    activeTask,
    activeTaskId,
    setActiveTaskId,
    browserRef,
    verificationNote,
    setVerificationNote,
    confirmTask,
    resolveVehicleTask,
    resolvingVehicleTaskId,
    vbkLogin,
    setActiveTaskId: setActiveTask,
  } = model;

  if (!project) return null;

  const taskList = project?.researchTasks ?? [];
  const canSend = input.trim().length > 0 && !loading && Boolean(project);

  const handleSend = () => {
    if (!project || loading || !input.trim()) return;
    send();
    setBrowserUrl("");
    setBrowserOpen(true);
  };

  const handleRetryMessage = (index: number) => {
    if (!project || loading) return;
    for (let i = index - 1; i >= 0; i--) {
      const target = project.messages[i];
      if (target.role === "user") {
        send(target.content);
        setBrowserOpen(true);
        break;
      }
    }
  };

  return <div className={`${layout.stageSplit} ${styles.reviewSplit}`} style={splitStyle}>
    <section className={`${layout.panel} ${chat.ai}`} aria-label="方案对话">
      <div className={layout.panelHeader}>
        <div className={layout.panelTitleRow}>
          <span className={layout.panelNum}>01</span>
          <strong className={layout.panelTitle}>方案协作</strong>
        </div>
        <span className={layout.panelSubLine}>{(() => {
          const userTurns = project.messages.filter((m) => m.role === "user").length;
          if (userTurns === 0) return "等待你的第一条消息";
          return `${userTurns} 轮对话 · 可继续追问`;
        })()}</span>
      </div>
      <div className={chat.conversation} ref={browserRef} role="log" aria-live="polite">
        {project.messages.map((message, index) => {
          const failed = message.role === "assistant" && message.taskStatus === "failed";
          const lastQuestion = failed
            ? project.messages.slice(0, index).reverse().find((candidate) => candidate.role === "user")?.content
            : "";

          return (
            <article key={message.id} className={chat.msg} data-role={message.role} data-state={message.taskStatus}>
              <span className={chat.msgAvatar}>
                {message.role === "assistant" ? <MessageCircleMore size={14} /> : message.role === "system" ? <CircleHelp size={14} /> : "我"}
              </span>
              <div className={chat.msgBody}>
                <div className={chat.msgContent}><p>{message.content}</p></div>
                <small className={chat.msgMeta}>
                  {new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                </small>
                {failed && lastQuestion && (
                  <button
                    className={`${shared.btn} ${shared.btnSm}`}
                    type="button"
                    onClick={() => handleRetryMessage(index)}
                    disabled={!lastQuestion || loading}
                  >
                    <RefreshCw size={13} />重新发送该条问题
                  </button>
                )}
              </div>
            </article>
          );
        })}
        {loading && <div className={chat.aiThinking} role="status"><MessageCircleMore size={14} /><span>AI 正在生成回复…</span></div>}
      </div>
      <div className={chat.composer}>
        <div className={chat.composerCard}>
          <textarea
            className={chat.composerTextarea}
            placeholder="例如：把这个产品改成亲子主题；或：在右侧浏览器核查 XX 资源后，把结果填充回方案..."
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSend) {
                event.preventDefault();
                handleSend();
              }
            }}
            disabled={loading}
          />
          <button
            className={`${shared.btn} ${shared.btnLg}`}
            data-variant="primary"
            type="button"
            disabled={!canSend}
            onClick={handleSend}
          >
            {loading ? <LoaderCircle size={15} /> : <Send size={15} />}
            发送
          </button>
        </div>
      </div>
    </section>
    <aside className={`${layout.panel} ${styles.reviewSummary}`} aria-label="审查结果概要">
      <div className={layout.panelHeader}>
        <div className={layout.panelTitleRow}>
          <span className={layout.panelNum}>02</span>
          <strong className={layout.panelTitle}>待核查清单</strong>
        </div>
        <span className={shared.state} data-state={readiness.ready ? "confirmed" : "needsConfirmation"}>
          {readiness.ready ? "可以录入" : `${readiness.issues.length} 项待处理`}
        </span>
      </div>
      <div className={styles.productScroll}>
        <div className={`${styles.reviewChecklist} ${styles.reviewChecklistFull}`}>
          {readiness.issues.length === 0 ? (
            <p className={shared.sectionEmpty}>当前方案待核查项为空，可继续补充对话。</p>
          ) : (
            readiness.issues.map((issue, index) => (
              <div className={styles.reviewChecklistItem} data-priority={index === 0 ? "high" : "medium"} key={`${issue.label}-${index}`}>
                <span className={styles.reviewChecklistIndex}>{index + 1}</span>
                <span className={styles.reviewChecklistBody}>
                  <strong className={styles.reviewChecklistLabel}>{issue.label}</strong>
                  <span className={styles.reviewChecklistGuidance}>{issueText(issue)}</span>
                </span>
              </div>
            ))
          )}
        </div>
        {taskList.length ? <section className={styles.productSection}>
          <div className={styles.productSectionHead}>
            <span className={layout.panelNum}>B</span>
            <strong className={styles.productSectionTitle}>待核查任务</strong>
            <span className={styles.productSectionMeta}>{`${taskList.filter((task) => task.state === "confirmed" || task.state === "resolved").length} / ${taskList.length} 已确认`}</span>
          </div>
          <div className={styles.taskRail}>
              <div className={styles.taskRailHead}>
                <strong><CalendarDays size={14} /> 核查任务</strong>
                <small>{taskList.filter((task) => task.state === "confirmed" || task.state === "resolved").length} / {taskList.length}</small>
              </div>
              <div className={styles.taskRailBody}>
                <div className={styles.taskStrip}>
                  {taskList.map((task) => {
                    const isActive = activeTaskId === task.id;
                    const done = task.state === "confirmed" || task.state === "resolved";
                    return (
                      <button
                        key={task.id}
                        type="button"
                        className={styles.taskRowGrid}
                        data-active={isActive}
                        data-done={done}
                        onClick={() => setActiveTask(task.id)}
                        aria-label={`核查任务：${task.label}`}
                      >
                        <span className={styles.marker}>
                          {done ? <CheckCircle2 size={12} /> : <CircleHelp size={12} />}
                        </span>
                        <span className={styles.body}>
                          <span className={styles.label}>{task.label}</span>
                          <span className={styles.detail}>{task.detail || "请补充核查信息后保存"}</span>
                        </span>
                        <span className={shared.chipMini} data-on={isActive}>
                          {isActive ? "正在处理" : "待核查"}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {activeTask && !activeTask.state.match(/confirmed|resolved/) ? (
                  <div className={styles.taskDetailCard}>
                    <div className={styles.body}>
                      <div className={styles.head}>
                        <span className={shared.state} data-state={activeTask.state}>{fieldStateLabel(activeTask.state)}</span>
                      </div>
                      <h4>{activeTask.label}</h4>
                      <p>{activeTask.detail || "请在 VBK 或公开来源核查后回填结果。"}</p>
                      <textarea
                        className={styles.taskResult}
                        value={verificationNote}
                        onChange={(event) => setVerificationNote(event.target.value)}
                        placeholder="粘贴核查结果，例如资源组 ID、价格或链接…"
                        aria-label="核查结果"
                      />
                      {isVehicleResourceTask(activeTask) && (
                        <button
                          className={`${shared.btn} ${shared.btnSm} ${styles.vehicleResolveBtn}`}
                          type="button"
                          data-variant="secondary"
                          disabled={!vbkLogin?.loggedIn || resolvingVehicleTaskId === activeTask.id}
                          onClick={() => void resolveVehicleTask()}
                        >
                          {resolvingVehicleTaskId === activeTask.id ? <LoaderCircle size={14} /> : <Truck size={14} />}
                          {vbkLogin?.loggedIn ? "估算并匹配资源组" : "先登录 VBK"}
                        </button>
                      )}
                    </div>
                    <div className={styles.taskActions}>
                      <button
                        className={shared.btn}
                        data-variant="primary"
                        onClick={() => void confirmTask()}
                        disabled={loading || !verificationNote.trim()}
                      >
                        {loading ? <LoaderCircle size={15} /> : <ShieldCheck size={15} />}
                        保存并写入
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
        </section> : null}
      </div>
    </aside>
  </div>;
}
