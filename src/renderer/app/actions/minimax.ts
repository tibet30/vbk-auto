import { useEffect, useRef } from "react";
import {
  aiModelOption,
  aiProviderConfig,
  aiProviderProfile,
  type AiProvider,
  type ConnectionTest,
} from "../../../shared/contracts.js";
import { api } from "../helpers";
import { readAiConnectionTest, rememberAiConnectionTest } from "../helpers/ai-test-receipts";
import type { AppState } from "../state/useAppState";

function validateServiceUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback);
  } catch {
    return false;
  }
}

export function useAiHandlers(state: AppState) {
  const {
    settings,
    aiConfigOpen,
    setAiConfigOpen,
    setAiBaseUrl,
    setAiApiKey,
    setAiModel,
    setAiTest,
    setShowAiApiKey,
    aiBaseUrl,
    aiApiKey,
    aiModel,
    aiProvider,
    setAiProvider,
    setNotice,
    setSavingAi,
    setTestingAi,
    setLoadingAiKey,
    aiTest,
    setAiModelLists,
    setRefreshingAiModels,
    setAiModelListErrors,
    setSettings,
  } = state;
  const testRequestId = useRef(0);
  const modelListRequestId = useRef<Record<AiProvider, number>>({ minimax: 0, deepseek: 0 });

  const loadAiModelList = async (provider: AiProvider, baseUrl: string, apiKey = "") => {
    if (!api() || !validateServiceUrl(baseUrl)) return;
    const requestId = ++modelListRequestId.current[provider];
    setRefreshingAiModels(true);
    setAiModelListErrors((current) => ({ ...current, [provider]: undefined }));
    try {
      const result = await api()!.settings.listModels({
        provider,
        baseUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      if (requestId === modelListRequestId.current[provider]) {
        setAiModelLists((current) => ({ ...current, [provider]: result.models }));
      }
    } catch (error) {
      if (requestId === modelListRequestId.current[provider]) {
        setAiModelListErrors((current) => ({
          ...current,
          [provider]: error instanceof Error ? error.message : "无法自动获取模型列表。",
        }));
      }
    } finally {
      if (requestId === modelListRequestId.current[provider]) setRefreshingAiModels(false);
    }
  };

  useEffect(() => {
    if (!settings) return;
    if (settings.hasMiniMaxKey) void loadAiModelList("minimax", settings.minimaxBaseUrl);
    if (settings.hasDeepSeekKey) void loadAiModelList("deepseek", settings.deepseekBaseUrl);
  }, [settings?.hasMiniMaxKey, settings?.minimaxBaseUrl, settings?.hasDeepSeekKey, settings?.deepseekBaseUrl]);

  useEffect(() => {
    const key = aiApiKey.trim();
    const baseUrl = aiBaseUrl.trim();
    if (!aiConfigOpen || !key || !validateServiceUrl(baseUrl)) return;
    const timer = window.setTimeout(() => void loadAiModelList(aiProvider, baseUrl, key), 500);
    return () => window.clearTimeout(timer);
  }, [aiConfigOpen, aiProvider, aiBaseUrl, aiApiKey]);

  const switchProvider = async (provider: AiProvider) => {
    testRequestId.current += 1;
    const profile = aiProviderProfile(provider);
    const config = settings ? aiProviderConfig(settings, provider) : null;

    setAiProvider(provider);
    setAiBaseUrl(config?.baseUrl || profile.defaultBaseUrl);
    const configuredModel = config?.model || profile.defaultModel;
    const model = configuredModel.trim() || profile.defaultModel;
    setAiModel(model);
    setAiApiKey("");
    setShowAiApiKey(false);
    setAiTest(readAiConnectionTest(provider, model));
    setAiModelListErrors((current) => ({ ...current, [provider]: undefined }));
    setNotice(null);
    // API Key 永远不从本机读回：渲染端只持有「临时未保存」的输入框值。
    // 如需校验或调用模型，由调用方在 settings:listModels / settings:test 的入参里
    // 显式带上当前 UI 输入框的 key；持久化需要走 settings:save。
    setLoadingAiKey(false);
    if (config?.hasKey) void loadAiModelList(provider, config.baseUrl);
  };

  const openAiConfig = () => {
    if (!settings) return;
    setAiConfigOpen(true);
    void switchProvider(settings.aiProvider || "minimax");
  };

  const switchAiModel = (model: string) => {
    setAiModel(model);
    setAiTest(readAiConnectionTest(aiProvider, model));
    setNotice(null);
  };

  const changeAiBaseUrl = (baseUrl: string) => {
    modelListRequestId.current[aiProvider] += 1;
    setRefreshingAiModels(false);
    setAiBaseUrl(baseUrl);
    setAiModelLists((current) => ({ ...current, [aiProvider]: undefined }));
    setAiModelListErrors((current) => ({ ...current, [aiProvider]: undefined }));
    setAiTest(null);
  };

  const changeAiApiKey = (key: string) => {
    modelListRequestId.current[aiProvider] += 1;
    setRefreshingAiModels(false);
    setAiApiKey(key);
    setAiModelLists((current) => ({ ...current, [aiProvider]: undefined }));
    setAiModelListErrors((current) => ({ ...current, [aiProvider]: undefined }));
    setAiTest(null);
  };

  const saveAiConfig = async () => {
    const baseUrl = aiBaseUrl.trim();
    const model = aiModel.trim();
    const apiKey = aiApiKey.trim();
    const profile = aiProviderProfile(aiProvider);
    if (!api()) return;
    if (!validateServiceUrl(baseUrl)) {
      setNotice("服务地址必须使用 https://；本机调试可使用 http://127.0.0.1。");
      return;
    }
    if (!model) {
      setNotice("请填写模型名。");
      return;
    }
    const testMatches = aiTest?.connected
      && aiTest.provider === aiProvider
      && aiTest.baseUrl === baseUrl
      && aiTest.model === model;
    if (!testMatches) {
      setNotice("请先测试当前模型，连接成功后再保存使用。");
      return;
    }

    setSavingAi(true);
    setNotice(null);
    try {
      const nextSettings = aiProvider === "minimax"
        ? await api()!.settings.save({
          aiProvider,
          minimaxBaseUrl: baseUrl,
          minimaxModel: model,
          ...(apiKey ? { apiKey } : {}),
        })
        : await api()!.settings.save({
          aiProvider,
          deepseekBaseUrl: baseUrl,
          deepseekModel: model,
          ...(apiKey ? { deepseekApiKey: apiKey } : {}),
        });
      setSettings(nextSettings);
      setAiApiKey("");
      setShowAiApiKey(false);
      setAiConfigOpen(false);
      setNotice(`${profile.shortLabel} · ${model} 已保存并切换为当前模型。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `无法保存 ${profile.shortLabel} 配置。`);
    } finally {
      setSavingAi(false);
    }
  };

  const switchWorkspaceAiModel = async (provider: AiProvider, model: string) => {
    if (!api() || !settings) return;
    const config = aiProviderConfig(settings, provider);
    if (!config.hasKey) {
      setNotice(`请先到设置中配置 ${aiProviderProfile(provider).shortLabel}。`);
      return;
    }
    if (settings.aiProvider === provider && config.model === model) return;

    setSavingAi(true);
    setNotice(null);
    try {
      const nextSettings = await api()!.settings.save(provider === "minimax"
        ? { aiProvider: provider, minimaxModel: model }
        : { aiProvider: provider, deepseekModel: model });
      setSettings(nextSettings);
      const label = aiModelOption(provider, model)?.label || model;
      setNotice(`已切换到 ${label}，下一次 AI 请求开始使用。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "模型切换失败，请重试。");
    } finally {
      setSavingAi(false);
    }
  };

  const testAiConnection = async () => {
    const baseUrl = aiBaseUrl.trim();
    const model = aiModel.trim();
    const apiKey = aiApiKey.trim();
    const profile = aiProviderProfile(aiProvider);
    const storedKeyAvailable = settings ? aiProviderConfig(settings, aiProvider).hasKey : false;
    if (!api()) return;
    if (!validateServiceUrl(baseUrl)) {
      setNotice("服务地址必须使用 https://；本机调试可使用 http://127.0.0.1。");
      return;
    }
    if (!model) {
      setNotice("请填写要测试的模型名。");
      return;
    }
    if (!apiKey && !storedKeyAvailable) {
      setNotice(`请填写 ${profile.shortLabel} API Key 后再测试。`);
      return;
    }

    const requestId = ++testRequestId.current;
    setTestingAi(true);
    setAiTest(null);
    setNotice(null);
    try {
      const result = await api()!.settings.test({
        provider: aiProvider,
        baseUrl,
        model,
        ...(apiKey ? { apiKey } : {}),
      });
      if (requestId === testRequestId.current) {
        rememberAiConnectionTest(result);
        setAiTest(result);
        void loadAiModelList(aiProvider, baseUrl, apiKey);
      }
    } catch (error) {
      const failed: ConnectionTest = {
        connected: false,
        message: error instanceof Error ? error.message : `${profile.shortLabel} 连接测试失败。`,
        provider: aiProvider,
        baseUrl,
        model,
        testedAt: new Date().toISOString(),
      };
      if (requestId === testRequestId.current) {
        rememberAiConnectionTest(failed);
        setAiTest(failed);
      }
    } finally {
      if (requestId === testRequestId.current) setTestingAi(false);
    }
  };

  return {
    openAiConfig,
    switchProvider,
    switchAiModel,
    changeAiBaseUrl,
    changeAiApiKey,
    saveAiConfig,
    switchWorkspaceAiModel,
    testAiConnection,
  };
}
