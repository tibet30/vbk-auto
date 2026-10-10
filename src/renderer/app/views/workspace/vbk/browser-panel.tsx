/**
 * vbk.tsx 右半屏：VBK 浏览器面板（标题 + 路径 + 复制 / 刷新 / 外部打开 +
 * iframe viewport + 占位提示 + 待核查任务条）。
 *
 * 由 vbk.tsx 直接传入 AppModel 切片 + 自身维护 copiedUrl / refreshingUrl 两个 UI 状态。
 */

import { useState } from "react";
import { CalendarDays, Check, CircleHelp, Copy, ExternalLink, Maximize2, MessageCircleMore, Minimize2, RefreshCw } from "lucide-react";
import { api, copyText, formatBrowserPath } from "../../../helpers";
import shared from "../../shared.module.less";
import layout from "../layout.module.less";
import browser from "../vbk.browser.module.less";
import tasks from "../vbk.tasks.module.less";
import type { AppModel } from "../../../app.main.model";

export interface BrowserPanelProps {
  model: AppModel;
}

export function AppWorkspaceVbkBrowser({ model }: BrowserPanelProps) {
  const {
    product,
    browserFullscreen,
    setBrowserFullscreen,
    browserOpen,
    browserRef,
    browserUrl,
    vbkLogin,
    browserPlaceholderTitle,
    browserPlaceholderText,
    setLoginPanelOpen,
    setNotice,
    openLogin,
    showVbkBrowser,
    setActiveTaskId,
    activeTaskId,
  } = model;

  const [copiedUrl, setCopiedUrl] = useState(false);
  const [refreshingUrl, setRefreshingUrl] = useState(false);

  const taskList = (product?.researchTasks ?? []).filter(
    (task) => task.state !== "confirmed" && task.state !== "resolved",
  );

  return (
    <section className={`${layout.panel} ${browser.browser} ${browserFullscreen ? browser.browserFullscreen : ""}`} aria-label="VBK 浏览器">
      <div className={layout.panelHeader}>
        <div className={layout.panelTitleRow}>
          <strong className={layout.panelTitle}>VBK 浏览器</strong>
        </div>
        <button
          className={`${shared.iconBtn} ${browser.fullscreenToggle}`}
          type="button"
          data-size="sm"
          onClick={() => setBrowserFullscreen((current) => !current)}
          aria-label={browserFullscreen ? "缩小 VBK 浏览器" : "全屏 VBK 浏览器"}
          title={browserFullscreen ? "缩小" : "全屏"}
        >
          {browserFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      </div>
      <div className={browser.browserPanelHead}>
        <div className={browser.browserUrl} title={browserUrl || "/产品库"}>
          <span className={browser.host}>vbooking.ctrip.com</span>
          <span className={browser.path}>{browserUrl ? formatBrowserPath(browserUrl) : "/产品库"}</span>
        </div>
        <div className={browser.browserActions}>
          <button
            className={`${shared.iconBtn} ${copiedUrl ? browser.actionSuccess : ""}`}
            type="button"
            data-size="sm"
            onClick={() => {
              if (!browserUrl) return;
              void copyText(browserUrl).then((copied) => {
                if (!copied) {
                  setNotice("复制页面地址失败，请重试。");
                  return;
                }
                setCopiedUrl(true);
                window.setTimeout(() => setCopiedUrl(false), 1000);
              });
            }}
            disabled={!browserUrl}
            aria-label="复制页面地址"
            title={copiedUrl ? "已复制页面地址" : "复制页面地址"}
          >
            {copiedUrl ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button
            className={shared.iconBtn}
            type="button"
            data-size="sm"
            onClick={() => {
              if (!browserUrl || refreshingUrl) return;
              setRefreshingUrl(true);
              void api()!.browser.navigate(browserUrl)
                .catch((error) => setNotice(error instanceof Error ? error.message : "刷新 VBK 页面失败，请重试。"))
                .finally(() => setRefreshingUrl(false));
            }}
            disabled={!browserUrl || refreshingUrl}
            aria-label="刷新当前页面"
            title={refreshingUrl ? "正在刷新页面" : "刷新当前页面"}
          >
            <RefreshCw size={14} className={refreshingUrl ? browser.actionSpinning : ""} />
          </button>
          <button
            className={shared.iconBtn}
            type="button"
            data-size="sm"
            onClick={() => void api()!.browser.openExternal().catch((error) => setNotice(error instanceof Error ? error.message : "无法在默认浏览器中打开。"))}
            disabled={!browserUrl}
            aria-label="在默认浏览器中打开"
            title="在默认浏览器中打开"
          >
            <ExternalLink size={14} />
          </button>
        </div>
      </div>
      <div className={browser.browserViewport} ref={browserRef}>
        {!browserOpen ? (
          <div className={browser.browserPlaceholder}>
            <div className={browser.browserPlaceholderCard}>
              <MessageCircleMore size={22} />
              <h4>{browserPlaceholderTitle}</h4>
              <p>{browserPlaceholderText}</p>
              <div className={`${shared.btnRow}`}>
                {vbkLogin?.loggedIn ? (
                  <button className={shared.btn} data-variant="primary" onClick={showVbkBrowser}>
                    <MessageCircleMore size={15} /> 显示浏览器
                  </button>
                ) : (
                  <button className={shared.btn} data-variant="primary" onClick={() => openLogin()}>
                    <MessageCircleMore size={15} /> 登录 VBK
                  </button>
                )}
                <button className={shared.btn} data-variant="ghost" onClick={() => setLoginPanelOpen(false)}>
                  刷新状态
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {taskList.length ? (
          <div className={tasks.taskRail} data-empty={taskList.length === 0}>
            <div className={tasks.taskRailHead}>
              <strong><CalendarDays size={14} />待核查</strong>
              <small>{`${taskList.length} 项`}</small>
            </div>
            <div className={tasks.taskStrip}>
              {taskList.map((task) => (
                <button
                  key={task.id}
                  className={tasks.taskRowGrid}
                  onClick={() => setActiveTaskId(task.id)}
                  data-active={task.id === activeTaskId}
                >
                  <span className={tasks.marker}>
                    <CircleHelp size={12} />
                  </span>
                  <span className={tasks.body}>
                    <span className={tasks.label}>{task.label}</span>
                    <span className={tasks.detail}>{task.detail || "需要核查"}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}