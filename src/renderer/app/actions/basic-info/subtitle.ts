/**
 * 「副标题」字段的保存 + AI 重新生成：
 *   - saveSubtitle：UI 上是字符串，落到 product.basicInfo.subtitle；
 *   - regenerateSubtitle：调用 ai:regenerate 拿候选（失败 → 错误贴回 UI，返回 null）。
 */

import { api } from "../../helpers";
import type { AppState } from "../../state/useAppState.js";
import type { UpdateFieldDeps } from "./update-field.js";
import { makeUpdateField } from "./update-field.js";

export interface SubtitleDeps {
  api: typeof api;
  basicInfoDraft: AppState["basicInfoDraft"];
  setBasicInfoErrors: AppState["setBasicInfoErrors"];
  setNotice: AppState["setNotice"];
}

export function makeSaveSubtitle(deps: UpdateFieldDeps & { basicInfoDraft: AppState["basicInfoDraft"] }) {
  const { basicInfoDraft, ...rest } = deps;
  const updateField = makeUpdateField(rest);
  return function saveSubtitle(localProductId: string, explicit?: string) {
    const draft = (explicit ?? basicInfoDraft.subtitle ?? "").trim();
    if (!draft) return;
    void updateField(localProductId, "subtitle", { field: "basicInfoSubtitle", subtitle: draft });
  };
}

export function makeRegenerateSubtitle(deps: SubtitleDeps) {
  const { api: apiRef, setBasicInfoErrors, setNotice } = deps;
  return async function regenerateSubtitle(localProductId: string): Promise<string | null> {
    const ipc = apiRef();
    if (!ipc) return null;
    try {
      return await ipc.ai.regenerate(localProductId, "subtitle");
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 副标题生成失败，请重试。";
      setBasicInfoErrors((prev) => ({ ...prev, subtitle: message }));
      setNotice(`AI 副标题生成失败：${message}`);
      return null;
    }
  };
}