import { Eye, EyeOff, LoaderCircle, PlugZap, Save, Shield, UserRound, Zap } from "lucide-react";
import type { AppModel } from "../../app.main.model";
import shared from "../shared.module.less";
import styles from "./index.module.less";

export function AppSettingsPage({ model }: { model: AppModel }) {
  const {
    settings,
    loggedAccounts,
    vbkLogin,
    checkingVbkLogin,
    openLogin,
    logoutVbk,
    miniMaxConfigOpen,
    setMiniMaxConfigOpen,
    miniMaxBaseUrl,
    setMiniMaxBaseUrl,
    miniMaxApiKey,
    setMiniMaxApiKey,
    showMiniMaxApiKey,
    setShowMiniMaxApiKey,
    savingMiniMax,
    testingMiniMax,
    miniMaxTest,
    openMiniMaxConfig,
    saveMiniMaxConfig,
    testMiniMaxConnection,
    testSavedMiniMaxConnection,
  } = model;

  return <div className={styles.settingsPage}>
    <header className={styles.settingsPageHead}>
      <h1>设置</h1>
      <p className={shared.viewSub}>连接 VBK 与 MiniMax，保证 AI 与浏览器可持续运行。</p>
    </header>

    <div className={styles.settingsStack}>
      <section className={styles.settingsBlock}>
        <div className={styles.settingsBlockHead}>
          <span className={styles.settingsBlockIcon}><UserRound size={18} /></span>
          <div className={styles.settingsBlockHeadBody}>
            <strong>VBK 登录</strong>
            <small>登录状态与可用账号</small>
          </div>
        </div>
        <div className={styles.settingsBlockBody}>
          <p>当前登录：{vbkLogin?.loggedIn ? "已登录" : "未登录"}</p>
          <p>账号显示名：{vbkLogin?.accountName || "未登录"}</p>
          <p>已记录账号：{loggedAccounts.length ? loggedAccounts.join(" / ") : "暂无账号"}</p>
          <div className={shared.btnRow}>
            <button className={`${shared.btn} ${shared.btnSm}`} onClick={() => openLogin()} disabled={checkingVbkLogin}>
              <PlugZap size={14} />
              新增登录VBK
            </button>
            {vbkLogin?.loggedIn && (
              <button
                className={`${shared.btn} ${shared.btnSm}`}
                data-variant="ghost"
                disabled={checkingVbkLogin}
                onClick={() => void logoutVbk()}
              >
                <Shield size={14} />
                退出登录
              </button>
            )}
          </div>
        </div>
      </section>

      <section className={styles.settingsBlock}>
        <div className={styles.settingsBlockHead}>
          <span className={styles.settingsBlockIcon}><Zap size={18} /></span>
          <div className={styles.settingsBlockHeadBody}>
            <strong>MiniMax 配置</strong>
            <small>AI 对话、自动化补全与推荐依赖该配置</small>
          </div>
        </div>
        <div className={styles.settingsBlockBody}>
          {!settings ? (
            <p className={shared.taskEmpty}>设置加载中…</p>
          ) : (
            <>
              {!miniMaxConfigOpen ? (
                <>
                  <p>服务地址：{settings.minimaxBaseUrl}</p>
                  <p>API Key：{settings.hasMiniMaxKey ? "已配置" : "未配置"}</p>
                  <div className={shared.btnRow}>
                    <button className={`${shared.btn} ${shared.btnSm}`} onClick={openMiniMaxConfig} data-variant="primary">
                      <Save size={14} /> 编辑配置
                    </button>
                    {settings.hasMiniMaxKey && (
                      <button className={`${shared.btn} ${shared.btnSm}`} onClick={() => void testSavedMiniMaxConnection()} disabled={testingMiniMax}>
                        {testingMiniMax ? <LoaderCircle size={14} /> : <svg aria-hidden="true" />}
                        测试已保存配置
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <label className={styles.field}>
                    <span className={shared.fieldLabel}>MiniMax 服务地址</span>
                    <input
                      className={shared.input}
                      value={miniMaxBaseUrl}
                      onChange={(event) => setMiniMaxBaseUrl(event.target.value)}
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={shared.fieldLabel}>MiniMax API Key</span>
                    <div className={shared.passInputWrap}>
                      <input
                        className={shared.input}
                        type={showMiniMaxApiKey ? "text" : "password"}
                        value={miniMaxApiKey}
                        onChange={(event) => setMiniMaxApiKey(event.target.value)}
                        placeholder={settings.hasMiniMaxKey ? "留空则沿用已保存密钥" : "请输入 API Key"}
                      />
                      <button
                        type="button"
                        className={shared.iconBtn}
                        onClick={() => setShowMiniMaxApiKey((show) => !show)}
                        aria-label={showMiniMaxApiKey ? "隐藏 API Key" : "显示 API Key"}
                      >
                        {showMiniMaxApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </label>
                  <div className={shared.btnRow}>
                    <button className={`${shared.btn} ${shared.btnSm}`} onClick={() => setMiniMaxConfigOpen(false)}>
                      取消
                    </button>
                    <button className={`${shared.btn} ${shared.btnSm}`} onClick={() => void testMiniMaxConnection()} disabled={testingMiniMax}>
                      {testingMiniMax ? <LoaderCircle size={14} /> : <PlugZap size={14} />}
                      测试
                    </button>
                    <button className={`${shared.btn} ${shared.btnSm}`} data-variant="primary" onClick={() => void saveMiniMaxConfig()} disabled={savingMiniMax}>
                      {savingMiniMax ? <LoaderCircle size={14} /> : <Save size={14} />}
                      保存
                    </button>
                  </div>
                  {miniMaxTest && (
                    <p className={`${shared.taskEmpty} ${miniMaxTest.connected ? styles.taskEmptyOk : styles.taskEmptyWarn}`} style={{ marginBottom: 0 }}>
                      {miniMaxTest.message}
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  </div>;
}
