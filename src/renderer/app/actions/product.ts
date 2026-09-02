import type { ProductSummary, ProductWorkflowTask, WorkflowTaskRetryMode } from "../../../shared/contracts.js";
import { aiProviderLabel, hasActiveAiKey } from "../../../shared/contracts.js";
import { api } from "../helpers";
import { validateProductBrief } from "../helpers/product-brief-validation.js";
import type { AppState } from "../state/useAppState";

export function useProductHandlers(state: AppState) {
  const {
    product,
    input,
    loading,
    createInput,
    autoConfirmCreation,
    settings,
    setInput,
    setLoading,
    setNotice,
    setProduct,
    setProducts,
    setWorkflowTasks,
    setCreating,
    setCreateInput,
    setAutoConfirmCreation,
    setSavingProduct,
    setView,
    setStage,
    setAccountMenuOpen,
    setActiveTaskId,
  } = state;

  const send = async (retryContent?: string, keepNotice = false, options: { isRetry?: boolean } = {}) => {
    const retryFallback = options.isRetry
      ? product?.messages?.slice().reverse().find((message) => message.role === "user" && message.content.trim())?.content.trim()
      : "";
    const rawText = (retryContent || input || retryFallback || "").trim();
    const hasRunningAiMessage = product?.messages.some((message) => message.role === "user" && message.taskStatus === "running") ?? false;
    if (loading || hasRunningAiMessage) {
      setNotice("AI 正在生成中，请稍后再试。");
      return;
    }
    if (!product) {
      if (!keepNotice) setNotice("当前未选中产品，请先打开产品后再发送。");
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
      await aiApi.ai.send(product.id, text);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "方案生成失败，请重试。");
    } finally {
      setLoading(false);
    }
  };

  const cancel = async () => {
    const hasRunningAiMessage = product?.messages.some((message) => message.role === "user" && message.taskStatus === "running") ?? false;
    if (!product || (!loading && !hasRunningAiMessage)) return;
    const aiApi = api();
    if (!aiApi) return;
    setNotice("正在取消本次 AI 对话…");
    try {
      await aiApi.ai.cancel(product.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "取消 AI 对话失败，请稍后重试。");
    }
  };

  const createProduct = async () => {
    if (!hasActiveAiKey(settings)) {
      setNotice(`尚未配置 AI 模型，请先到「设置」中配置 ${aiProviderLabel(settings)} 的 API Key 后再创建产品。`);
      return;
    }
    const fieldErrors = validateProductBrief(createInput);
    const firstFieldError = Object.values(fieldErrors)[0];
    if (firstFieldError) {
      setNotice(firstFieldError);
      return;
    }
    setSavingProduct(true);
    setNotice(null);
    try {
      const client = api();
      if (!client) throw new Error("应用通道未就绪，请稍后重试。");
      const created = await client.products.create({
        ...createInput,
        destination: createInput.destination.trim(),
        userIdea: (createInput.userIdea ?? "").trim(),
        autoConfirm: autoConfirmCreation,
      });
      const latestTask = created.workflowTask;
      const visibleCreated = latestTask
        ? { ...created, workflowTask: latestTask, updatedAt: latestTask.updatedAt }
        : created;
      setProducts((items) => [visibleCreated, ...items]);
      if (autoConfirmCreation) {
        if (latestTask) {
          setWorkflowTasks((items) => [latestTask, ...items.filter((item) => item.id !== latestTask.id)]);
        }
        setProduct(null);
        setView("products");
        setNotice("产品和后台任务已创建；进入产品列表或任务中心时会读取最新进度。");
      } else {
        setProduct(visibleCreated);
        setView("workspace");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "创建产品失败，请重试。");
    } finally {
      setSavingProduct(false);
      setCreating(false);
      setAutoConfirmCreation(false);
    }
  };

  const openProduct = async (item: ProductSummary) => {
    if (!api()) return;
    setNotice(null);
    setCreating(false);
    setAccountMenuOpen(false);
    try {
      setProduct(await api()!.products.get(item.id));
      setActiveTaskId(null);
      setView("workspace");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "打开产品失败，请重试。");
    }
  };

  const openWorkflowTask = async (task: ProductWorkflowTask) => {
    if (!api()) return;
    setNotice(null);
    setCreating(false);
    setAccountMenuOpen(false);
    try {
      setProduct(await api()!.products.get(task.localProductId));
      setActiveTaskId(null);
      setStage(task.stage === "automation" || task.stage === "completed" ? "vbk" : "review");
      setView("workspace");
      requestAnimationFrame(() => {
        document.getElementById("workflow-task-status")?.focus();
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "打开任务关联产品失败，请重试。");
    }
  };

  const abandonWorkflowTask = async (task: ProductWorkflowTask) => {
    const client = api();
    if (!client) return false;
    setNotice(null);
    try {
      const abandoned = await client.workflowTasks.abandon(task.id);
      setWorkflowTasks((items) => [abandoned, ...items.filter((item) => item.id !== abandoned.id)]);
      setProducts((items) => items.map((item) => item.id === abandoned.localProductId
        ? { ...item, workflowTask: abandoned, updatedAt: abandoned.updatedAt }
        : item));
      setProduct((current) => current?.id === abandoned.localProductId
        ? { ...current, workflowTask: abandoned }
        : current);
      setNotice(`任务「${abandoned.productName}」已永久废弃；关联产品和携程草稿未删除。`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "废弃任务失败，请重试。");
      return false;
    }
  };

  const resumeWorkflowTask = async (task: ProductWorkflowTask, mode: WorkflowTaskRetryMode) => {
    const client = api();
    if (!client) return false;
    setNotice(null);
    try {
      const resumed = await client.workflowTasks.resume(task.id, mode);
      setWorkflowTasks((items) => [resumed, ...items.filter((item) => item.id !== resumed.id)]);
      setProducts((items) => items.map((item) => item.id === resumed.localProductId
        ? { ...item, workflowTask: resumed, updatedAt: resumed.updatedAt }
        : item));
      setProduct((current) => current?.id === resumed.localProductId
        ? { ...current, workflowTask: resumed }
        : current);
      setNotice(mode === "from_error"
        ? `任务「${resumed.productName}」已从报错处继续执行。`
        : `任务「${resumed.productName}」已从头开始重新执行。`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "继续执行失败，请重试。");
      return false;
    }
  };

  const deleteProduct = async (item: ProductSummary) => {
    if (!api()) return false;
    setNotice(null);
    try {
      await api()!.products.delete(item.id);
      setProducts((items) => items.filter((candidate) => candidate.id !== item.id));
      if (product?.id === item.id) setProduct(null);
      setNotice(`已删除本机产品「${item.name}」。VBK 平台上的产品未受影响。`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除产品失败，请重试。");
      return false;
    }
  };

  return {
    send,
    cancel,
    createProduct,
    openProduct,
    openWorkflowTask,
    abandonWorkflowTask,
    resumeWorkflowTask,
    deleteProduct,
  };
}
