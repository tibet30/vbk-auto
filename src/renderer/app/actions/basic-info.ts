import type { ContactCardSelection, ManualReviewFieldInput } from "../../../shared/contracts.js";
import { useRef } from "react";
import { api } from "../helpers";
import type { AppState } from "../state/useAppState";

/**
 * 右侧 review 面板的「基础信息」编辑模块专用 action：
 *   - 拉取当前账号的 AccountFixedInfo.butlerName 默认联系人，进入模块时
 *     一次性预填；账号未登录 / 未配置时返回 null（让 UI 显示「未设置」提示）；
 *   - 调 IPC projects.updateReviewField 把单一字段写入 product JSON，
 *     写完后由 project:updated 推送事件回流，UI 自动重新派生 JSON 视图。
 *
 * 实现约束：
 *   - per-field saving 锁：避免运营连续点击同一字段造成 race；
 *   - per-field error 文案：保存失败时贴回 UI 红错并保留用户已输入的草稿；
 *   - 严禁编造但 booker / 资源组 ID：butler 必须来自 AccountFixedInfo，
 *     资源组 ID 必须由 VBK 真实匹配得到，UI 不允许自由输入。
 */

type UpdateField = "subtitle" | "butler" | "adult" | "child" | "requestedDailyCost";

export function useBasicInfoHandlers(state: AppState) {
  const savingFieldsRef = useRef<Set<UpdateField>>(new Set());
  const {
    setBasicInfoButlerDefault,
    setBasicInfoServicePhone,
    setBasicInfoButlerLoadedForProjectId,
    setBasicInfoDraft,
    setBasicInfoSaving,
    setBasicInfoErrors,
    setNotice,
    basicInfoDraft,
    basicInfoSaving,
    basicInfoErrors,
    basicInfoButlerDefault,
    basicInfoButlerLoadedForProjectId,
    basicInfoServicePhone,
    project,
    isVbkLoggedIn,
    setBrowserOpen,
    setLoginPanelOpen,
    updateReadiness,
  } = state;

  /**
   * 进入「基础信息」编辑模块时调用：拉取当前账号的管家联系人默认值 + 400 电话。
   *  - 拉一次后缓存到 basicInfoButlerLoadedForProjectId，避免重复 IO；
   *  - 项目切换时由调用方显式 resetLoaded 复位 sentinel；
   *  - 账号未登录 / 未配置时静默置 null，不抛错；
   *  - 项目切换期间如果上一次加载才返回，丢弃迟到的结果，防止跨项目污染。
   *  - servicePhone 与 butlerName 共用同一次 IPC（accounts.getFixedInfo），避免重复 IO；
   *    两者均不写入 product，只在 review 模块作为「产品基础信息 + 创建前置」展示。
   */
  const loadAccountFixedInfo = async (projectId: string, accountName: string | null) => {
    if (!api() || !accountName) return;
    if (basicInfoButlerLoadedForProjectId === projectId) return;
    // 用一个调用方局部 sentinel：项目切换时 sentinel 被 reset()，即便在途请求
    // 晚到也不会把 stale default 写入新项目。
    const capturedId = projectId;
    try {
      const info = await api()!.accounts.getFixedInfo(accountName);
      if (basicInfoButlerLoadedForProjectId && basicInfoButlerLoadedForProjectId !== capturedId) return;
      const butlerRaw = info.values.butlerName;
      if (butlerRaw && typeof butlerRaw === "object" && "contactCardId" in butlerRaw) {
        setBasicInfoButlerDefault(butlerRaw as ContactCardSelection);
      } else {
        setBasicInfoButlerDefault(null);
      }
      const phoneRaw = info.values.servicePhone;
      if (typeof phoneRaw === "string" && phoneRaw.trim().length > 0) {
        setBasicInfoServicePhone(phoneRaw.trim());
      } else {
        setBasicInfoServicePhone(null);
      }
      setBasicInfoButlerLoadedForProjectId(capturedId);
    } catch (error) {
      if (basicInfoButlerLoadedForProjectId && basicInfoButlerLoadedForProjectId !== capturedId) return;
      setBasicInfoButlerDefault(null);
      setBasicInfoServicePhone(null);
      setBasicInfoButlerLoadedForProjectId(capturedId);
      console.warn("[basic-info] load account fixed info failed", { accountName, error });
    }
  };

  /**
   * 向后兼容的别名：旧调用方读 loadButlerDefault；
   * 现已统一改为 loadAccountFixedInfo（同时拉取 butler + 400 电话）。
   */
  const loadButlerDefault = loadAccountFixedInfo;

  /** 切换项目时清掉缓存的账号默认值，避免老项目的账号默认值污染新项目。 */
  const resetLoaded = () => {
    setBasicInfoButlerDefault(null);
    setBasicInfoServicePhone(null);
    setBasicInfoButlerLoadedForProjectId(null);
  };

  /**
   * 把单个字段写入 product JSON：
   *  - 调 IPC projects.updateReviewField；
   *  - 成功后 main 进程会发 project:updated，UI 通过 useAppState 自动重派生；
   *  - 失败时把错误文案贴回 UI（per-field），不抛错到全局。
   */
  const updateField = async (
    projectId: string,
    field: UpdateField,
    payload: ManualReviewFieldInput,
  ): Promise<boolean> => {
    if (!api()) return false;
    if (savingFieldsRef.current.has(field) || basicInfoSaving === field) return false; // 重复点击锁
    savingFieldsRef.current.add(field);
    setBasicInfoSaving(field);
    setBasicInfoErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
    try {
      await api()!.projects.updateReviewField(projectId, payload);
      // 保存成功后清掉该字段的本地草稿，避免下次重渲染时把已持久化的旧值
      // 又覆盖回来。
      setBasicInfoDraft((prev) => {
        if (!(field in prev)) return prev;
        const next = { ...prev };
        delete next[field];
        return next;
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存失败，请重试。";
      setBasicInfoErrors((prev) => ({ ...prev, [field]: message }));
      setNotice(`保存「${fieldLabel(field)}」失败：${message}`);
      return false;
    } finally {
      savingFieldsRef.current.delete(field);
      setBasicInfoSaving((current) => (current === field ? null : current));
    }
  };

  /**
   * 写入副标题：UI 上是字符串，落到 product.basicInfo.subtitle。
   */
  const saveSubtitle = (projectId: string) => {
    const draft = (basicInfoDraft.subtitle ?? "").trim();
    if (!draft) return;
    void updateField(projectId, "subtitle", { field: "basicInfoSubtitle", subtitle: draft });
  };

  /**
   * 把「管家联系人」写入 product.operations.bookingControls.butler：
   *  - selection 直接来自 AccountFixedInfo 的 butlerName（已是合法 ContactCardSelection）；
   *  - selection=null 表示清空（让自动化阶段走 VBK 默认逻辑）。
   */
  const saveButler = (projectId: string, selection: ContactCardSelection | null) => {
    void updateField(projectId, "butler", { field: "butlerContact", selection });
  };

  /** 写成人价 / 儿童价；二者必同存，沿用 pricing 字段。 */
  const savePricing = (projectId: string, adult: number, child: number) => {
    void updateField(projectId, "adult", { field: "pricing", adult, child });
  };

  /** 写单个车辆资源组字段：当前仅允许用车日价；资源组 ID / 名称必须来自 VBK 匹配。 */
  const saveVehicleResourceField = (
    projectId: string,
    payload: Extract<ManualReviewFieldInput, { field: "vehicleResource" }>,
  ) => {
    const fieldKey: UpdateField = ((): UpdateField => {
      if ("requestedDailyCost" in payload) return "requestedDailyCost";
      return "requestedDailyCost";
    })();
    void updateField(projectId, fieldKey, payload);
  };

  /**
   * 写「用车日价（待核查）」的便捷入口：value === null 表示显式清除。
   * 与 saveVehicleResourceField 共享同一条 IPC（projects:updateReviewField），
   * 只是包了 number | null 友好签名，让 basic-info-vehicle-row 不用自己
   * 构造 discriminated union。
   */
  const saveVehicleCost = (projectId: string, value: number | null) => {
    return saveVehicleCostAndResolve(projectId, value);
  };

  const saveVehicleCostAndResolve = async (projectId: string, value: number | null) => {
    const saved = await updateField(projectId, "requestedDailyCost", { field: "vehicleResource", requestedDailyCost: value });
    // value === null = 显式清除；保存已在 updateField 内做完，这里不再发起匹配。
    if (!saved || value === null) return;
    if (!api()) return;
    if (!isVbkLoggedIn) {
      const message = "用车日价已保存；请先登录 VBK，再搜索用车资源组。";
      setBasicInfoErrors((prev) => ({ ...prev, requestedDailyCost: message }));
      setNotice(message);
      setLoginPanelOpen(true);
      return;
    }
    if (savingFieldsRef.current.has("requestedDailyCost")) return;
    savingFieldsRef.current.add("requestedDailyCost");
    setBasicInfoSaving("requestedDailyCost");
    setBasicInfoErrors((prev) => {
      if (!prev.requestedDailyCost) return prev;
      const next = { ...prev };
      delete next.requestedDailyCost;
      return next;
    });
    setBrowserOpen(true);
    try {
      const result = await api()!.research.resolveVehicleResource(projectId);
      if (result) {
        setNotice(`已按 ${value} 元/天搜索并匹配资源组：${result.resourceGroupName}（ID ${result.resourceGroupId}）。`);
      } else {
        const message = `用车日价已保存为 ${value} 元/天；VBK 未返回可匹配资源组，请调整价格后重试。`;
        setBasicInfoErrors((prev) => ({ ...prev, requestedDailyCost: message }));
        setNotice(message);
      }
      if (project?.id === projectId) void updateReadiness(project);
    } catch (error) {
      const message = error instanceof Error ? error.message : "用车资源组搜索失败；用车日价已保留。";
      setBasicInfoErrors((prev) => ({ ...prev, requestedDailyCost: message }));
      setNotice(`用车日价已保存；资源组搜索失败：${message}`);
    } finally {
      savingFieldsRef.current.delete("requestedDailyCost");
      setBasicInfoSaving((current) => (current === "requestedDailyCost" ? null : current));
    }
  };

  /** 清空某个字段的 error 文案（手动清错时调用）。接受任意字符串字段名以匹配组件泛型签名。 */
  const clearError = (field: string) => {
    setBasicInfoErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  /** 重置全部错误（切项目 / 模块卸载时调用）。 */
  const clearAllErrors = () => setBasicInfoErrors({});

  return {
    loadAccountFixedInfo,
    loadButlerDefault,
    resetLoaded,
    saveSubtitle,
    saveButler,
    savePricing,
    saveVehicleResourceField,
    saveVehicleCost,
    clearError,
    clearAllErrors,
    saving: basicInfoSaving,
    errors: basicInfoErrors,
    butlerDefault: basicInfoButlerDefault,
    servicePhone: basicInfoServicePhone,
    draft: basicInfoDraft,
    setDraft: setBasicInfoDraft,
  };
}

function fieldLabel(field: UpdateField): string {
  return ({
    subtitle: "副标题",
    butler: "管家联系人",
    adult: "成人价",
    child: "儿童价",
    requestedDailyCost: "用车日价",
  } as Record<UpdateField, string>)[field];
}
