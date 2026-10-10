/**
 * useBasicInfoHandlers：右侧 review 面板「基础信息」编辑模块的 hook 入口。
 *
 * 把每个"字段保存"action 抽到独立 sub-file（按职责），再在这里以闭包形式注入依赖；
 * 上层组件继续 `const handlers = useBasicInfoHandlers(state);` 取全部 action。
 */

import { useRef } from "react";
import { api } from "../../helpers";
import type { AppState } from "../../state/useAppState.js";
import { createBasicInfoCoverSearchActions } from "../basic-info-cover-search.js";
import { makeSaveButler, makeSaveInventory, makeSavePricing } from "./butler-pricing-inventory.js";
import { makeSaveCtripLibraryCover, makeClearCover, makeUploadAndSaveManualCover } from "./cover.js";
import { makeClearAllErrors, makeClearError } from "./errors.js";
import { makeLoadAccountFixedInfo, makeResetLoaded } from "./fixed-info.js";
import { makeRegenerateSubtitle, makeSaveSubtitle } from "./subtitle.js";
import { makeSaveVehicleCost, makeSaveVehicleCostAndResolve, makeSaveVehicleResourceField } from "./vehicle.js";

export function useBasicInfoHandlers(state: AppState) {
  const savingFieldsRef = useRef<Set<import("./types.js").UpdateField>>(new Set());
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
    fixedInfoReloadToken,
    product,
    isVbkLoggedIn,
    setBrowserOpen,
    setLoginPanelOpen,
    updateReadiness,
  } = state;
  const coverSearchActions = createBasicInfoCoverSearchActions(setNotice);
  const loadedFixedInfoTokenRef = useRef<number | null>(null);

  const baseDeps = {
    api,
    savingFieldsRef,
    basicInfoSaving,
    setBasicInfoSaving,
    setBasicInfoErrors,
    setBasicInfoDraft,
    setNotice,
    basicInfoDraft,
  };
  const fixedInfoDeps = {
    api,
    basicInfoButlerLoadedForLocalProductId,
    fixedInfoReloadToken,
    loadedFixedInfoTokenRef,
    setBasicInfoButlerDefault,
    setBasicInfoServicePhone,
    setBasicInfoButlerLoadedForLocalProductId,
  };
  const subtitleDeps = { api, basicInfoDraft, setBasicInfoErrors, setNotice };
  const coverDeps = { ...baseDeps, product, setBasicInfoErrors, setNotice };
  const vehicleDeps = {
    ...baseDeps,
    api,
    product,
    isVbkLoggedIn,
    setBrowserOpen,
    setLoginPanelOpen,
    setBasicInfoErrors,
    setBasicInfoSaving,
    setNotice,
    updateReadiness,
  };
  const errorDeps = { setBasicInfoErrors };
  const clearCoverDeps = { api, setNotice };

  const loadAccountFixedInfo = makeLoadAccountFixedInfo(fixedInfoDeps);
  const resetLoaded = makeResetLoaded(fixedInfoDeps);
  const saveSubtitle = makeSaveSubtitle(baseDeps);
  const regenerateSubtitle = makeRegenerateSubtitle(subtitleDeps);
  const saveButler = makeSaveButler(baseDeps);
  const savePricing = makeSavePricing(baseDeps);
  const saveInventory = makeSaveInventory(baseDeps);
  const saveVehicleResourceField = makeSaveVehicleResourceField(baseDeps);
  const saveVehicleCost = makeSaveVehicleCost(vehicleDeps);
  const saveVehicleCostAndResolve = makeSaveVehicleCostAndResolve(vehicleDeps);
  const clearError = makeClearError(errorDeps);
  const clearAllErrors = makeClearAllErrors(errorDeps);
  const uploadAndSaveManualCover = makeUploadAndSaveManualCover(coverDeps);
  const saveCtripLibraryCover = makeSaveCtripLibraryCover(coverDeps);
  const clearCover = makeClearCover(clearCoverDeps);

  // 向后兼容的别名：旧调用方读 loadButlerDefault；
  // 现已统一改为 loadAccountFixedInfo（同时拉取 butler + 400 电话）。
  const loadButlerDefault = loadAccountFixedInfo;
  void saveVehicleCostAndResolve; // 保留 hook 里的接口位（仅 IP C 名差异）

  return {
    loadAccountFixedInfo,
    loadButlerDefault,
    resetLoaded,
    saveSubtitle,
    regenerateSubtitle,
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

export type { UpdateField } from "./types.js";
export { fieldLabel } from "./types.js";