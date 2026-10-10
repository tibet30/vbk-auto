/**
 * useReviewSummaryBasicInfoState：
 *   - 把封面预览 useEffect / 账号 fixedInfo 拉取 useEffect / 账号管家自动同步
 *     useEffect 三个 effect 集中到自定义 hook；
 *   - 派生 servicePhoneRaw / subtitleHasValue / butlerHasValue / pricingHasValue /
 *     inventoryHasValue / vehicleHasValue / vehicleVisible 7 个展示布尔 + headParts。
 *   - 提供 updateDraft / updatePricingDraft / updateInventoryDraft 三个 setter。
 *
 * 主组件只负责渲染和把 props 透传给子行组件。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ContactCardSelection,
  ManualUploadCoverMeta,
  ProductDetail,
} from "../../../../../shared/contracts-types.js";
import { api } from "../../../helpers";
import { readBasicInfoFromProduct, shouldShowVehicleResourceRow } from "../review-summary-basic-info.helpers.js";
import {
  buildHeadParts,
  deriveInventoryDraft,
  derivePricingDraft,
  sameContactCard,
  type InventoryDraft,
  type PricingDraft,
} from "./util.js";

export interface ReviewSummaryStateArgs {
  product: ProductDetail;
  currentAccountName: string | null;
  fixedInfoReloadToken: number;
  accountButlerDefault: ContactCardSelection | null;
  accountServicePhone: string | null;
  savingField: string | null;
  draft: Record<string, string>;
  setDraft: (value: Record<string, string>) => void;
  loadAccountFixedInfo: (localProductId: string, accountName: string | null) => void;
  saveButler: (localProductId: string, selection: ContactCardSelection | null) => Promise<void> | void;
}

export interface ReviewSummaryState {
  snapshot: ReturnType<typeof readBasicInfoFromProduct>;
  coverPreviewUrl: string | null;
  readPreviewUrl: (fileId: string, originalName?: string) => Promise<string | null>;
  servicePhoneRaw: string;
  servicePhoneHasValue: boolean;
  subtitleHasValue: boolean;
  butlerHasValue: boolean;
  pricingHasValue: boolean;
  inventoryHasValue: boolean;
  vehicleVisible: boolean;
  vehicleHasValue: boolean;
  headMeta: string;
  subtitleDraft: string;
  pricingDraft: PricingDraft;
  inventoryDraft: InventoryDraft;
  costDraft: string;
  updateDraft: (key: string, value: string) => void;
  updatePricingDraft: (next: PricingDraft) => void;
  updateInventoryDraft: (next: InventoryDraft) => void;
}

export function useReviewSummaryBasicInfoState(args: ReviewSummaryStateArgs): ReviewSummaryState {
  const {
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
  } = args;

  const snapshot = useMemo(() => readBasicInfoFromProduct(product.product), [product.product]);

  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null);
  const autoSyncedButlerKeyRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const cover = snapshot.cover;
    if (!cover || cover.source !== "manualUpload" || !cover.fileId) {
      setCoverPreviewUrl(null);
      return () => { cancelled = true; };
    }
    if (!api()) return () => { cancelled = true; };
    void api()!.cover.read({ fileId: cover.fileId, originalName: cover.originalName ?? "" })
      .then((res) => { if (!cancelled) setCoverPreviewUrl(res.url); })
      .catch(() => { if (!cancelled) setCoverPreviewUrl(null); });
    return () => { cancelled = true; };
  }, [snapshot.cover]);

  // 进入「基础信息」模块时拉一次当前账号的 fixedInfo；
  // loadAccountFixedInfo 内部已对 localProductId 做去重，不会重复 IO。
  useEffect(() => {
    loadAccountFixedInfo(product.id, currentAccountName);
  }, [product.id, currentAccountName, fixedInfoReloadToken, loadAccountFixedInfo]);

  // 账号固定信息是默认来源：账号联系人变化后，自动同步当前产品，
  // 保证自动录入仍读取完整的产品级 ContactCardSelection。
  const accountButlerKey = accountButlerDefault
    ? `${accountButlerDefault.contactCardId}:${accountButlerDefault.providerId}:${accountButlerDefault.displayName}`
    : "none";
  useEffect(() => {
    if (!accountButlerDefault || savingField === "butler") return;
    if (sameContactCard(snapshot.butler, accountButlerDefault)) return;
    const syncKey = `${product.id}:${accountButlerKey}`;
    if (autoSyncedButlerKeyRef.current === syncKey) return;
    autoSyncedButlerKeyRef.current = syncKey;
    void saveButler(product.id, accountButlerDefault);
  }, [accountButlerDefault, accountButlerKey, product.id, saveButler, savingField, snapshot.butler]);

  const subtitleHasValue = snapshot.subtitle !== null;
  const butlerHasValue = snapshot.butler !== null;
  const pricingHasValue = snapshot.adult !== null
    && snapshot.child !== null
    && snapshot.minimumTravelers !== null;
  const inventoryHasValue = snapshot.inventory.startDate !== null
    && snapshot.inventory.endDate !== null
    && snapshot.inventory.dailyQuota !== null;
  const vehicleVisible = shouldShowVehicleResourceRow(snapshot);
  const vehicleHasValue = vehicleVisible && (
    snapshot.vehicleResource.resourceGroupId !== null
    || (snapshot.vehicleResource.resourceGroupName !== null
      && snapshot.vehicleResource.resourceGroupName.trim().length > 0)
    || snapshot.vehicleResource.requestedTotalCost !== null
  );
  const servicePhoneRaw = typeof accountServicePhone === "string" ? accountServicePhone.trim() : "";
  const servicePhoneHasValue = servicePhoneRaw.length > 0;

  const headParts = buildHeadParts(snapshot, servicePhoneRaw, vehicleVisible, vehicleHasValue);
  const headMeta = headParts.join(" · ");

  const subtitleDraft = draft.subtitle ?? "";
  const pricingDraft = derivePricingDraft(draft);
  const inventoryDraft = deriveInventoryDraft(draft);
  const costDraft = draft.requestedTotalCost ?? "";

  const updateDraft = (key: string, value: string) => setDraft({ ...draft, [key]: value });
  const updatePricingDraft = (next: PricingDraft) =>
    setDraft({
      ...draft,
      adult: next.adult,
      child: next.child,
      minimumTravelers: next.minimumTravelers,
    });
  const updateInventoryDraft = (next: InventoryDraft) =>
    setDraft({
      ...draft,
      startDate: next.startDate,
      endDate: next.endDate,
      dailyQuota: next.dailyQuota,
    });

  const readPreviewUrl = async (fileId: string, originalName?: string): Promise<string | null> => {
    if (!api()) return null;
    const result = await api()!.cover.read({ fileId, originalName: originalName ?? "" });
    return result.url;
  };

  // Avoid unused-type warning: ManualUploadCoverMeta is referenced via the prop
  // shape but the local hook only needs the React side.
  void (null as ManualUploadCoverMeta | null);

  return {
    snapshot,
    coverPreviewUrl,
    readPreviewUrl,
    servicePhoneRaw,
    servicePhoneHasValue,
    subtitleHasValue,
    butlerHasValue,
    pricingHasValue,
    inventoryHasValue,
    vehicleVisible,
    vehicleHasValue,
    headMeta,
    subtitleDraft,
    pricingDraft,
    inventoryDraft,
    costDraft,
    updateDraft,
    updatePricingDraft,
    updateInventoryDraft,
  };
}