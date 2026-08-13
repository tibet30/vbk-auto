import { useState } from "react";
import type { AiModelInfo, ConnectionTest, Settings } from "../../../../shared/contracts.js";

export function useAiSettingsState() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [aiProvider, setAiProvider] = useState<"minimax" | "deepseek">("minimax");
  const [aiConfigOpen, setAiConfigOpen] = useState(false);
  const [aiBaseUrl, setAiBaseUrl] = useState("https://api.minimaxi.com/v1");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [showAiApiKey, setShowAiApiKey] = useState(false);
  const [savingAi, setSavingAi] = useState(false);
  const [testingAi, setTestingAi] = useState(false);
  const [loadingAiKey, setLoadingAiKey] = useState(false);
  const [aiTest, setAiTest] = useState<ConnectionTest | null>(null);
  const [aiModelList, setAiModelList] = useState<AiModelInfo[] | null>(null);
  const [refreshingAiModels, setRefreshingAiModels] = useState(false);
  const [aiModelListError, setAiModelListError] = useState<string | null>(null);

  return {
    settings, setSettings,
    aiProvider, setAiProvider,
    aiConfigOpen, setAiConfigOpen,
    aiBaseUrl, setAiBaseUrl,
    aiApiKey, setAiApiKey,
    aiModel, setAiModel,
    showAiApiKey, setShowAiApiKey,
    savingAi, setSavingAi,
    testingAi, setTestingAi,
    loadingAiKey, setLoadingAiKey,
    aiTest, setAiTest,
    aiModelList, setAiModelList,
    refreshingAiModels, setRefreshingAiModels,
    aiModelListError, setAiModelListError,
  };
}
