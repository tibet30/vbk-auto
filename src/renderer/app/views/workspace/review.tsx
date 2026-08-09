import {
  CircleHelp,
  LoaderCircle,
  MessageCircleMore,
  RefreshCw,
  RotateCcw,
  Send,
} from "lucide-react";
import type { AppModel } from "../../app.main.model";
import shared from "../shared.module.less";
import chat from "./review.chat.module.less";
import layout from "./layout.module.less";
import { AppWorkspaceReviewSummary } from "./review-summary";

export function AppWorkspaceReview({ model }: { model: AppModel }) {
  const {
    project,
    input,
    setInput,
    loading,
    setNotice,
    send,
    setBrowserUrl,
    setBrowserOpen,
    splitStyle,
    readiness,
    activeTask,
    setActiveTaskId,
    browserRef,
    verificationNote,
    setVerificationNote,
    confirmTask,
    resolveVehicleTask,
    resolvingVehicleTaskId,
    vbkLogin,
    itinerary,
    expandedDayIndex,
    setExpandedDayIndex,
    planningRecovery,
    planningResume,
    planningBusy,
  } = model;

  if (!project) return null;

  const taskList = project.researchTasks ?? [];
  const planningActive = planningRecovery?.status === "pending" || planningRecovery?.status === "running";
  const planningPartial = planningRecovery?.status === "completed" && !planningRecovery.allStagesCompleted;
  const planningResumable = planningRecovery?.status === "needs_user"
    || planningRecovery?.status === "failed"
    || planningPartial;
  const canSend = input.trim().length > 0 && !loading && !planningActive;

  const handleSend = () => {
    if (!project || loading || planningActive || !input.trim()) {
      if (planningActive) setNotice("方案正在分阶段生成中，请完成后再继续对话。");
      return;
    }
    send();
    setBrowserUrl("");
    setBrowserOpen(true);
  };

  const handleRetryMessage = async (targetMessageId: string) => {
    if (!project) {
      setNotice("当前未选中项目，请先打开项目后重试。");
      return;
    }
    if (loading || planningActive) {
      setNotice("AI 正在生成中，请稍后再点击“重新发送该条问题”。");
      return;
    }
    const targetIndex = project.messages.findIndex((item) => item.id === targetMessageId);
    let retryContent = "";
    if (targetIndex >= 0) {
      const target = project.messages[targetIndex];
      if (target.role === "user" && target.content.trim()) {
        retryContent = target.content.trim();
      }

      for (let i = targetIndex - 1; i >= 0 && !retryContent; i -= 1) {
        const candidate = project.messages[i];
        if (candidate.role === "user" && candidate.content.trim()) {
          retryContent = candidate.content.trim();
          break;
        }
      }

      if (!retryContent && targetIndex > 0) {
        const previous = project.messages[targetIndex - 1];
        if (previous?.role === "user" && previous.content.trim()) {
          retryContent = previous.content.trim();
        }
      }
    }

    if (!retryContent && !input.trim()) {
      const latestUser = project.messages.slice().reverse().find((item) => item.role === "user" && item.content.trim());
      if (latestUser) {
        retryContent = latestUser.content.trim();
        setNotice("未找到目标上下文，已使用最近一条提问内容重试。");
      }
    }

    if (!retryContent && input.trim()) {
      retryContent = input.trim();
      setNotice("未检测到可重试的历史提问，已使用当前输入框内容重发。");
    }
    if (!retryContent) {
      setNotice("未找到可重试的问题内容，请在输入框手动重新提交该问题。");
      return;
    }
    setNotice("正在重发该条问题并请求结构化补齐，请稍等。");
    await send(retryContent, true, { isRetry: true });
    setBrowserOpen(true);
  };

  const userTurns = project.messages.filter((m) => m.role === "user").length;

  return (
    <div className={layout.stageSplit} style={splitStyle}>
      <section className={`${layout.panel} ${chat.ai}`} aria-label="方案对话">
        <div className={layout.panelHeader}>
          <div className={layout.panelTitleRow}>
            <span className={layout.panelNum}>01</span>
            <strong className={layout.panelTitle}>方案协作</strong>
          </div>
          <span className={layout.panelSubLine}>
            {userTurns === 0 ? "等待你的第一条消息" : `${userTurns} 轮对话 · 可继续追问`}
          </span>
        </div>
        <div className={chat.conversation} ref={browserRef} role="log" aria-live="polite">
          {planningRecovery && (planningRecovery.status === "needs_user" || planningRecovery.status === "failed" || planningRecovery.status === "running" || planningRecovery.status === "pending" || planningPartial) && (
            <article
              className={chat.recoveryStrip}
              data-status={planningRecovery.status}
              aria-label="方案规划恢复面板"
            >
              <header className={chat.recoveryHead}>
                <span className={chat.recoveryIcon}>
                  {planningRecovery.status === "running" || planningRecovery.status === "pending" ? <LoaderCircle size={14} /> : <RotateCcw size={14} />}
                </span>
                <strong className={chat.recoveryHeadline}>{planningRecovery.headline}</strong>
                {planningResumable && (
                  <button
                    className={`${shared.btn} ${shared.btnSm}`}
                    type="button"
                    data-variant="ai"
                    onClick={() => void planningResume()}
                    disabled={planningBusy || loading}
                    data-testid="planning-resume-button"
                  >
                    {planningBusy ? <LoaderCircle size={13} /> : <RefreshCw size={13} />}
                    {planningRecovery.status === "failed" ? "重试规划" : "继续规划"}
                  </button>
                )}
              </header>
              {(planningRecovery.status === "running" || planningRecovery.status === "pending" || planningPartial) && planningRecovery.currentStageLabel && (
                <p className={chat.recoveryCurrentStage}>
                  当前阶段：<strong>{planningRecovery.currentStageLabel}</strong>
                </p>
              )}
              {(planningRecovery.status === "running" || planningRecovery.status === "pending" || planningPartial) && planningRecovery.stageProgress && planningRecovery.stageProgress.length > 0 && (
                <ol className={chat.recoveryStageList} aria-label="规划阶段进度">
                  {planningRecovery.stageProgress.map((entry: { stage: string; label: string; state: "completed" | "current" | "pending" }) => {
                    // 用户可见的状态文案：内部数据用 completed / current / pending 三档，
                    // 渲染时翻译成「已完成 / 进行中 / 待开始」三档之一。色弱/灰度模式下也能
                    // 区分，必须显式说出口，不能仅靠颜色暗示。
                    const phaseStateText = entry.state === "completed"
                      ? "已完成"
                      : entry.state === "current"
                        ? "进行中"
                        : "待开始";
                    return (
                      <li
                        key={entry.stage}
                        className={chat.recoveryStageItem}
                        data-state={entry.state}
                        aria-label={`${entry.label}：${phaseStateText}`}
                      >
                        <span className={chat.recoveryStageDot} aria-hidden="true" />
                        {/* entry.label 是中文短标签（如「产品骨架」）；entry.stage 是内部 ID（如 skeleton），
                            绝不作为可见主标签出现，避免泄漏 dev-only 枚举字符串。 */}
                        <span className={chat.recoveryStageLabel}>{entry.label}</span>
                        <span className={chat.recoveryStageState}>{phaseStateText}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
              <p className={chat.recoveryHint}>{planningRecovery.hint}</p>
              <div className={chat.recoveryChips}>
                {planningRecovery.accepted.length > 0 && (
                  <span className={chat.recoveryChipGroup} data-tone="ok">
                    已接受：
                    {planningRecovery.accepted.map((m: string) => (
                      <span key={m} className={shared.chipMini} data-on="true">{m}</span>
                    ))}
                  </span>
                )}
                {planningRecovery.missing.length > 0 && (
                  <span className={chat.recoveryChipGroup} data-tone="warn">
                    缺失：
                    {planningRecovery.missing.map((m: string) => (
                      <span key={m} className={shared.chipMini}>{m}</span>
                    ))}
                  </span>
                )}
              </div>
            </article>
          )}
          {project.messages.map((message, index) => {
            const failed = message.role === "assistant" && message.taskStatus === "failed";
              const lastQuestion = failed
              ? project.messages.slice(0, index).reverse().find((candidate) => candidate.role === "user" && candidate.content.trim())?.content?.trim()
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
                        onClick={() => handleRetryMessage(message.id)}
                        disabled={loading}
                      >
                        <RefreshCw size={13} />重新发送该条问题
                      </button>
                    )}
                </div>
              </article>
            );
          })}
          {loading && (
            <div className={chat.aiThinking} role="status">
              <MessageCircleMore size={14} />
              <span>AI 正在生成回复…</span>
            </div>
          )}
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

      <AppWorkspaceReviewSummary
        project={project}
        readiness={readiness}
        itinerary={itinerary as any}
        taskList={taskList}
        activeTask={activeTask}
        verificationNote={verificationNote}
        setVerificationNote={setVerificationNote}
        setComposerInput={setInput}
        planningRecovery={planningRecovery}
        setActiveTask={setActiveTaskId}
        expandedDayIndex={expandedDayIndex}
        setExpandedDayIndex={setExpandedDayIndex}
        vbkLoggedIn={Boolean(vbkLogin?.loggedIn)}
        resolvingVehicleTaskId={resolvingVehicleTaskId}
        loading={loading}
        onConfirmTask={() => void confirmTask()}
        onResolveVehicle={() => void resolveVehicleTask()}
      />
    </div>
  );
}
