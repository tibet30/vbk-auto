/**
 * 单字段保存通用动作（lock + error + IPC + draft clear）：
 *   - makeUpdateField(deps)：工厂，注入 setBasicInfoSaving / setBasicInfoErrors /
 *     setBasicInfoDraft / setNotice / savingFieldsRef / basicInfoSaving 后返回
 *     可被各 save 函数复用的 updateField；
 *   - 重复点击锁：savingFieldsRef + basicInfoSaving 双重判定，避免 race；
 *   - 失败时贴回 UI 红错（per-field），保留草稿；
 *   - 成功后清掉该字段的本地草稿。
 */

import { api } from "../../helpers";
import type { AppState } from "../../state/useAppState.js";
import type { ManualReviewFieldInput } from "../../../../shared/contracts.js";
import type { UpdateField } from "./types.js";
import { fieldLabel } from "./types.js";

export interface UpdateFieldDeps {
  api: typeof api;
  savingFieldsRef: React.MutableRefObject<Set<UpdateField>>;
  basicInfoSaving: AppState["basicInfoSaving"];
  setBasicInfoSaving: AppState["setBasicInfoSaving"];
  setBasicInfoErrors: AppState["setBasicInfoErrors"];
  setBasicInfoDraft: AppState["setBasicInfoDraft"];
  setNotice: AppState["setNotice"];
}

/**
 * 把单个字段写入 product JSON：
 *  - 调 IPC products.updateReviewField；
 *  - 成功后 main 进程会发 product:updated，UI 通过 useAppState 自动重派生；
 *  - 失败时把错误文案贴回 UI（per-field），不抛错到全局。
 */
export function makeUpdateField(deps: UpdateFieldDeps) {
  const {
    api: apiRef,
    savingFieldsRef,
    basicInfoSaving,
    setBasicInfoSaving,
    setBasicInfoErrors,
    setBasicInfoDraft,
    setNotice,
  } = deps;
  return async (
    localProductId: string,
    field: UpdateField,
    payload: ManualReviewFieldInput,
  ): Promise<boolean> => {
    const ipc = apiRef();
    if (!ipc) return false;
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
      await ipc.products.updateReviewField(localProductId, payload);
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
}