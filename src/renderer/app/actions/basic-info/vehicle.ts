/**
 * 用车资源组：仅写「全程用车总成本」，资源组 ID / 名称必须由 VBK 真实匹配得到，
 * UI 不允许自由输入。
 *   - saveVehicleResourceField：discriminated union 透传到 updateField；
 *   - saveVehicleCost / saveVehicleCostAndResolve：便捷 number | null 入口，
 *     保存成功后顺手调 research.resolveVehicleResource 触发 VBK 资源组匹配。
 */

import type { ManualReviewFieldInput } from "../../../../shared/contracts.js";
import type { AppState } from "../../state/useAppState.js";
import type { UpdateFieldDeps } from "./update-field.js";
import { makeUpdateField } from "./update-field.js";
import type { UpdateField } from "./types.js";

/** 写单个车辆资源组字段：当前仅允许全程用车总成本；资源组 ID / 名称必须来自 VBK 匹配。 */
export function makeSaveVehicleResourceField(deps: UpdateFieldDeps) {
  const updateField = makeUpdateField(deps);
  return function saveVehicleResourceField(
    localProductId: string,
    payload: Extract<ManualReviewFieldInput, { field: "vehicleResource" }>,
  ) {
    const fieldKey: UpdateField = ((): UpdateField => {
      if ("requestedTotalCost" in payload) return "requestedTotalCost";
      return "requestedTotalCost";
    })();
    void updateField(localProductId, fieldKey, payload);
  };
}

interface VehicleCostDeps extends UpdateFieldDeps {
  api: typeof import("../../helpers").api;
  product: AppState["product"];
  isVbkLoggedIn: AppState["isVbkLoggedIn"];
  setBrowserOpen: AppState["setBrowserOpen"];
  setLoginPanelOpen: AppState["setLoginPanelOpen"];
  setBasicInfoErrors: AppState["setBasicInfoErrors"];
  setBasicInfoSaving: AppState["setBasicInfoSaving"];
  setNotice: AppState["setNotice"];
  updateReadiness: AppState["updateReadiness"];
}

/**
 * 写「全程用车总成本（待核查）」的便捷入口：value === null 表示显式清除。
 * 与 saveVehicleResourceField 共享同一条 IPC（products:updateReviewField），
 * 只是包了 number | null 友好签名，让 basic-info-vehicle-row 不用自己
 * 构造 discriminated union。
 */
export function makeSaveVehicleCost(deps: VehicleCostDeps) {
  const saveVehicleCostAndResolve = makeSaveVehicleCostAndResolve(deps);
  return function saveVehicleCost(localProductId: string, value: number | null) {
    return saveVehicleCostAndResolve(localProductId, value);
  };
}

export function makeSaveVehicleCostAndResolve(deps: VehicleCostDeps) {
  const {
    api: apiRef,
    product,
    isVbkLoggedIn,
    setBrowserOpen,
    setLoginPanelOpen,
    setBasicInfoErrors,
    setBasicInfoSaving,
    setNotice,
    updateReadiness,
    savingFieldsRef,
  } = deps;
  const updateField = makeUpdateField(deps);
  return async function saveVehicleCostAndResolve(localProductId: string, value: number | null) {
    const saved = await updateField(localProductId, "requestedTotalCost", { field: "vehicleResource", requestedTotalCost: value });
    // value === null = 显式清除；保存已在 updateField 内做完，这里不再发起匹配。
    if (!saved || value === null) return;
    const ipc = apiRef();
    if (!ipc) return;
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
      const result = await ipc.research.resolveVehicleResource(localProductId);
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
}