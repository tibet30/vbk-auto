import { Eye, EyeOff, LoaderCircle, PlugZap, Save, Zap } from "lucide-react";
import type { AppModel } from "../../app.main.model";
import shared from "../shared.module.less";
import styles from "./minimax-block.module.less";

export function MiniMaxBlock({ model }: { model: AppModel }) {
  const {
    settings,
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

  const minimaxConfigured = !!settings?.hasMiniMaxKey;

  return <section className={styles.block}>
    <div className={styles.blockHead}>
      <span className={styles.blockIcon}><Zap size={18} /></span>
      <div className={styles.blockHeadBody}>
        <strong>MiniMax 配置</strong>
        <small>AI 对话、自动化补全与推荐依赖该配置</small>
      </div>
      <span
        className={`${shared.state} ${styles.headStatus}`}
        data-state={minimaxConfigured ? "confirmed" : "blocked"}
      >
        <span className={shared.dot} data-state={minimaxConfigured ? "ok" : "block"} />
        {minimaxConfigured ? "已配置" : "未配置"}
      </span>
    </div>

    <div className={styles.blockBody}>
      {!settings ? (
        <p className={shared.sectionEmpty}>设置加载中…</p>
      ) : !miniMaxConfigOpen ? (
        <dl className={styles.kv}>
          <div className={styles.kvRow}>
            <dt className={styles.kvLabel}>服务地址</dt>
            <dd className={styles.kvValue}>
              <span className={styles.mono}>{settings.minimaxBaseUrl}</span>
            </dd>
          </div>
          <div className={styles.kvRow}>
            <dt className={styles.kvLabel}>API Key</dt>
            <dd className={styles.kvValue}>
              {minimaxConfigured ? (
                <span className={styles.apiKeyMasked}>sk-••••••••••••••••</span>
              ) : (
                <span className={shared.taskEmpty}>未配置，AI 功能不可用</span>
              )}
            </dd>
          </div>
          <div className={styles.kvRow}>
            <dt className={styles.kvLabel}>存储位置</dt>
            <dd className={styles.kvValue}>
              <span className={shared.taskEmpty}>macOS 加密钥匙串（仅本机）</span>
            </dd>
          </div>
        </dl>
      ) : (
        <div className={styles.editForm}>
          <label className={styles.field}>
            <span className={shared.fieldLabel}>MiniMax 服务地址</span>
            <input
              className={shared.input}
              value={miniMaxBaseUrl}
              onChange={(event) => setMiniMaxBaseUrl(event.target.value)}
              spellCheck={false}
              autoComplete="off"
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
                spellCheck={false}
                autoComplete="off"
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
            <small className={shared.fieldHint}>仅保存在本机 macOS Keychain，不会写入仓库。</small>
          </label>
          {miniMaxTest && (
            <p
              className={`${shared.taskEmpty} ${miniMaxTest.connected ? styles.taskEmptyOk : styles.taskEmptyWarn}`}
              style={{ marginBottom: 0, marginTop: 4 }}
            >
              {miniMaxTest.message}
            </p>
          )}
        </div>
      )}
    </div>

    <footer className={styles.blockFoot}>
      <div
        className={styles.footHint}
        data-state={
          !settings || miniMaxConfigOpen
            ? undefined
            : miniMaxTest
              ? (miniMaxTest.connected ? "ok" : "block")
              : undefined
        }
        title={miniMaxTest?.message}
      >
        {!settings
          ? "加载中…"
          : miniMaxConfigOpen
            ? "保存后会立刻测试连通性，失败可回滚。"
            : minimaxConfigured
              ? miniMaxTest
                ? (miniMaxTest.connected ? "上次测试：通过" : "上次测试：失败")
                : "上次测试：未运行"
              : "未配置时 AI 对话、自动化补全均不可用。"}
        {miniMaxTest && !miniMaxConfigOpen && (
          <span className={styles.footHintDetail}>
            {miniMaxTest.message}
          </span>
        )}
      </div>
      {settings && (
        <div className={shared.btnRow}>
          {miniMaxConfigOpen ? (
            <>
              <button
                className={`${shared.btn} ${shared.btnSm}`}
                onClick={() => setMiniMaxConfigOpen(false)}
                disabled={savingMiniMax || testingMiniMax}
              >
                取消
              </button>
              <button
                className={`${shared.btn} ${shared.btnSm}`}
                onClick={() => void testMiniMaxConnection()}
                disabled={testingMiniMax}
              >
                {testingMiniMax ? <LoaderCircle size={14} /> : <PlugZap size={14} />}
                测试
              </button>
              <button
                className={`${shared.btn} ${shared.btnSm}`}
                data-variant="primary"
                onClick={() => void saveMiniMaxConfig()}
                disabled={savingMiniMax}
              >
                {savingMiniMax ? <LoaderCircle size={14} /> : <Save size={14} />}
                保存
              </button>
            </>
          ) : (
            <>
              {minimaxConfigured && (
                <button
                  className={`${shared.btn} ${shared.btnSm}`}
                  onClick={() => void testSavedMiniMaxConnection()}
                  disabled={testingMiniMax}
                >
                  {testingMiniMax ? <LoaderCircle size={14} /> : <PlugZap size={14} />}
                  测试已保存配置
                </button>
              )}
              <button
                className={`${shared.btn} ${shared.btnSm}`}
                data-variant="primary"
                onClick={openMiniMaxConfig}
              >
                <Save size={14} />
                {minimaxConfigured ? "重新配置" : "配置 API Key"}
              </button>
            </>
          )}
        </div>
      )}
    </footer>
  </section>;
}