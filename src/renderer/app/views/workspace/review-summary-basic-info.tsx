/**
 * 右侧 review 面板的「基础信息」模块：
 *   - 副标题 (basicInfo.subtitle)
 *   - 管家联系人 (operations.bookingControls.butler)
 *   - 套餐定价 (commercial.pricing.adult / child)
 *   - 用车资源组 (operations.vehicleResource.{resourceGroupId, name, requestedDailyCost})
 *   - 400 电话（来自账号 AccountFixedInfo.servicePhone，仅展示 + 引导设置）
 *
 * 验收门（与用户规格一一对齐）：
 *  1. 模块自身不引入 max-height / overflow-y / 内部滚动 / 绝对定位覆盖下方内容；
 *     自然高度随行数变化扩展，与「每日行程」「待处理」模块上下相连。
 *  2. 默认展示态只渲染「非空」字段：空值 / 未匹配 / 次级说明 / 内部 ID 等默认隐藏。
 *  3. 每个可编辑行单独一个「编辑」按钮；点击后仅该行原位展开 input；
 *     持久化回流 / 取消立即收起回展示态。
 *  4. 管家 / 400 电话仍必须保留作为创建前置校验；
 *     UI 隐藏不会影响持久化（precondition 由 main 进程单独断言）。
 *  5. 视觉密度收紧：单层 label + value + actions 三段，无嵌套大卡。
 *
 * 拆分：
 *  - .row.tsx            行壳 + 紧凑展示/编辑态切换（实际未使用 row.tsx，保留命名一致性）
 *  - basic-info-row-shell.tsx  共享行 chrome
 *  - basic-info-subtitle-row.tsx       副标题行
 *  - basic-info-butler-row.tsx         管家联系人行
 *  - basic-info-pricing-row.tsx        套餐定价行
 *  - basic-info-vehicle-row.tsx        用车资源组行
 *  - basic-info-service-phone-row.tsx  400 电话行
 *  - review-summary-basic-info.helpers.ts  纯数据抽取 / 草稿解析
 */

import { useEffect, useMemo } from "react";
import { ChevronDown, ClipboardList } from "lucide-react";
import type {
  ContactCardSelection,
  ProjectDetail,
} from "../../../../shared/contracts-types.js";
import { BasicInfoButlerRow } from "./basic-info-butler-row";
import { BasicInfoPricingRow } from "./basic-info-pricing-row";
import { BasicInfoServicePhoneRow } from "./basic-info-service-phone-row";
import { BasicInfoSubtitleRow } from "./basic-info-subtitle-row";
import { BasicInfoVehicleRow } from "./basic-info-vehicle-row";
import { readBasicInfoFromProduct, shouldShowVehicleResourceRow } from "./review-summary-basic-info.helpers";
import styles from "./review-summary-basic-info.module.less";

export interface ReviewSummaryBasicInfoProps {
  project: ProjectDetail;
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
  /** 进入基础信息模块时调用：拉取当前账号的 fixedInfo 并缓存。 */
  loadAccountFixedInfo: (projectId: string, accountName: string | null) => void;
  /** 引导用户去账号设置页选择管家 / 编辑 400 电话。 */
  onOpenAccountEditor: () => void;
  /** 字段级草稿：key=字段名, value=本地输入中的字符串。 */
  draft: Record<string, string>;
  setDraft: (value: Record<string, string>) => void;
  /** 单字段保存动作：把对应 ManualReviewFieldInput 推给主进程。 */
  saveSubtitle: (projectId: string) => Promise<void> | void;
  saveButler: (projectId: string, selection: ContactCardSelection | null) => Promise<void> | void;
  savePricing: (projectId: string, adult: number, child: number) => Promise<void> | void;
  saveVehicleCost: (projectId: string, value: number | null) => Promise<void> | void;
  /** 手动清除某字段的错误（输入时联动）。 */
  clearError: (field: string) => void;
  /** 整个模块是否被收起（仅显示头部）。 */
  collapsed: boolean;
  /** 切换收起 / 展开。 */
  onToggleCollapsed: () => void;
}

export function AppWorkspaceReviewSummaryBasicInfo({
  project,
  currentAccountName,
  savingField,
  errors,
  accountButlerDefault,
  accountServicePhone,
  loadAccountFixedInfo,
  onOpenAccountEditor,
  draft,
  setDraft,
  saveSubtitle,
  saveButler,
  savePricing,
  saveVehicleCost,
  clearError,
  collapsed,
  onToggleCollapsed,
}: ReviewSummaryBasicInfoProps) {
  const snapshot = useMemo(() => readBasicInfoFromProduct(project.product), [project.product]);

  // 进入「基础信息」模块时拉一次当前账号的 fixedInfo；
  // loadAccountFixedInfo 内部已对 projectId 做去重，不会重复 IO。
  useEffect(() => {
    loadAccountFixedInfo(project.id, currentAccountName);
  }, [project.id, currentAccountName, loadAccountFixedInfo]);

  // 「行级可渲染」判定：每行仅在「有非空关键信息」时才挂载，避免空值默认显示。
  // 隐藏占位行 = 满足验收门 #1「不展示占位行」+ #2「空值默认隐藏」。
  const subtitleVisible = snapshot.subtitle !== null;
  const butlerVisible = snapshot.butler !== null;
  const pricingVisible = snapshot.adult !== null;
  const vehicleVisible = shouldShowVehicleResourceRow(snapshot);
  const servicePhoneVisible = typeof accountServicePhone === "string" && accountServicePhone.trim().length > 0;

  // 「自然高度扩展」保证：只要存在任一可见行，整个 section 就会被挂载并占据
  // 自然高度；与「每日行程」「待处理」模块上下堆叠，共享 review-summary 滚动
  // 容器，不再自己滚。
  const anyVisible = subtitleVisible || butlerVisible || pricingVisible || vehicleVisible || servicePhoneVisible;
  if (!anyVisible) return null;

  const subtitleDraft = draft.subtitle ?? "";
  const pricingDraft = {
    adult: draft.adult ?? "",
    child: draft.child ?? "",
  };
  const costDraft = draft.requestedDailyCost ?? "";
  const headMeta = [
    subtitleVisible ? "副标题" : null,
    butlerVisible ? "管家" : null,
    servicePhoneVisible ? "400 电话" : null,
    pricingVisible ? "定价" : null,
    vehicleVisible ? "用车" : null,
  ].filter(Boolean).join(" · ");

  const updateDraft = (key: string, value: string) => setDraft({ ...draft, [key]: value });
  const updatePricingDraft = (next: { adult: string; child: string }) =>
    setDraft({ ...draft, adult: next.adult, child: next.child });

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
          {subtitleVisible ? (
            <BasicInfoSubtitleRow
              snapshot={snapshot}
              draft={subtitleDraft}
              saving={savingField === "subtitle"}
              error={errors.subtitle}
              onDraftChange={(value) => updateDraft("subtitle", value)}
              onSave={() => { void saveSubtitle(project.id); }}
              onClearError={() => clearError("subtitle")}
            />
          ) : null}

          {butlerVisible ? (
            <BasicInfoButlerRow
              snapshotButler={snapshot.butler}
              accountButlerDefault={accountButlerDefault}
              currentAccountName={currentAccountName}
              saving={savingField === "butler"}
              error={errors.butler}
              onUseAccountButler={(selection) => { void saveButler(project.id, selection); }}
              onClearButler={() => { void saveButler(project.id, null); }}
              onOpenAccountEditor={onOpenAccountEditor}
            />
          ) : null}

          {servicePhoneVisible ? (
            <BasicInfoServicePhoneRow
              servicePhone={(accountServicePhone ?? "").trim()}
              currentAccountName={currentAccountName}
              onOpenAccountEditor={onOpenAccountEditor}
            />
          ) : null}

          {pricingVisible && snapshot.adult !== null ? (
            <BasicInfoPricingRow
              adult={snapshot.adult}
              child={snapshot.child ?? 0}
              draft={pricingDraft}
              saving={savingField === "adult" || savingField === "child"}
              error={errors.adult ?? errors.child}
              onDraftChange={updatePricingDraft}
              onSave={(parsed) => { void savePricing(project.id, parsed.adult, parsed.child); }}
              onClearError={() => { clearError("adult"); clearError("child"); }}
            />
          ) : null}

          {vehicleVisible ? (
            <BasicInfoVehicleRow
              resourceGroupId={snapshot.vehicleResource.resourceGroupId}
              resourceGroupName={snapshot.vehicleResource.resourceGroupName}
              requestedDailyCost={snapshot.vehicleResource.requestedDailyCost}
              draft={costDraft}
              saving={savingField === "requestedDailyCost"}
              error={errors.requestedDailyCost}
              onDraftChange={(value) => updateDraft("requestedDailyCost", value)}
              onSave={(value) => { void saveVehicleCost(project.id, value); }}
              onClear={() => { void saveVehicleCost(project.id, null); }}
              onClearError={() => clearError("requestedDailyCost")}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
