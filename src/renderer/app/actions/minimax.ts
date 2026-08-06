import { api, initialInput } from "../helpers";
import type { AppState } from "../state/useAppState";

export function useMiniMaxHandlers(state: AppState) {
  const {
    settings,
    setMiniMaxConfigOpen,
    setMiniMaxBaseUrl,
    setMiniMaxApiKey,
    setMiniMaxTest,
    setShowMiniMaxApiKey,
    miniMaxBaseUrl,
    miniMaxApiKey,
    setNotice,
    setSavingMiniMax,
    savingMiniMax,
    setTestingMiniMax,
    setShowMiniMaxApiKey: setShowMiniMaxApiKeyState,
    miniMaxConfigOpen,
    setSettings,
    setCreating,
    creating,
  } = state;

  const openMiniMaxConfig = async () => {
    setMiniMaxBaseUrl(settings?.minimaxBaseUrl || "https://api.minimaxi.com/v1");
    // 密钥解密失败不能让整个配置入口失效，退回空值让用户重新填写。
    try {
      setMiniMaxApiKey(settings?.hasMiniMaxKey && api() ? await api()!.settings.getApiKey() : "");
    } catch {
      setMiniMaxApiKey("");
      setNotice("已保存的密钥无法读取，请重新填写。");
    }
    setShowMiniMaxApiKey(false);
    setMiniMaxTest(null);
    setMiniMaxConfigOpen(true);
  };

  const saveMiniMaxConfig = async () => {
    const baseUrl = miniMaxBaseUrl.trim();
    const apiKey = miniMaxApiKey.trim();
    if (!api()) return;
    if (!baseUrl) {
      setNotice("请填写 MiniMax 服务地址。");
      return;
    }
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    } catch {
      setNotice("请输入以 http:// 或 https:// 开头的服务地址。");
      return;
    }
    if (!apiKey && !settings?.hasMiniMaxKey) {
      setNotice("请填写 MiniMax API Key。");
      return;
    }
    setSavingMiniMax(true);
    setNotice(null);
    try {
      setSettings(await api()!.settings.save({ minimaxBaseUrl: baseUrl, ...(apiKey ? { apiKey } : {}) }));
      setMiniMaxApiKey("");
      setShowMiniMaxApiKey(false);
      setMiniMaxTest(null);
      setNotice("MiniMax 配置已保存，请测试连接。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法保存 MiniMax 配置。");
    } finally {
      setSavingMiniMax(false);
    }
  };

  const testMiniMaxConnection = async () => {
    const baseUrl = miniMaxBaseUrl.trim();
    const apiKey = miniMaxApiKey.trim();
    if (!api()) return;
    if (!baseUrl) {
      setNotice("请填写 MiniMax 服务地址。");
      return;
    }
    if (!apiKey && !settings?.hasMiniMaxKey) {
      setNotice("请填写 MiniMax API Key 后再测试。");
      return;
    }
    setTestingMiniMax(true);
    setMiniMaxTest(null);
    setNotice(null);
    try {
      const result = await api()!.settings.test({ minimaxBaseUrl: baseUrl, ...(apiKey ? { apiKey } : {}) });
      setMiniMaxTest(result);
    } catch (error) {
      setMiniMaxTest({ connected: false, message: error instanceof Error ? error.message : "MiniMax 连接测试失败。" });
    } finally {
      setTestingMiniMax(false);
    }
  };

  const testSavedMiniMaxConnection = async () => {
    if (!api() || !settings?.hasMiniMaxKey) return;
    setTestingMiniMax(true);
    setMiniMaxTest(null);
    setNotice(null);
    try {
      setMiniMaxTest(await api()!.settings.test({ minimaxBaseUrl: settings.minimaxBaseUrl }));
    } catch (error) {
      setMiniMaxTest({ connected: false, message: error instanceof Error ? error.message : "MiniMax 连接测试失败。" });
    } finally {
      setTestingMiniMax(false);
    }
  };

  return { openMiniMaxConfig, saveMiniMaxConfig, testMiniMaxConnection, testSavedMiniMaxConnection };
}
