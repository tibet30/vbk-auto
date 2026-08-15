import type { ProductSummary } from "../../../shared/contracts.js";
import { aiProviderLabel, hasActiveAiKey } from "../../../shared/contracts.js";
import { api } from "../helpers";
import type { AppState } from "../state/useAppState";

export function useProductHandlers(state: AppState) {
  const {
    product,
    input,
    loading,
    createInput,
    settings,
    setInput,
    setLoading,
    setNotice,
    setProduct,
    setProducts,
    setCreating,
    setCreateInput,
    setSavingProduct,
    setView,
    setAccountMenuOpen,
    refresh,
    setActiveTaskId,
  } = state;

  const send = async (retryContent?: string, keepNotice = false, options: { isRetry?: boolean } = {}) => {
    const retryFallback = options.isRetry
      ? product?.messages?.slice().reverse().find((message) => message.role === "user" && message.content.trim())?.content.trim()
      : "";
    const rawText = (retryContent || input || retryFallback || "").trim();
    if (loading) {
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

  const createProduct = async () => {
    if (!hasActiveAiKey(settings)) {
      setNotice(`尚未配置 AI 模型，请先到「设置」中配置 ${aiProviderLabel(settings)} 的 API Key 后再创建产品。`);
      return;
    }
    if (!createInput.destination.trim()) {
      setNotice("请填写目的地。");
      return;
    }
    setSavingProduct(true);
    setNotice(null);
    try {
      const created = await api()!.products.create({ ...createInput, destination: createInput.destination.trim() });
      setProduct(created);
      setProducts((items) => [created, ...items]);
      setView("workspace");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "创建产品失败，请重试。");
    } finally {
      setSavingProduct(false);
      setCreating(false);
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
    createProduct,
    openProduct,
    deleteProduct,
  };
}
