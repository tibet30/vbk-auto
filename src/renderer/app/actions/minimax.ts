import { useRef } from "react";
import {
  aiProviderConfig,
  aiProviderProfile,
  type AiProvider,
  type ConnectionTest,
} from "../../../shared/contracts.js";
import { api } from "../helpers";
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

const AI_TEST_STORAGE_PREFIX = "vbk:aiTest:";

function readSavedTest(provider: AiProvider, model: string): ConnectionTest | null {
  try {
    const raw = localStorage.getItem(`${AI_TEST_STORAGE_PREFIX}${provider}:${model}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ConnectionTest>;
    if (
      parsed.provider === provider
      && typeof parsed.connected === "boolean"
      && typeof parsed.message === "string"
      && typeof parsed.baseUrl === "string"
      && parsed.model === model
      && typeof parsed.testedAt === "string"
    ) return parsed as ConnectionTest;
  } catch { /* Electron 隐私模式或存储损坏时按未测试处理。 */ }
  return null;
}

function rememberTest(result: ConnectionTest) {
  try { localStorage.setItem(`${AI_TEST_STORAGE_PREFIX}${result.provider}:${result.model}`, JSON.stringify(result)); } catch { /* 忽略 */ }
}

export function useAiHandlers(state: AppState) {
  const {
    settings,
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
    setAiModelList,
    setRefreshingAiModels,
    setAiModelListError,
    setSettings,
  } = state;
  const keyRequestId = useRef(0);
  const testRequestId = useRef(0);
  const modelListRequestId = useRef(0);

  const switchProvider = async (provider: AiProvider) => {
    const requestId = ++keyRequestId.current;
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
    setAiTest(readSavedTest(provider, model));
    setAiModelListError(null);
    setNotice(null);
    setLoadingAiKey(true);

    try {
      const key = api() ? await api()!.settings.getApiKey(provider) : "";
      if (requestId === keyRequestId.current) setAiApiKey(key);
    } catch {
      if (requestId === keyRequestId.current) {
        setAiApiKey("");
        setNotice(`${profile.shortLabel} 已保存的密钥无法读取，请重新填写。`);
      }
    } finally {
      if (requestId === keyRequestId.current) setLoadingAiKey(false);
    }
  };

  const openAiConfig = () => {
    if (!settings) return;
    setAiConfigOpen(true);
    void switchProvider(settings.aiProvider || "minimax");
  };

  const switchAiModel = (model: string) => {
    setAiModel(model);
    setAiTest(readSavedTest(aiProvider, model));
    setNotice(null);
  };

  const changeAiBaseUrl = (baseUrl: string) => {
    modelListRequestId.current += 1;
    setRefreshingAiModels(false);
    setAiBaseUrl(baseUrl);
    setAiModelList(null);
    setAiModelListError(null);
    setAiTest(null);
  };

  const changeAiApiKey = (key: string) => {
    modelListRequestId.current += 1;
    setRefreshingAiModels(false);
    setAiApiKey(key);
    setAiModelList(null);
    setAiModelListError(null);
    setAiTest(null);
  };

  const refreshAiModels = async () => {
    const baseUrl = aiBaseUrl.trim();
    const apiKey = aiApiKey.trim();
    const storedKeyAvailable = settings ? aiProviderConfig(settings, aiProvider).hasKey : false;
    if (!api() || aiProvider !== "deepseek") return;
    if (!validateServiceUrl(baseUrl)) {
      setAiModelListError("服务地址必须使用 https://；本机调试可使用 http://127.0.0.1。");
      return;
    }
    if (!apiKey && !storedKeyAvailable) {
      setAiModelListError("请先填写 Evolink API Key，再刷新模型。");
      return;
    }

    const requestId = ++modelListRequestId.current;
    setRefreshingAiModels(true);
    setAiModelListError(null);
    setNotice(null);
    try {
      const result = await api()!.settings.listModels({
        provider: "deepseek",
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
      });
      if (requestId === modelListRequestId.current) setAiModelList(result.models);
    } catch (error) {
      if (requestId === modelListRequestId.current) {
        setAiModelListError(error instanceof Error ? error.message : "无法刷新 Evolink 模型列表。");
      }
    } finally {
      if (requestId === modelListRequestId.current) setRefreshingAiModels(false);
    }
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
        rememberTest(result);
        setAiTest(result);
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
        rememberTest(failed);
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
    refreshAiModels,
    saveAiConfig,
    testAiConnection,
  };
}
