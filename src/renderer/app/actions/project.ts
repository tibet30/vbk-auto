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

  const send = async (retryContent?: string) => {
    const text = (retryContent || input).trim();
    if (!text || !project || loading) return;
    setInput("");
    setLoading(true);
    setNotice(null);
    try {
      await api()!.ai.send(project.id, text);
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
      setNotice(error instanceof Error ? error.message : "删除项目失败，请重试。" );
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
