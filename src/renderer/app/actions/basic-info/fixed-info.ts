/**
 * 进入「基础信息」编辑模块时拉取账号固定信息（管家 / 400 电话）：
 *   - 拉一次后缓存到 basicInfoButlerLoadedForLocalProductId + loadedFixedInfoTokenRef，
 *     避免重复 IO；
 *   - 产品切换期间如果上一次加载才返回，丢弃迟到的结果；
 *   - 账号未登录 / 未配置时静默置 null，不抛错；
 *   - fixedInfoReloadToken 变化时强制刷新（账号设置保存后 review 立即看到新值）。
 *
 * 注意：resetLoaded 是产品切换时由调用方显式触发的 sentinel 清空。
 */

import { logWarn } from "../../../../shared/log-timestamp.js";
import { api } from "../../helpers";
import type { AppState } from "../../state/useAppState.js";
import type { ContactCardSelection } from "../../../../shared/contracts.js";

export interface FixedInfoDeps {
  api: typeof api;
  basicInfoButlerLoadedForLocalProductId: AppState["basicInfoButlerLoadedForLocalProductId"];
  fixedInfoReloadToken: AppState["fixedInfoReloadToken"];
  loadedFixedInfoTokenRef: React.MutableRefObject<number | null>;
  setBasicInfoButlerDefault: AppState["setBasicInfoButlerDefault"];
  setBasicInfoServicePhone: AppState["setBasicInfoServicePhone"];
  setBasicInfoButlerLoadedForLocalProductId: AppState["setBasicInfoButlerLoadedForLocalProductId"];
}

export function makeLoadAccountFixedInfo(deps: FixedInfoDeps) {
  const {
    api: apiRef,
    basicInfoButlerLoadedForLocalProductId,
    fixedInfoReloadToken,
    loadedFixedInfoTokenRef,
    setBasicInfoButlerDefault,
    setBasicInfoServicePhone,
    setBasicInfoButlerLoadedForLocalProductId,
  } = deps;
  return async function loadAccountFixedInfo(
    localProductId: string,
    accountName: string | null,
  ) {
    const ipc = apiRef();
    if (!ipc || !accountName) return;
    if (
      basicInfoButlerLoadedForLocalProductId === localProductId
      && loadedFixedInfoTokenRef.current === fixedInfoReloadToken
    ) return;
    // 用一个调用方局部 sentinel：产品切换时 sentinel 被 reset()，即便在途请求
    // 晚到也不会把 stale default 写入新产品。
    const capturedId = localProductId;
    try {
      const info = await ipc.accounts.getFixedInfo(accountName);
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
      loadedFixedInfoTokenRef.current = fixedInfoReloadToken;
    } catch (error) {
      if (basicInfoButlerLoadedForLocalProductId && basicInfoButlerLoadedForLocalProductId !== capturedId) return;
      setBasicInfoButlerDefault(null);
      setBasicInfoServicePhone(null);
      setBasicInfoButlerLoadedForLocalProductId(capturedId);
      loadedFixedInfoTokenRef.current = fixedInfoReloadToken;
      logWarn("[basic-info] load account fixed info failed", { accountName, error });
    }
  };
}

/** 切换产品时清掉缓存的账号默认值，避免老产品的账号默认值污染新产品。 */
export function makeResetLoaded(deps: {
  setBasicInfoButlerDefault: AppState["setBasicInfoButlerDefault"];
  setBasicInfoServicePhone: AppState["setBasicInfoServicePhone"];
  setBasicInfoButlerLoadedForLocalProductId: AppState["setBasicInfoButlerLoadedForLocalProductId"];
  loadedFixedInfoTokenRef: React.MutableRefObject<number | null>;
}) {
  const {
    setBasicInfoButlerDefault,
    setBasicInfoServicePhone,
    setBasicInfoButlerLoadedForLocalProductId,
    loadedFixedInfoTokenRef,
  } = deps;
  return function resetLoaded() {
    setBasicInfoButlerDefault(null);
    setBasicInfoServicePhone(null);
    setBasicInfoButlerLoadedForLocalProductId(null);
    loadedFixedInfoTokenRef.current = null;
  };
}