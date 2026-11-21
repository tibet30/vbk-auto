import { Select } from "../../helpers/Select";
import { Check, CircleCheck, CircleX, Eye, EyeOff, LoaderCircle, PlugZap, Save, Zap } from "lucide-react";
import {
  AI_PROVIDER_PROFILES,
  aiModelOption,
  aiProviderConfig,
  aiProviderProfile,
  type AiProvider,
} from "../../../../shared/contracts.js";
import type { AppModel } from "../../app.main.model";
import shared from "../shared.module.less";
import styles from "./minimax-block.module.less";

export function AiProviderBlock({ model }: { model: AppModel }) {
  const {
    settings,
    aiConfigOpen,
    setAiConfigOpen,
    aiBaseUrl,
    aiApiKey,
    aiModel,
    setAiModel,
    aiProvider,
    showAiApiKey,
    setShowAiApiKey,
    savingAi,
    testingAi,
    loadingAiKey,
    refreshingAiModels,
    aiTest,
    setAiTest,
    aiModelLists,
    aiModelListErrors,
    openAiConfig,
    switchProvider,
    switchAiModel,
    changeAiBaseUrl,
    changeAiApiKey,
    saveAiConfig,
    testAiConnection,
  } = model;

  const activeProvider = settings?.aiProvider || "minimax";
  const activeProfile = aiProviderProfile(activeProvider);
  const activeConfig = settings ? aiProviderConfig(settings, activeProvider) : null;
  const activeModel = aiModelOption(activeProvider, activeConfig?.model || "");
  const selectedProfile = aiProviderProfile(aiProvider);
  const selectedConfig = settings ? aiProviderConfig(settings, aiProvider) : null;
  const configured = Boolean(activeConfig?.hasKey);
  const trimmedBaseUrl = aiBaseUrl.trim();
  const trimmedModel = aiModel.trim();
  const testMatches = Boolean(
    aiTest?.connected
    && aiTest.provider === aiProvider
    && aiTest.baseUrl === trimmedBaseUrl
    && aiTest.model === trimmedModel,
  );
  const activeTestMatches = Boolean(
    aiTest
    && activeConfig
    && aiTest.provider === activeProvider
    && aiTest.baseUrl === activeConfig.baseUrl
    && aiTest.model === activeConfig.model,
  );
  const busy = savingAi || testingAi || loadingAiKey || refreshingAiModels;
  const builtInModelOptions = selectedProfile.modelOptions || [];
  const discoveredModels = aiModelLists[aiProvider];
  const modelListError = aiModelListErrors[aiProvider];
  const modelOptions = discoveredModels?.length
    ? discoveredModels.map((item) => ({ value: item.id, label: item.label }))
    : builtInModelOptions;
  const selectedModelMissing = Boolean(aiModel && !modelOptions.some((option) => option.value === aiModel));

  const invalidateTest = () => {
    if (aiTest) setAiTest(null);
  };

  return <section className={styles.block}>
    <div className={styles.blockHead}>
      <span className={styles.blockIcon}><Zap size={18} aria-hidden="true" /></span>
      <div className={styles.blockHeadBody}>
        <strong>AI 模型</strong>
        <small>为 AI 对话、自动化补全与推荐选择当前使用的模型</small>
      </div>
      <span
        className={`${shared.state} ${styles.headStatus}`}
        data-state={configured ? "confirmed" : "blocked"}
      >
        <span className={shared.dot} data-state={configured ? "ok" : "block"} />
        {configured ? `${activeModel?.label || activeProfile.shortLabel} 已配置` : "当前模型未配置"}
      </span>
    </div>

    <div className={styles.blockBody}>
      {!settings ? (
        <p className={shared.sectionEmpty}>设置加载中…</p>
      ) : !aiConfigOpen ? (
        <dl className={styles.kv}>
          <div className={styles.kvRow}>
            <dt className={styles.kvLabel}>当前模型</dt>
            <dd className={styles.kvValue}>
              <strong>{activeModel?.label || activeProfile.label}</strong>
              <span className={styles.activeBadge}>使用中</span>
            </dd>
          </div>
          <div className={styles.kvRow}>
            <dt className={styles.kvLabel}>模型名</dt>
            <dd className={styles.kvValue}><span className={styles.mono}>{activeConfig?.model}</span></dd>
          </div>
          <div className={styles.kvRow}>
            <dt className={styles.kvLabel}>服务地址</dt>
            <dd className={styles.kvValue}><span className={styles.mono}>{activeConfig?.baseUrl}</span></dd>
          </div>
          <div className={styles.kvRow}>
            <dt className={styles.kvLabel}>授权方式</dt>
            <dd className={styles.kvValue}>
              {configured
                ? <span>登录账号</span>
                : <span className={shared.taskEmpty}>未登录，AI 功能不可用</span>}
            </dd>
          </div>
        </dl>
      ) : (
        <div className={styles.editForm}>
          <fieldset className={styles.modelFieldset}>
            <legend className={shared.fieldLabel}>模型配置</legend>
            <div className={styles.modelSwitcher} role="group" aria-label="选择模型配置">
              {AI_PROVIDER_PROFILES.map((profile) => {
                const profileConfig = aiProviderConfig(settings, profile.value);
                const selected = profile.value === aiProvider;
                const active = profile.value === settings.aiProvider;
                return <button
                  key={profile.value}
                  type="button"
                  aria-pressed={selected}
                  className={styles.modelOption}
                  data-selected={selected}
                  disabled={busy}
                  onClick={() => void switchProvider(profile.value as AiProvider)}
                >
                  <span className={styles.modelOptionMark}>{selected && <Check size={12} aria-hidden="true" />}</span>
                  <span className={styles.modelOptionBody}>
                    <strong>{profile.label}</strong>
                    <small>{profileConfig.model || profile.defaultModel}</small>
                  </span>
                  <span className={styles.modelOptionState} data-configured={profileConfig.hasKey}>
                    {active ? "当前使用" : profileConfig.hasKey ? "已保存" : "未配置"}
                  </span>
                </button>;
              })}
            </div>
          </fieldset>

          <label className={styles.field}>
            <span className={shared.fieldLabel}>{selectedProfile.shortLabel} 服务地址</span>
            <input
              className={shared.input}
              value={aiBaseUrl}
              onChange={(event) => changeAiBaseUrl(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              disabled={loadingAiKey}
            />
          </label>
          <div className={styles.field}>
            <div className={styles.fieldLabelRow}>
              <label className={shared.fieldLabel} htmlFor="ai-model-select">{selectedProfile.shortLabel} 模型名</label>
              {refreshingAiModels && <span className={styles.modelRefreshStatus}>
                <LoaderCircle size={13} className={styles.spinner} aria-hidden="true" /> 自动获取中…
              </span>}
            </div>
            {modelOptions.length ? <>
              <Select
                id="ai-model-select"
                value={aiModel}
                onChange={(event) => switchAiModel(event.target.value)}
                disabled={loadingAiKey || refreshingAiModels}
              >
                {selectedModelMissing && <option value={aiModel}>{aiModel}（当前选择）</option>}
                {modelOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
              <div className={styles.modelMeta}>
                <small className={shared.fieldHint}>请求模型 ID：<span className={styles.inlineModelId}>{aiModel}</span></small>
                <small
                  className={styles.modelRefreshStatus}
                  data-state={modelListError ? "blocked" : discoveredModels ? "confirmed" : undefined}
                  role="status"
                  aria-live="polite"
                >
                  {modelListError || (discoveredModels
                    ? `已自动加载 ${discoveredModels.length} 个模型`
                    : selectedConfig?.hasKey ? "正在自动获取模型目录" : "保存供应商后自动获取模型")}
                </small>
              </div>
            </> : <input
              id="ai-model-select"
              className={shared.input}
              value={aiModel}
              onChange={(event) => { setAiModel(event.target.value); invalidateTest(); }}
              placeholder={selectedProfile.defaultModel}
              spellCheck={false}
              autoComplete="off"
              disabled={loadingAiKey}
            />}
          </div>
          <div
            className={styles.testStatus}
            data-state={testingAi ? "testing" : aiTest ? (aiTest.connected ? "ok" : "error") : "idle"}
            role="status"
            aria-live="polite"
            aria-busy={testingAi}
          >
            {testingAi ? <LoaderCircle size={15} className={styles.spinner} aria-hidden="true" />
              : aiTest?.connected ? <CircleCheck size={15} aria-hidden="true" />
                : aiTest ? <CircleX size={15} aria-hidden="true" />
                  : <PlugZap size={15} aria-hidden="true" />}
            <span>{testingAi
              ? `正在测试 ${selectedProfile.shortLabel} · ${trimmedModel || selectedProfile.defaultModel}…`
              : aiTest?.message || "测试会使用当前页显示的地址、模型和登录账号。"}</span>
          </div>
        </div>
      )}
    </div>

    <footer className={styles.blockFoot}>
      <div className={styles.footHint} data-state={!aiConfigOpen && activeTestMatches ? (aiTest?.connected ? "ok" : "block") : undefined}>
        {!settings ? "加载中…"
          : aiConfigOpen ? "先测试当前配置，连接成功后再保存并切换。"
            : activeTestMatches ? aiTest?.message
              : configured ? "AI 调用经登录账号授权，不在本机保存密钥。"
                : "登录后即可测试并使用 AI 功能。"}
      </div>
      {settings && <div className={shared.btnRow}>
        {aiConfigOpen ? <>
          <button
            type="button"
            className={`${shared.btn} ${shared.btnSm}`}
            onClick={() => setAiConfigOpen(false)}
            disabled={busy}
          >取消</button>
          <button
            type="button"
            className={`${shared.btn} ${shared.btnSm}`}
            onClick={() => void testAiConnection()}
            disabled={busy}
          >
            {testingAi ? <LoaderCircle size={14} className={styles.spinner} aria-hidden="true" /> : <PlugZap size={14} aria-hidden="true" />}
            {testingAi ? "测试中…" : "测试连接"}
          </button>
          <button
            type="button"
            className={`${shared.btn} ${shared.btnSm}`}
            data-variant="primary"
            onClick={() => void saveAiConfig()}
            disabled={busy || !testMatches}
          >
            {savingAi ? <LoaderCircle size={14} className={styles.spinner} aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
            保存并使用
          </button>
        </> : <button
          type="button"
          className={`${shared.btn} ${shared.btnSm}`}
          data-variant="primary"
          onClick={openAiConfig}
        >
          <Save size={14} aria-hidden="true" />
          管理模型
        </button>}
      </div>}
    </footer>
  </section>;
}
