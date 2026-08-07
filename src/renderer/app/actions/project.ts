import type { ProjectSummary } from "../../../shared/contracts.js";
import { api } from "../helpers";
import type { AppState } from "../state/useAppState";

export function useProjectHandlers(state: AppState) {
  const {
    project,
    input,
    loading,
    createInput,
    setInput,
    setLoading,
    setNotice,
    setProject,
    setProjects,
    setCreating,
    setCreateInput,
    setSavingProject,
    setView,
    setAccountMenuOpen,
    refresh,
    setActiveTaskId,
  } = state;

  const send = async (retryContent?: string, keepNotice = false, options: { isRetry?: boolean } = {}) => {
    const retryFallback = options.isRetry
      ? project?.messages?.slice().reverse().find((message) => message.role === "user" && message.content.trim())?.content.trim()
      : "";
    const rawText = (retryContent || input || retryFallback || "").trim();
    if (loading) {
      setNotice("AI 正在生成中，请稍后再试。");
      return;
    }
    if (!project) {
      if (!keepNotice) setNotice("当前未选中项目，请先打开项目后再发送。");
      return;
    }
    const aiApi = api();
    if (!aiApi) {
      setNotice("AI 通道未就绪，请稍后重试。");
      return;
    }
    if (!rawText) {
      setNotice(options.isRetry
        ? "未检测到可重试的问题内容，请在输入框手动重新提交该问题。"
        : "请先输入要发送给 AI 的内容。");
      return;
    }
    const shouldRetryWithStructuredHint = options.isRetry;
    let text = rawText;
    if (shouldRetryWithStructuredHint && !text.includes("上一次返回未通过结构化校验")) {
      text = `${text}\n\n上一次返回未通过结构化校验，请只返回纯 JSON 对象（仅包含 reply、patch、questions、researchTasks 四个字段），并为该轮返回至少一个可写入的 patch；不得带说明文字。`;
    }

    // 避免“点击重试后无感知”：先恢复到发送态并清理一次旧notice。
    setNotice(null);
    setInput("");
    setLoading(true);
    if (options.isRetry) {
      setNotice("正在重发该条问题并请求结构化补齐，请稍等。");
    } else if (!keepNotice) {
      setNotice(null);
    }
    try {
      await aiApi.ai.send(project.id, text);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "方案生成失败，请重试。");
    } finally {
      setLoading(false);
    }
  };

  const createProject = async () => {
    if (!createInput.destination.trim()) {
      setNotice("请填写目的地。");
      return;
    }
    setSavingProject(true);
    setNotice(null);
    try {
      const created = await api()!.projects.create({ ...createInput, destination: createInput.destination.trim() });
      setProject(created);
      setProjects((items) => [created, ...items]);
      setView("workspace");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "创建项目失败，请重试。");
    } finally {
      setSavingProject(false);
      setCreating(false);
    }
  };

  const openProject = async (item: ProjectSummary) => {
    if (!api()) return;
    setNotice(null);
    setCreating(false);
    setAccountMenuOpen(false);
    try {
      setProject(await api()!.projects.get(item.id));
      setActiveTaskId(null);
      setView("workspace");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "打开项目失败，请重试。");
    }
  };

  const deleteProject = async (item: ProjectSummary) => {
    if (!api()) return false;
    setNotice(null);
    try {
      await api()!.projects.delete(item.id);
      setProjects((items) => items.filter((candidate) => candidate.id !== item.id));
      if (project?.id === item.id) setProject(null);
      setNotice(`已删除本机项目「${item.name}」。VBK 平台上的产品未受影响。`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除项目失败，请重试。");
      return false;
    }
  };

  return {
    send,
    createProject,
    openProject,
    deleteProject,
  };
}
