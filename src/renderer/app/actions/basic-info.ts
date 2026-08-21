import { logWarn } from "../../../shared/log-timestamp.js";
import type {
  ContactCardSelection,
  CtripLibraryImageCandidate,
  ManualReviewFieldInput,
  ManualUploadCoverMeta,
  ProductCover,
} from "../../../shared/contracts.js";
import { useRef } from "react";
import { api } from "../helpers";
import type { AppState } from "../state/useAppState";
import { buildCtripLibraryCover, deriveManualCoverFields, readPreviousCover } from "./basic-info-cover-model";
import { createBasicInfoCoverSearchActions } from "./basic-info-cover-search";

/**
 * 右侧 review 面板的「基础信息」编辑模块专用 action：
 *   - 拉取当前账号的 AccountFixedInfo.butlerName 默认联系人，进入模块时
 *     一次性预填；账号未登录 / 未配置时返回 null（让 UI 显示「未设置」提示）；
 *   - 调 IPC products.updateReviewField 把单一字段写入 product JSON，
 *     写完后由 product:updated 推送事件回流，UI 自动重新派生 JSON 视图。
 *
 * 实现约束：
 *   - per-field saving 锁：避免运营连续点击同一字段造成 race；
 *   - per-field error 文案：保存失败时贴回 UI 红错并保留用户已输入的草稿；
 *   - 严禁编造但 booker / 资源组 ID：butler 必须来自 AccountFixedInfo，
 *     资源组 ID 必须由 VBK 真实匹配得到，UI 不允许自由输入。
 */

type UpdateField = "subtitle" | "butler" | "adult" | "child" | "minimumTravelers" | "inventory" | "requestedTotalCost" | "cover";

export function useBasicInfoHandlers(state: AppState) {
  const savingFieldsRef = useRef<Set<UpdateField>>(new Set());
  const {
    setBasicInfoButlerDefault,
    setBasicInfoServicePhone,
    setBasicInfoButlerLoadedForLocalProductId,
    setBasicInfoDraft,
    setBasicInfoSaving,
    setBasicInfoErrors,
    setNotice,
    basicInfoDraft,
    basicInfoSaving,
    basicInfoErrors,
    basicInfoButlerDefault,
    basicInfoButlerLoadedForLocalProductId,
    basicInfoServicePhone,
    product,
    isVbkLoggedIn,
    setBrowserOpen,
    setLoginPanelOpen,
    updateReadiness,
  } = state;
  const coverSearchActions = createBasicInfoCoverSearchActions(setNotice);

  /**
   * 进入「基础信息」编辑模块时调用：拉取当前账号的管家联系人默认值 + 400 电话。
   *  - 拉一次后缓存到 basicInfoButlerLoadedForLocalProductId，避免重复 IO；
   *  - 产品切换时由调用方显式 resetLoaded 复位 sentinel；
   *  - 账号未登录 / 未配置时静默置 null，不抛错；
   *  - 产品切换期间如果上一次加载才返回，丢弃迟到的结果，防止跨产品污染。
   *  - servicePhone 与 butlerName 共用同一次 IPC（accounts.getFixedInfo），避免重复 IO；
   *    两者均不写入 product，只在 review 模块作为「产品基础信息 + 创建前置」展示。
   */
  const loadAccountFixedInfo = async (localProductId: string, accountName: string | null) => {
    if (!api() || !accountName) return;
    if (basicInfoButlerLoadedForLocalProductId === localProductId) return;
    // 用一个调用方局部 sentinel：产品切换时 sentinel 被 reset()，即便在途请求
    // 晚到也不会把 stale default 写入新产品。
    const capturedId = localProductId;
    try {
      const info = await api()!.accounts.getFixedInfo(accountName);
      if (basicInfoButlerLoadedForLocalProductId && basicInfoButlerLoadedForLocalProductId !== capturedId) return;
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
      setBasicInfoButlerLoadedForLocalProductId(capturedId);
    } catch (error) {
      if (basicInfoButlerLoadedForLocalProductId && basicInfoButlerLoadedForLocalProductId !== capturedId) return;
      setBasicInfoButlerDefault(null);
      setBasicInfoServicePhone(null);
      setBasicInfoButlerLoadedForLocalProductId(capturedId);
      logWarn("[basic-info] load account fixed info failed", { accountName, error });
    }
  };

  /**
   * 向后兼容的别名：旧调用方读 loadButlerDefault；
   * 现已统一改为 loadAccountFixedInfo（同时拉取 butler + 400 电话）。
   */
  const loadButlerDefault = loadAccountFixedInfo;

  /** 切换产品时清掉缓存的账号默认值，避免老产品的账号默认值污染新产品。 */
  const resetLoaded = () => {
    setBasicInfoButlerDefault(null);
    setBasicInfoServicePhone(null);
    setBasicInfoButlerLoadedForLocalProductId(null);
  };

  /**
   * 把单个字段写入 product JSON：
   *  - 调 IPC products.updateReviewField；
   *  - 成功后 main 进程会发 product:updated，UI 通过 useAppState 自动重派生；
   *  - 失败时把错误文案贴回 UI（per-field），不抛错到全局。
   */
  const updateField = async (
    localProductId: string,
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
      await api()!.products.updateReviewField(localProductId, payload);
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
  const saveSubtitle = (localProductId: string) => {
    const draft = (basicInfoDraft.subtitle ?? "").trim();
    if (!draft) return;
    void updateField(localProductId, "subtitle", { field: "basicInfoSubtitle", subtitle: draft });
  };

  /**
   * 把「管家联系人」写入 product.operations.bookingControls.butler：
   *  - selection 直接来自 AccountFixedInfo 的 butlerName（已是合法 ContactCardSelection）；
   *  - selection=null 表示清空（让自动化阶段走 VBK 默认逻辑）。
   */
  const saveButler = (localProductId: string, selection: ContactCardSelection | null) => {
    void updateField(localProductId, "butler", { field: "butlerContact", selection });
  };

  /** 写成人价 / 儿童价 / 起订人数；三者必同存，沿用 pricing 字段。
   *  - 不接受默认起订人数；UI 层 parsePricingDraft 已保证 minimumTravelers
   *    是用户输入的正整数，action 不再额外填补。
   *  - 不修改 commercial.pricing.cost（成本子对象），applyManualReviewField
   *    会保留已存在的 cost 字段。
   *  - 起订人数独立的 saving 锁与文案条目，便于 UI 在重渲染时只显示对应
   *    字段的 loading / error，不互相覆盖。
   */
  const savePricing = (localProductId: string, adult: number, child: number, minimumTravelers: number) => {
    // 三字段同一笔保存互锁：只要任一字段正在 saving，整笔就拒，避免
    // 「保存 a 后立即编辑 b」产生半成品 pricing。锁粒度沿用「adult」作为
    // canonical slot（最与 schema pricing.adult 对齐），其它字段用
    // `basicInfoSaving === "adult"` 协同判断。
    if (savingFieldsRef.current.has("adult") || savingFieldsRef.current.has("minimumTravelers") || basicInfoSaving === "adult" || basicInfoSaving === "minimumTravelers") return;
    void updateField(localProductId, "adult", { field: "pricing", adult, child, minimumTravelers });
  };

  const saveInventory = (localProductId: string, startDate: string, endDate: string, dailyQuota: number) => {
    if (savingFieldsRef.current.has("inventory") || basicInfoSaving === "inventory") return;
    void updateField(localProductId, "inventory", { field: "inventory", startDate, endDate, dailyQuota });
  };

  /** 写单个车辆资源组字段：当前仅允许全程用车总成本；资源组 ID / 名称必须来自 VBK 匹配。 */
  const saveVehicleResourceField = (
    localProductId: string,
    payload: Extract<ManualReviewFieldInput, { field: "vehicleResource" }>,
  ) => {
    const fieldKey: UpdateField = ((): UpdateField => {
      if ("requestedTotalCost" in payload) return "requestedTotalCost";
      return "requestedTotalCost";
    })();
    void updateField(localProductId, fieldKey, payload);
  };

  /**
   * 写「全程用车总成本（待核查）」的便捷入口：value === null 表示显式清除。
   * 与 saveVehicleResourceField 共享同一条 IPC（products:updateReviewField），
   * 只是包了 number | null 友好签名，让 basic-info-vehicle-row 不用自己
   * 构造 discriminated union。
   */
  const saveVehicleCost = (localProductId: string, value: number | null) => {
    return saveVehicleCostAndResolve(localProductId, value);
  };

  const saveVehicleCostAndResolve = async (localProductId: string, value: number | null) => {
    const saved = await updateField(localProductId, "requestedTotalCost", { field: "vehicleResource", requestedTotalCost: value });
    // value === null = 显式清除；保存已在 updateField 内做完，这里不再发起匹配。
    if (!saved || value === null) return;
    if (!api()) return;
    if (!isVbkLoggedIn) {
      const message = "全程用车总成本已保存；请先登录 VBK，再搜索用车资源组。";
      setBasicInfoErrors((prev) => ({ ...prev, requestedTotalCost: message }));
      setNotice(message);
      setLoginPanelOpen(true);
      return;
    }
    if (savingFieldsRef.current.has("requestedTotalCost")) return;
    savingFieldsRef.current.add("requestedTotalCost");
    setBasicInfoSaving("requestedTotalCost");
    setBasicInfoErrors((prev) => {
      if (!prev.requestedTotalCost) return prev;
      const next = { ...prev };
      delete next.requestedTotalCost;
      return next;
    });
    setBrowserOpen(true);
    try {
      const result = await api()!.research.resolveVehicleResource(localProductId);
      if (result) {
        setNotice(`已按全程总价 ${value} 元搜索并匹配资源组：${result.resourceGroupName}（ID ${result.resourceGroupId}）。`);
      } else {
        const message = `全程用车总成本已保存为 ${value} 元；VBK 未返回可匹配资源组，请调整总成本后重试。`;
        setBasicInfoErrors((prev) => ({ ...prev, requestedTotalCost: message }));
        setNotice(message);
      }
      if (product?.id === localProductId) void updateReadiness(product);
    } catch (error) {
      const message = error instanceof Error ? error.message : "用车资源组搜索失败；全程用车总成本已保留。";
      setBasicInfoErrors((prev) => ({ ...prev, requestedTotalCost: message }));
      setNotice(`全程用车总成本已保存；资源组搜索失败：${message}`);
    } finally {
      savingFieldsRef.current.delete("requestedTotalCost");
      setBasicInfoSaving((current) => (current === "requestedTotalCost" ? null : current));
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

  /** 重置全部错误（切产品 / 模块卸载时调用）。 */
  const clearAllErrors = () => setBasicInfoErrors({});

  /**
   * 手动上传封面：
   *  1. 先把字节送到 main 端 cover:uploadManual 落本地副本（仅元数据回传）；
   *  2. poi / description / minQuality 由前端根据
   *     a) 旧 cover 同名字段；
   *     b) product.basicInfo.destinationCity / meetingCity；
   *     c) 去掉扩展名的文件名；
   *     d) 「手动上传封面」占位
   *     自动推导，UI 不需要再让运营补字段；
   *  3. 再用 products:updateReviewField 把 meta + 推导字段写入 product.presentation.cover；
   *  4. 上传成功但写入失败时把已上传的 meta 抛错，让 UI 提示运营「重试写入」
   *     而非重新上传。
   */
  const uploadAndSaveManualCover = async (
    localProductId: string,
    args: { file: { name: string; type: string; base64: string } },
  ): Promise<ManualUploadCoverMeta | null> => {
    if (!api()) return null;
    if (savingFieldsRef.current.has("cover") || basicInfoSaving === "cover") return null;
    savingFieldsRef.current.add("cover");
    setBasicInfoSaving("cover");
    setBasicInfoErrors((prev) => {
      if (!prev.cover) return prev;
      const next = { ...prev };
      delete next.cover;
      return next;
    });
    try {
      const meta = await api()!.cover.uploadManual({
        originalName: args.file.name,
        mimeType: args.file.type,
        base64: args.file.base64,
      });
      const derived = deriveManualCoverFields({
        previousCover: readPreviousCover(product),
        product: (product?.product ?? {}) as Record<string, unknown>,
        originalName: meta.originalName,
      });
      const cover: ProductCover = {
        source: "manualUpload",
        fileId: meta.fileId,
        originalName: meta.originalName,
        mimeType: meta.mimeType,
        sizeBytes: meta.sizeBytes,
        poi: derived.poi,
        description: derived.description,
        minQuality: derived.minQuality,
        uploadedAt: meta.uploadedAt,
      };
      await api()!.products.updateReviewField(localProductId, { field: "productCover", cover });
      return meta;
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存封面失败。";
      setBasicInfoErrors((prev) => ({ ...prev, cover: message }));
      setNotice(`保存封面失败：${message}`);
      return null;
    } finally {
      savingFieldsRef.current.delete("cover");
      setBasicInfoSaving((current) => (current === "cover" ? null : current));
    }
  };

  /**
   * 把携程图库候选写入 product.presentation.cover：
   *  - 由候选自动推导出 cover.poi / description / minQuality，并把候选自带的
   *    imageId / imageUrl（缺一即拒）以及可选的 thumbnailUrl / previewUrl /
   *    score / resolution / poiId / poiName 一起写入；
   *  - candidate 缺 imageId / imageUrl 时设置 basicInfoErrors.cover 与 notice，
   *    返回 false，不调用 updateReviewField，避免空图被持久化；
   *  - poi / description 兑底 = `携程图库图片 ${imageId}`，尽量保留候选上的
   *    poiName 让 cover 展示更具语义；
   *  - minQuality = 3（与 schema 默认保持一致）；
   *  - selectedAt = 写入瞬间的 ISO 时间戳，便于审计与对账；
   *  - 成功后由 product:updated 推送回流；失败把错误贴回 UI。
   */
  const saveCtripLibraryCover = async (
    localProductId: string,
    args: { candidate: CtripLibraryImageCandidate },
  ): Promise<boolean> => {
    if (!api()) return false;
    if (savingFieldsRef.current.has("cover") || basicInfoSaving === "cover") return false;
    savingFieldsRef.current.add("cover");
    setBasicInfoSaving("cover");
    setBasicInfoErrors((prev) => {
      if (!prev.cover) return prev;
      const next = { ...prev };
      delete next.cover;
      return next;
    });
    try {
      const cover = buildCtripLibraryCover(args.candidate);
      await api()!.products.updateReviewField(localProductId, { field: "productCover", cover });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存封面失败。";
      setBasicInfoErrors((prev) => ({ ...prev, cover: message }));
      setNotice(`保存封面失败：${message}`);
      return false;
    } finally {
      savingFieldsRef.current.delete("cover");
      setBasicInfoSaving((current) => (current === "cover" ? null : current));
    }
  };

  /** 清空产品封面：让 main 端走 cover 移除路径（暂不支持，留接口给未来"清除"按钮）。 */
  const clearCover = async (localProductId: string): Promise<boolean> => {
    if (!api()) return false;
    // 当前 ManualReviewFieldInput 不接受"清除 cover"；先把 cover 整段从 presentation
    // 删掉需要 products:updateProductJson 走 schema 校验；这里走 patch via updateProductJson
    // 会让 UI 失去 per-field 错误反馈，先暂时禁用并保留接口。后续若需要清除，由 main 端
    // 增加 { field: "productCover", cover: null } 的 contract。
    void localProductId;
    setNotice("暂不支持清除封面，请改用重新上传 / 重新查询并选择。");
    return false;
  };

  return {
    loadAccountFixedInfo,
    loadButlerDefault,
    resetLoaded,
    saveSubtitle,
    saveButler,
    savePricing,
    saveInventory,
    saveVehicleResourceField,
    saveVehicleCost,
    clearError,
    clearAllErrors,
    uploadAndSaveManualCover,
    saveCtripLibraryCover,
    clearCover,
    ...coverSearchActions,
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
    minimumTravelers: "起订人数",
    inventory: "班期库存",
    requestedTotalCost: "全程用车总成本",
    cover: "产品封面",
  } as Record<UpdateField, string>)[field];
}

/**
 * 从当前 product.presentation.cover 安全取上一份 cover 对象（任意来源），便于
 * uploadAndSaveManualCover 自动沿用旧 POI / 描述 / 最低质量分。
 */
