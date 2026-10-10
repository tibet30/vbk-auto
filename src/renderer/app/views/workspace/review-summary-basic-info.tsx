/**
 * 右侧 review 面板的「基础信息」模块：
 *   - 封面 (presentation.cover)
 *   - 副标题 (basicInfo.subtitle)
 *   - 管家联系人 (operations.bookingControls.butler)
 *   - 400 电话（来自账号 AccountFixedInfo.servicePhone，仅展示 + 引导设置）
 *   - 套餐定价 (commercial.pricing.adult / child)
 *   - 班期库存 (commercial.inventory.startDate / endDate / dailyQuota)
 *   - 用车资源组 (operations.vehicleResource.{resourceGroupId, name, requestedTotalCost})
 *
 * 验收门（与用户规格一一对齐）：
 *  1. 模块自身不引入 max-height / overflow-y / 内部滚动 / 绝对定位覆盖下方内容；
 *     自然高度随行数变化扩展，与「每日行程」「待处理」模块上下相连。
 *  2. 基础信息「始终展示」：有 product/product 时模块不被隐藏；缺失字段在
 *     各自行内显示紧凑空状态 + 编辑/设置入口，不再按非空值挂载行；
 *     用车资源组保持既有产品类型逻辑（私家团或已有数据才显示）。
 *  3. 每个可编辑行单独一个「编辑 / 去设置」按钮；点击后仅该行原位展开 input；
 *     持久化回流 / 取消立即收起回展示态。
 *  4. 管家 / 400 电话仍必须保留作为创建前置校验；
 *     UI 隐藏不会影响持久化（precondition 由 main 进程单独断言）。
 *  5. headMeta/模块头部能表达「待补充」状态，不再只列已有值；缺失字段以
 *     「… 待补充 / 待设置」文案标记，文案保持中文、紧凑、操作型。
 *  6. 视觉密度收紧：单层 label + value + actions 三段，无嵌套大卡。
 *
 * 子文件：
 *   - review-summary-basic-info/util.ts   : sameContactCard / buildHeadParts /
 *                                           derivePricingDraft / deriveInventoryDraft；
 *   - review-summary-basic-info/hooks.ts  : useReviewSummaryBasicInfoState（effects +
 *                                           派生展示态 + headMeta）。
 *
 * 子行组件（位于同级目录，未参与本次拆分）：
 *   - basic-info-cover-row / subtitle / butler / pricing / inventory / vehicle /
 *     service-phone-row。
 */

import { ChevronDown, ClipboardList } from "lucide-react";
import type {
  ContactCardSelection,
  CtripLibraryImageCandidate,
  CtripLibraryPlaceCandidate,
  CtripLibraryPlaceSearchResult,
  CtripLibrarySearchResult,
  ManualUploadCoverMeta,
  ProductDetail,
} from "../../../../shared/contracts-types.js";
import { BasicInfoButlerRow } from "./basic-info-butler-row";
import { BasicInfoCoverRow } from "./basic-info-cover-row";
import { BasicInfoInventoryRow } from "./basic-info-inventory-row";
import { BasicInfoPricingRow } from "./basic-info-pricing-row";
import { BasicInfoServicePhoneRow } from "./basic-info-service-phone-row";
import { BasicInfoSubtitleRow } from "./basic-info-subtitle-row";
import { BasicInfoVehicleRow } from "./basic-info-vehicle-row";
import { useReviewSummaryBasicInfoState } from "./review-summary-basic-info/hooks.js";
import styles from "./review-summary-basic-info.module.less";

export interface ReviewSummaryBasicInfoProps {
  product: ProductDetail;
  /** 当前登录的 VBK 账号名（vbkLogin.accountName）；未登录时为 null。 */
  currentAccountName: string | null;
  /** 当前正在保存的字段名（来自 basicInfoSaving）。null 表示空闲。 */
  savingField: string | null;
  /** 字段错误文案映射。 */
  errors: Record<string, string>;
  /** 当前账号已配置的管家联系人：来自 AccountFixedInfo.butlerName。null = 未设置。 */
  accountButlerDefault: ContactCardSelection | null;
  /** 当前账号已配置的 400 电话：来自 AccountFixedInfo.servicePhone。null / 空串 = 未设置。 */
  accountServicePhone: string | null;
  /** 账号固定信息保存后的刷新令牌。 */
  fixedInfoReloadToken: number;
  /** 进入基础信息模块时调用：拉取当前账号的 fixedInfo 并缓存。 */
  loadAccountFixedInfo: (localProductId: string, accountName: string | null) => void;
  /** 字段级草稿：key=字段名, value=本地输入中的字符串。 */
  draft: Record<string, string>;
  setDraft: (value: Record<string, string>) => void;
  /** 单字段保存动作：把对应 ManualReviewFieldInput 推给主进程。 */
  saveSubtitle: (localProductId: string, value?: string) => Promise<void> | void;
  /** AI 重新生成副标题：返回候选（失败返回 null），不写库。 */
  regenerateSubtitle: (localProductId: string) => Promise<string | null>;
  saveButler: (localProductId: string, selection: ContactCardSelection | null) => Promise<void> | void;
  savePricing: (localProductId: string, adult: number, child: number, minimumTravelers: number) => Promise<void> | void;
  saveInventory: (localProductId: string, startDate: string, endDate: string, dailyQuota: number) => Promise<void> | void;
  saveVehicleCost: (localProductId: string, value: number | null) => Promise<void> | void;
  /**
   * 手动上传封面：
   *  - 先调 cover:uploadManual 落本地副本；
   *  - poi / description / minQuality 由 action 层根据旧 cover / product 自动推导，
   *    UI 不再传这些内部字段。
   */
  uploadAndSaveManualCover: (localProductId: string, args: {
    file: { name: string; type: string; base64: string };
  }) => Promise<ManualUploadCoverMeta | null>;
  /** 携程图库候选写入 product（ctripLibrary 形态）；由候选自动推导 cover 三字段。 */
  saveCtripLibraryCover: (localProductId: string, args: { candidate: CtripLibraryImageCandidate }) => Promise<boolean>;
  /**
   * 阶段 A：按景点名称解析 suggestpoi.json → places 候选列表。
   *  返回 null 时由 notice 通道兜底。
   */
  searchCtripLibraryPlaces: (localProductId: string, args: { keyword: string }) => Promise<CtripLibraryPlaceSearchResult | null>;
  /**
   * 阶段 B：按已选 place（poiId + poiName）拉该地址下的图库图片列表。
   *  返回 null 时由 notice 通道兜底。
   */
  searchCtripLibraryImages: (localProductId: string, args: { keyword: string; place: CtripLibraryPlaceCandidate }) => Promise<CtripLibrarySearchResult | null>;
  /** 手动清除某字段的错误（输入时联动）。 */
  clearError: (field: string) => void;
  /** 整个模块是否被收起（仅显示头部）。 */
  collapsed: boolean;
  /** 切换收起 / 展开。 */
  onToggleCollapsed: () => void;
}

export function AppWorkspaceReviewSummaryBasicInfo(props: ReviewSummaryBasicInfoProps) {
  const {
    product,
    currentAccountName,
    savingField,
    errors,
    accountButlerDefault,
    accountServicePhone,
    fixedInfoReloadToken,
    loadAccountFixedInfo,
    draft,
    setDraft,
    saveSubtitle,
    regenerateSubtitle,
    saveButler,
    savePricing,
    saveInventory,
    saveVehicleCost,
    uploadAndSaveManualCover,
    saveCtripLibraryCover,
    searchCtripLibraryPlaces,
    searchCtripLibraryImages,
    clearError,
    collapsed,
    onToggleCollapsed,
  } = props;

  const state = useReviewSummaryBasicInfoState({
    product,
    currentAccountName,
    fixedInfoReloadToken,
    accountButlerDefault,
    accountServicePhone,
    savingField,
    draft,
    setDraft,
    loadAccountFixedInfo,
    saveButler,
  });

  const {
    snapshot,
    coverPreviewUrl,
    readPreviewUrl,
    headMeta,
    subtitleDraft,
    pricingDraft,
    inventoryDraft,
    costDraft,
    vehicleVisible,
    updateDraft,
    updatePricingDraft,
    updateInventoryDraft,
  } = state;

  return (
    <section
      className={styles.block}
      aria-label="基础信息"
      data-collapsed={collapsed}
      data-testid="review-basic-info"
    >
      <button
        type="button"
        className={styles.head}
        aria-expanded={!collapsed}
        aria-controls="basic-info-body"
        onClick={onToggleCollapsed}
      >
        <span className={styles.headIcon} aria-hidden="true">
          <ClipboardList size={13} />
        </span>
        <strong className={styles.headTitle}>基础信息</strong>
        <small className={styles.headMeta}>{headMeta}</small>
        <span className={styles.headChevron} aria-hidden="true">
          <ChevronDown size={16} strokeWidth={2} />
        </span>
      </button>

      {!collapsed ? (
        <div id="basic-info-body" className={styles.body}>
          <BasicInfoCoverRow
            cover={snapshot.cover}
            fallback={snapshot.coverFallback}
            previewUrl={coverPreviewUrl}
            saving={savingField === "cover"}
            error={errors.cover}
            onClearError={() => clearError("cover")}
            onUploadManual={(args) => uploadAndSaveManualCover(product.id, args)}
            onPickCtripLibrary={(args) => saveCtripLibraryCover(product.id, args)}
            onSearchCtripLibraryPlaces={(args) => searchCtripLibraryPlaces(product.id, args)}
            onSearchCtripLibraryImages={(args) => searchCtripLibraryImages(product.id, args)}
            onReadPreviewUrl={async (fileId, originalName) => readPreviewUrl(fileId, originalName)}
          />

          <BasicInfoSubtitleRow
            snapshot={snapshot}
            draft={subtitleDraft}
            saving={savingField === "subtitle"}
            error={errors.subtitle}
            onDraftChange={(value) => updateDraft("subtitle", value)}
            onSave={(value) => { void saveSubtitle(product.id, value); }}
            onClearError={() => clearError("subtitle")}
            onRegenerate={() => regenerateSubtitle(product.id)}
          />

          <BasicInfoButlerRow
            snapshotButler={snapshot.butler}
            accountButlerDefault={accountButlerDefault}
            saving={savingField === "butler"}
            error={errors.butler}
          />

          <BasicInfoServicePhoneRow
            servicePhone={state.servicePhoneRaw.length > 0 ? state.servicePhoneRaw : null}
          />

          <BasicInfoPricingRow
            adult={snapshot.adult}
            child={snapshot.child}
            minimumTravelers={snapshot.minimumTravelers}
            draft={pricingDraft}
            saving={savingField === "adult" || savingField === "child" || savingField === "minimumTravelers"}
            error={errors.adult ?? errors.child ?? errors.minimumTravelers}
            onDraftChange={updatePricingDraft}
            onSave={(parsed) => { void savePricing(product.id, parsed.adult, parsed.child, parsed.minimumTravelers); }}
            onClearError={() => { clearError("adult"); clearError("child"); clearError("minimumTravelers"); }}
          />

          <BasicInfoInventoryRow
            startDate={snapshot.inventory.startDate}
            endDate={snapshot.inventory.endDate}
            dailyQuota={snapshot.inventory.dailyQuota}
            draft={inventoryDraft}
            saving={savingField === "inventory"}
            error={errors.inventory}
            onDraftChange={updateInventoryDraft}
            onSave={(parsed) => { void saveInventory(product.id, parsed.startDate, parsed.endDate, parsed.dailyQuota); }}
            onClearError={() => clearError("inventory")}
          />

          {vehicleVisible ? (
            <BasicInfoVehicleRow
              bindingVerified={product.status === "draft_saved" && product.automation?.phases.some(phase => phase.phase === "vehicleResource" && phase.status === "completed")}
              resourceGroupId={snapshot.vehicleResource.resourceGroupId}
              resourceGroupName={snapshot.vehicleResource.resourceGroupName}
              requestedTotalCost={snapshot.vehicleResource.requestedTotalCost}
              draft={costDraft}
              saving={savingField === "requestedTotalCost"}
              error={errors.requestedTotalCost}
              onDraftChange={(value) => updateDraft("requestedTotalCost", value)}
              onSave={(value) => { void saveVehicleCost(product.id, value); }}
              onClear={() => { void saveVehicleCost(product.id, null); }}
              onClearError={() => clearError("requestedTotalCost")}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}