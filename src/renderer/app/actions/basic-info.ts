import { logWarn } from "../../../shared/log-timestamp.js";
import type {
  ContactCardSelection,
  CtripLibraryImageCandidate,
  CtripLibraryPlaceCandidate,
  CtripLibraryPlaceSearchResult,
  CtripLibrarySearchResult,
  ManualReviewFieldInput,
  ManualUploadCoverMeta,
  ProductCover,
} from "../../../shared/contracts.js";
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

type UpdateField = "subtitle" | "butler" | "adult" | "child" | "minimumTravelers" | "inventory" | "requestedDailyCost" | "cover";

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
      logWarn("[basic-info] load account fixed info failed", { accountName, error });
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

  /** 写成人价 / 儿童价 / 起订人数；三者必同存，沿用 pricing 字段。
   *  - 不接受默认起订人数；UI 层 parsePricingDraft 已保证 minimumTravelers
   *    是用户输入的正整数，action 不再额外填补。
   *  - 不修改 commercial.pricing.cost（成本子对象），applyManualReviewField
   *    会保留已存在的 cost 字段。
   *  - 起订人数独立的 saving 锁与文案条目，便于 UI 在重渲染时只显示对应
   *    字段的 loading / error，不互相覆盖。
   */
  const savePricing = (projectId: string, adult: number, child: number, minimumTravelers: number) => {
    // 三字段同一笔保存互锁：只要任一字段正在 saving，整笔就拒，避免
    // 「保存 a 后立即编辑 b」产生半成品 pricing。锁粒度沿用「adult」作为
    // canonical slot（最与 schema pricing.adult 对齐），其它字段用
    // `basicInfoSaving === "adult"` 协同判断。
    if (savingFieldsRef.current.has("adult") || savingFieldsRef.current.has("minimumTravelers") || basicInfoSaving === "adult" || basicInfoSaving === "minimumTravelers") return;
    void updateField(projectId, "adult", { field: "pricing", adult, child, minimumTravelers });
  };

  const saveInventory = (projectId: string, startDate: string, endDate: string, dailyQuota: number) => {
    if (savingFieldsRef.current.has("inventory") || basicInfoSaving === "inventory") return;
    void updateField(projectId, "inventory", { field: "inventory", startDate, endDate, dailyQuota });
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

  /**
   * 手动上传封面：
   *  1. 先把字节送到 main 端 cover:uploadManual 落本地副本（仅元数据回传）；
   *  2. poi / description / minQuality 由前端根据
   *     a) 旧 cover 同名字段；
   *     b) product.basicInfo.destinationCity / meetingCity；
   *     c) 去掉扩展名的文件名；
   *     d) 「手动上传封面」占位
   *     自动推导，UI 不需要再让运营补字段；
   *  3. 再用 projects:updateReviewField 把 meta + 推导字段写入 product.presentation.cover；
   *  4. 上传成功但写入失败时把已上传的 meta 抛错，让 UI 提示运营「重试写入」
   *     而非重新上传。
   */
  const uploadAndSaveManualCover = async (
    projectId: string,
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
        previousCover: readPreviousCover(project),
        product: (project?.product ?? {}) as Record<string, unknown>,
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
      await api()!.projects.updateReviewField(projectId, { field: "productCover", cover });
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
   *  - 成功后由 project:updated 推送回流；失败把错误贴回 UI。
   */
  const saveCtripLibraryCover = async (
    projectId: string,
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
      const candidate = args.candidate;
      // 校验 imageId / imageUrl：候选必须来自 getImageInfo 补全后的真实图库
      // 图片，二者缺一即视为「未取到图库图片」，不写 product。
      const imageId = typeof candidate.imageId === "number" && Number.isInteger(candidate.imageId) && candidate.imageId > 0
        ? candidate.imageId
        : null;
      // imageUrl 优先于 previewUrl / thumbnailUrl：原始展示图质量最高，
      // 仅在三者都缺失时视为「未取到图库图片」。
      const imageUrl = typeof candidate.imageUrl === "string" && candidate.imageUrl.trim().length > 0
        ? candidate.imageUrl.trim()
        : typeof candidate.previewUrl === "string" && candidate.previewUrl.trim().length > 0
          ? candidate.previewUrl.trim()
          : typeof candidate.thumbnailUrl === "string" && candidate.thumbnailUrl.trim().length > 0
            ? candidate.thumbnailUrl.trim()
            : null;
      if (imageId === null || imageUrl === null) {
        const message = "携程图库候选缺少 imageId 或 imageUrl，请重新查询并选择有图片的候选。";
        setBasicInfoErrors((prev) => ({ ...prev, cover: message }));
        setNotice(`保存封面失败：${message}`);
        return false;
      }

      // 收集可选字段：仅当候选 / getImageInfo 真正提供了合法值时才写入，
      // 避免把 undefined / 空串塞进 product JSON 后污染下游 schema 校验。
      const optionalFields: {
        score?: number;
        resolution?: string;
        poiId?: number;
        poiName?: string;
        thumbnailUrl?: string;
        previewUrl?: string;
      } = {};
      if (typeof candidate.score === "number" && Number.isFinite(candidate.score)) {
        optionalFields.score = candidate.score;
      }
      if (typeof candidate.resolution === "string" && candidate.resolution.trim()) {
        optionalFields.resolution = candidate.resolution.trim();
      }
      if (typeof candidate.poiId === "number" && Number.isInteger(candidate.poiId) && candidate.poiId > 0) {
        optionalFields.poiId = candidate.poiId;
      }
      if (typeof candidate.poiName === "string" && candidate.poiName.trim()) {
        optionalFields.poiName = candidate.poiName.trim();
      }
      if (typeof candidate.thumbnailUrl === "string" && candidate.thumbnailUrl.trim()) {
        optionalFields.thumbnailUrl = candidate.thumbnailUrl.trim();
      }
      if (typeof candidate.previewUrl === "string" && candidate.previewUrl.trim()) {
        optionalFields.previewUrl = candidate.previewUrl.trim();
      }

      const fallbackLabel = `携程图库图片 ${imageId}`;
      const cover: ProductCover = {
        source: "ctripLibrary",
        imageId,
        imageUrl,
        poi: candidate.poiName || fallbackLabel,
        description: candidate.poiName || fallbackLabel,
        minQuality: 3,
        selectedAt: new Date().toISOString(),
        ...optionalFields,
      };
      await api()!.projects.updateReviewField(projectId, { field: "productCover", cover });
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
  const clearCover = async (projectId: string): Promise<boolean> => {
    if (!api()) return false;
    // 当前 ManualReviewFieldInput 不接受"清除 cover"；先把 cover 整段从 presentation
    // 删掉需要 projects:updateProductJson 走 schema 校验；这里走 patch via updateProductJson
    // 会让 UI 失去 per-field 错误反馈，先暂时禁用并保留接口。后续若需要清除，由 main 端
    // 增加 { field: "productCover", cover: null } 的 contract。
    void projectId;
    setNotice("暂不支持清除封面，请改用重新上传 / 重新查询并选择。");
    return false;
  };

  /**
   * 携程图库查询阶段 A：按景点名称（keyword）解析 suggestpoi.json 候选 POI 列表。
   *  - UI 在地址列表里选中一个 place 后再调 searchCtripLibraryImages 走阶段 B；
   *  - 失败 / 未登录由 IPC 层抛错，本 action 走 notice 通道兜底；
   *  - keyword 留空直接走 setNotice 通道，不进入 IPC。
   */
  const searchCtripLibraryPlaces = async (
    projectId: string,
    args: { keyword: string },
  ): Promise<CtripLibraryPlaceSearchResult | null> => {
    if (!api()) return null;
    const keyword = args.keyword.trim();
    if (keyword.length === 0) {
      setNotice("请输入景点名称后再查询。");
      void projectId;
      return null;
    }
    try {
      return await api()!.cover.searchCtripLibraryPlaces({ keyword });
    } catch (error) {
      const message = error instanceof Error ? error.message : "查询携程图库地址失败。";
      setNotice(`查询携程图库地址失败：${message}`);
      void projectId;
      return null;
    }
  };

  /**
   * 携程图库查询阶段 B：按已选 place（poiId + poiName）拉该地址下的图库图片列表。
   *  - keyword 与 place 由 UI 从阶段 A 的结果里选出来后透传；
   *  - 失败 / 未登录 / place 不合法由 IPC 层抛错，action 走 notice 通道兜底；
   *  - 返回 CtripLibrarySearchResult：candidates 是真实 getImageInfo 解析后的图。
   */
  const searchCtripLibraryImages = async (
    projectId: string,
    args: { keyword: string; place: CtripLibraryPlaceCandidate },
  ): Promise<CtripLibrarySearchResult | null> => {
    if (!api()) return null;
    const keyword = args.keyword.trim();
    if (keyword.length === 0 || !args.place || !Number.isInteger(args.place.poiId) || args.place.poiId <= 0) {
      setNotice("请先选择地址后再查询图片。");
      void projectId;
      return null;
    }
    try {
      return await api()!.cover.searchCtripLibraryImages({ keyword, place: args.place });
    } catch (error) {
      const message = error instanceof Error ? error.message : "查询携程图库图片失败。";
      setNotice(`查询携程图库图片失败：${message}`);
      void projectId;
      return null;
    }
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
    searchCtripLibraryPlaces,
    searchCtripLibraryImages,
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
    requestedDailyCost: "用车日价",
    cover: "产品封面",
  } as Record<UpdateField, string>)[field];
}

/**
 * 从当前 project.presentation.cover 安全取上一份 cover 对象（任意来源），便于
 * uploadAndSaveManualCover 自动沿用旧 POI / 描述 / 最低质量分。
 */
function readPreviousCover(project: { product?: unknown } | null | undefined): Record<string, unknown> | null {
  if (!project) return null;
  const product = project.product;
  if (!product || typeof product !== "object") return null;
  const presentation = (product as Record<string, unknown>).presentation;
  if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) return null;
  const cover = (presentation as Record<string, unknown>).cover;
  if (!cover || typeof cover !== "object" || Array.isArray(cover)) return null;
  return cover as Record<string, unknown>;
}

interface DerivedManualCoverFields {
  poi: string;
  description: string;
  minQuality: number;
}

/**
 * 自动推导手动上传封面需要的内部字段：
 *  - poi：旧 cover.poi → product.basicInfo.destinationCity / meetingCity → 去掉
 *    扩展名的文件名 → 「手动上传封面」；
 *  - description：旧 cover.description → `手动上传：${originalName}`；
 *  - minQuality：旧值合法则保留，否则 3（与 schema 默认保持一致）。
 */
function deriveManualCoverFields(args: {
  previousCover: Record<string, unknown> | null;
  product: Record<string, unknown>;
  originalName: string;
}): DerivedManualCoverFields {
  const previous = args.previousCover;
  const product = args.product;
  const basic = product.basicInfo && typeof product.basicInfo === "object" && !Array.isArray(product.basicInfo)
    ? (product.basicInfo as Record<string, unknown>)
    : null;

  const trim = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const fromPrevPoi = trim(previous?.poi);
  const fromDestination = trim(basic?.destinationCity);
  const fromMeeting = trim(basic?.meetingCity);
  const fromFile = stripExtension(args.originalName).trim();
  const poi = fromPrevPoi || fromDestination || fromMeeting || fromFile || "手动上传封面";

  const fromPrevDescription = trim(previous?.description);
  const originalName = args.originalName.trim();
  const description = fromPrevDescription || (originalName ? `手动上传：${originalName}` : "手动上传封面");

  const prevQuality = previous?.minQuality;
  const minQuality = typeof prevQuality === "number" && Number.isFinite(prevQuality) && prevQuality >= 0 && prevQuality <= 5
    ? prevQuality
    : 3;

  return { poi, description, minQuality };
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name;
  return name.slice(0, dot);
}
